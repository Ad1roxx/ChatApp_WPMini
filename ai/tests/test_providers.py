"""The provider layer, against scripted HTTP responses: no network, no keys.

Every response here has the shape the real provider sends (AGENT_PLAN 2.6,
read 2026-10-31): a 429 with a retry-after, Groq's `x-ratelimit-*` headers,
Gemini's `MAX_TOKENS` and Groq's `length` finishes, a withdrawn model's 404.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import httpx
import pytest

import providers
from providers import (
    FAILED,
    NOT_CONFIGURED,
    OK,
    PLAIN,
    RATE_LIMITED,
    TRUNCATED,
    UNAVAILABLE,
    CallBudget,
    GeminiProvider,
    Generation,
    GroqProvider,
    HeaderBudget,
    ScriptedProvider,
    Unconfigured,
    log_call,
    parse_duration,
)

KEY = "test-key-0123456789-not-real"
SYSTEM = "You answer from the sources."
USER = "What is the retry policy?"


class Clock:
    """Time that only moves when something sleeps, or a test moves it."""

    def __init__(self, now: float = 1_000_000.0):
        self.now = now
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


class Server:
    """A MockTransport that replies from a script and keeps every request."""

    def __init__(self, *responses: httpx.Response):
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []
        self.transport = httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self.responses:
            raise AssertionError("no scripted response left")
        reply = self.responses.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def gemini_ok(text="The answer [1].", finish="STOP", prompt=900, out=40, thoughts=None) -> httpx.Response:
    usage = {"promptTokenCount": prompt, "candidatesTokenCount": out}
    if thoughts is not None:
        usage["thoughtsTokenCount"] = thoughts
    return httpx.Response(200, json={
        "candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": finish}],
        "usageMetadata": usage,
    })


def gemini_429(delay: str | None = "5s", header: str | None = None) -> httpx.Response:
    details = [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": delay}] if delay else []
    return httpx.Response(
        429,
        headers={"retry-after": header} if header else {},
        json={"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "Quota exceeded", "details": details}},
    )


def groq_ok(text="The answer [1].", finish="stop", headers=None) -> httpx.Response:
    return httpx.Response(200, headers=headers or {}, json={
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": finish}],
        "usage": {"prompt_tokens": 950, "completion_tokens": 60},
    })


def groq_headers(tokens: int, reset_tokens="7.66s", requests=999, reset_requests="1m26.4s") -> dict:
    return {
        "x-ratelimit-limit-tokens": "8000",
        "x-ratelimit-remaining-tokens": str(tokens),
        "x-ratelimit-reset-tokens": reset_tokens,
        "x-ratelimit-limit-requests": "1000",
        "x-ratelimit-remaining-requests": str(requests),
        "x-ratelimit-reset-requests": reset_requests,
    }


def gemini(server: Server, clock: Clock, rpm=15, rpd=500, path=None) -> GeminiProvider:
    return GeminiProvider(
        KEY, "gemini-3.5-flash-lite", transport=server.transport, clock=clock, sleep=clock.sleep,
        budget=CallBudget(rpm, rpd, path, clock=clock),
    )


def groq(server: Server, clock: Clock) -> GroqProvider:
    return GroqProvider(KEY, "openai/gpt-oss-120b", transport=server.transport, clock=clock, sleep=clock.sleep)


# ---------------------------------------------------------------- requests


def test_gemini_sends_the_pinned_model_the_cap_and_the_key_only_in_a_header():
    server, clock = Server(gemini_ok()), Clock()
    result = gemini(server, clock).generate(SYSTEM, USER)

    assert result.ok and result.text == "The answer [1]."
    (request,) = server.requests
    assert request.url.path.endswith("/models/gemini-3.5-flash-lite:generateContent")
    assert KEY not in str(request.url)
    assert request.headers["x-goog-api-key"] == KEY
    body = json.loads(request.content)
    assert body["systemInstruction"]["parts"][0]["text"] == SYSTEM
    assert body["contents"] == [{"role": "user", "parts": [{"text": USER}]}]
    assert body["generationConfig"] == {"maxOutputTokens": 400, "temperature": 0}


def test_groq_sends_low_reasoning_effort_and_the_cap():
    server, clock = Server(groq_ok()), Clock()
    result = groq(server, clock).generate(SYSTEM, USER)

    assert result.ok and (result.input_tokens, result.output_tokens) == (950, 60)
    (request,) = server.requests
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert KEY not in str(request.url)
    body = json.loads(request.content)
    assert body["model"] == "openai/gpt-oss-120b"
    assert body["messages"] == [{"role": "system", "content": SYSTEM}, {"role": "user", "content": USER}]
    assert body["max_completion_tokens"] == 400
    assert body["reasoning_effort"] == "low"


def test_gemini_thinking_tokens_count_as_output():
    server, clock = Server(gemini_ok(out=40, thoughts=25)), Clock()
    result = gemini(server, clock).generate(SYSTEM, USER)
    assert (result.input_tokens, result.output_tokens) == (900, 65)


def test_thought_parts_are_not_part_of_the_answer():
    response = httpx.Response(200, json={
        "candidates": [{"content": {"parts": [{"text": "planning...", "thought": True}, {"text": "Answer [2]."}]},
                        "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 3},
    })
    result = gemini(Server(response), Clock()).generate(SYSTEM, USER)
    assert result.text == "Answer [2]."


# ---------------------------------------------------------------- the cap


@pytest.mark.parametrize("make, response", [
    (gemini, gemini_ok(text="The answer is cut", finish="MAX_TOKENS")),
    (groq, groq_ok(text="The answer is cut", finish="length")),
])
def test_an_answer_stopped_at_the_cap_is_an_error_never_an_answer(make, response):
    result = make(Server(response), Clock()).generate(SYSTEM, USER)

    assert result.outcome == TRUNCATED
    assert result.text == ""
    assert not result.ok
    assert result.message == PLAIN[TRUNCATED]


# ---------------------------------------------------------------- 429


def test_a_429_whose_retry_after_fits_is_retried_once():
    server, clock = Server(gemini_429(delay="5s"), gemini_ok()), Clock()
    result = gemini(server, clock).generate(SYSTEM, USER, budget_s=20)

    assert result.ok
    assert result.attempts == 2
    assert clock.slept == [5.0]
    assert len(server.requests) == 2


def test_a_second_429_is_reported_not_retried_again():
    server, clock = Server(gemini_429(delay="2s"), gemini_429(delay="2s")), Clock()
    result = gemini(server, clock).generate(SYSTEM, USER, budget_s=20)

    assert result.outcome == RATE_LIMITED
    assert result.attempts == 2
    assert len(server.requests) == 2
    assert result.message == PLAIN[RATE_LIMITED]


def test_a_429_whose_retry_after_does_not_fit_is_reported_at_once():
    server, clock = Server(gemini_429(delay="45s")), Clock()
    result = gemini(server, clock).generate(SYSTEM, USER, budget_s=20)

    assert result.outcome == RATE_LIMITED
    assert result.retry_after == 45.0
    assert result.attempts == 1
    assert clock.slept == []


def test_a_429_without_a_retry_after_is_not_retried():
    server, clock = Server(gemini_429(delay=None)), Clock()
    result = gemini(server, clock).generate(SYSTEM, USER)
    assert result.outcome == RATE_LIMITED and result.attempts == 1


def test_groq_429_retry_after_header_is_honoured():
    server, clock = Server(httpx.Response(429, headers={"retry-after": "3"}, json={"error": {"code": "rate_limit_exceeded"}}),
                           groq_ok()), Clock()
    result = groq(server, clock).generate(SYSTEM, USER, budget_s=20)
    assert result.ok and clock.slept == [3.0]


# ---------------------------------------------------------------- Gemini's own count


def test_gemini_refuses_before_calling_when_the_minute_is_full_and_the_wait_does_not_fit():
    server, clock = Server(gemini_ok(), gemini_ok()), Clock()
    provider = gemini(server, clock, rpm=2)
    assert provider.generate(SYSTEM, USER).ok
    assert provider.generate(SYSTEM, USER).ok

    result = provider.generate(SYSTEM, USER, budget_s=20)

    assert result.outcome == RATE_LIMITED
    assert result.detail == "budget"
    assert result.attempts == 0
    assert len(server.requests) == 2  # the third was never sent
    assert result.message == PLAIN[RATE_LIMITED]


def test_gemini_waits_for_the_minute_when_the_wait_fits():
    server, clock = Server(gemini_ok(), gemini_ok()), Clock()
    provider = gemini(server, clock, rpm=1)
    assert provider.generate(SYSTEM, USER).ok
    clock.now += 50

    result = provider.generate(SYSTEM, USER, budget_s=30)

    assert result.ok
    assert clock.slept == [pytest.approx(10.0)]


def test_gemini_refuses_for_the_rest_of_the_day_once_the_day_is_used():
    server, clock = Server(*[gemini_ok() for _ in range(3)]), Clock()
    provider = gemini(server, clock, rpm=15, rpd=3)
    for _ in range(3):
        assert provider.generate(SYSTEM, USER).ok
        clock.now += 61

    result = provider.generate(SYSTEM, USER, budget_s=600)

    assert result.outcome == RATE_LIMITED
    assert result.retry_after > 3600
    assert len(server.requests) == 3


def test_a_failed_call_still_counts_against_the_budget():
    server, clock = Server(httpx.Response(500, json={}), gemini_ok()), Clock()
    provider = gemini(server, clock, rpm=1)
    assert provider.generate(SYSTEM, USER).outcome == FAILED
    assert provider.generate(SYSTEM, USER, budget_s=20).outcome == RATE_LIMITED


def test_the_count_is_shared_through_the_file_and_survives_a_restart(tmp_path):
    path = str(tmp_path / "usage.json")
    clock = Clock()
    first = CallBudget(2, 500, path, clock=clock)
    assert first.claim() == 0
    second = CallBudget(2, 500, path, clock=clock)  # another process, or after a restart
    assert second.claim() == 0

    assert first.used() == (2, 2)
    assert first.wait_s() == pytest.approx(60.0)


def test_calls_older_than_a_day_are_forgotten(tmp_path):
    path = str(tmp_path / "usage.json")
    clock = Clock()
    budget = CallBudget(15, 1, path, clock=clock)
    assert budget.claim() == 0
    assert budget.wait_s() == pytest.approx(86_400.0)
    clock.now += 86_400
    assert budget.wait_s() == 0.0


def test_an_unreadable_usage_file_does_not_crash(tmp_path):
    path = tmp_path / "usage.json"
    path.write_text("{not json")
    budget = CallBudget(15, 500, str(path), clock=Clock())
    assert budget.wait_s() == 0.0
    assert budget.claim() == 0
    assert budget.used() == (1, 1)


# Several real processes hammering one usage file at once. Each claims as
# fast as it can and prints how many of its claims were granted.
_CLAIMER = """
import sys
from providers import CallBudget
path, rpm, tries = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
budget = CallBudget(rpm, 100000, path)
print(sum(1 for _ in range(tries) if budget.claim() == 0))
"""


def _claim_in_processes(path, rpm, processes, tries):
    import subprocess
    import sys

    ai = Path(providers.__file__).resolve().parent
    running = [
        subprocess.Popen([sys.executable, "-c", _CLAIMER, path, str(rpm), str(tries)],
                         cwd=ai, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for _ in range(processes)
    ]
    granted = []
    for p in running:
        out, err = p.communicate(timeout=120)
        assert p.returncode == 0, err
        granted.append(int(out.strip()))
    return granted


def test_no_count_is_lost_when_processes_claim_at_once(tmp_path):
    path = str(tmp_path / "usage.json")
    granted = _claim_in_processes(path, rpm=100000, processes=6, tries=40)

    assert granted == [40] * 6
    assert CallBudget(100000, 100000, path).used() == (240, 240)


def test_processes_together_never_exceed_the_minute(tmp_path):
    path = str(tmp_path / "usage.json")
    granted = _claim_in_processes(path, rpm=15, processes=6, tries=10)

    assert sum(granted) == 15
    assert CallBudget(15, 100000, path).used() == (15, 15)


# ---------------------------------------------------------------- Groq's headers


def test_an_exhausted_groq_header_set_gives_the_plain_message_without_a_call():
    server, clock = Server(groq_ok(headers=groq_headers(tokens=300, reset_tokens="40s"))), Clock()
    provider = groq(server, clock)
    assert provider.generate(SYSTEM, USER).ok

    result = provider.generate(SYSTEM, USER, budget_s=20)

    assert result.outcome == RATE_LIMITED
    assert result.message == PLAIN[RATE_LIMITED]
    assert len(server.requests) == 1


def test_groq_waits_for_the_bucket_when_the_reset_fits():
    server, clock = Server(groq_ok(headers=groq_headers(tokens=300, reset_tokens="7.66s")), groq_ok()), Clock()
    provider = groq(server, clock)
    provider.generate(SYSTEM, USER)

    result = provider.generate(SYSTEM, USER, budget_s=20)

    assert result.ok
    assert clock.slept == [pytest.approx(7.66)]


def test_groq_out_of_requests_for_the_day_is_rate_limited():
    server, clock = Server(groq_ok(headers=groq_headers(tokens=8000, requests=0, reset_requests="3h"))), Clock()
    provider = groq(server, clock)
    provider.generate(SYSTEM, USER)
    result = provider.generate(SYSTEM, USER)
    assert result.outcome == RATE_LIMITED and result.retry_after == pytest.approx(3 * 3600)


def test_groq_will_it_fit_counts_the_whole_output_cap():
    provider = groq(Server(), Clock())
    need = provider.need_tokens(SYSTEM, USER)
    prompt = providers.estimate_tokens(SYSTEM) + providers.estimate_tokens(USER) + providers.GROQ_TEMPLATE_TOKENS
    assert need == prompt + 400

    budget = HeaderBudget(clock=Clock())
    budget.update(httpx.Headers(groq_headers(tokens=need - 1)))
    assert budget.wait_s(need) > 0
    budget.update(httpx.Headers(groq_headers(tokens=need)))
    assert budget.wait_s(need) == 0


@pytest.mark.parametrize("text, seconds", [
    ("7.66s", 7.66), ("2m59.56s", 179.56), ("1h2m3s", 3723.0), ("120ms", 0.12), ("17", 17.0), ("1m", 60.0),
    ("", None), (None, None), ("soon", None),
])
def test_durations(text, seconds):
    assert parse_duration(text) == (pytest.approx(seconds) if seconds is not None else None)


# ---------------------------------------------------------------- unavailable and failed


def test_a_withdrawn_gemini_model_is_unavailable_with_a_clear_log_line(caplog):
    response = httpx.Response(404, json={"error": {"code": 404, "status": "NOT_FOUND",
                                                   "message": "This model is no longer available to new users."}})
    with caplog.at_level(logging.ERROR, logger="copilot.llm"):
        result = gemini(Server(response), Clock()).generate(SYSTEM, USER)

    assert result.outcome == UNAVAILABLE
    assert result.message == PLAIN[UNAVAILABLE]
    assert "gemini-3.5-flash-lite" in caplog.text and "re-check the provider's model list" in caplog.text


def test_a_withdrawn_groq_model_is_unavailable():
    response = httpx.Response(400, json={"error": {"code": "model_decommissioned", "message": "gone"}})
    assert groq(Server(response), Clock()).generate(SYSTEM, USER).outcome == UNAVAILABLE


def test_a_rejected_key_is_unavailable():
    response = httpx.Response(401, json={"error": {"code": "invalid_api_key"}})
    assert groq(Server(response), Clock()).generate(SYSTEM, USER).outcome == UNAVAILABLE


@pytest.mark.parametrize("response, detail", [
    (httpx.Response(503, json={"error": {"status": "UNAVAILABLE", "message": "high demand"}}), "http 503 UNAVAILABLE"),
    (httpx.Response(200, text="not json"), "malformed"),
    (httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}}), "blocked SAFETY"),
    (gemini_ok(finish="SAFETY"), "SAFETY"),
    (gemini_ok(text="   "), "empty"),
])
def test_everything_else_is_failed_not_a_crash(response, detail):
    result = gemini(Server(response), Clock()).generate(SYSTEM, USER)
    assert result.outcome == FAILED
    assert result.detail == detail
    assert result.message == PLAIN[FAILED]


def test_a_timeout_is_failed():
    server = Server(httpx.ReadTimeout("slow"))
    result = groq(server, Clock()).generate(SYSTEM, USER)
    assert result.outcome == FAILED and result.detail == "timeout"


# ---------------------------------------------------------------- what never leaks


def test_the_key_and_the_providers_error_text_never_reach_the_outcome_or_the_log(caplog):
    leaky = httpx.Response(400, json={"error": {"code": f"bad key {KEY}", "message": f"echo: {KEY} {USER}"}})
    with caplog.at_level(logging.DEBUG):
        result = groq(Server(leaky), Clock()).generate(SYSTEM, USER)
        line = log_call(result, prompt_version="test-v1")

    assert result.outcome == FAILED
    for text in (repr(result), result.detail, line, caplog.text, result.message):
        assert KEY not in text
        assert USER not in text
        assert "echo" not in text


def test_the_log_line_has_counts_and_codes_but_no_text(caplog):
    result = Generation(OK, "gemini", "gemini-3.5-flash-lite", text="The secret answer [1].",
                        input_tokens=900, output_tokens=40, latency_ms=812.4, attempts=1)
    with caplog.at_level(logging.INFO, logger="copilot.llm"):
        line = log_call(result, prompt_version="s2-v1", stripped=2)

    assert line == ("llm provider=gemini model=gemini-3.5-flash-lite prompt=s2-v1 outcome=ok attempts=1 "
                    "in=900 out=40 ms=812 stripped=2")
    assert "secret answer" not in caplog.text
    assert "secret answer" not in repr(result)


# ---------------------------------------------------------------- start-up and the fake


def test_a_missing_key_gives_an_unconfigured_provider_not_a_crash(monkeypatch):
    monkeypatch.setattr(providers, "GEMINI_API_KEY", "")
    provider = providers.build_provider("gemini")

    assert isinstance(provider, Unconfigured)
    result = provider.generate(SYSTEM, USER)
    assert result.outcome == NOT_CONFIGURED
    assert result.message == PLAIN[NOT_CONFIGURED]


def test_an_unknown_provider_name_fails_loudly():
    with pytest.raises(ValueError, match="unknown AI_LLM_PROVIDER"):
        providers.build_provider("openai")


def test_the_scripted_provider_replays_and_records():
    fake = ScriptedProvider("first [1]", Generation(RATE_LIMITED, "fake", "scripted"), lambda s, u: f"echo {u}")

    assert fake.generate("sys", "a").text == "first [1]"
    assert fake.generate("sys", "b").outcome == RATE_LIMITED
    assert fake.generate("sys", "c").text == "echo c"
    assert fake.calls == [("sys", "a"), ("sys", "b"), ("sys", "c")]
    with pytest.raises(AssertionError):
        fake.generate("sys", "d")


def test_every_outcome_but_ok_has_a_plain_message():
    assert set(PLAIN) == {RATE_LIMITED, TRUNCATED, UNAVAILABLE, NOT_CONFIGURED, FAILED}
    for message in PLAIN.values():
        assert message.endswith(".") and "429" not in message and "http" not in message.lower()
