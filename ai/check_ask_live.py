"""One live call through the real ask route: Express -> ai/ -> Gemini.

    python check_ask_live.py

Spends ONE Gemini call (plus none for the refusal, which never reaches the
model). Starts the real Express server and the real service, as
`check_freshness.py` does, on a fixture database of its own
(`chatapp_asklive` on each MongoDB) - never `chatapp`, never the served index -
and drives them only through the app's HTTP routes, signed in as fixture users
through the development sign-in:

1. the mentor adds the student and sets a brief, written for this check;
2. once search finds the brief, an outsider asks and must be refused (403);
3. the student asks one question, timed from the request to the response.

The response and the timing are written to `eval/s2-live-ask.txt`. Synthetic
data only. The key is read by the service from ai/.env, as in production.
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import check_freshness as cf

cf.FIXTURE = "chatapp_asklive"  # its own databases, dropped at the end

BRIEF = (
    "Make the payment webhook handler safe to retry. On a failure it should retry five "
    "times with exponential backoff starting at 200 ms, then move the message to the "
    "payments-dlq queue so that nothing is lost. Write up how a duplicate delivery is "
    "recognised."
)
QUESTION = "How many times should the webhook retry, and where does the message go after that?"
OUT = Path(__file__).resolve().parent / "eval" / "s2-live-ask.txt"


def ask(as_user: str, mid: str) -> tuple[int, dict | None, float]:
    started = time.perf_counter()
    status, body = cf.call("POST", f"/api/mentorships/{mid}/copilot/ask", as_user, {"question": QUESTION})
    return status, body, (time.perf_counter() - started) * 1000


def main() -> None:
    cf.seed()
    procs = cf.start()
    lines = [
        "S2 step 4 (Entry 72): one live call through the real ask route, Express -> ai/ -> Gemini.",
        f"run {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}; fixture databases {cf.FIXTURE}; "
        "fixture users signed in through the development sign-in; synthetic brief.",
        "",
    ]
    try:
        _, mentorship = cf.call("POST", "/api/mentorships", cf.MENTOR, {"studentId": cf.STUDENT, "topic": "Webhooks"})
        mid = mentorship["_id"]
        due = datetime.fromtimestamp(time.time() + 7 * 86400, timezone.utc).isoformat()
        cf.call("POST", "/api/assignments", cf.MENTOR,
                {"title": "Payment webhook retries", "instructions": BRIEF, "dueAt": due, "mentorshipIds": [mid]})
        waited, _ = cf.until(lambda: cf.has(cf.STUDENT, mid, "Payment webhook retries"), timeout=120)
        if waited is None:
            raise SystemExit("the brief never became searchable")
        lines.append(f"brief searchable {waited:.2f} s after it was set")

        status, _, ms = ask(cf.OUTSIDER, mid)
        lines.append(f"outsider asks: HTTP {status} in {ms:.0f} ms (expected 403, before the service is called)")
        if status != 403:
            raise SystemExit(f"the outsider was not refused: {status}")

        status, body, ms = ask(cf.STUDENT, mid)
        lines += [
            f"student asks: {QUESTION!r}",
            f"  HTTP {status} in {ms:.0f} ms, from request to response, through Express",
            "  response:",
            *("    " + line for line in json.dumps(body, indent=2, ensure_ascii=False).splitlines()),
        ]
    finally:
        cf.stop(procs)

    log = cf.SERVICE_LOG.read_text(encoding="utf-8", errors="replace").splitlines()
    lines += ["", "service log lines for the turn (no prompt or answer text is ever logged):"]
    lines += ["  " + line for line in log if " llm " in f" {line}" or "copilot prompt=" in line]
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    sys.exit(main())
