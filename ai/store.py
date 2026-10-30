"""The chunk store: embeddings in, vector search out.

The one thing worth reading carefully is `search`. The mentorship filter and
the viewer filter are passed to `$vectorSearch` itself, not applied to its
results. Filtering afterwards would mean the index had already spent its
`numCandidates` budget on documents the caller may not see — so a query could
come back empty *because* the nearest neighbours belonged to someone else, and
the fix would look like "ask for more candidates" rather than "this is wrong".
"""

from __future__ import annotations

import time
from typing import Iterable

from pymongo import MongoClient
from pymongo.operations import SearchIndexModel

from config import (
    CANDIDATE_K,
    CHUNKS_COLLECTION,
    DB_NAME,
    DIVERSITY,
    DIVERSITY_CAP,
    DIVERSITY_MARGIN,
    EMBEDDING_DIMS,
    EMBEDDING_MODEL,
    MONGODB_URI,
    QUERY_INSTRUCTION,
    RERANK,
    RERANK_MODEL,
    SERVED_K,
    VECTOR_INDEX,
)

_model = None


def embedder():
    """Loaded once, on first use: importing torch costs seconds, not milliseconds."""
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer

        _model = SentenceTransformer(EMBEDDING_MODEL)
    return _model


_reranker = None


def reranker():
    """The cross-encoder, loaded once. Same reasoning as `embedder`."""
    global _reranker
    if _reranker is None:
        from sentence_transformers import CrossEncoder

        _reranker = CrossEncoder(RERANK_MODEL)
    return _reranker


def _normalise(scores: list[float]) -> list[float]:
    """Squash scores to 0-1 across THIS query's candidates.

    Cross-encoder outputs are raw logits on an arbitrary scale - roughly -11 to
    +11 here - so a margin expressed as a number only means something once they
    are on a fixed scale. Min-max over the candidate set is the simplest mapping
    that gives one.

    The caveat is worth stating because it has bitten this project once already
    (Entry 41): a normalised 1.0 means "the best of these candidates", not
    "good". It is right for ordering inside one query and wrong for comparing
    across queries, which is exactly why no threshold is built on it.
    """
    if not scores:
        return []
    low, high = min(scores), max(scores)
    if high - low < 1e-9:
        return [1.0] * len(scores)
    return [(s - low) / (high - low) for s in scores]


def _record_of(chunk: dict) -> tuple:
    """Which record a chunk belongs to, for the purpose of diversity.

    A file's chunks and the hand-in text they were attached to are one record,
    not two: the thing being limited is "one record taking every slot", and a
    PDF plus the note above it is still one hand-in. For a record's own text
    the parent fields are empty and this is just its own identity.
    """
    return (
        chunk.get("parentType") or chunk["sourceType"],
        chunk.get("parentId") or chunk["sourceId"],
    )


def soft_cap(chunks: list[dict], k: int, cap: int, margin: float) -> list[dict]:
    """Take chunks in rank order, yielding a capped record's slot only when the
    alternative is close behind.

    Ported from RAG-Project `rag/retrieve.py` at commit 695795a, with the key
    changed from the arXiv id to the mentorship record.

    A fixed cap is unconditional, and that is its flaw: there it left
    comparison questions at full recall while dropping single-source precision
    from 0.88 to 0.64, because when one document genuinely owns the answer,
    forcing two foreign chunks into the results buys no recall and costs two
    slots. Here a capped record's chunk is skipped only if some under-cap
    record has a candidate within `margin` of it. Diversity is what decides
    when relevance cannot, rather than a quota imposed on top of it.

    Nothing is ever dropped to satisfy the cap: deferred chunks come back at
    the end rather than returning fewer than `k`. A cap that silently shrinks
    the context is worse than one that bends.
    """
    if not chunks:
        return []

    relevance = _normalise([c["score"] for c in chunks])
    selected: list[dict] = []
    deferred: list[dict] = []
    per_record: dict[tuple, int] = {}

    for index, chunk in enumerate(chunks):
        if len(selected) >= k:
            break
        record = _record_of(chunk)

        if per_record.get(record, 0) < cap:
            selected.append(chunk)
            per_record[record] = per_record.get(record, 0) + 1
            continue

        best_alternative = max(
            (
                relevance[j]
                for j in range(index + 1, len(chunks))
                if per_record.get(_record_of(chunks[j]), 0) < cap
            ),
            default=None,
        )
        if best_alternative is not None and relevance[index] - best_alternative <= margin:
            deferred.append(chunk)
        else:
            selected.append(chunk)
            per_record[record] = per_record.get(record, 0) + 1

    for chunk in deferred:
        if len(selected) >= k:
            break
        selected.append(chunk)

    return selected


