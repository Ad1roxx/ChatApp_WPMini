"""Can the provider drive the agent? Three calls, synthetic data only.

    cd ai
    AI_LIVE_SMOKE=1 .venv/Scripts/python.exe eval/function_calling_check.py --provider gemini

S4 Step 0 left the agent's provider open: "Gemini drives the agent if its
function-calling check passes, with Groq as a manual setting" (AGENT_PLAN S4).
Groq's check was made then (BUILD_NOTES Entry 93). This is Gemini's, and the same
three calls:

1. **One trivial tool.** A made-up lookup with one argument, through
   `converse()`: does the model call it, with the right argument?
2. **and 3. One agent turn, through the real `agent.run_turn`.** The agent's own
   prompt and the student's real tool list. Express is replaced by a stub that
   answers `list_goals` with an invented goal, and search with nothing. Does the
   model choose `list_goals`, and does its answer name the milestone still to do
   and cite the record's handle, so that verification keeps it?

Nothing here reads any database, and every name, goal and question is invented
(AGENT_PLAN §2.6). The calls count against the same daily allowance as
everything else, so the script refuses unless AI_LIVE_SMOKE=1 is set and three
calls fit. The result is appended to `eval/s4-function-calling.txt`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import agent  # noqa: E402
import providers  # noqa: E402
from config import LLM_USAGE_FILE  # noqa: E402

LOG = HERE / "s4-function-calling.txt"
CALLS = 3
MID, VIEWER = "0000000000000000000000b1", "0000000000000000000000a1"
GOAL = {
    "kind": "goal", "id": "0000000000000000000000c1", "title": "Ready for backend interviews",
    "status": "active", "setBy": "mentor",
    "milestones": [{"title": "Design a rate limiter", "done": True},
                   {"title": "Pass a mock interview", "done": False}],
}
LOOKUP = {
    "name": "get_room_code",
    "description": "The room code of a building on the invented campus, by the building's name.",
    "parameters": {"type": "object", "properties": {"building": {"type": "string"}},
                   "required": ["building"], "additionalProperties": False},
}


class Express:
    """The internal tool endpoint, played: canned answers by tool name."""

    def __init__(self):
        self.requests: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        name = request.url.path.rsplit("/", 1)[-1]
        self.requests.append(name)
        records = [GOAL] if name == "list_goals" else []
        return httpx.Response(200, json={"records": records})


class NoStore:
    def search(self, *_args, **_kwargs):
        return []


def row(label: str, g: providers.Generation, did: str) -> str:
    return (f"  {label:<44} {g.outcome:<4} {g.latency_ms:>6.0f} ms  in {g.input_tokens!s:>5}  "
            f"out {g.output_tokens!s:>4}  {did}")


class Recording:
    """Wraps the provider so each of the turn's calls can be reported."""

    def __init__(self, inner):
        self.inner, self.calls = inner, []
        self.name, self.model = inner.name, inner.model

    def converse(self, system, messages, tools, **kw):
        g = self.inner.converse(system, messages, tools, **kw)
        self.calls.append((g, len(tools)))
        return g


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=("gemini", "groq"), default="gemini")
    args = parser.parse_args()
    if os.getenv("AI_LIVE_SMOKE") != "1":
        raise SystemExit("live provider calls: set AI_LIVE_SMOKE=1 to spend three requests")
    if args.provider == "gemini":
        used = providers.CallBudget(providers.GEMINI_RPM, providers.GEMINI_RPD, LLM_USAGE_FILE).used()[1]
        if used + CALLS > providers.GEMINI_RPD:
            raise SystemExit(f"{used} of {providers.GEMINI_RPD} calls used today: no room for {CALLS}")

    provider = providers.build_provider(args.provider)
    lines = [f"== {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC, {provider.name} {provider.model}, "
             f"agent prompt {agent.PROMPT_VERSION}"]
    passed = []

    # 1. One trivial tool.
    g = provider.converse("You answer questions about an invented campus. Use the tool to look things up.",
                          [{"role": "user", "text": "What is the room code of the Larkspur building?"}], [LOOKUP])
    call = g.calls[0] if g.calls else None
    ok1 = bool(g.ok and call and call[1] == "get_room_code" and isinstance(call[2], dict)
               and "larkspur" in str(call[2].get("building", "")).lower())
    did = f"called {call[1]}({json.dumps(call[2])})" if call else f"no tool call; text {len(g.text)} chars"
    lines.append(row("1. one trivial tool", g, did))
    passed.append(ok1)

    # 2 and 3. One agent turn, through run_turn.
    express = Express()
    recording = Recording(provider)
    turn = agent.Turn(
        mentorship_id=MID, viewer_id=VIEWER, role="student",
        question="Which milestones on my goal are still to do?",
        token="synthetic.capability.token", provider=recording, store=NoStore(),
        express=httpx.Client(base_url="http://127.0.0.1:1", headers={"X-AI-Secret": "synthetic"},
                             transport=httpx.MockTransport(express)),
    )
    result = agent.run_turn(turn)
    for i, (gen, offered) in enumerate(recording.calls, start=2):
        what = (f"chose {', '.join(c[1] for c in gen.calls)}" if gen.calls
                else f"answered, {len(gen.text)} chars")
        lines.append(row(f"{i}. agent step {i - 1}: {offered} tools offered", gen, what))
    answer = result.get("answer") or ""
    cited = [c.get("handle") for c in result.get("citations", [])]
    # Read by hand as well: whether it says the rate limiter is done is in the answer, printed below.
    ok_turn = (express.requests == ["list_goals"] and result.get("status") == "answered"
               and "mock interview" in answer.lower() and bool(cited) and len(recording.calls) == 2)
    lines += [
        f"  turn: status {result.get('status')}, model calls {result.get('modelCalls')}, tool calls "
        f"{result.get('toolCalls')}, tools asked of Express {express.requests}, citations {cited}, "
        f"stripped {result.get('stripped')}",
        f"  answer: {answer or result.get('message')}",
    ]
    passed.append(ok_turn)
    lines.append(f"  {'PASSES' if all(passed) else 'does not pass'} "
                 f"(trivial tool: {'yes' if passed[0] else 'no'}; agent turn: {'yes' if passed[1] else 'no'})")
    lines.append("")
    text = "\n".join(lines)
    print(text)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(text + "\n")


if __name__ == "__main__":
    main()
