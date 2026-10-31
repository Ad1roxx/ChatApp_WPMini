"""What the evaluation corpus turns into, before anything is measured.

    cd ai && .venv/Scripts/python.exe eval/corpus_stats.py

For every attached file: pages, the sections the extractor finds (with their
headings), and the chunks they become. Then the chunks each viewer of
mentorship 1 can see. Extraction and chunking only - nothing is embedded and
nothing is searched, so this describes the corpus without scoring it.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chunking import chunk_document  # noqa: E402
from config import CHUNK_BUDGET_TOKENS  # noqa: E402
from evaluate import fixture  # noqa: E402
from sources import documents  # noqa: E402

M1 = "d00000000000000000000001"
VIEWERS = {"0000000000000000000000a1": "Aditya (student)", "0000000000000000000000b1": "Priya (mentor)"}


def main() -> None:
    _, records = fixture()
    by_mentorship: Counter = Counter()
    visible: Counter = Counter()
    kinds: Counter = Counter()

    print(f"{'file':<28} {'m':>2} {'pages':>5} {'sections':>8} {'chunks':>6}   headings")
    for doc in documents(records):
        pieces = chunk_document(doc, budget=CHUNK_BUDGET_TOKENS)
        mentorship = "M1" if doc["mentorship_id"] == M1 else "M2"
        by_mentorship[mentorship] += len(pieces)
        kinds[(mentorship, "attachment" if doc.get("sections") is not None else doc["source_type"])] += len(pieces)
        if mentorship == "M1":
            for viewer in doc["viewers"]:
                visible[viewer] += len(pieces)
        if doc.get("sections") is None:
            continue
        headings = [s["heading"] for s in doc["sections"]]
        pages = doc.get("page_count", "")
        print(f"{doc['title']:<28} {mentorship[1]:>2} {pages!s:>5} {len(headings):>8} {len(pieces):>6}   {headings}")

    print()
    for (mentorship, kind), n in sorted(kinds.items()):
        print(f"  {mentorship} {kind:<12} {n:>4} chunks")
    print(f"  chunks in all: M1 {by_mentorship['M1']}, M2 {by_mentorship['M2']}")
    for viewer, name in VIEWERS.items():
        print(f"  visible in M1 to {name}: {visible[viewer]}")


if __name__ == "__main__":
    main()
