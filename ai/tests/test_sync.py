"""Sync: the real sync functions, the real endpoint, the real worker.

S1.5 step 3. Every test changes the app's records the way a route would, then
syncs, then searches through the real `search()`. Each first proves the right
person can retrieve something, and only then that the later state cannot.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta

import gridfs
import pytest
from bson import ObjectId, json_util
from fastapi.testclient import TestClient

import appdb
import sync
from ingest import run
from test_attachments import BRIEF, DOCX_TYPE, MARKING, PDF_TYPE, Corpus, docx_bytes, pdf_bytes

pytestmark = pytest.mark.needs_mongo

QUERY = "what must the invalidation rule say about stale entries?"
_clock = [datetime(2026, 3, 1)]


def tick() -> datetime:
    """A later updatedAt each time, as Mongoose's save() would write."""
    _clock[0] += timedelta(seconds=1)
    return _clock[0]


@pytest.fixture
def world(clean_search_store, test_app_db):
    store = clean_search_store
    records = appdb.wrap(test_app_db)
    store._records = records
    return store, records, Corpus(test_app_db), test_app_db


def found(store, viewer, mentorship=Corpus.M1, query=QUERY, k=10):
    return store.search(mentorship, viewer, query, k=k, rerank=False, diversity="none")


def titles(hits) -> set:
    return {h["title"] for h in hits}


def settle(store):
    assert store.wait_until_searchable(store.chunks.count_documents({}))


def report(name):
    return pdf_bytes([f"Requirements\n\n{BRIEF}", f"Marking scheme\n\n{MARKING}"]), name, PDF_TYPE


def attach(corpus, app_db, sid, data, name, content_type):
    """What POST /api/submissions/:id/files does: bytes, then the record."""
    file_id = corpus.put_file(data, name)
    app_db.submissions.update_one(
        {"_id": sid},
        {
            "$push": {
                "attachments": {
                    "fileId": file_id,
                    "name": name,
                    "size": len(data),
                    "contentType": content_type,
                    "uploadedAt": tick(),
                }
            },
            "$set": {"status": "draft", "updatedAt": tick()},
        },
    )
    return file_id


def detach(app_db, sid, file_id):
    """What DELETE /api/submissions/:id/files/:fileId does: record, then bytes."""
    app_db.submissions.update_one(
        {"_id": sid},
        {"$pull": {"attachments": {"fileId": file_id}}, "$set": {"updatedAt": tick()}},
    )
    gridfs.GridFSBucket(app_db, bucket_name="attachments").delete(file_id)


def index_state(store) -> set:
    return {
        (c["mentorshipId"], c["sourceType"], c["sourceId"], c["chunkIndex"], c["content"])
        for c in store.chunks.find()
    }


# --------------------------------------------------------------------------
# Additions
# --------------------------------------------------------------------------
def test_an_upload_is_searchable_by_the_two_parties_and_nobody_else(world):
    store, records, corpus, app_db = world
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, text="My invalidation rule.")
    run(store, records)
    data, name, kind = report("brief.pdf")
    attach(corpus, app_db, sid, data, name, kind)
    attach(corpus, app_db, sid, docx_bytes([("Requirements", BRIEF)]), "notes.docx", DOCX_TYPE)

    sync.sync_source(store, records, "submission", str(sid))
    settle(store)

    for party in (Corpus.ADITYA, Corpus.PRIYA):
        assert {"brief.pdf", "notes.docx"} <= titles(found(store, party))
    for outsider in (Corpus.ZARA, Corpus.KARAN):
        assert found(store, outsider) == []
        assert not {"brief.pdf", "notes.docx"} & titles(found(store, outsider, mentorship=Corpus.M2))


