"""Versions on chunks, and one copy of the indexing rules.

S1.5 step 1. Two properties:

1. Every chunk records the version of the source it was built from, and the
   version is the right one for its type - including the case the inventory
   found, where a hand-in's title comes from its assignment.
2. The rules are callable for a single source, and that path agrees with the
   full walk exactly. Step 2's read-time check and step 3's sync both stand
   on this: if the single-source answer drifted from the indexer's, the check
   would pass chunks the indexer would never write, or drop ones it would.
"""

from __future__ import annotations

from datetime import datetime

import pytest
from bson import ObjectId

import appdb
import sources
from ingest import run
from store import ChunkStore
from test_attachments import BRIEF, DOCX_TYPE, PDF_TYPE, Corpus, docx_bytes, pdf_bytes

pytestmark = pytest.mark.needs_mongo


@pytest.fixture
def corpus(test_db):
    return Corpus(test_db)


@pytest.fixture
def store(test_db, mongo_uri):
    return ChunkStore(uri=mongo_uri, db_name=test_db.name)


def index(store):
    return run(store, appdb.wrap(store.db))


def a_full_corpus(corpus, test_db):
    """One of everything this service indexes, across both mentorships."""
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[
            (pdf_bytes([f"Requirements\n\n{BRIEF}"]), "brief.pdf", PDF_TYPE),
            (docx_bytes([("Requirements", BRIEF)]), "notes.docx", DOCX_TYPE),
        ],
    )
    corpus.submission(Corpus.M2, Corpus.ZARA, text="Zara's hand-in.")
    test_db.goals.insert_one(
        {
            "_id": ObjectId(),
            "mentorship": ObjectId(Corpus.M1),
            "title": "Be ready for interviews",
            "milestones": [{"title": "Indexing", "done": True}],
            "updatedAt": datetime(2026, 1, 4),
        }
    )
    test_db.resources.insert_one(
        {
            "_id": ObjectId(),
            "mentorship": ObjectId(Corpus.M1),
            "title": "Use The Index, Luke",
            "note": "Read the B-tree chapter.",
            "url": "https://use-the-index-luke.com/",
            "updatedAt": datetime(2026, 1, 5),
        }
    )


# --------------------------------------------------------------------------
# 1. The right version on every chunk
# --------------------------------------------------------------------------
def test_every_chunk_carries_a_version(corpus, test_db, store):
    a_full_corpus(corpus, test_db)

    index(store)

    types = set(store.chunks.distinct("sourceType"))
    assert types == {"assignment", "submission", "attachment", "goal", "resource"}
    assert store.chunks.count_documents({"sourceVersion": None}) == 0


def test_each_type_takes_its_version_from_the_right_place(corpus, test_db, store):
    a_full_corpus(corpus, test_db)

    index(store)

    def version(source_type):
        return {c["sourceVersion"] for c in store.chunks.find({"sourceType": source_type})}

    assert version("assignment") == {datetime(2026, 1, 1)}
    assert version("goal") == {datetime(2026, 1, 4)}
    assert version("resource") == {datetime(2026, 1, 5)}
    # A file is written once and never changed: its upload time is its version.
    assert version("attachment") == {datetime(2026, 1, 3)}
    # The submission's own update (Jan 2) is later than its assignment's (Jan 1).
    assert version("submission") == {datetime(2026, 1, 2)}


def test_a_renamed_assignment_moves_its_hand_ins_version(corpus, test_db, store):
    """The inventory's finding: a hand-in chunk's title comes from its
    assignment, so renaming the brief must make the hand-in's chunk stale even
    though the hand-in itself never changed."""
    corpus.submission(Corpus.M1, Corpus.ADITYA, text="My hand-in.")
    index(store)
    before = store.chunks.find_one({"sourceType": "submission"})["sourceVersion"]

    test_db.assignments.update_one(
        {"_id": corpus.assignment},
        {"$set": {"title": "Renamed exercise", "updatedAt": datetime(2026, 2, 1)}},
    )
    index(store)
    chunk = store.chunks.find_one({"sourceType": "submission"})

    assert before == datetime(2026, 1, 2)
    assert chunk["sourceVersion"] == datetime(2026, 2, 1)
    assert chunk["title"] == "Hand-in: Renamed exercise"


