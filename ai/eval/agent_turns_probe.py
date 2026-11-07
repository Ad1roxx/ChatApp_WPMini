"""How long does an agent turn take, end to end? Real turns on the demo, through Express.

    npm run demo -- --agent        # in another terminal, and wait for it to be ready
    cd ai
    AI_LIVE_SMOKE=1 .venv/Scripts/python.exe eval/agent_turns_probe.py

S4 Step 5 sets the agent's timeouts from measurement, as Entry 67 set S2's: the
turn's own budget (ai/config.py AGENT_BUDGET_S), Express's wait for a turn
(COPILOT_AGENT_TIMEOUT_MS) and the browser's (src/lib/copilot.js). Each turn here
goes the whole way the panel's does: Express's agent route as the demo's invented
student or mentor (the dev sign-in), the capability token, the AI service, the
model, the tools back through Express.

The questions are the panel's ten from Entry 92, plus two that exercise the
record tools and a file summary. Everything is the demo's invented data
(`chatapp_demo`): the script refuses unless the demo's Express says the agent
can run, which it does only on a synthetic database. Each turn is one to eleven
model calls, so it also refuses without AI_LIVE_SMOKE=1, and stops if the day's
allowance would not cover the worst case of what is left. Appended to
`eval/s4-agent-latency.txt`.
"""

from __future__ import annotations

import json
import os
import statistics
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import providers  # noqa: E402
from config import LLM_USAGE_FILE  # noqa: E402

API = os.getenv("DEMO_API", "http://127.0.0.1:3101")
LOG = HERE / "s4-agent-latency.txt"
MEERA, ROHAN = "00000000000000000000d001", "00000000000000000000d002"
WORST_TURN = 11
# Longer than any timeout under test, so the probe measures the turn, not itself.
CLIENT_WAIT_S = 120

QUESTIONS = [
    (ROHAN, "Which algorithm did I choose for my rate limiter, and why?"),
    (ROHAN, "What does Meera want me to change in my rate limiter design?"),
    (ROHAN, "What caused the lunch-rush outage?"),
    (ROHAN, "How long does the server remember an idempotency key?"),
    (ROHAN, "What is the canteen's refund policy?"),
    (MEERA, "How did Rohan test his rate limiter, and what were the results?"),
    (MEERA, "What is still open in Rohan's rate limiter design?"),
    (MEERA, "What action items came out of the postmortem?"),
    (MEERA, "Which milestones on Rohan's goal are still to do?"),
    (MEERA, "What did Ananya find in the hostel survey?"),
    # The record tools and a file summary: the longest kinds of turn.
    (ROHAN, "Which of my hand-ins are late or still waiting for a review?"),
    (MEERA, "Summarise Rohan's rate-limiter-design.pdf."),
]


def call(path: str, as_user: str, body: dict | None = None) -> tuple[int, dict | None, float]:
    request = urllib.request.Request(
        API + path, method="POST" if body is not None else "GET",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"X-Dev-User-Id": as_user, "Content-Type": "application/json"},
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=CLIENT_WAIT_S) as res:
            status, raw = res.status, res.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    ms = (time.perf_counter() - started) * 1000
    try:
        return status, json.loads(raw), ms
    except ValueError:
        return status, None, ms


def main() -> None:
    if os.getenv("AI_LIVE_SMOKE") != "1":
        raise SystemExit("live provider calls: set AI_LIVE_SMOKE=1 to spend up to "
                         f"{WORST_TURN * len(QUESTIONS)} requests")
    _, mode, _ = call("/api/copilot/mode", ROHAN)
    if (mode or {}).get("mode") != "agent":
        raise SystemExit("the demo's Express does not offer the agent: start it with `npm run demo -- --agent`")
    status, mentorships, _ = call("/api/mentorships", ROHAN)
    active = [m for m in mentorships or [] if m.get("status") == "active"]
    if status != 200 or len(active) != 1:
        raise SystemExit("expected Rohan to have exactly one active mentorship in the demo")
    mid = active[0]["_id"]
    budget = providers.CallBudget(providers.GEMINI_RPM, providers.GEMINI_RPD, LLM_USAGE_FILE)

    rows, times = [], []
    for as_user, question in QUESTIONS:
        if budget.used()[1] + WORST_TURN > providers.GEMINI_RPD:
            rows.append("  stopped: the day's allowance would not cover another turn's worst case")
            break
        status, body, ms = call(f"/api/mentorships/{mid}/copilot/agent", as_user, {"question": question})
        body = body or {}
        who = "student" if as_user == ROHAN else "mentor "
        if status == 429 and "minute" in str(body.get("error", "")):
            time.sleep(60)  # this person's share per minute: wait it out, and ask again
            status, body, ms = call(f"/api/mentorships/{mid}/copilot/agent", as_user, {"question": question})
            body = body or {}
        if status == 200:
            times.append(ms)
        rows.append(
            f"  {who} {ms:>7.0f} ms  {status} {body.get('status', body.get('error', '-'))!s:<12.12} "
            f"model {body.get('modelCalls', '-')!s:>2}  tools {body.get('toolCalls', '-')!s:>1}  "
            f"summary {body.get('summaryCalls', '-')!s:>1}  {body.get('cause') or ''}  {question}"
        )
        print(rows[-1], flush=True)
        time.sleep(5)  # well inside 12 calls a minute for each person

    stamp = datetime.now(timezone.utc)
    ist = stamp + timedelta(hours=5, minutes=30)
    lines = [f"== {stamp:%Y-%m-%d %H:%M} UTC ({ist:%H:%M} IST), {len(rows)} turns through the demo's Express", *rows]
    if times:
        ordered = sorted(times)
        lines.append(f"  answered or declined (200): {len(times)}; median {statistics.median(times):.0f} ms, "
                     f"slowest {ordered[-1]:.0f} ms")
    lines.append("")
    with LOG.open("a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines[-2:]))


if __name__ == "__main__":
    main()
