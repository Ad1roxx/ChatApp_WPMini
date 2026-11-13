"""S8: verdict replies against the output cap, a dry run from the saved runs (BUILD_NOTES Entry 145). No API call.

    .venv/Scripts/python.exe eval/s8_cutoff_dryrun.py

Every verdict the model gave in the four saved S8 runs is put back into the
batches `coverage.assess` makes, at 5 a call (before) and at 3 (after), and
each batch's reply is rebuilt in the verdict schema and sized two ways: three
characters a token (`providers.estimate_tokens`, deliberately high) and four
(nearer English prose). A batch over the cap would have been cut off. After the
fix, a batch cut off is asked again half at a time, so what still fails is a
single verdict over the cap. Verdicts lost to a failed call have no text to
replay; their batches are listed apart.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from config import LLM_MAX_OUTPUT_TOKENS  # noqa: E402

RUNS = ["s8-run1.json", "s8-run2.json", "s8-x2-run1.json", "s8-x2-run2.json"]
SIZERS = {"3 chars a token": 3, "4 chars a token": 4}


def reply(verdicts: list[dict]) -> str:
    return json.dumps({"verdicts": [
        {"criterion_id": v["criterionId"], "verdict": v["verdict"], "present": v.get("present", ""), "absent": v.get("absent", ""),
         "reason": v.get("reason"), "evidence": [e["handle"] for e in v.get("evidence") or []],
         "suggested_marks": v.get("suggestedMarks")} for v in verdicts]})


def tokens(text: str, chars: int) -> int:
    return -(-len(text) // chars)


def judged(state: dict) -> list[list[dict]]:
    """Each case's verdicts as they were sent for judging: in order, set-aside ones left out."""
    return [[v for v in out["result"]["verdicts"] if v.get("reason") != "set_aside"]
            for out in state.values() if out["result"].get("verdicts")]


def main() -> None:
    cases = []
    for name in RUNS:
        cases += judged(json.loads((HERE / name).read_text(encoding="utf-8")))
    print(f"S8 verdict replies against the output cap ({LLM_MAX_OUTPUT_TOKENS} tokens): a dry run over {len(RUNS)} saved runs, "
          f"{len(cases)} assessed cases.")
    for size in (5, 3):
        replayable, lost = 0, 0
        over = {k: 0 for k in SIZERS}
        for verdicts in cases:
            for i in range(0, len(verdicts), size):
                batch = verdicts[i:i + size]
                if any(v.get("reason") == "no_verdict" for v in batch):
                    lost += 1
                    continue
                replayable += 1
                for k, chars in SIZERS.items():
                    over[k] += tokens(reply(batch), chars) > LLM_MAX_OUTPUT_TOKENS
        shown = "; ".join(f"{k}: {n}/{replayable} over the cap" for k, n in over.items())
        print(f"  {size} a call: {replayable} batches replayable, {lost} with a verdict lost to a failed call. {shown}")
    singles = [v for verdicts in cases for v in verdicts if v.get("reason") != "no_verdict"]
    worst = {k: max(tokens(reply([v]), chars) for v in singles) for k, chars in SIZERS.items()}
    print(f"  after the split, only a single verdict over the cap still fails: the largest of {len(singles)} is "
          + ", ".join(f"{n} tokens at {k}" for k, n in worst.items()) + ".")


if __name__ == "__main__":
    main()
