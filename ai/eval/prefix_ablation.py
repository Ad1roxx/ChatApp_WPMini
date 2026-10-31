"""The BGE query prefix, on and off, in the served configuration.

    cd ai && .venv/Scripts/python.exe eval/prefix_ablation.py

Entry 47 kept bge-small's query instruction ("Represent this sentence for
searching relevant passages: ") although its only measurement went against it
- 0.81 recall@1 without, 0.74 with, on a corpus that had no documents yet - and
deferred the decision to step 8, which never made it. This makes it.

Exactly what is served: bge-small, dense, the soft cap, k=4, the read-time
check. The records questions are scored on the six clear-cut label changes
(Entry 51), the set every quoted figure uses. The prefix touches only the query
vector, so one index serves both runs; only `store.QUERY_INSTRUCTION` changes.
"""

from __future__ import annotations

import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import store  # noqa: E402
from config import CHUNK_BUDGET_TOKENS, QUERY_INSTRUCTION, SERVED_K  # noqa: E402
from evaluate import ADITYA, M1, build_index, by_group, fixture, load_questions  # noqa: E402

# Entry 51: two of the eight widened labels are judgment calls, and every
# quoted figure leaves them out.
BORDERLINE = ("idx-07", "cache-03")


def quoted_labels(questions: list[dict]) -> list[dict]:
    return [
        dict(q, expected=[e for e in q["expected"] if not (q["id"] in BORDERLINE and e.endswith((".pdf", ".docx")))])
        for q in questions
    ]


def score(chunk_store, questions: list[dict]) -> dict:
    """recall@1, recall@3, MRR over the k results served, and separation."""
    first_ranks, answerable_top, unanswerable_top = [], [], []
    for q in questions:
        hits = chunk_store.search(M1, ADITYA, q["question"], k=SERVED_K, rerank=False, diversity="soft_cap")
        top = hits[0]["score"] if hits else 0.0
        if not q["answerable"]:
            unanswerable_top.append(top)
            continue
        answerable_top.append(top)
        ranks = [i + 1 for i, h in enumerate(hits) if h["title"] in q["expected"]]
        first_ranks.append(min(ranks) if ranks else None)

    n = len(first_ranks)
    return {
        "recall@1": sum(1 for r in first_ranks if r == 1) / n,
        "recall@3": sum(1 for r in first_ranks if r and r <= 3) / n,
        "mrr": sum(1 / r for r in first_ranks if r) / n,
        "separation": min(answerable_top) - max(unanswerable_top),
        "answerable": n,
        "unanswerable": len(unanswerable_top),
        "median_top": statistics.median(answerable_top),
    }


def main() -> None:
    chunk_store, records = fixture()
    chunk_store.ensure_vector_index()
    chunks = build_index(chunk_store, records, CHUNK_BUDGET_TOKENS)

    groups = by_group(load_questions())
    sets = {"records": quoted_labels(groups["records"]), "documents": groups["documents"]}

    print(f"served configuration: bge-small dense, soft cap, k={SERVED_K}; {chunks} chunks")
    print("records scored on the six clear-cut label changes (Entry 51)\n")
    print(f"  {'group':<10} {'query prefix':<13} {'recall@1':>8} {'recall@3':>8} {'MRR':>7} {'separation':>11}")

    for label, instruction in (("on", QUERY_INSTRUCTION), ("off", "")):
        store.QUERY_INSTRUCTION = instruction
        for group, questions in sets.items():
            r = score(chunk_store, questions)
            print(
                f"  {group:<10} {label:<13} {r['recall@1']:>8.2f} {r['recall@3']:>8.2f} "
                f"{r['mrr']:>7.3f} {r['separation']:>+11.3f}"
            )
    store.QUERY_INSTRUCTION = QUERY_INSTRUCTION


if __name__ == "__main__":
    main()
