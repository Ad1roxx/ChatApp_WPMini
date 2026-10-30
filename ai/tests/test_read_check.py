"""The read-time check, through the real search() over a real vector index.

S1.5 step 2. Every test here changes the app's records WITHOUT telling the
index - no sync, no re-index - because that is the case the check exists for:
an event that was never delivered. Each one first proves the right person CAN
retrieve the chunk, and only then that the later state cannot (Entry 41: an
empty result proves nothing on its own).
"""

from __future__ import annotations

import logging
from datetime import datetime

import pytest
from bson import ObjectId
from fastapi.testclient import TestClient

import appdb
from ingest import run
from store import ChunkStore
from test_attachments import BRIEF, MARKING, PDF_TYPE, Corpus, pdf_bytes

pytestmark = pytest.mark.needs_mongo

QUERY = "what must the invalidation rule say about stale entries?"


@pytest.fixture
def world(clean_search_store, test_app_db):
    """A corpus in a fixture app database, and the shared search store over it."""
    store = clean_search_store
    store._records = appdb.wrap(test_app_db)
    return store, Corpus(test_app_db), test_app_db


def index(store, app_db) -> int:
    _, written, _ = run(store, appdb.wrap(app_db))
    assert store.wait_until_searchable(written), "the search index never caught up"
    return written


def found(store, viewer, mentorship=Corpus.M1, query=QUERY, k=10) -> list[dict]:
    return store.search(mentorship, viewer, query, k=k, rerank=False, diversity="none")


def titles(hits) -> set[str]:
    return {h["title"] for h in hits}


def report(name):
    return pdf_bytes([f"Requirements\n\n{BRIEF}", f"Marking scheme\n\n{MARKING}"]), name, PDF_TYPE


# --------------------------------------------------------------------------
# A fresh index: the check must drop nothing
# --------------------------------------------------------------------------
def test_on_a_fresh_index_the_check_drops_nothing(world):
    store, corpus, app_db = world
    corpus.submission(Corpus.M1, Corpus.ADITYA, text="My invalidation rule.", files=[report("mine.pdf")])
    index(store, app_db)

    hits = found(store, Corpus.ADITYA)

    assert {"mine.pdf", "Hand-in: Caching exercise"} <= titles(hits)
    assert store.last_dropped == []


def test_an_outsider_still_gets_nothing(world):
    store, corpus, app_db = world
    corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("mine.pdf")])
    index(store, app_db)

    assert found(store, Corpus.ADITYA), "the member found nothing either"
    assert found(store, Corpus.ZARA) == []


# --------------------------------------------------------------------------
# Removals the index was never told about
# --------------------------------------------------------------------------
def test_a_deleted_hand_in_is_not_returned(world, caplog):
    store, corpus, app_db = world
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, text="My invalidation rule.", files=[report("mine.pdf")])
    index(store, app_db)
    assert {"mine.pdf", "Hand-in: Caching exercise"} <= titles(found(store, Corpus.ADITYA))

    app_db.submissions.delete_one({"_id": sid})
    with caplog.at_level(logging.INFO, logger="store"):
        hits = found(store, Corpus.ADITYA)

    assert not {"mine.pdf", "Hand-in: Caching exercise"} & titles(hits)
    assert "source gone" in caplog.text


def test_a_removed_attachment_is_not_returned_and_its_sibling_is(world, caplog):
    store, corpus, app_db = world
    sid = corpus.submission(
        Corpus.M1, Corpus.ADITYA, files=[report("kept.pdf"), report("removed.pdf")]
    )
    index(store, app_db)
    assert {"kept.pdf", "removed.pdf"} <= titles(found(store, Corpus.ADITYA))

    app_db.submissions.update_one({"_id": sid}, {"$pull": {"attachments": {"name": "removed.pdf"}}})
    with caplog.at_level(logging.INFO, logger="store"):
        hits = found(store, Corpus.ADITYA)

    assert "removed.pdf" not in titles(hits)
    assert "kept.pdf" in titles(hits)
    assert "attachment removed" in caplog.text


def test_nothing_from_an_ended_mentorship_is_returned(world):
    store, corpus, app_db = world
    corpus.submission(Corpus.M1, Corpus.ADITYA, text="My invalidation rule.", files=[report("mine.pdf")])
    index(store, app_db)
    assert found(store, Corpus.ADITYA)
    assert found(store, Corpus.PRIYA)

    app_db.mentorships.update_one({"_id": ObjectId(Corpus.M1)}, {"$set": {"status": "ended"}})

    assert found(store, Corpus.ADITYA) == []
    assert found(store, Corpus.PRIYA) == []


def test_a_deleted_assignment_takes_its_brief_hand_ins_and_files_with_it(world):
    """The route deletes the brief, every hand-in, and every file. Without the
    event, all three kinds of chunk must still disappear."""
    store, corpus, app_db = world
    corpus.submission(Corpus.M1, Corpus.ADITYA, text="My invalidation rule.", files=[report("mine.pdf")])
    index(store, app_db)
    before = found(store, Corpus.ADITYA, query="caching exercise reading list invalidation")
    assert {h["sourceType"] for h in before} == {"assignment", "submission", "attachment"}

    app_db.submissions.delete_many({"assignment": corpus.assignment})
    app_db.assignments.delete_one({"_id": corpus.assignment})

    assert found(store, Corpus.ADITYA, query="caching exercise reading list invalidation") == []


