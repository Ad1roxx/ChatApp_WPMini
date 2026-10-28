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


def embed(texts: list[str]) -> list[list[float]]:
    vectors = embedder().encode(texts, normalize_embeddings=True)
    return [v.tolist() for v in vectors]


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

    def replace_source(self, doc: dict, chunks: Iterable[str]) -> int:
        """Re-index one source. Delete then insert, so editing a brief cannot
        leave the old wording retrievable beside the new."""
        chunks = [c for c in chunks if c.strip()]
        self.chunks.delete_many(
            {
                "mentorshipId": doc["mentorship_id"],
                "sourceType": doc["source_type"],
                "sourceId": doc["source_id"],
            }
        )
        if not chunks:
            return 0

        vectors = embed(chunks)
        self.chunks.insert_many(
            [
                {
                    "mentorshipId": doc["mentorship_id"],
                    "sourceType": doc["source_type"],
                    "sourceId": doc["source_id"],
                    "title": doc["title"],
                    "content": text,
                    "chunkIndex": i,
                    "viewers": doc["viewers"],
                    "visibility": doc["visibility"],
                    "ownerId": doc.get("owner_id"),
                    "url": doc.get("url"),
                    "embedding": vector,
                }
                for i, (text, vector) in enumerate(zip(chunks, vectors))
            ]
        )
        return len(chunks)

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

        probe = embed(["indexing and caching"])[0]
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
        vector = embed([query])[0]

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