def test_attachment_chunks_are_not_versioned_by_the_assignment(corpus, test_db, store):
    """Deliberately different from the hand-in text: versioning every file by
    its brief would re-extract every attached PDF whenever a due date moved.
    The parent's title is filled in live at search time instead."""
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "brief.pdf", PDF_TYPE)],
    )
    test_db.assignments.update_one(
        {"_id": corpus.assignment}, {"$set": {"updatedAt": datetime(2026, 3, 1)}}
    )

    index(store)

    assert {c["sourceVersion"] for c in store.chunks.find({"sourceType": "attachment"})} == {
        datetime(2026, 1, 3)
    }


def test_a_record_without_a_version_is_indexed_without_one(corpus, test_db, store):
    """Recorded as missing rather than invented; the read-time check then
    fails closed on it. Inventing one would let it pass as current forever."""
    corpus.submission(Corpus.M1, Corpus.ADITYA, text="My hand-in.")
    test_db.submissions.update_many({}, {"$unset": {"updatedAt": ""}})

    index(store)

    assert store.chunks.find_one({"sourceType": "submission"})["sourceVersion"] is None


# --------------------------------------------------------------------------
# 2. One source at a time, by the same rules
# --------------------------------------------------------------------------
def comparable(document: dict) -> dict:
    """What a document says about indexing: identity, audience, version, text."""
    return {
        "key": (document["mentorship_id"], document["source_type"], document["source_id"]),
        "viewers": sorted(document["viewers"]),
        "visibility": document["visibility"],
        "version": document["version"],
        "text": document.get("text") or [s["text"] for s in document["sections"]],
    }


def test_one_source_at_a_time_agrees_with_the_full_walk(corpus, test_db):
    a_full_corpus(corpus, test_db)
    db = appdb.wrap(test_db)

    walked = sorted((comparable(d) for d in sources.documents(db)), key=lambda d: d["key"])

    one_at_a_time = []
    for source_type, collection in (
        ("assignment", test_db.assignments),
        ("submission", test_db.submissions),
        ("goal", test_db.goals),
        ("resource", test_db.resources),
    ):
        for record in collection.find():
            one_at_a_time += sources.source_documents(db, source_type, str(record["_id"]))
    single = sorted((comparable(d) for d in one_at_a_time), key=lambda d: d["key"])

    assert walked, "the corpus produced nothing to compare"
    assert single == walked


def test_a_brief_set_to_two_mentorships_is_two_documents(corpus, test_db):
    docs = sources.source_documents(appdb.wrap(test_db), "assignment", str(corpus.assignment))

    assert {d["mentorship_id"] for d in docs} == {Corpus.M1, Corpus.M2}


def test_a_missing_record_contributes_nothing(test_db):
    assert sources.source_documents(appdb.wrap(test_db), "submission", str(ObjectId())) == []


def test_a_record_in_an_ended_mentorship_contributes_nothing(corpus, test_db):
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, text="My hand-in.")
    test_db.mentorships.update_one(
        {"_id": ObjectId(Corpus.M1)}, {"$set": {"status": "ended"}}
    )

    assert sources.source_documents(appdb.wrap(test_db), "submission", str(sid)) == []


def test_an_unknown_source_type_is_refused(test_db):
    with pytest.raises(ValueError, match="unknown source type"):
        sources.source_documents(appdb.wrap(test_db), "mentorship", str(ObjectId()))


def test_an_empty_hand_in_still_lends_its_files_an_audience(corpus, test_db):
    """No text, so no submission entry - but the parent context its files are
    indexed under must still exist, or an attached PDF would vanish with it."""
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, text="")
    s = test_db.submissions.find_one({"_id": sid})
    m = test_db.mentorships.find_one({"_id": ObjectId(Corpus.M1)})
    a = test_db.assignments.find_one({"_id": corpus.assignment})

    assert sources.submission_entry(s, a, m) is None
    parent = sources.submission_parent(s, a, m)
    assert parent is not None
    assert sorted(parent["viewers"]) == sorted([Corpus.ADITYA, Corpus.PRIYA])
