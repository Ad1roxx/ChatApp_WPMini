"""PDF headings by type size, on and off, in the served configuration.

    cd ai && .venv/Scripts/python.exe eval/heading_ablation.py

S2 step 1 (BUILD_NOTES Entry 61). The fixture's reports now look like real
ones - unnumbered headings set larger than the body - so with the size rule
off each of them is one section called "Document", and with it on each is
split at its headings. Same questions, same labels, same served search
(bge-small, dense, soft cap, k=4, read-time check); only
`extract.HEADING_SIZE_RATIO` changes, and the index is rebuilt for each,
because what changes is the chunks.

Records are scored on both label sets: the six clear-cut changes every quoted
figure uses, and all eight (what `evaluate.py` reads).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import extract  # noqa: E402
from config import CHUNK_BUDGET_TOKENS  # noqa: E402
from evaluate import build_index, by_group, fixture, load_questions  # noqa: E402
from prefix_ablation import quoted_labels, score  # noqa: E402

ON = extract.HEADING_SIZE_RATIO
OFF = float("inf")


def sections_found(chunk_store) -> int:
    """Distinct (file, heading) pairs among the PDF chunks in the index."""
    pairs = {
        (c["title"], c.get("heading"))
        for c in chunk_store.chunks.find({"title": {"$regex": r"\.pdf$"}}, {"title": 1, "heading": 1})
    }
    return len(pairs)


def main() -> None:
    chunk_store, records = fixture()
    chunk_store.ensure_vector_index()

    groups = by_group(load_questions())
    sets = {
        "records (six labels)": quoted_labels(groups["records"]),
        "records (all eight)": groups["records"],
        "documents": groups["documents"],
    }

    print("served configuration: bge-small dense, soft cap, k=4")
    print(f"  {'size rule':<10} {'chunks':>6} {'pdf sections':>12}   {'group':<21} {'recall@1':>13} {'recall@3':>13} {'MRR':>7}")
    for label, ratio in (("off", OFF), ("on", ON)):
        extract.HEADING_SIZE_RATIO = ratio
        chunks = build_index(chunk_store, records, CHUNK_BUDGET_TOKENS)
        found = sections_found(chunk_store)
        for group, questions in sets.items():
            r = score(chunk_store, questions)
            n = r["answerable"]
            at1, at3 = round(r["recall@1"] * n), round(r["recall@3"] * n)
            print(
                f"  {label:<10} {chunks:>6} {found:>12}   {group:<21} "
                f"{r['recall@1']:>5.2f} ({at1:>2}/{n}) {r['recall@3']:>5.2f} ({at3:>2}/{n}) {r['mrr']:>7.3f}"
            )
    extract.HEADING_SIZE_RATIO = ON


if __name__ == "__main__":
    main()
