"""The app's database: read through appdb.py, never written, held by few.

Three properties, each asserted directly:

1. The handle has no way to write. Not "the code happens not to write" - the
   methods are absent, so a write is an AttributeError.
2. A full ingest leaves the app's database exactly as it found it, compared
   document by document, GridFS included - while demonstrably writing chunks
   somewhere else.
3. Only the modules that need it import it. From S2 this service also calls a
   language model, and nothing that builds a prompt may read the app's
   database except through the permission-checked search.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest
from bson import json_util

import appdb
from ingest import run
from store import ChunkStore
from test_attachments import BRIEF, PDF_TYPE, Corpus, pdf_bytes

AI_ROOT = Path(__file__).resolve().parent.parent

# Exactly who imports the app-database module. `store.py`, which opens the
# handle for the read-time check (S1.5 step 2) and passes it to the sync
# worker, and the CLIs that build or measure an index. S2 removed three stale
# entries the old subset check could not see (BUILD_NOTES Entry 66): `app.py`,
# which wires the store and the worker but never opens the database itself,
# so the module serving the ask route would now have to change this list to
# read the app's data; and `sync.py` and `check_retrieval.py`, which receive
# a handle rather than open one. Neither `answer.py` nor `providers.py` is
# here: generation reads only what search returns.
ALLOWED_IMPORTERS = {
    # Measures the read-time check across two servers, over a COPY of the
    # evaluation fixture's records; never the app's real database.
    "check_freshness.py",
    "evaluate.py",
    # Reads the invented demo database by name, read-only; never the app's real one.
    "eval/heading_embed.py",
    "ingest.py",
    "store.py",
}


# --------------------------------------------------------------------------
# 1. No way to write
# --------------------------------------------------------------------------
WRITES = [
    "insert_one",
    "insert_many",
    "update_one",
    "update_many",
    "replace_one",
    "delete_one",
    "delete_many",
    "find_one_and_update",
    "find_one_and_replace",
    "find_one_and_delete",
    "bulk_write",
    "drop",
    "create_index",
    "rename",
    # aggregate can write: a pipeline ending in $out or $merge.
    "aggregate",
]


@pytest.mark.parametrize("method", WRITES)
def test_a_collection_offers_no_write(method):
    collection = appdb.ReadOnlyDatabase(_UnusedDb()).submissions

    assert not hasattr(collection, method)


def test_the_reads_the_indexer_needs_are_there():
    collection = appdb.ReadOnlyDatabase(_UnusedDb()).submissions

    for method in ("find", "find_one", "count_documents", "distinct"):
        assert callable(getattr(collection, method))


def test_a_database_method_name_is_just_a_collection_not_a_write():
    """`db.drop_collection(...)` on the wrapper is a collection called
    "drop_collection", which cannot be called - not a drop."""
    db = appdb.ReadOnlyDatabase(_UnusedDb())

    with pytest.raises(TypeError):
        db.drop_collection("submissions")


class _UnusedDb:
    """Enough of a pymongo Database for the wrapper to be built; never queried."""

    name = "unused"

    def __getitem__(self, name):
        return object()


# --------------------------------------------------------------------------
# 2. A full ingest leaves the app's database untouched
# --------------------------------------------------------------------------
def snapshot(db) -> dict[str, list[str]]:
    """Every document in every collection, GridFS included, in a stable order."""
    return {
        name: sorted(json_util.dumps(doc, sort_keys=True) for doc in db[name].find())
        for name in sorted(db.list_collection_names())
    }


@pytest.mark.needs_mongo
def test_a_full_ingest_never_writes_to_the_app_database(test_db, test_app_db, mongo_uri):
    corpus = Corpus(test_app_db)
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "brief.pdf", PDF_TYPE)],
    )
    before = snapshot(test_app_db)
    assert "attachments.files" in before, "the fixture has no GridFS file to protect"

    store = ChunkStore(uri=mongo_uri, db_name=test_db.name)
    _, written, _ = run(store, appdb.wrap(test_app_db))

    # It did real work - so "nothing changed" is not the absence of a run.
    assert written > 0
    assert store.chunks.count_documents({"sourceType": "attachment"}) > 0
    assert snapshot(test_app_db) == before


@pytest.mark.needs_mongo
def test_chunks_are_written_to_the_store_and_nowhere_near_the_records(
    test_db, test_app_db, mongo_uri
):
    Corpus(test_app_db).submission(Corpus.M1, Corpus.ADITYA, text="My hand-in.")

    run(ChunkStore(uri=mongo_uri, db_name=test_db.name), appdb.wrap(test_app_db))

    assert "knowledge_chunks" in test_db.list_collection_names()
    assert "knowledge_chunks" not in test_app_db.list_collection_names()


# --------------------------------------------------------------------------
# 3. Only these modules may hold it
# --------------------------------------------------------------------------
def importers_of_appdb() -> set[str]:
    found = set()
    for path in [*AI_ROOT.glob("*.py"), *AI_ROOT.glob("eval/*.py")]:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            names = (
                [alias.name for alias in node.names]
                if isinstance(node, ast.Import)
                else [node.module or ""]
                if isinstance(node, ast.ImportFrom)
                else []
            )
            if "appdb" in names:
                found.add(path.relative_to(AI_ROOT).as_posix())
    return found


def test_only_the_modules_that_need_the_app_database_import_it():
    """Read from the source, so a new import is caught without running it."""
    importers = importers_of_appdb()

    assert importers, "nothing imports appdb - the scan is broken"
    # Equality, not a subset: an entry that no longer imports it is stale, and
    # a stale entry is permission nobody is using.
    assert importers == ALLOWED_IMPORTERS, {
        "not allowed": importers - ALLOWED_IMPORTERS,
        "stale": ALLOWED_IMPORTERS - importers,
    }


def test_sources_receives_the_handle_rather_than_opening_one():
    """sources.py builds documents from whatever read-only view it is given;
    it must not be able to open its own connection to the app's database."""
    assert "sources.py" not in importers_of_appdb()