# --------------------------------------------------------------------------
# Removals
# --------------------------------------------------------------------------
def test_a_deleted_attachment_is_gone_when_the_event_arrives(world):
    store, records, corpus, app_db = world
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("kept.pdf"), report("removed.pdf")])
    run(store, records)
    settle(store)
    assert {"kept.pdf", "removed.pdf"} <= titles(found(store, Corpus.ADITYA))
    removed = next(
        a["fileId"]
        for a in app_db.submissions.find_one({"_id": sid})["attachments"]
        if a["name"] == "removed.pdf"
    )

    detach(app_db, sid, removed)
    sync.sync_source(store, records, "submission", str(sid))

    # Physically gone from the index, not merely filtered out of results.
    assert store.chunks.count_documents({"attachmentId": str(removed)}) == 0
    # The sync re-wrote kept.pdf's chunks too (delete, then insert), and the
    # search node indexes asynchronously: until it catches up, the unchanged
    # file is briefly unfindable. A freshness cost of syncing a whole record,
    # recorded in BUILD_NOTES, not hidden by searching too early.
    settle(store)
    hits = found(store, Corpus.ADITYA)
    assert "removed.pdf" not in titles(hits)
    assert "kept.pdf" in titles(hits)


def test_a_deleted_attachment_is_gone_when_the_event_is_lost(world):
    store, records, corpus, app_db = world
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("removed.pdf")])
    run(store, records)
    settle(store)
    assert "removed.pdf" in titles(found(store, Corpus.ADITYA))
    file_id = app_db.submissions.find_one({"_id": sid})["attachments"][0]["fileId"]

    detach(app_db, sid, file_id)  # and no sync: the event was dropped

    assert store.chunks.count_documents({"attachmentId": str(file_id)}) > 0, "the index still has it"
    assert "removed.pdf" not in titles(found(store, Corpus.ADITYA))


def test_after_a_mentorship_ends_nothing_from_it_is_returned(world):
    store, records, corpus, app_db = world
    corpus.submission(Corpus.M1, Corpus.ADITYA, text="My invalidation rule.", files=[report("mine.pdf")])
    run(store, records)
    settle(store)
    assert found(store, Corpus.ADITYA) and found(store, Corpus.PRIYA)

    app_db.mentorships.update_one({"_id": ObjectId(Corpus.M1)}, {"$set": {"status": "ended"}})
    sync.sync_mentorship(store, records, Corpus.M1)

    assert store.chunks.count_documents({"mentorshipId": Corpus.M1}) == 0
    assert found(store, Corpus.ADITYA) == [] and found(store, Corpus.PRIYA) == []
    assert store.chunks.count_documents({"mentorshipId": Corpus.M2}) > 0, "M2 was collateral"


def attach_to_brief(corpus, app_db, data, name, content_type):
    """What POST /api/assignments/:id/files does: bytes, then the record on the brief."""
    file_id = corpus.put_file(data, name)
    app_db.assignments.update_one(
        {"_id": corpus.assignment},
        {"$push": {"attachments": {"fileId": file_id, "name": name, "size": len(data),
                                   "contentType": content_type, "uploadedAt": tick()}},
         "$set": {"updatedAt": tick()}},
    )
    return file_id


def test_a_brief_file_is_searchable_by_everyone_it_was_set_for_and_a_deleted_one_disappears(world):
    """S8 prerequisite: an assignment's own files, indexed with the brief's viewers, and gone once removed."""
    store, records, corpus, app_db = world
    run(store, records)
    kept = attach_to_brief(corpus, app_db, *report("rubric-notes.pdf"))
    removed = attach_to_brief(corpus, app_db, *report("old-brief.pdf"))
    sync.sync_source(store, records, "assignment", str(corpus.assignment))
    settle(store)
    # The brief was set for both mentorships: each one's two parties find both files there.
    for mentorship, parties in ((Corpus.M1, (Corpus.ADITYA, Corpus.PRIYA)), (Corpus.M2, (Corpus.ZARA, Corpus.KARAN))):
        for party in parties:
            assert {"rubric-notes.pdf", "old-brief.pdf"} <= titles(found(store, party, mentorship=mentorship))
    # Nobody finds them through a mentorship they are not in.
    assert found(store, Corpus.ZARA, mentorship=Corpus.M1) == []

    # What DELETE /api/assignments/:id/files/:fileId does: record, then bytes, then the assignment's sync.
    app_db.assignments.update_one({"_id": corpus.assignment},
                                  {"$pull": {"attachments": {"fileId": removed}}, "$set": {"updatedAt": tick()}})
    gridfs.GridFSBucket(app_db, bucket_name="attachments").delete(removed)
    sync.sync_source(store, records, "assignment", str(corpus.assignment))

    assert store.chunks.count_documents({"attachmentId": str(removed)}) == 0
    assert store.chunks.count_documents({"attachmentId": str(kept)}) > 0
    settle(store)
    for mentorship, party in ((Corpus.M1, Corpus.ADITYA), (Corpus.M2, Corpus.ZARA)):
        hits = titles(found(store, party, mentorship=mentorship))
        assert "old-brief.pdf" not in hits and "rubric-notes.pdf" in hits