def test_a_caller_who_is_no_longer_a_viewer_is_refused(world, caplog):
    """Viewers are the mentorship's parties now, not as they were at indexing.
    Changed directly in the database: no route moves a mentor, but the check
    must not depend on that staying true."""
    store, corpus, app_db = world
    corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("mine.pdf")])
    index(store, app_db)
    assert found(store, Corpus.PRIYA)

    app_db.mentorships.update_one(
        {"_id": ObjectId(Corpus.M1)}, {"$set": {"mentor": ObjectId(Corpus.KARAN)}}
    )
    with caplog.at_level(logging.INFO, logger="store"):
        hits = found(store, Corpus.PRIYA)

    assert hits == []
    assert "no longer a viewer" in caplog.text


# --------------------------------------------------------------------------
# Changes the index was never told about
# --------------------------------------------------------------------------
def test_edited_text_is_never_returned_in_its_old_form(world, caplog):
    store, corpus, app_db = world
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, text="The invalidation rule clears the zebra cache.")
    index(store, app_db)
    assert any("zebra" in h["content"] for h in found(store, Corpus.ADITYA))

    app_db.submissions.update_one(
        {"_id": sid},
        {"$set": {"text": "The invalidation rule clears the quartz cache.", "updatedAt": datetime(2026, 2, 1)}},
    )
    with caplog.at_level(logging.INFO, logger="store"):
        stale = found(store, Corpus.ADITYA)

    assert not any("zebra" in h["content"] for h in stale)
    assert "stale" in caplog.text

    # And once it is re-indexed, the new text is what comes back.
    index(store, app_db)
    fresh = found(store, Corpus.ADITYA)
    assert any("quartz" in h["content"] for h in fresh)
    assert not any("zebra" in h["content"] for h in fresh)


def test_a_renamed_brief_shows_its_new_name_on_a_file_without_a_re_index(world):
    """A file's parent title comes from the assignment and is filled from the
    live record at search time - so it is current with no sync at all."""
    store, corpus, app_db = world
    corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("mine.pdf")])
    index(store, app_db)

    app_db.assignments.update_one(
        {"_id": corpus.assignment},
        {"$set": {"title": "Renamed exercise", "updatedAt": datetime(2026, 2, 1)}},
    )
    files = [h for h in found(store, Corpus.ADITYA) if h["title"] == "mine.pdf"]

    assert files, "the file was dropped - its version should not depend on the brief"
    assert {h["parentTitle"] for h in files} == {"Hand-in: Renamed exercise"}


def test_a_chunk_with_no_version_is_dropped(world, caplog):
    store, corpus, app_db = world
    corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("mine.pdf")])
    index(store, app_db)
    assert found(store, Corpus.ADITYA)

    # What a chunk written before S1.5 looks like.
    store.chunks.update_many({}, {"$unset": {"sourceVersion": ""}})
    with caplog.at_level(logging.INFO, logger="store"):
        hits = found(store, Corpus.ADITYA)

    assert hits == []
    assert "no version" in caplog.text


# --------------------------------------------------------------------------
# The check can only remove
# --------------------------------------------------------------------------
def test_the_check_never_adds_a_candidate(world):
    store, corpus, app_db = world
    corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("mine.pdf")])
    index(store, app_db)

    from store import read_time_check

    hits = found(store, Corpus.ADITYA)
    kept, dropped = read_time_check(appdb.wrap(app_db), [dict(h) for h in hits[:1]], Corpus.ADITYA)

    assert len(kept) + len(dropped) == 1
    assert all(h["sourceId"] == hits[0]["sourceId"] for h in kept)


# --------------------------------------------------------------------------
# Failing closed
# --------------------------------------------------------------------------
UNREACHABLE = "mongodb://127.0.0.1:1/?directConnection=true"


def test_search_fails_rather_than_returning_unchecked_chunks(world):
    store, corpus, app_db = world
    corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("mine.pdf")])
    index(store, app_db)
    assert found(store, Corpus.ADITYA)

    store._records = appdb.connect(UNREACHABLE, "chatapp_rag_pytest_app")

    with pytest.raises(Exception) as caught:
        found(store, Corpus.ADITYA)
    assert "ServerSelectionTimeout" in type(caught.value).__name__


def test_the_endpoint_answers_an_error_not_chunks_when_the_app_database_is_down(
    world, monkeypatch
):
    """Express maps any non-2xx from here to its 502. What must never happen
    is a 200 carrying chunks nobody checked."""
    import app as service

    store, corpus, app_db = world
    corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("mine.pdf")])
    index(store, app_db)

    down = ChunkStore(
        uri=_uri(store),
        db_name=store.db.name,
        records=appdb.connect(UNREACHABLE, "chatapp_rag_pytest_app"),
    )
    monkeypatch.setattr(service, "store", down)
    monkeypatch.setattr(service, "SERVICE_SECRET", "test-secret")

    response = TestClient(service.app, raise_server_exceptions=False).post(
        "/search",
        headers={"X-AI-Secret": "test-secret"},
        json={"mentorshipId": Corpus.M1, "viewerId": Corpus.ADITYA, "query": QUERY},
    )

    assert response.status_code >= 500
    assert "chunks" not in response.text


def _uri(store) -> str:
    host, port = store.client.address
    return f"mongodb://{host}:{port}/?directConnection=true"
