"""Gemini's latency across a day, before any timeout changes.

    cd ai && .venv/Scripts/python.exe eval/latency_probe.py            # 48 calls, one every 30 minutes
    cd ai && .venv/Scripts/python.exe eval/latency_probe.py --report   # no calls

One real call each time, the size of a real turn: the serving prompt over four invented
sources. The budget is 30 s rather than the served 8 s, so a slow call is timed instead of
cut off, and the report counts how many would have missed 8 s.

Spends at most one call per sample, through the shared daily counter. A sample with no room
in the counter is recorded as `no_room` and spends nothing. Records times, outcomes and token
counts, never text, in the ignored `eval/.cache/gemini-latency.jsonl`, and appends as it goes, so a machine that
sleeps leaves a gap to see rather than a run to lose.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import providers  # noqa: E402
from answer import PROMPT_VERSION, build_prompt, system_prompt  # noqa: E402
from config import ASK_BUDGET_S  # noqa: E402

DATA = HERE / ".cache" / "gemini-latency.jsonl"
REPORT = HERE / "gemini-latency.txt"
IST = timezone(timedelta(hours=5, minutes=30))
SAMPLES = 48
INTERVAL_S = 30 * 60
PROBE_BUDGET_S = 30.0

# Invented, and about the size of the chunks a real turn sends.
PASSAGE = (
    "The queue service retries a failed delivery five times, waiting a random time between attempts so that "
    "a burst of failures does not return as a burst of retries. After the fifth failure the event goes to a "
    "holding table and an operator is told. Each processed event id is kept for seven days, which is longer "
    "than the longest possible retry sequence, so a late duplicate is still recognised and dropped. "
) * 4
HITS = [{"sourceType": "resource", "title": f"Note {n}", "content": PASSAGE} for n in range(1, 5)]
QUESTION = "How many times does the queue service retry, and what happens after the last failure?"


def sample(provider) -> dict:
    row = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    if provider.budget.wait_s() > 0:
        return {**row, "outcome": "no_room"}
    result = provider.generate(system_prompt("student", PROMPT_VERSION), build_prompt(QUESTION, HITS, "probe"), budget_s=PROBE_BUDGET_S)
    return {**row, "outcome": result.outcome, "detail": result.detail, "ms": round(result.latency_ms), "attempts": result.attempts,
            "tokens_in": result.input_tokens, "tokens_out": result.output_tokens}


def percentile(values: list[int], p: float) -> int:
    return sorted(values)[min(len(values) - 1, int(p * len(values)))]


def report() -> str:
    rows = [json.loads(line) for line in DATA.read_text(encoding="utf-8").splitlines() if line.strip()]
    timed = [r for r in rows if r["outcome"] != "no_room"]
    ok = [r["ms"] for r in timed if r["outcome"] == "ok"]
    out = ["Gemini latency across a day - one call every 30 minutes, the size of a real turn, 30 s budget.", ""]
    if rows:
        out.append(f"  from {rows[0]['at']} to {rows[-1]['at']} (UTC)")
    out.append(f"  samples {len(rows)}: called {len(timed)}, no room in the counter {len(rows) - len(timed)}")
    outcomes = defaultdict(int)
    for r in timed:
        outcomes[f"{r['outcome']} {r.get('detail') or ''}".strip()] += 1
    out.append("  outcomes: " + (", ".join(f"{k} {v}" for k, v in sorted(outcomes.items())) or "-"))
    if ok:
        out.append(f"  ok calls, ms: median {statistics.median(ok):.0f}, p90 {percentile(ok, 0.9)}, p95 {percentile(ok, 0.95)}, slowest {max(ok)}")
    over = [r for r in timed if r.get("ms", 0) > ASK_BUDGET_S * 1000]
    out.append(f"  would have missed the served {ASK_BUDGET_S:.0f} s budget: {len(over)} of {len(timed)}")
    out += ["", "  by hour, IST:   calls   median ms   slowest ms"]
    hours = defaultdict(list)
    for r in timed:
        if r["outcome"] == "ok":
            hours[datetime.fromisoformat(r["at"]).astimezone(IST).hour].append(r["ms"])
    for hour in sorted(hours):
        out.append(f"  {hour:02d}:00          {len(hours[hour]):>5}   {statistics.median(hours[hour]):>9.0f}   {max(hours[hour]):>10}")
    text = "\n".join(out) + "\n"
    REPORT.write_text(text, encoding="utf-8")
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--report", action="store_true", help="write the report from what is recorded; no calls")
    parser.add_argument("--samples", type=int, default=SAMPLES)
    parser.add_argument("--interval", type=int, default=INTERVAL_S, help="seconds between samples")
    args = parser.parse_args()
    if args.report:
        print(report())
        return
    DATA.parent.mkdir(exist_ok=True)
    provider = providers.build_provider("gemini")
    for n in range(args.samples):
        if n:
            time.sleep(args.interval)
        row = sample(provider)
        with DATA.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
    report()


if __name__ == "__main__":
    main()