def test_deleting_an_assignment_removes_its_brief_hand_ins_and_files(world):
    """Only the assignment's own event: it alone must be enough."""
    store, records, corpus, app_db = world
    corpus.submission(Corpus.M1, Corpus.ADITYA, text="My invalidation rule.", files=[report("mine.pdf")])
    corpus.submission(Corpus.M2, Corpus.ZARA, text="")  # an empty hand-in with no chunks of its own
    run(store, records)
    assert {c["sourceType"] for c in store.chunks.find()} == {"assignment", "submission", "attachment"}

    for s in app_db.submissions.find({"assignment": corpus.assignment}):
        for a in s.get("attachments", []):
            gridfs.GridFSBucket(app_db, bucket_name="attachments").delete(a["fileId"])
    app_db.submissions.delete_many({"assignment": corpus.assignment})
    app_db.assignments.delete_one({"_id": corpus.assignment})
    sync.sync_source(store, records, "assignment", str(corpus.assignment))

    assert store.chunks.count_documents({}) == 0


# --------------------------------------------------------------------------
# Changes
# --------------------------------------------------------------------------
def test_unsubmit_keeps_the_hand_in_visible_to_both_and_a_draft_edit_replaces_it(world):
    """The replacement for the brief's unsubmit test. The mentor sees drafts in
    the app (S1.5 inventory), so the index must not hide them: after unsubmit
    both parties still retrieve the hand-in, and text edited during the draft
    replaces the old text once synced."""
    store, records, corpus, app_db = world
    sid = corpus.submission(
        Corpus.M1, Corpus.ADITYA, text="The invalidation rule clears the zebra cache.", files=[report("mine.pdf")]
    )
    run(store, records)
    settle(store)
    for party in (Corpus.ADITYA, Corpus.PRIYA):
        assert any("zebra" in h["content"] for h in found(store, party))

    app_db.submissions.update_one({"_id": sid}, {"$set": {"status": "draft", "updatedAt": tick()}})
    sync.sync_source(store, records, "submission", str(sid))
    settle(store)
    for party in (Corpus.ADITYA, Corpus.PRIYA):
        hits = found(store, party)
        assert any("zebra" in h["content"] for h in hits), f"{party} lost the unsubmitted text"
        assert "mine.pdf" in titles(hits)

    app_db.submissions.update_one(
        {"_id": sid},
        {"$set": {"text": "The invalidation rule clears the quartz cache.", "updatedAt": tick()}},
    )
    assert not any("zebra" in h["content"] for h in found(store, Corpus.ADITYA)), "old text before sync"
    sync.sync_source(store, records, "submission", str(sid))
    settle(store)
    for party in (Corpus.ADITYA, Corpus.PRIYA):
        hits = found(store, party)
        assert any("quartz" in h["content"] for h in hits)
        assert not any("zebra" in h["content"] for h in hits)


def test_edited_text_is_never_returned_old_and_is_returned_new_after_sync(world):
    store, records, corpus, app_db = world
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, text="The invalidation rule clears the zebra cache.")
    run(store, records)
    settle(store)
    assert any("zebra" in h["content"] for h in found(store, Corpus.ADITYA))

    app_db.submissions.update_one(
        {"_id": sid}, {"$set": {"text": "The invalidation rule clears the quartz cache.", "updatedAt": tick()}}
    )
    assert not any("zebra" in h["content"] for h in found(store, Corpus.ADITYA))

    sync.sync_source(store, records, "submission", str(sid))
    settle(store)
    hits = found(store, Corpus.ADITYA)
    assert any("quartz" in h["content"] for h in hits)
    assert not any("zebra" in h["content"] for h in hits)


