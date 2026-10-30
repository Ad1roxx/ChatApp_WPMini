"""End-to-end check: does retrieval find the right thing, and only for the right person?

    python check_retrieval.py

Ingests the seeded corpus and then asserts four properties. It exits non-zero
on the first failure, so it can go in CI later beside the Node suite.

The corpus is built to make leakage likely rather than unlikely: both
mentorships cover indexing and caching, in similar words, and both students
attached an indexing report saying much the same thing with different numbers.
If the mentorship filter were applied to the *results* of the vector search
rather than inside it, the second mentorship's chunks would be the ones
crowding out the first's.

Run after seeding, including the documents:

    node scripts/seed-rag-corpus.cjs
    .venv/Scripts/python.exe eval/seed_documents.py
    .venv/Scripts/python.exe check_retrieval.py
"""

from __future__ import annotations

import sys

from chunking import chunk_document
from sources import documents
from store import ChunkStore

M1 = "d00000000000000000000001"  # Priya  -> Aditya
M2 = "d00000000000000000000002"  # Karan  -> Zara
PRIYA = "0000000000000000000000b1"
ADITYA = "0000000000000000000000a1"
ZARA = "0000000000000000000000c2"

failures: list[str] = []


def check(what: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {what}")
    if detail:
        print(f"       {detail}")
    if not ok:
        failures.append(what)


def main() -> None:
    store = ChunkStore()
    print("vector index:", store.ensure_vector_index())

    store.drop_all()
    counts = {"sources": 0, "chunks": 0}
    m2_titles: set[str] = set()

    for doc in documents(store.db):
        written = store.replace_source(doc, chunk_document(doc))
        counts["sources"] += 1
        counts["chunks"] += written
        if doc["mentorship_id"] == M2:
            m2_titles.add(doc["title"])

    print(f"ingested {counts['sources']} sources into {counts['chunks']} chunks")
    print(f"the other mentorship's material: {sorted(m2_titles)}")

    # The search node indexes asynchronously, so querying straight after the
    # writes reads an index that has not caught up. Every check below would
    # then be measuring the wait rather than the retrieval.
    caught_up = store.wait_until_searchable(counts["chunks"])
    print(f"index caught up with the writes: {caught_up}\n")
    check("the index caught up before anything was asserted", caught_up)

    # 1. It finds the right thing.
    hits = store.search(M1, ADITYA, "how do compound indexes work?", k=4)
    top = hits[0] if hits else {}
    check(
        "a question about indexing finds the indexing material",
        bool(hits) and "index" in (top.get("title", "") + top.get("content", "")).lower(),
        f"top hit: {top.get('title')!r} ({top.get('score', 0):.3f})",
    )

    # 2. It does not find the other mentorship's near-identical material.
    #    `bool(hits)` is part of the assertion on purpose: with nothing
    #    returned, "nothing leaked" is true and means nothing.
    leaked = [h["title"] for h in hits if h["title"] in m2_titles]
    check(
        "no chunk from the other mentorship appears, among results that exist",
        bool(hits) and not leaked,
        f"returned: {[h['title'] for h in hits]}",
    )

    # 3. Someone else's student gets nothing here, even though they are a real
    #    user asking a question their own mentor covers. Only meaningful
    #    against the same query returning something for someone who belongs.
    zara = store.search(M1, ZARA, "how do compound indexes work?", k=4)
    check(
        "the same query returns chunks for a member and nothing for an outsider",
        bool(hits) and zara == [],
        f"member: {len(hits)} chunks, outsider: {len(zara)}",
    )

    # 4. The mentor sees the shared material in their own mentorship.
    priya = store.search(M1, PRIYA, "what did I ask about caching invalidation?", k=4)
    check(
        "the mentor retrieves their own mentorship's material",
        bool(priya),
        f"top hit: {priya[0]['title']!r}" if priya else "nothing returned",
    )

    # 5. The student's hand-in is retrievable by both parties of the mentorship
    #    — with one student per mentorship, that is the same set as the
    #    mentorship itself, which is worth knowing rather than assuming.
    handins = store.search(M1, ADITYA, "thundering herd cold cache two requests", k=4)
    check(
        "a hand-in and its review are retrievable",
        any(h["sourceType"] == "submission" for h in handins),
        f"types: {[h['sourceType'] for h in handins]}",
    )

    # 6. A question only an attached file can answer retrieves that file. Its
    #    text appears in no record's own text, so a hit here is extraction,
    #    chunking and embedding of a real PDF working end to end.
    attached = store.search(M1, ADITYA, "what is the TTL on the item detail endpoint?", k=4)
    check(
        "a question only an attached document answers retrieves the attachment",
        any(h["sourceType"] == "attachment" for h in attached),
        f"titles: {[h['title'] for h in attached]}",
    )

    # 7. The other student's near-identical report never appears. This is check
    #    2 again, aimed at the case the corpus was built for: two documents
    #    about the same work, in the same words, in different mentorships.
    numbers = store.search(M1, ADITYA, "how many documents did the status lookup scan?", k=4)
    check(
        "the other mentorship's version of the same report never appears",
        bool(numbers)
        and all(h["title"] != "zara-indexing-report.pdf" for h in numbers),
        f"titles: {[h['title'] for h in numbers]}",
    )

    # 8. The scan has no text layer, so nothing of it is retrievable. Indexing
    #    its filename would make an unreadable file look answerable.
    scanned = store.chunks.count_documents({"title": "whiteboard-scan.pdf"})
    check(
        "a scan with no text layer contributes no chunks at all",
        scanned == 0,
        f"chunks from the scan: {scanned}",
    )

    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