def _encode(texts: list[str]) -> list[list[float]]:
    # Normalising to unit length makes a dot product exactly a cosine, so every
    # score sits on a comparable scale and the index can rank by cosine
    # cheaply. The vector index is declared with "similarity": "cosine", which
    # normalises internally too; doing it here as well means the vectors stored
    # and the vectors compared are the same numbers, and a score computed by
    # hand matches the one Atlas returns.
    vectors = embedder().encode(texts, normalize_embeddings=True)
    return [v.tolist() for v in vectors]


def embed_passages(texts: list[str]) -> list[list[float]]:
    """Embed indexed text: bare, with no instruction prefix."""
    return _encode(texts)


def embed_query(query: str) -> list[float]:
    """Embed a search query, with the model's query instruction if it has one.

    BGE models are trained **asymmetrically**: passages are embedded bare and
    queries carry an instruction prefix. That is not decoration, it is how the
    model was fine-tuned — a question and the passage answering it are not
    paraphrases of each other. "What is the marking scheme?" shares little
    surface form with "Each criterion is worth ten marks."

    Getting it wrong fails quietly: everything still runs and results are still
    returned, they are just measurably worse. Prefixing the *passages* as well
    would be the same mistake twice, which is why the two directions are
    separate functions rather than one with a flag that defaults to something.
    """
    return _encode([f"{QUERY_INSTRUCTION}{query}"])[0]


