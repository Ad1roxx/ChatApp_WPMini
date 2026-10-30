"""The application's own database: read, never written.

Until S1.5 this service read its *source records* from the same database as its
chunks — a seeded copy on the Atlas container — while the app wrote to its own
MongoDB on 27017. The Copilot therefore never searched anything a real user had
written. The records now come from the app's database, and this module is the
only way to reach it.

## Why a wrapper rather than a plain pymongo handle

"This service never writes to the app's database" is a property, and a property
is worth more when it is enforced than when it is a convention. A
`ReadOnlyDatabase` has no method that writes: there is no `insert_one` to call
by mistake, no `drop`, no `aggregate` that could carry an `$out`. Reaching for
one is an `AttributeError` in development, not a corrupted collection in
production.

A deployment would add the second lock — a database user granted only `read`
on this database — so the guarantee would hold even against code that went
around this module. Locally there are no users to grant.

## Who may hold one

`sources.py`, `ingest.py`, the store's read-time check and the sync worker. A
test asserts that list, because from S2 this service also calls a language
model, and nothing that builds a prompt or runs an agent tool should be able to
read the app's database directly: what a model sees must pass through the same
permission-checked search a user's question does.
"""

from __future__ import annotations

from typing import Any, Iterator

import gridfs
from pymongo import MongoClient

from config import APP_DB_NAME, APP_MONGODB_URI

ATTACHMENTS_BUCKET = "attachments"

# Short, because the read-time check sits on the search path. If the app's
# database is down, search must fail closed and fail fast - not hang for the
# driver's default thirty seconds while Express's own 15-second timeout runs out.
SERVER_SELECTION_TIMEOUT_MS = 2000


class ReadOnlyCollection:
    """The reads this service needs from one collection, and nothing else."""

    def __init__(self, collection) -> None:
        self._collection = collection

    def find(self, *args: Any, **kwargs: Any) -> Iterator[dict]:
        return self._collection.find(*args, **kwargs)

    def find_one(self, *args: Any, **kwargs: Any) -> dict | None:
        return self._collection.find_one(*args, **kwargs)

    def count_documents(self, *args: Any, **kwargs: Any) -> int:
        return self._collection.count_documents(*args, **kwargs)

    def distinct(self, *args: Any, **kwargs: Any) -> list:
        return self._collection.distinct(*args, **kwargs)


class ReadOnlyDatabase:
    """Collections by attribute, as pymongo allows, but read-only ones."""

    def __init__(self, db) -> None:
        self._db = db

    @property
    def name(self) -> str:
        return self._db.name

    def __getattr__(self, collection: str) -> ReadOnlyCollection:
        if collection.startswith("_"):
            raise AttributeError(collection)
        return ReadOnlyCollection(self._db[collection])

    def __getitem__(self, collection: str) -> ReadOnlyCollection:
        return ReadOnlyCollection(self._db[collection])

    def open_download_stream(self, file_id):
        """The bytes of one attachment. GridFS reads only; no upload, no delete."""
        return gridfs.GridFSBucket(self._db, bucket_name=ATTACHMENTS_BUCKET).open_download_stream(
            file_id
        )

    def ping(self) -> None:
        """Raise if the database cannot be reached. Used to fail closed."""
        self._db.client.admin.command("ping")


def wrap(db) -> ReadOnlyDatabase:
    """A read-only view of a database someone else already opened.

    For the tests and the evaluation, which build their fixtures through a
    writable handle and then give the code under test only this view of it.
    """
    return ReadOnlyDatabase(db)


def connect(uri: str = APP_MONGODB_URI, db_name: str = APP_DB_NAME) -> ReadOnlyDatabase:
    client = MongoClient(uri, serverSelectionTimeoutMS=SERVER_SELECTION_TIMEOUT_MS)
    return ReadOnlyDatabase(client[db_name])
