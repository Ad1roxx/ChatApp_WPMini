"""Build the search index from application data.

    python ingest.py                     every active mentorship
    python ingest.py --mentorship <id>   just one
    python ingest.py --strategy heading  the other chunker
    python ingest.py --drop              start from empty

Ingestion is idempotent per source: each run deletes that source's chunks
before writing new ones, so running it twice leaves the same index rather than
two copies of everything.
"""

from __future__ import annotations

import argparse
from collections import Counter

from chunking import STRATEGIES
from config import CHUNK_MAX_CHARS, CHUNK_OVERLAP
from sources import documents
from store import ChunkStore


def main() -> None:
    parser = argparse.ArgumentParser(description="Index mentorship material.")
    parser.add_argument("--mentorship", help="only this mentorship id")
    parser.add_argument("--strategy", choices=sorted(STRATEGIES), default="fixed")
    parser.add_argument("--max-chars", type=int, default=CHUNK_MAX_CHARS)
    parser.add_argument("--drop", action="store_true", help="empty the index first")
    args = parser.parse_args()

    store = ChunkStore()
    print("vector index:", store.ensure_vector_index())

    if args.drop:
        store.drop_all()
        print("index emptied")

    split = STRATEGIES[args.strategy]
    counts: Counter[str] = Counter()
    chunk_total = 0

    for doc in documents(store.db, args.mentorship):
        pieces = (
            split(doc["text"], args.max_chars, CHUNK_OVERLAP)
            if args.strategy == "fixed"
            else split(doc["text"], args.max_chars)
        )
        written = store.replace_source(doc, pieces)
        counts[doc["source_type"]] += 1
        chunk_total += written

    if not counts:
        print("nothing to index — is the corpus seeded, and the mentorship active?")
        return

    print(f"\nchunked with: {args.strategy} (max {args.max_chars} chars)")
    for source_type, n in sorted(counts.items()):
        print(f"  {source_type:<12} {n:>3} sources")
    print(f"  {'chunks':<12} {chunk_total:>3} written")


if __name__ == "__main__":
    main()
