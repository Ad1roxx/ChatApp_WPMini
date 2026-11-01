"""Generation providers: one interface, two adapters, and a scripted fake.

    provider.generate(system, user, budget_s=...)  ->  Generation

Everything a caller needs to know comes back as a `Generation` with an
`outcome`, never as an exception: an answer (`ok`), a limit reached
(`rate_limited`), an answer cut off at the output cap (`truncated`), a model or
key the provider will not serve (`unavailable`), no key configured
(`not_configured`), or anything else (`failed`). Each outcome but `ok` has one
plain sentence for the user in `PLAIN`, and no provider's own error text ever
reaches one.

## Why httpx, not the providers' SDKs

Each provider is one POST with one JSON shape, and the rules this layer exists
to enforce sit exactly where an SDK hides things:

- **Retries.** S2 retries a 429 once, and only if its retry-after fits the time
  left. The Groq SDK retries 429s itself (twice, by default) and the Gemini SDK
  has its own policy; either would have to be switched off and then trusted to
  stay off across upgrades.
- **Headers.** Groq's budget is read from `x-ratelimit-*` on every response,
  and the will-it-fit check runs on them before the next call.
- **Tests.** `httpx.MockTransport` serves real response shapes - a 429 with a
  retry-after, an exhausted header set, a `MAX_TOKENS` finish - with no network
  and no SDK internals to patch.

httpx is already in the environment (FastAPI's test client uses it) and is now
pinned. Two SDKs would add two dependency trees for two POSTs. No LangChain:
the prompt and its parsing are the part worth reading.

## Limits live here, not at the call sites

**Gemini** sends no rate-limit headers, so its calls are counted: `CallBudget`
holds the timestamps of the last day's calls in a small file shared by every
process using the key, locked between processes, and refuses - before sending
- a call that would exceed 15 a minute or 480 a day (Google's limit is 500). **Groq** reserves the prompt plus
`max_completion_tokens` from one 8K-a-minute bucket before it generates, so
`HeaderBudget` keeps what the last response said was left and checks that sum
against it. Either way a call that cannot be made in time is a `rate_limited`
outcome without a request being sent.

Keys go into each client's headers once, at construction. Never into a URL,
which ends up in exception messages; never into a log line or `detail`, which
are built only from status codes and the provider's own one-word error codes.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol

import httpx

from config import (
    GEMINI_API_KEY,
    GEMINI_MODEL,
    GEMINI_RPD,
    GEMINI_RPM,
    GROQ_API_KEY,
    GROQ_MODEL,
    GROQ_REASONING_EFFORT,
    LLM_MAX_OUTPUT_TOKENS,
    LLM_PROVIDER,
    LLM_USAGE_FILE,
)

log = logging.getLogger("copilot.llm")

OK = "ok"
RATE_LIMITED = "rate_limited"
TRUNCATED = "truncated"
UNAVAILABLE = "unavailable"
NOT_CONFIGURED = "not_configured"
FAILED = "failed"

# What the user reads. Describes what happened from where they sit, and never
# quotes a provider: an error body can carry anything, including the prompt.
PLAIN = {
    RATE_LIMITED: "The assistant has reached its usage limit for now. Try again in a minute.",
    TRUNCATED: "The assistant's answer ran past its length limit, so it isn't shown. Try a narrower question.",
    UNAVAILABLE: "The assistant is unavailable right now.",
    NOT_CONFIGURED: "The assistant isn't set up on this server.",
    FAILED: "The assistant couldn't answer just now. Try again.",
}

# Seconds a call needs to be worth starting. A wait or a retry that would leave
# less than this before the deadline is not attempted.
MIN_CALL_S = 3.0
DEFAULT_BUDGET_S = 20.0

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# Groq's chat template adds about 70 tokens to every prompt (AGENT_PLAN 2.6).
GROQ_TEMPLATE_TOKENS = 70

_CODE = re.compile(r"^[A-Za-z_]{1,40}$")


@dataclass(frozen=True)
class Generation:
    outcome: str
    provider: str
    model: str
    # Excluded from repr so that no log of a Generation carries an answer.
    text: str = field(default="", repr=False)
    input_tokens: int | None = None
    output_tokens: int | None = None
    latency_ms: float = 0.0
    attempts: int = 0
    retry_after: float | None = None
    # A status code and the provider's one-word error code, never free text.
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.outcome == OK

    @property
    def message(self) -> str | None:
        """The plain sentence for the user, or None for an answer."""
        return PLAIN.get(self.outcome)


class LLMProvider(Protocol):
    name: str
    model: str

    def generate(self, system: str, user: str, *, budget_s: float = DEFAULT_BUDGET_S) -> Generation: ...


def log_call(generation: Generation, *, prompt_version: str, stripped: int = 0) -> str:
    """One line per provider call. Counts and codes only: no prompt, no answer."""
    g = generation
    line = (
        f"llm provider={g.provider} model={g.model} prompt={prompt_version} outcome={g.outcome} "
        f"attempts={g.attempts} in={g.input_tokens if g.input_tokens is not None else '-'} "
        f"out={g.output_tokens if g.output_tokens is not None else '-'} ms={g.latency_ms:.0f} "
        f"stripped={stripped}" + (f" detail={g.detail}" if g.detail else "")
    )
    log.info(line)
    return line


# ---------------------------------------------------------------------------
# Budgets
# ---------------------------------------------------------------------------


class _FileLock:
    """An exclusive lock between processes, held on a sibling `.lock` file.

    The operating system's own record lock (`msvcrt.locking` on Windows,
    `fcntl.flock` elsewhere), so it is released when its holder exits, crashes
    included: there is never a stale lock to clear by hand. Inside one process
    a thread lock serialises first, because an OS lock taken twice by the same
    process does not exclude.
    """

    def __init__(self, path: str):
        self.path = path + ".lock"
        self._thread = threading.Lock()
        self._file = None

    def __enter__(self):
        self._thread.acquire()
        try:
            self._file = open(self.path, "a+b")
            if os.name == "nt":
                import msvcrt

                self._file.seek(0)
                # LK_LOCK retries for about ten seconds, then raises.
                msvcrt.locking(self._file.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(self._file.fileno(), fcntl.LOCK_EX)
        except BaseException:
            if self._file:
                self._file.close()
            self._thread.release()
            raise
        return self

    def __exit__(self, *exc):
        try:
            if os.name == "nt":
                import msvcrt

                self._file.seek(0)
                msvcrt.locking(self._file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
        finally:
            self._file.close()
            self._thread.release()


class CallBudget:
    """Calls per minute and per day, counted by us, for a provider that says nothing.

    Windows are rolling: no more than `rpd` calls in any 24 hours. Google resets
    its daily count at midnight Pacific; a rolling window can never exceed a
    calendar day's limit whichever midnight it uses, at the cost of being
    stricter around it.

    With a `path`, the timestamps live in a file that every process using the
    key shares - the service, an evaluation run, a smoke test - so they count
    against one quota and a restart does not forget the day. **Every read and
    write of it happens under an exclusive lock between processes, and checking
    a call and counting it are one step (`claim`).** Without that, two processes
    could each see 14 calls in the minute and both send a 15th, a
    read-modify-write could lose a count, and on Windows a write could fail
    outright while the other process had the file open.
    """

    MINUTE = 60.0
    DAY = 86_400.0

    def __init__(self, rpm: int, rpd: int, path: str | None = None, clock: Callable[[], float] = time.time):
        self.rpm, self.rpd, self.path, self.clock = rpm, rpd, path, clock
        self._calls: list[float] = []
        self._lock = _FileLock(path) if path else threading.Lock()

    def _load(self) -> list[float]:
        if not self.path:
            return self._calls
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            return sorted(float(t) for t in data.get("calls", []))
        except FileNotFoundError:
            return []
        except (OSError, ValueError, TypeError, AttributeError):
            log.warning("llm usage file %s is unreadable; counting from empty", self.path)
            return []

    def _save(self, calls: list[float]) -> None:
        if not self.path:
            self._calls = calls
            return
        # Written whole and swapped in, so a crash mid-write leaves the old
        # file rather than half a new one. Safe under the lock: no other
        # process has the file open while this one holds it.
        tmp = f"{self.path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"calls": calls}, f)
        os.replace(tmp, self.path)

    def _wait(self, now: float, calls: list[float]) -> float:
        minute = [t for t in calls if now - t < self.MINUTE]
        waits = [0.0]
        if len(minute) >= self.rpm:
            waits.append(minute[-self.rpm] + self.MINUTE - now)
        if len(calls) >= self.rpd:
            waits.append(calls[-self.rpd] + self.DAY - now)
        return max(waits)

    def claim(self) -> float:
        """Count a call if it fits now and return 0; otherwise count nothing and
        return the seconds until it would fit. Atomic across processes."""
        with self._lock:
            now = self.clock()
            calls = [t for t in self._load() if now - t < self.DAY]
            wait = self._wait(now, calls)
            if wait == 0:
                self._save(calls + [now])
            return wait

    def wait_s(self) -> float:
        """Seconds until the next call would fit, counting nothing. For pacing."""
        with self._lock:
            now = self.clock()
            return self._wait(now, [t for t in self._load() if now - t < self.DAY])

    def used(self) -> tuple[int, int]:
        """(calls in the last minute, calls in the last day)."""
        with self._lock:
            now = self.clock()
            calls = [t for t in self._load() if now - t < self.DAY]
            return sum(1 for t in calls if now - t < self.MINUTE), len(calls)


_DURATION = re.compile(r"(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$")


def parse_duration(text: str | None) -> float | None:
    """Groq's and Gemini's durations ("7.66s", "2m59.56s", "1h2m", "120ms") in seconds."""
    if not text:
        return None
    text = text.strip()
    try:
        return float(text)
    except ValueError:
        pass
    match = _DURATION.match(text)
    if not match or not any(match.groups()):
        return None
    h, m, s, ms = (float(g) if g else 0.0 for g in match.groups())
    return h * 3600 + m * 60 + s + ms / 1000


class HeaderBudget:
    """What Groq's last response said was left, and when it refills.

    One bucket of tokens a minute and a count of requests a day. Before a call
    the need is the prompt plus the output cap, because that is what Groq
    reserves; if the bucket held less than that, the call waits for the reset or
    does not happen. Nothing is known before the first response, so the first
    call is always attempted.
    """

    def __init__(self, clock: Callable[[], float] = time.time):
        self.clock = clock
        self.tokens: int | None = None
        self.tokens_reset_at = 0.0
        self.requests: int | None = None
        self.requests_reset_at = 0.0

    def update(self, headers: httpx.Headers) -> None:
        now = self.clock()

        def number(name: str) -> int | None:
            try:
                return int(float(headers[name]))
            except (KeyError, ValueError):
                return None

        tokens, requests = number("x-ratelimit-remaining-tokens"), number("x-ratelimit-remaining-requests")
        if tokens is not None:
            self.tokens = tokens
            self.tokens_reset_at = now + (parse_duration(headers.get("x-ratelimit-reset-tokens")) or 60.0)
        if requests is not None:
            self.requests = requests
            self.requests_reset_at = now + (parse_duration(headers.get("x-ratelimit-reset-requests")) or CallBudget.DAY)

    def wait_s(self, need_tokens: int) -> float:
        now = self.clock()
        waits = [0.0]
        if self.requests is not None and self.requests <= 0 and now < self.requests_reset_at:
            waits.append(self.requests_reset_at - now)
        if self.tokens is not None and self.tokens < need_tokens and now < self.tokens_reset_at:
            waits.append(self.tokens_reset_at - now)
        return max(waits)


def estimate_tokens(text: str) -> int:
    """A deliberately high estimate: three characters a token.

    Groq's tokenizer is not available here, and English prose runs nearer four
    characters a token, so this over-reserves a little rather than sending a
    call the bucket cannot hold.
    """
    return math.ceil(len(text) / 3)


# ---------------------------------------------------------------------------
# The adapters
# ---------------------------------------------------------------------------


class _Parsed(Exception):
    """A response's outcome, raised out of `_parse` when it is not an answer."""

    def __init__(self, outcome: str, detail: str):
        super().__init__(detail)
        self.outcome, self.detail = outcome, detail