# --------------------------------------------------------------------------
# Order, concurrency, failure
# --------------------------------------------------------------------------
def test_events_arriving_in_reverse_order_still_give_the_right_index(world):
    """An upload and its deletion, their events delivered deletion-first, the
    upload's arriving late. A delta design would re-add the file. A sync reads
    the record as it is when the event arrives, so the order cannot matter."""
    store, records, corpus, app_db = world
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, text="My invalidation rule.")
    run(store, records)
    data, name, kind = report("brief.pdf")

    file_id = attach(corpus, app_db, sid, data, name, kind)  # upload: its event delayed
    detach(app_db, sid, file_id)  # deletion
    sync.sync_source(store, records, "submission", str(sid))  # the deletion's event
    sync.sync_source(store, records, "submission", str(sid))  # the upload's, late

    after_events = index_state(store)
    store.drop_all()
    run(store, records)  # what a fresh index of the final state holds

    assert after_events == index_state(store)
    assert store.chunks.count_documents({"sourceType": "attachment"}) == 0


def test_two_syncs_of_one_source_at_once_leave_one_set(world):
    store, records, corpus, app_db = world
    sid = corpus.submission(
        Corpus.M1, Corpus.ADITYA, text="My invalidation rule.", files=[report("a.pdf"), report("b.pdf")]
    )
    run(store, records)
    expected = store.chunks.count_documents({})

    start = threading.Barrier(2)
    errors = []

    def go():
        start.wait()
        try:
            sync.sync_source(store, records, "submission", str(sid))
        except Exception as err:  # noqa: BLE001 - collected and asserted below
            errors.append(err)

    threads = [threading.Thread(target=go) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    keys = [
        (c["mentorshipId"], c["sourceType"], c["sourceId"], c["chunkIndex"]) for c in store.chunks.find()
    ]
    assert len(keys) == len(set(keys)), "duplicate chunks"
    assert len(keys) == expected


def test_a_corrupt_file_is_logged_its_old_chunks_removed_and_its_siblings_kept(world, caplog):
    store, records, corpus, app_db = world
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("good.pdf"), report("bad.pdf")])
    run(store, records)
    bad = next(
        a["fileId"] for a in app_db.submissions.find_one({"_id": sid})["attachments"] if a["name"] == "bad.pdf"
    )
    assert store.chunks.count_documents({"attachmentId": str(bad)}) > 0

    # The same file id, its bytes now unreadable.
    bucket = gridfs.GridFSBucket(app_db, bucket_name="attachments")
    bucket.delete(bad)
    bucket.upload_from_stream_with_id(bad, "bad.pdf", b"%PDF-1.7 this is no longer a pdf")

    with caplog.at_level(logging.WARNING):
        sync.sync_source(store, records, "submission", str(sid))

    assert "bad.pdf could not be read" in caplog.text
    assert store.chunks.count_documents({"attachmentId": str(bad)}) == 0
    assert store.chunks.count_documents({"title": "good.pdf"}) > 0


def snapshot(db):
    return {
        name: sorted(json_util.dumps(d, sort_keys=True) for d in db[name].find())
        for name in sorted(db.list_collection_names())
    }


def test_no_sync_writes_to_the_app_database(world):
    store, records, corpus, app_db = world
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("mine.pdf")])
    before = snapshot(app_db)

    sync.sync_source(store, records, "submission", str(sid))
    sync.sync_source(store, records, "assignment", str(corpus.assignment))
    sync.sync_mentorship(store, records, Corpus.M1)
    sync.sync_everything(store, records)

    assert store.chunks.count_documents({}) > 0
    assert snapshot(app_db) == before


# --------------------------------------------------------------------------
# The endpoint, the worker, and start-up
# --------------------------------------------------------------------------
SECRET = "sync-test-secret"


@pytest.fixture
def service(world, monkeypatch):
    import app as service_module

    store, records, corpus, app_db = world
    monkeypatch.setattr(service_module, "store", store)
    monkeypatch.setattr(service_module, "SERVICE_SECRET", SECRET)
    monkeypatch.setattr(service_module, "CATCHUP", "off")
    return service_module, world


def client(service_module, host="127.0.0.1"):
    return TestClient(service_module.app, client=(host, 50000))


def post(c, body, secret=SECRET):
    headers = {"X-AI-Secret": secret} if secret is not None else {}
    return c.post("/index/sync", json=body, headers=headers)


def test_the_endpoint_syncs_a_record_through_the_worker(service):
    service_module, (store, records, corpus, app_db) = service
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("mine.pdf")])

    with client(service_module) as c:
        response = post(c, {"sourceType": "submission", "sourceId": str(sid)})
        service_module.worker.wait_until_idle()

    assert response.status_code == 202
    settle(store)
    assert "mine.pdf" in titles(found(store, Corpus.ADITYA))


