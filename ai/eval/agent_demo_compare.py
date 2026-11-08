"""The demo's questions through the agent and through the S2 path, side by side.

    npm run demo -- --agent        # in another terminal, and wait for it to be ready
    cd ai
    AI_LIVE_SMOKE=1 .venv/Scripts/python.exe eval/agent_demo_compare.py

S4 Step 6. The nine S3 demo questions in the mentorship they belong to (the panel's
ten from Entry 92, without the hostel survey question, which `demo-check.mjs` asks in
the wrong mentorship on purpose). Each goes through Express's two real routes as the
demo's invented student or mentor. Saved to `s4-demo-compare.json`, and written out
for reading in `s4-demo-compare.txt`. Answers are not scored: that is S6's job.
"""

from __future__ import annotations

import json
import os
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from agent_turns_probe import QUESTIONS, ROHAN, call  # noqa: E402

JSON_OUT = HERE / "s4-demo-compare.json"
TEXT_OUT = HERE / "s4-demo-compare.txt"
NINE = [q for q in QUESTIONS[:10] if "hostel survey" not in q[1]]
# The ask route allows five a minute for each person.
ASK_GAP_S = 13


def main() -> None:
    if os.getenv("AI_LIVE_SMOKE") != "1":
        raise SystemExit("live provider calls: set AI_LIVE_SMOKE=1")
    if len(NINE) != 9:
        raise SystemExit(f"expected nine questions, found {len(NINE)}")
    _, mode, _ = call("/api/copilot/mode", ROHAN)
    if (mode or {}).get("mode") != "agent":
        raise SystemExit("start the demo with `npm run demo -- --agent`")
    _, mentorships, _ = call("/api/mentorships", ROHAN)
    mid = next(m["_id"] for m in mentorships if m.get("status") == "active")

    rows = []
    for who, question in NINE:
        row = {"as": "student" if who == ROHAN else "mentor", "question": question}
        for route in ("ask", "agent"):
            path = f"/api/mentorships/{mid}/copilot/{route}"
            status, body, ms = call(path, who, {"question": question})
            first_failure = None
            if status == 429:  # our own per-person limit, not the provider: wait it out
                time.sleep(61)
                status, body, ms = call(path, who, {"question": question})
            if status in (502, 503):  # the provider: once more, and say that it happened
                first_failure = f"{status} after {round(ms)} ms"
                time.sleep(30)
                status, body, ms = call(path, who, {"question": question})
            body = body or {}
            row[route] = {
                "first_failure": first_failure, "http": status, "status": body.get("status"), "cause": body.get("cause"), "ms": round(ms),
                "answer": body.get("answer"), "error": body.get("error"), "promptVersion": body.get("promptVersion"),
                "citations": [c.get("title") for c in body.get("citations", [])],
                "modelCalls": body.get("modelCalls", 1 if route == "ask" and status == 200 else None),
                "toolCalls": body.get("toolCalls"), "summaryCalls": body.get("summaryCalls"),
            }
            time.sleep(ASK_GAP_S if route == "ask" else 5)
        rows.append(row)
        print(row["as"], "|", row["ask"]["status"], row["ask"]["ms"], "|", row["agent"]["status"], row["agent"]["ms"], "|", question, flush=True)

    JSON_OUT.write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    lines = ["The nine S3 demo questions: the S2 path against the agent, through Express, on chatapp_demo. Not scored.", ""]
    for r in rows:
        lines.append(f"[{r['as']}] {r['question']}")
        for route, name in (("ask", f"S2 ({r['ask'].get('promptVersion')})"), ("agent", "agent")):
            x = r[route]
            lines.append(f"  {name}: {x['status'] or x['error']}{' / ' + x['cause'] if x['cause'] else ''}, {x['ms']} ms"
                         f"{', ' + str(x['modelCalls']) + ' model calls' if x['modelCalls'] is not None else ''}"
                         f"{'  (first try failed: ' + x['first_failure'] + ')' if x['first_failure'] else ''}")
            lines.append(f"    {x['answer'] or '-'}")
        lines.append("")
    count = lambda route, s: sum(1 for r in rows if r[route]["status"] == s)  # noqa: E731
    ms = lambda route: statistics.median(r[route]["ms"] for r in rows)  # noqa: E731
    failed_first = lambda route: sum(1 for r in rows if r[route]["first_failure"])  # noqa: E731
    calls = sum((r["agent"]["modelCalls"] or 0) + (r["agent"]["summaryCalls"] or 0) for r in rows)
    lines += [
        f"S2:    answered {count('ask', 'answered')}/9, declined {count('ask', 'abstained')}/9, median {ms('ask'):.0f} ms, {failed_first('ask')} needed a retry (model calls: not counted by this route)",
        f"agent: answered {count('agent', 'answered')}/9, declined {count('agent', 'abstained')}/9, median {ms('agent'):.0f} ms, {calls} model calls, {failed_first('agent')} needed a retry",
    ]
    TEXT_OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[-2:]))


if __name__ == "__main__":
    main()