def _code(value) -> str:
    """A provider's error code, only if it is one word: never free text."""
    return value if isinstance(value, str) and _CODE.match(value) else ""


class _HttpProvider:
    name = "http"

    def __init__(
        self,
        api_key: str,
        model: str,
        *,
        max_output_tokens: int = LLM_MAX_OUTPUT_TOKENS,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.model = model
        self.max_output_tokens = max_output_tokens
        self.clock, self.sleep = clock, sleep
        # Created once, here, and reused: a connection pool per process, and
        # the key set in exactly one place.
        self.client = httpx.Client(headers=self._auth(api_key), transport=transport)

    # -- per provider --
    def _auth(self, api_key: str) -> dict: raise NotImplementedError
    def _url(self) -> str: raise NotImplementedError
    def _body(self, system: str, user: str) -> dict: raise NotImplementedError
    def _parse(self, body: dict) -> tuple[str, int | None, int | None]: raise NotImplementedError
    def _claim(self, system: str, user: str) -> float: return 0.0
    def _received(self, response: httpx.Response) -> None: pass
    def _retry_after(self, response: httpx.Response) -> float | None:
        return parse_duration(response.headers.get("retry-after"))
    def _error_code(self, response: httpx.Response) -> str: return ""

    def generate(self, system: str, user: str, *, budget_s: float = DEFAULT_BUDGET_S) -> Generation:
        started = self.clock()
        deadline = started + budget_s
        attempts = 0

        def result(outcome: str, **kw) -> Generation:
            return Generation(
                outcome, self.name, self.model,
                latency_ms=(self.clock() - started) * 1000, attempts=attempts, **kw,
            )

        while True:
            # Check the budget and, for Gemini, count the call - in one step,
            # so no other process can take the same slot in between.
            wait = self._claim(system, user)
            while wait > 0:
                if self.clock() + wait > deadline - MIN_CALL_S:
                    return result(RATE_LIMITED, retry_after=wait, detail="budget")
                self.sleep(wait)
                wait = self._claim(system, user)

            attempts += 1
            try:
                response = self.client.post(
                    self._url(), json=self._body(system, user), timeout=max(deadline - self.clock(), 1.0)
                )
            except httpx.TimeoutException:
                return result(FAILED, detail="timeout")
            except httpx.HTTPError as error:
                return result(FAILED, detail=type(error).__name__)
            self._received(response)
            status = response.status_code

            if status == 429:
                retry = self._retry_after(response)
                if attempts == 1 and retry is not None and self.clock() + retry <= deadline - MIN_CALL_S:
                    self.sleep(retry)
                    continue
                return result(RATE_LIMITED, retry_after=retry, detail=f"http 429 {self._error_code(response)}".strip())

            code = self._error_code(response)
            if status == 404 or code in ("model_not_found", "model_decommissioned"):
                log.error(
                    "llm provider=%s model=%s unavailable (http %s %s): the pinned model may have been "
                    "withdrawn - re-check the provider's model list", self.name, self.model, status, code,
                )
                return result(UNAVAILABLE, detail=f"http {status} {code}".strip())
            if status in (401, 403):
                log.error("llm provider=%s rejected the key (http %s %s)", self.name, status, code)
                return result(UNAVAILABLE, detail=f"http {status} {code}".strip())
            if status != 200:
                return result(FAILED, detail=f"http {status} {code}".strip())

            try:
                text, tokens_in, tokens_out = self._parse(response.json())
            except _Parsed as parsed:
                return result(parsed.outcome, detail=parsed.detail)
            except (ValueError, KeyError, IndexError, TypeError, AttributeError):
                return result(FAILED, detail="malformed")
            return result(OK, text=text, input_tokens=tokens_in, output_tokens=tokens_out)


class GeminiProvider(_HttpProvider):
    name = "gemini"

    def __init__(self, api_key: str, model: str = GEMINI_MODEL, *, budget: CallBudget | None = None, **kw):
        super().__init__(api_key, model, **kw)
        self.budget = budget or CallBudget(GEMINI_RPM, GEMINI_RPD, LLM_USAGE_FILE, clock=self.clock)

    def _auth(self, api_key: str) -> dict:
        return {"x-goog-api-key": api_key}

    def _url(self) -> str:
        return GEMINI_URL.format(model=self.model)

    def _body(self, system: str, user: str) -> dict:
        return {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"maxOutputTokens": self.max_output_tokens, "temperature": 0},
        }

    def _claim(self, system: str, user: str) -> float:
        # Counted when claimed, just before sending: a call that fails still
        # counts at Google.
        return self.budget.claim()

    def _error(self, response: httpx.Response) -> dict:
        try:
            error = response.json().get("error", {})
            return error if isinstance(error, dict) else {}
        except ValueError:
            return {}

    def _error_code(self, response: httpx.Response) -> str:
        return _code(self._error(response).get("status"))

    def _retry_after(self, response: httpx.Response) -> float | None:
        header = super()._retry_after(response)
        if header is not None:
            return header
        for item in self._error(response).get("details") or []:
            if isinstance(item, dict) and str(item.get("@type", "")).endswith("RetryInfo"):
                return parse_duration(item.get("retryDelay"))
        return None

    def _parse(self, body: dict) -> tuple[str, int | None, int | None]:
        usage = body.get("usageMetadata") or {}
        tokens_in = usage.get("promptTokenCount")
        out = [usage.get("candidatesTokenCount"), usage.get("thoughtsTokenCount")]
        tokens_out = sum(t for t in out if t) if any(t is not None for t in out) else None

        candidates = body.get("candidates") or []
        if not candidates:
            reason = _code((body.get("promptFeedback") or {}).get("blockReason"))
            raise _Parsed(FAILED, f"blocked {reason}".strip())
        candidate = candidates[0]
        finish = candidate.get("finishReason")
        if finish == "MAX_TOKENS":
            raise _Parsed(TRUNCATED, "MAX_TOKENS")
        if finish not in ("STOP", None):
            raise _Parsed(FAILED, _code(finish) or "finish")
        parts = (candidate.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
        if not text:
            raise _Parsed(FAILED, "empty")
        return text, tokens_in, tokens_out


class GroqProvider(_HttpProvider):
    name = "groq"

    def __init__(self, api_key: str, model: str = GROQ_MODEL, *, reasoning_effort: str = GROQ_REASONING_EFFORT, **kw):
        super().__init__(api_key, model, **kw)
        self.reasoning_effort = reasoning_effort
        self.budget = HeaderBudget(clock=self.clock)

    def _auth(self, api_key: str) -> dict:
        return {"Authorization": f"Bearer {api_key}"}

    def _url(self) -> str:
        return GROQ_URL

    def _body(self, system: str, user: str) -> dict:
        return {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_completion_tokens": self.max_output_tokens,
            "reasoning_effort": self.reasoning_effort,
            "temperature": 0,
        }

    def need_tokens(self, system: str, user: str) -> int:
        """What Groq will reserve: the prompt, its template, and the whole cap."""
        return estimate_tokens(system) + estimate_tokens(user) + GROQ_TEMPLATE_TOKENS + self.max_output_tokens

    def _claim(self, system: str, user: str) -> float:
        return self.budget.wait_s(self.need_tokens(system, user))

    def _received(self, response: httpx.Response) -> None:
        self.budget.update(response.headers)

    def _error_code(self, response: httpx.Response) -> str:
        try:
            error = response.json().get("error", {})
        except ValueError:
            return ""
        return _code(error.get("code")) if isinstance(error, dict) else ""

    def _parse(self, body: dict) -> tuple[str, int | None, int | None]:
        usage = body.get("usage") or {}
        choice = body["choices"][0]
        finish = choice.get("finish_reason")
        if finish == "length":
            raise _Parsed(TRUNCATED, "length")
        if finish not in ("stop", None):
            raise _Parsed(FAILED, _code(finish) or "finish")
        text = (choice.get("message") or {}).get("content") or ""
        if not text.strip():
            raise _Parsed(FAILED, "empty")
        return text.strip(), usage.get("prompt_tokens"), usage.get("completion_tokens")


class Unconfigured:
    """The provider when its key is missing: answers every call with a plain 503."""

    def __init__(self, name: str, model: str):
        self.name, self.model = name, model

    def generate(self, system: str, user: str, *, budget_s: float = DEFAULT_BUDGET_S) -> Generation:
        return Generation(NOT_CONFIGURED, self.name, self.model, detail="no key")


class ScriptedProvider:
    """A fake for tests: plays back replies in order and records every call.

    A reply is answer text, a ready-made `Generation`, or a function of
    (system, user) returning either. Running out of replies is a test error.
    """

    def __init__(self, *replies, name: str = "fake", model: str = "scripted"):
        self.name, self.model = name, model
        self.replies = list(replies)
        self.calls: list[tuple[str, str]] = []

    def generate(self, system: str, user: str, *, budget_s: float = DEFAULT_BUDGET_S) -> Generation:
        self.calls.append((system, user))
        if not self.replies:
            raise AssertionError("ScriptedProvider has no reply left for this call")
        reply = self.replies.pop(0)
        if callable(reply):
            reply = reply(system, user)
        if isinstance(reply, Generation):
            return reply
        return Generation(OK, self.name, self.model, text=reply, input_tokens=0, output_tokens=0, attempts=1)


def build_provider(name: str = LLM_PROVIDER) -> LLMProvider:
    """The configured provider, built once at start-up.

    A missing key is not a start-up failure: search must keep working, so the
    provider becomes `Unconfigured` and the ask route answers 503. An unknown
    provider name is a start-up failure, loudly, because it is a typo.
    """
    if name == "gemini":
        if not GEMINI_API_KEY:
            log.warning("llm provider=gemini has no GEMINI_API_KEY: the ask route will answer 503")
            return Unconfigured("gemini", GEMINI_MODEL)
        return GeminiProvider(GEMINI_API_KEY)
    if name == "groq":
        if not GROQ_API_KEY:
            log.warning("llm provider=groq has no GROQ_API_KEY: the ask route will answer 503")
            return Unconfigured("groq", GROQ_MODEL)
        return GroqProvider(GROQ_API_KEY)
    raise ValueError(f"unknown AI_LLM_PROVIDER {name!r}; expected 'gemini' or 'groq'")