@pytest.mark.parametrize(
    "body,secret,host,status",
    [
        ({"sourceType": "submission", "sourceId": "a" * 24}, None, "127.0.0.1", 401),
        ({"sourceType": "submission", "sourceId": "a" * 24}, "wrong", "127.0.0.1", 401),
        ({"sourceType": "submission", "sourceId": "a" * 24}, SECRET, "10.0.0.5", 403),
        ({"sourceType": "message", "sourceId": "a" * 24}, SECRET, "127.0.0.1", 422),
        ({"sourceType": "submission", "sourceId": "not-an-id"}, SECRET, "127.0.0.1", 422),
        ({"sourceType": "submission", "sourceId": "a" * 24, "text": "injected"}, SECRET, "127.0.0.1", 422),
        ({"sourceType": "submission", "sourceId": "a" * 24, "content": "injected"}, SECRET, "127.0.0.1", 422),
        ({"sourceType": "submission", "sourceId": "a" * 24, "viewers": ["x"]}, SECRET, "127.0.0.1", 422),
        ({"mentorshipId": "a" * 24, "viewers": ["x"]}, SECRET, "127.0.0.1", 422),
    ],
    ids=[
        "no-secret",
        "wrong-secret",
        "not-localhost",
        "unknown-type",
        "malformed-id",
        "carries-text",
        "carries-content",
        "carries-viewers",
        "mentorship-with-viewers",
    ],
)
def test_the_endpoint_refuses(service, body, secret, host, status):
    service_module, (store, *_rest) = service

    with client(service_module, host) as c:
        response = post(c, body, secret)

    assert response.status_code == status
    assert store.chunks.count_documents({}) == 0


def test_the_endpoint_cannot_index_a_record_into_another_mentorship(service):
    """A record's mentorship comes from the record. Naming a different one
    alongside it is refused outright - and a record named alone is indexed
    only where it actually lives."""
    service_module, (store, records, corpus, app_db) = service
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("mine.pdf")])

    with client(service_module) as c:
        refused = post(c, {"sourceType": "submission", "sourceId": str(sid), "mentorshipId": Corpus.M2})
        accepted = post(c, {"sourceType": "submission", "sourceId": str(sid)})
        service_module.worker.wait_until_idle()

    assert refused.status_code == 422
    assert accepted.status_code == 202
    assert store.chunks.distinct("mentorshipId") == [Corpus.M1]


def test_start_up_catches_up_on_what_was_missed(service, monkeypatch):
    """Changes made while the service was down: a new hand-in to add, and a
    deleted one whose chunks are still in the index."""
    service_module, (store, records, corpus, app_db) = service
    gone = corpus.submission(Corpus.M1, Corpus.ADITYA, text="Soon deleted.")
    run(store, records)
    app_db.submissions.delete_one({"_id": gone})
    corpus.submission(Corpus.M1, Corpus.ADITYA, files=[report("while-down.pdf")])
    monkeypatch.setattr(service_module, "CATCHUP", "full")

    with client(service_module):
        service_module.worker.wait_until_idle()

    assert store.chunks.count_documents({"title": "while-down.pdf"}) > 0
    assert store.chunks.count_documents({"sourceId": str(gone)}) == 0


def test_the_worker_folds_waiting_duplicates_and_survives_a_failure(world, caplog):
    store, records, corpus, app_db = world
    sid = corpus.submission(Corpus.M1, Corpus.ADITYA, text="My invalidation rule.")
    worker = sync.SyncWorker(store, records)

    # Not started yet, so both wait - and the second is folded into the first.
    assert worker.submit(("source", "submission", str(sid))) is True
    assert worker.submit(("source", "submission", str(sid))) is False
    worker.submit(("nonsense",))
    worker.submit(("source", "goal", str(ObjectId())))

    with caplog.at_level(logging.ERROR, logger="sync"):
        worker.start()
        worker.wait_until_idle()
        worker.stop()

    assert "failed" in caplog.text, "the bad job was not reported"
    assert store.chunks.count_documents({"sourceId": str(sid)}) > 0, "the worker died on a bad job"
