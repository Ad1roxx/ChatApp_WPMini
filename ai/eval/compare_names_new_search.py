"""s2-v3 against s2-v4 (names), on fresh runs made on the new search. No calls.

    cd ai && .venv/Scripts/python.exe eval/compare_names_new_search.py

BUILD_NOTES Entry 92. The rule is Entry 76's, unchanged, and so is the code that
applies it (`compare_names_fresh.py`); only the runs it reads differ. Runs 5 and 6
of each version, with contextual headers and names as roles on (Entries 85-90) and
the reranker on. Every s2-v4 run made on the old search, runs 1 to 4, is left out,
so that only one thing changes between this decision and the last.

The injection check is made again after s2-v4's runs 5 and 6, and kept as
`s2-injection-s2-v4-new-search.txt`; an older file says nothing about these runs.
As before, s2-v3's runs are spent only if s2-v4 meets every other condition.

Writes `eval/s2-v4-new-search-decision.txt`.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import compare_names_fresh as fresh  # noqa: E402
import evaluate_answers as ea  # noqa: E402
from compare_names import injection  # noqa: E402

fresh.V4 = (("s2-v4", 5), ("s2-v4", 6))
fresh.V3 = (("s2-v3", 5), ("s2-v3", 6))
fresh.OUT = HERE / "s2-v4-new-search-decision.txt"
REPORT = HERE / "s2-injection-s2-v4-new-search.txt"


def probes_after_the_runs(provider) -> list[tuple[int, int]]:
    """The injection results, only if that check ran after s2-v4's last run here."""
    ea.VERSION, ea.RUN, ea.RERANK_ON = fresh.V4[-1][0], fresh.V4[-1][1], True
    last_run = ea.cache_path(provider)
    if not REPORT.exists() or not last_run.exists() or REPORT.stat().st_mtime < last_run.stat().st_mtime:
        return []
    return injection("s2-v4-new-search")


fresh.fresh_probes = probes_after_the_runs

if __name__ == "__main__":
    text = fresh.main()
    first, _, rest = text.partition("\n")
    text = "s2-v3 against s2-v4 on fresh runs on the new search (runs 5, 6), reranker on - BUILD_NOTES Entry 92.\n" + rest
    fresh.OUT.write_text(text, encoding="utf-8")
