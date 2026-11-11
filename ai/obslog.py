"""Structured logs: one JSON line per model call and per tool call (S6 Step 1).

    {"ts": "...", "kind": "model_call", "turn": "3f9a...", "route": "/agent", "provider": "gemini",
     "model": "gemini-3.5-flash-lite", "prompt_version": "agent-v4", "prompt_hash": "...", "tokens_in": 812,
     "tokens_out": 44, "latency_ms": 1210, "outcome": "ok", "attempts": 1}
    {"ts": "...", "kind": "tool_call", "turn": "3f9a...", "route": "/agent", "tool": "list_goals",
     "status": "200", "latency_ms": 38, "refusal_reason": null}

## Metadata only, by construction

No question, answer, source text, name, email, record id or key can reach a line, because a
line is built from a fixed list of fields and each field is checked against what it may hold:
numbers are numbers, and every string must look like a name (letters, digits and `._:/-`, no
spaces, at most 80 characters). A sentence can't pass, and neither can an email (`@`). Anything
that doesn't fit is written as "invalid". The turn id is random, made here, and means nothing
outside these logs. The prompt hash is of the template, never of a filled-in prompt.

## Where

Outside the repository: `AI_LOG_DIR`, or a `logs` folder beside the AI_ENV_FILE file. A folder
inside the repository is refused, so a log can never be committed. Neither set: no file is
written. Files rotate at AI_LOG_MAX_BYTES (5 MB) and AI_LOG_KEEP (7) are kept.
"""

from __future__ import annotations

import contextlib
import contextvars
import hashlib
import json
import logging
import logging.handlers
import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path

LOG_NAME = "copilot.jsonl"
REPO_ROOT = Path(__file__).resolve().parent.parent
_NAME = re.compile(r"^[A-Za-z0-9._:/-]{1,80}$")
ROUTES = frozenset({"/ask", "/agent", "-"})

_route: contextvars.ContextVar[str] = contextvars.ContextVar("obslog_route", default="-")
_turn: contextvars.ContextVar[str] = contextvars.ContextVar("obslog_turn", default="-")
_prompts: dict[str, str] = {}
# Tool names this code defines (registered by agent.py). Anything else is written as "invalid".
_tools: set[str] = {"-"}

_logger = logging.getLogger("copilot.structured")
_logger.propagate = False  # never to the console handlers, which a person reads
_logger.setLevel(logging.INFO)


def _name(value) -> str | None:
    if value is None:
        return None
    value = str(value)
    return value if _NAME.fullmatch(value) else "invalid"


def _count(value) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = round(float(value))
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def prompt_hash(template: str) -> str:
    return hashlib.sha256(template.encode("utf-8")).hexdigest()[:16]


def register_prompts(templates: dict[str, str]) -> None:
    """Prompt version -> its template's hash. Templates, never filled prompts."""
    for version, template in templates.items():
        _prompts[version] = prompt_hash(template)


def register_tools(names) -> None:
    _tools.update(names)


def _inside_repo(path: Path) -> bool:
    path = path.resolve()
    return path == REPO_ROOT or REPO_ROOT in path.parents


def log_directory(env=os.environ) -> Path | None:
    """Where logs go, or None. Never inside the repository."""
    named = str(env.get("AI_LOG_DIR", "")).strip()
    if not named:
        secrets_file = str(env.get("AI_ENV_FILE", "")).strip()
        if not secrets_file:
            return None
        named = str(Path(secrets_file).parent / "logs")
    directory = Path(named).resolve()
    return None if _inside_repo(directory) else directory


def configure(directory: Path | None = None, *, max_bytes: int | None = None, keep: int | None = None) -> Path | None:
    """Point the log at a file and rotate it. Returns the file, or None when logging to a file is off."""
    for handler in list(_logger.handlers):
        _logger.removeHandler(handler)
        handler.close()
    directory = directory if directory is not None else log_directory()
    if directory is None:
        return None
    directory = Path(directory).resolve()
    if _inside_repo(directory):
        return None
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / LOG_NAME
    # The file itself, or a rotated copy, must not lead back into the repository through a link.
    if any(p.is_symlink() or _inside_repo(p) for p in [path, *directory.glob(LOG_NAME + ".*")]):
        return None
    handler = logging.handlers.RotatingFileHandler(
        path, maxBytes=max_bytes or int(os.getenv("AI_LOG_MAX_BYTES", str(5 * 1024 * 1024))),
        backupCount=keep or int(os.getenv("AI_LOG_KEEP", "7")), encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(message)s"))
    _logger.addHandler(handler)
    return path


@contextlib.contextmanager
def turn(route: str):
    """One request's context: its route, and a fresh random turn id for every line it writes."""
    route_token = _route.set(route if route in ROUTES else "-")
    turn_token = _turn.set(secrets.token_hex(8))
    try:
        yield _turn.get()
    finally:
        _route.reset(route_token)
        _turn.reset(turn_token)


def _emit(kind: str, fields: dict) -> dict:
    line = {"ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), "kind": kind, "turn": _turn.get(), "route": _route.get(), **fields}
    if _logger.handlers:
        _logger.info(json.dumps(line, ensure_ascii=True))
    return line


def model_call(generation, *, prompt_version: str) -> dict:
    """One line for one provider call. Reads only the fields named here, never text or detail."""
    g = generation
    return _emit("model_call", {
        "provider": _name(g.provider), "model": _name(g.model), "prompt_version": _name(prompt_version),
        "prompt_hash": _prompts.get(prompt_version), "tokens_in": _count(g.input_tokens), "tokens_out": _count(g.output_tokens),
        "latency_ms": _count(g.latency_ms), "outcome": _name(g.outcome), "attempts": _count(g.attempts),
    })


def tool_call(*, tool, status, latency_ms=None) -> dict:
    """One line for one tool call. A status other than 200 is the refusal reason."""
    status = _name(status)
    tool = str(tool) if str(tool) in _tools else "invalid"
    return _emit("tool_call", {"tool": tool, "status": status, "latency_ms": _count(latency_ms),
                               "refusal_reason": None if status == "200" else status})


class ToolSteps(list):
    """A turn's steps, as the agent keeps them: each one appended is also one log line."""

    def append(self, step: dict) -> None:
        super().append(step)
        tool_call(tool=step.get("tool"), status=step.get("status"), latency_ms=step.get("ms"))
