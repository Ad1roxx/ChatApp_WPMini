"""Build the search index from application data.

    python ingest.py                     every active mentorship
    python ingest.py --mentorship <id>   just one
    python ingest.py --budget 256        a smaller token budget
    python ingest.py --drop              start from empty

Ingestion is idempotent per source: each run deletes that source's chunks
before writing new ones, so running it twice leaves the same index rather than
two copies of everything.

It also *reconciles*. Replacing a source cannot delete the chunks of a source
that no longer exists at all - a removed attachment, a deleted hand-in, an
ended mentorship - so at the end of a run anything that was not seen is
deleted. A full run reconciles the whole index; a run scoped to one mentorship
reconciles only inside it, because it only looked there.
"""

from __future__ import annotations

import argparse
from collections import Counter

from chunking import chunk_document, effective_budget
from config import CHUNK_BUDGET_TOKENS
from sources import documents
from store import ChunkStore


def main() -> None:
    parser = argparse.ArgumentParser(description="Index mentorship material.")
    parser.add_argument("--mentorship", help="only this mentorship id")
    parser.add_argument("--budget", type=int, default=CHUNK_BUDGET_TOKENS,
                        help="chunk budget, in the embedding model's own tokens")
    parser.add_argument("--drop", action="store_true", help="empty the index first")
    args = parser.parse_args()

    store = ChunkStore()
    print("vector index:", store.ensure_vector_index())

    if args.drop:
        store.drop_all()
        print("index emptied")

    counts: Counter[str] = Counter()
    chunk_total = 0
    seen: set[tuple[str, str, str]] = set()

    for doc in documents(store.db, args.mentorship):
        pieces = chunk_document(doc, budget=args.budget)
        written = store.replace_source(doc, pieces)
        counts[doc["source_type"]] += 1
        chunk_total += written
        # Recorded even when it produced no chunks: a brief emptied to nothing
        # still exists, and reconciliation must not treat it as deleted. Keyed
        # by mentorship as well, because one assignment set to two mentorships
        # is one source in each of them under the same id.
        seen.add((doc["mentorship_id"], doc["source_type"], doc["source_id"]))

    if not counts:
        print("nothing to index — is the corpus seeded, and the mentorship active?")
        return

    removed = store.reconcile(seen, [args.mentorship] if args.mentorship else None)

    print(f"\nchunked at {effective_budget(args.budget)} tokens (requested {args.budget})")
    for source_type, n in sorted(counts.items()):
        print(f"  {source_type:<12} {n:>3} sources")
    print(f"  {'chunks':<12} {chunk_total:>3} written")
    scope = f"in {args.mentorship}" if args.mentorship else "across the index"
    print(f"  {'removed':<12} {removed:>3} chunks whose source is gone, {scope}")


if __name__ == "__main__":
    main()
