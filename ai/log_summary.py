"""Summarise the structured log (S6 Step 1). Counts and timings only: the log holds nothing else.

    cd ai
    .venv/Scripts/python.exe log_summary.py                   # the configured log folder
    .venv/Scripts/python.exe log_summary.py path/to/folder    # another folder
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import Counter
from pathlib import Path


def lines_in(folder: Path) -> list[dict]:
    """Every line of the current file and its rotated copies. A line that isn't JSON is counted, not read."""
    out = []
    for path in sorted(folder.glob("copilot.jsonl*")):
        for raw in path.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(raw))
            except json.JSONDecodeError:
                out.append({"kind": "unreadable"})
    return out


def percentile(values: list[int], p: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int(round(p * len(ordered))) - 1))]


def summarise(lines: list[dict]) -> dict:
    models = [l for l in lines if l.get("kind") == "model_call"]
    tools = [l for l in lines if l.get("kind") == "tool_call"]
    latency = [l["latency_ms"] for l in models if isinstance(l.get("latency_ms"), int)]
    return {
        "lines": len(lines),
        "unreadable": sum(1 for l in lines if l.get("kind") == "unreadable"),
        "turns": len({l.get("turn") for l in lines if l.get("turn") not in (None, "-")}),
        "model_calls": len(models),
        "model_calls_by": dict(Counter(f"{l.get('route')} {l.get('provider')}/{l.get('model')} {l.get('prompt_version')}" for l in models)),
        "outcomes": dict(Counter(l.get("outcome") for l in models)),
        "tokens_in": sum(l.get("tokens_in") or 0 for l in models),
        "tokens_out": sum(l.get("tokens_out") or 0 for l in models),
        "latency_ms_median": int(statistics.median(latency)) if latency else None,
        "latency_ms_p95": percentile(latency, 0.95),
        "tool_calls": len(tools),
        "tool_calls_by": dict(Counter(l.get("tool") for l in tools)),
        "refusals": dict(Counter(l.get("refusal_reason") for l in tools if l.get("refusal_reason"))),
    }


def main(argv: list[str]) -> None:
    if len(argv) > 1:
        folder = Path(argv[1])
    else:
        import obslog

        folder = obslog.log_directory()
        if folder is None:
            raise SystemExit("no log folder: set AI_LOG_DIR, or AI_ENV_FILE")
    print(json.dumps(summarise(lines_in(folder)), indent=1))


if __name__ == "__main__":
    main(sys.argv)
