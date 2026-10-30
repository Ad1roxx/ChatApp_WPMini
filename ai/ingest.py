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
import logging
from collections import Counter

from chunking import chunk_document, effective_budget
from config import CHUNK_BUDGET_TOKENS
from sources import documents
from store import ChunkStore


def run(
    store: ChunkStore, mentorship_id: str | None = None, budget: int | None = None
) -> tuple[Counter, int, int]:
    """Index, then reconcile. Returns (sources per type, chunks written, removed).

    A function rather than the body of `main` so the tests run this code and
    not a copy of it. A copy is how the first version shipped a bug its own
    tests could not see: they reconciled on every run, while `main` returned
    early when there was nothing to index.
    """
    counts: Counter[str] = Counter()
    written = 0
    seen: set[tuple[str, str, str]] = set()

    for doc in documents(store.db, mentorship_id):
        written += store.replace_source(doc, chunk_document(doc, budget=budget))
        counts[doc["source_type"]] += 1
        # Recorded even when it produced no chunks: a brief emptied to nothing
        # still exists, and reconciliation must not treat it as deleted. Keyed
        # by mentorship as well, because one assignment set to two mentorships
        # is one source in each of them under the same id.
        seen.add((doc["mentorship_id"], doc["source_type"], doc["source_id"]))

    # Reconcile even when nothing was indexed. "Nothing to index" is exactly
    # what a run sees after the last active mentorship ends, or when it is
    # scoped to a mentorship that has ended - and in both cases the right
    # outcome is that its chunks go. Returning early here left them
    # retrievable indefinitely.
    removed = store.reconcile(seen, [mentorship_id] if mentorship_id else None)
    return counts, written, removed


def main() -> None:
    parser = argparse.ArgumentParser(description="Index mentorship material.")
    parser.add_argument("--mentorship", help="only this mentorship id")
    parser.add_argument("--budget", type=int, default=CHUNK_BUDGET_TOKENS,
                        help="chunk budget, in the embedding model's own tokens")
    parser.add_argument("--drop", action="store_true", help="empty the index first")
    args = parser.parse_args()

    # Without this, Python's default level is WARNING and every "skipped, and
    # why" message from sources.py is silently discarded. INFO for this
    # service's own modules only: at the root it also turns on every HTTP
    # request the model hub client makes, which buries the lines that matter.
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    for name in ("sources", "extract"):
        logging.getLogger(name).setLevel(logging.INFO)

    store = ChunkStore()
    print("vector index:", store.ensure_vector_index())

    if args.drop:
        store.drop_all()
        print("index emptied")

    counts, written, removed = run(store, args.mentorship, args.budget)

    scope = f"in {args.mentorship}" if args.mentorship else "across the index"
    if not counts:
        print("nothing to index - is the corpus seeded, and the mentorship active?")
        print(f"  removed {removed} chunks whose source is gone, {scope}")
        return

    print(f"\nchunked at {effective_budget(args.budget)} tokens (requested {args.budget})")
    for source_type, n in sorted(counts.items()):
        print(f"  {source_type:<12} {n:>3} sources")
    print(f"  {'chunks':<12} {written:>3} written")
    print(f"  {'removed':<12} {removed:>3} chunks whose source is gone, {scope}")


if __name__ == "__main__":
    main()
