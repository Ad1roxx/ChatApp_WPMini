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
    CHUNKS_COLLECTION,
    DB_NAME,
    EMBEDDING_DIMS,
    EMBEDDING_MODEL,
    MONGODB_URI,
    QUERY_INSTRUCTION,
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
        k: int = 5,
        candidates: int | None = None,
    ) -> list[dict]:
        vector = embed_query(query)

        pipeline = [
            {
                "$vectorSearch": {
                    "index": VECTOR_INDEX,
                    "path": "embedding",
                    "queryVector": vector,
                    "numCandidates": candidates or max(k * 10, 50),
                    "limit": k,
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
                    "score": {"$meta": "vectorSearchScore"},
                }
            },
        ]
        return list(self.chunks.aggregate(pipeline))