class ChunkStore:
    def __init__(self, uri: str = MONGODB_URI, db_name: str = DB_NAME):
        self.client = MongoClient(uri)
        self.db = self.client[db_name]
        self.chunks = self.db[CHUNKS_COLLECTION]

    # ---------------- index ----------------

    def ensure_vector_index(self, wait: bool = True) -> str:
        # A search index belongs to a collection, and the server refuses to
        # create one on a namespace that does not exist. On a first run nothing
        # has been inserted yet, so the collection is created deliberately
        # rather than as a side effect of the first write.
        if CHUNKS_COLLECTION not in self.db.list_collection_names():
            self.db.create_collection(CHUNKS_COLLECTION)

        existing = {i["name"] for i in self.chunks.list_search_indexes()}
        if VECTOR_INDEX in existing:
            return "already there"

        self.chunks.create_search_index(
            SearchIndexModel(
                name=VECTOR_INDEX,
                type="vectorSearch",
                definition={
                    "fields": [
                        {
                            "type": "vector",
                            "path": "embedding",
                            # 384 for both all-MiniLM-L6-v2 and
                            # bge-small-en-v1.5, which is why swapping between
                            # them needs no index rebuild — only a re-embed.
                            # A model with a different width would: the server
                            # rejects a query vector whose length does not
                            # match this number, so the mismatch is loud.
                            "numDimensions": EMBEDDING_DIMS,
                            "similarity": "cosine",
                        },
                        # Both are filter fields so they can be applied inside
                        # the search rather than after it.
                        {"type": "filter", "path": "mentorshipId"},
                        {"type": "filter", "path": "viewers"},
                    ]
                },
            )
        )

        if not wait:
            return "requested"

        for _ in range(60):
            for index in self.chunks.list_search_indexes():
                if index["name"] == VECTOR_INDEX and index.get("queryable"):
                    return "ready"
            time.sleep(2)
        raise TimeoutError("the vector index never became queryable")

    # ---------------- writing ----------------

    def replace_source(self, doc: dict, chunks: Iterable[dict]) -> int:
        """Re-index one source. Delete then insert, so editing a brief cannot
        leave the old wording retrievable beside the new.

        `chunks` are the dicts `chunking.chunk_document` returns: a `text` and,
        for an attachment, where in the file it came from.
        """
        pieces = [c for c in chunks if c.get("text", "").strip()]
        self.chunks.delete_many(
            {
                "mentorshipId": doc["mentorship_id"],
                "sourceType": doc["source_type"],
                "sourceId": doc["source_id"],
            }
        )
        if not pieces:
            return 0

        vectors = embed_passages([c["text"] for c in pieces])
        self.chunks.insert_many(
            [
                {
                    "mentorshipId": doc["mentorship_id"],
                    "sourceType": doc["source_type"],
                    "sourceId": doc["source_id"],
                    "title": doc["title"],
                    "content": piece["text"],
                    "chunkIndex": i,
                    "viewers": doc["viewers"],
                    "visibility": doc["visibility"],
                    "ownerId": doc.get("owner_id"),
                    "url": doc.get("url"),
                    # Where a citation points, for an attachment: the record a
                    # person can open, which file, and which page or section of
                    # it. All None for a record's own text, which has no
                    # position worth naming.
                    "parentType": doc.get("parent_type"),
                    "parentId": doc.get("parent_id"),
                    "parentTitle": doc.get("parent_title"),
                    "attachmentId": doc.get("attachment_id"),
                    "fileKind": doc.get("file_kind"),
                    "heading": piece.get("heading"),
                    "sectionIndex": piece.get("section_index"),
                    "startPage": piece.get("start_page"),
                    "endPage": piece.get("end_page"),
                    "embedding": vector,
                }
                for i, (piece, vector) in enumerate(zip(pieces, vectors))
            ]
        )
        return len(pieces)

    def reconcile(
        self, seen: set[tuple[str, str, str]], mentorship_ids: list[str] | None = None
    ) -> int:
        """Delete chunks whose source was not seen in this run.

        `replace_source` keeps one source honest, but it can only delete chunks
        it is handed a source for. Nothing deletes the chunks of a source that
        is simply **gone** — a removed attachment, a deleted hand-in, a
        mentorship that ended. Those chunks stay retrievable, and from S2 on a
        stale chunk is not merely wrong, it is wrong text quoted back to
        someone as though it were current.

        A full run passes `mentorship_ids=None` and reconciles the whole index,
        because a mentorship that no longer exists cannot appear in a list
        derived from the mentorships that do. A run scoped with `--mentorship`
        reconciles only within that mentorship: its own sources were all
        visited, nobody else's were, and deleting on the strength of a partial
        view would empty the index one mentorship at a time.

        A source is identified by **mentorship, type and id together**, not by
        type and id. One assignment can be set to several mentorships, and it
        is then one source in each of them with the same id in all - so keying
        on the pair alone makes any still-live copy vouch for every dead one,
        and a mentorship removed from a brief's list keeps its chunks forever.
        A test asserts this by ending one of two mentorships that share a brief.
        """
        scope: dict = (
            {} if mentorship_ids is None else {"mentorshipId": {"$in": list(mentorship_ids)}}
        )

        stale = [
            group["_id"]
            for group in self.chunks.aggregate(
                [
                    {"$match": scope},
                    {
                        "$group": {
                            "_id": {
                                "mentorshipId": "$mentorshipId",
                                "sourceType": "$sourceType",
                                "sourceId": "$sourceId",
                            }
                        }
                    },
                ]
            )
            if (
                group["_id"]["mentorshipId"],
                group["_id"]["sourceType"],
                group["_id"]["sourceId"],
            )
            not in seen
        ]
        if not stale:
            return 0

        return self.chunks.delete_many(
            {
                **scope,
                "$or": [
                    {
                        "mentorshipId": s["mentorshipId"],
                        "sourceType": s["sourceType"],
                        "sourceId": s["sourceId"],
                    }
                    for s in stale
                ],
            }
        ).deleted_count

    def drop_all(self) -> None:
        self.chunks.delete_many({})

    def wait_until_searchable(self, expected: int, timeout: float = 90.0) -> bool:
        """Block until the search index has caught up with the writes.

        Atlas indexes asynchronously: `insert_many` returns as soon as Mongo
        has the documents, while the search node sees them a moment later. A
        query issued in that window comes back empty — and an empty result is
        indistinguishable from "nothing matched", which is how the first
        version of the retrieval check managed to report that no other
        mentorship's chunks had leaked. Nothing had been returned at all.
        """
        if expected <= 0:
            return True

        probe = embed_query("indexing and caching")
        deadline = time.time() + timeout

        while time.time() < deadline:
            counted = list(
                self.chunks.aggregate(
                    [
                        {
                            "$vectorSearch": {
                                "index": VECTOR_INDEX,
                                "path": "embedding",
                                "queryVector": probe,
                                "numCandidates": max(expected * 5, 100),
                                "limit": expected,
                            }
                        },
                        {"$count": "n"},
                    ]
                )
            )
            if counted and counted[0]["n"] >= expected:
                return True
            time.sleep(1)

        return False

    # ---------------- reading ----------------

    def search(
        self,
        mentorship_id: str,
        viewer_id: str,
        query: str,
        k: int = SERVED_K,
        candidates: int | None = None,
        rerank: bool | None = None,
        diversity: str | None = None,
    ) -> list[dict]:
        """The served search: over-fetch, rerank, diversify, cut to k.

            vector search (30)  ->  cross-encoder  ->  soft cap  ->  k
                  recall             precision          coverage

        Each stage fixes a different failure. The bi-encoder encodes question
        and passage separately, which is what makes passages indexable and what
        limits it: a passage's vector was computed without knowing the question.
        The cross-encoder reads both together and cannot be precomputed, so it
        only ever sees the candidates. The cap exists because relevance ranking
        has no reason to spread results across records, and the nearest four
        chunks to a question are often four chunks of one document.

        `rerank` and `diversity` default to the configured behaviour and are
        parameters so that `evaluate.py` can measure each stage on its own -
        which is the only way the defaults were chosen.
        """
        rerank = RERANK if rerank is None else rerank
        diversity = DIVERSITY if diversity is None else diversity

        # Over-fetch only when something downstream will re-order the results.
        # Asking for 30 and keeping the first 4 of the same ordering would cost
        # the index 26 candidates' work and change nothing.
        wanted = max(k, CANDIDATE_K) if (rerank or diversity != "none") else k

        vector = embed_query(query)

        pipeline = [
            {
                "$vectorSearch": {
                    "index": VECTOR_INDEX,
                    "path": "embedding",
                    "queryVector": vector,
                    "numCandidates": candidates or max(wanted * 10, 50),
                    "limit": wanted,
                    "filter": {
                        "mentorshipId": {"$eq": mentorship_id},
                        "viewers": {"$in": [viewer_id]},
                    },
                }
            },
            {
                "$project": {
                    "_id": 0,
                    "title": 1,
                    "content": 1,
                    "sourceType": 1,
                    "sourceId": 1,
                    "chunkIndex": 1,
                    "url": 1,
                    "parentType": 1,
                    "parentId": 1,
                    "parentTitle": 1,
                    "attachmentId": 1,
                    "fileKind": 1,
                    "heading": 1,
                    "startPage": 1,
                    "endPage": 1,
                    "score": {"$meta": "vectorSearchScore"},
                }
            },
        ]
        hits = list(self.chunks.aggregate(pipeline))

        # Reranking and capping only ever REORDER chunks the caller may already
        # see. The permission filter ran inside `$vectorSearch` above, so no
        # stage after this point can widen what came back - which is why these
        # are allowed to be the default at all.
        if rerank and hits:
            scores = reranker().predict([(query, hit["content"]) for hit in hits])
            for hit, score in zip(hits, scores):
                hit["score"] = float(score)
            hits.sort(key=lambda hit: hit["score"], reverse=True)

        if diversity == "soft_cap":
            return soft_cap(hits, k, DIVERSITY_CAP, DIVERSITY_MARGIN)
        return hits[:k]
