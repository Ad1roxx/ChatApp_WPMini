"""Attachments: what gets indexed, who may see it, and what happens when it goes.

These run against the Atlas Local container, because the things worth asserting
here are about the database: GridFS holds the bytes, and reconciliation is a
query over what is in the index against what still exists. They never touch
`chatapp` or `chatapp_rag` — see `conftest.py`.

No vector index is created: nothing here searches. `replace_source` and
`reconcile` are ordinary reads and writes, so the assertions do not have to
wait for a search node to catch up.
"""

from __future__ import annotations

import io
import logging
from datetime import datetime

import gridfs
import pymupdf
import pytest
from bson import ObjectId
from docx import Document

import appdb
import sources
from ingest import run
from store import ChunkStore

pytestmark = pytest.mark.needs_mongo

PDF_TYPE = "application/pdf"
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

# Enough prose that extraction has something to keep: the composition filter
# drops short, list-shaped lines on purpose.
BRIEF = (
    "The submission must include an invalidation rule written as a comment, "
    "and a short explanation of which entries become stale when an item is "
    "added to the reading list. It should also describe what happens when two "
    "requests arrive together on a cold cache, which is the case that most "
    "implementations get wrong."
)
MARKING = (
    "Ten marks are available for the written explanation, and a further ten "
    "for the invalidation rule itself. Work handed in without a rule can score "
    "no more than half, however good the explanation beside it is."
)


# --------------------------------------------------------------------------
# Fixtures: a corpus with files in it
# --------------------------------------------------------------------------
def pdf_bytes(pages: list[str]) -> bytes:
    document = pymupdf.open()
    for text in pages:
        page = document.new_page()
        if text:
            page.insert_textbox(pymupdf.Rect(56, 56, 540, 760), text, fontsize=11)
    data = document.tobytes()
    document.close()
    return data


def docx_bytes(sections: list[tuple[str, str]]) -> bytes:
    document = Document()
    for heading, body in sections:
        document.add_heading(heading, level=1)
        document.add_paragraph(body)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


class Corpus:
    """Two mentorships with one hand-in each, and files attached to them.

    Deliberately symmetrical: M2 holds a near-identical document, so "the
    right chunks came back" and "only the right chunks came back" are
    different assertions.
    """

    M1 = "d00000000000000000000001"
    M2 = "d00000000000000000000002"
    PRIYA = "0000000000000000000000b1"  # mentor, M1
    ADITYA = "0000000000000000000000a1"  # student, M1
    KARAN = "0000000000000000000000b2"  # mentor, M2
    ZARA = "0000000000000000000000c2"  # student, M2

    def __init__(self, db):
        self.db = db
        self.bucket = gridfs.GridFSBucket(db, bucket_name="attachments")

        db.mentorships.insert_many(
            [
                {
                    "_id": ObjectId(self.M1),
                    "student": ObjectId(self.ADITYA),
                    "mentor": ObjectId(self.PRIYA),
                    "status": "active",
                },
                {
                    "_id": ObjectId(self.M2),
                    "student": ObjectId(self.ZARA),
                    "mentor": ObjectId(self.KARAN),
                    "status": "active",
                },
            ]
        )

        self.assignment = ObjectId()
        db.assignments.insert_one(
            {
                "_id": self.assignment,
                "title": "Caching exercise",
                "instructions": "Add caching to the reading list endpoint.",
                "mentorships": [ObjectId(self.M1), ObjectId(self.M2)],
                # What Mongoose's timestamps would have written. Whole seconds:
                # Mongo keeps milliseconds, and a fixture with microseconds
                # would not survive the round trip it is compared after.
                "createdAt": datetime(2026, 1, 1),
                "updatedAt": datetime(2026, 1, 1),
            }
        )

    def put_file(self, data: bytes, name: str) -> ObjectId:
        stream = self.bucket.open_upload_stream(name)
        with stream:
            stream.write(data)
        # `_id` rather than `file_id`: GridIn exposes the stored document's
        # fields, and the field is called _id.
        return stream._id

    def submission(
        self, mentorship: str, student: str, *, text: str = "My hand-in.", files=()
    ) -> ObjectId:
        attachments = []
        for data, name, content_type in files:
            attachments.append(
                {
                    "fileId": self.put_file(data, name),
                    "name": name,
                    "size": len(data),
                    "contentType": content_type,
                    "uploadedAt": datetime(2026, 1, 3),
                }
            )

        sid = ObjectId()
        self.db.submissions.insert_one(
            {
                "_id": sid,
                "assignment": self.assignment,
                "mentorship": ObjectId(mentorship),
                "student": ObjectId(student),
                "text": text,
                "attachments": attachments,
                "createdAt": datetime(2026, 1, 2),
                "updatedAt": datetime(2026, 1, 2),
            }
        )
        return sid


@pytest.fixture
def corpus(test_db):
    return Corpus(test_db)


@pytest.fixture
def store(test_db, mongo_uri):
    return ChunkStore(uri=mongo_uri, db_name=test_db.name)


def index_everything(store, mentorship_id=None) -> tuple[int, int]:
    """`ingest.run` itself, not a copy of it.

    The first version of this helper re-implemented the loop, and reconciled on
    every call. `ingest.py` did not: it returned early when nothing was
    indexed, so ending the last mentorship left its chunks behind - and every
    test here passed, because none of them ran the code that shipped.
    """
    # Records and chunks share the test database here; the code under test
    # still only gets a read-only view of the records, as it does in service.
    _, written, removed = run(store, appdb.wrap(store.db), mentorship_id)
    return written, removed


def attachment_chunks(store, **extra) -> list[dict]:
    return list(store.chunks.find({"sourceType": "attachment", **extra}))


# --------------------------------------------------------------------------
# What gets indexed
# --------------------------------------------------------------------------
def test_a_pdf_attachment_is_indexed_as_its_own_source(corpus, store):
    file_id = None
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "brief.pdf", PDF_TYPE)],
    )

    index_everything(store)
    chunks = attachment_chunks(store)

    assert chunks, "the PDF produced no chunks"
    assert {c["title"] for c in chunks} == {"brief.pdf"}
    assert {c["fileKind"] for c in chunks} == {"pdf"}
    # The source id is the GridFS file id, which is unique across the store —
    # so one file's chunks can be replaced or deleted on their own.
    file_id = store.db.submissions.find_one({})["attachments"][0]["fileId"]
    assert {c["sourceId"] for c in chunks} == {str(file_id)}
    assert "invalidation rule" in " ".join(c["content"] for c in chunks)


def test_a_chunk_records_where_in_the_file_it_came_from(corpus, store):
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[
            (
                pdf_bytes([f"Requirements\n\n{BRIEF}", f"Marking scheme\n\n{MARKING}"]),
                "brief.pdf",
                PDF_TYPE,
            )
        ],
    )

    index_everything(store)
    chunks = attachment_chunks(store)

    assert chunks
    for chunk in chunks:
        # A citation has to be actionable: the record a person can open, the
        # file inside it, and the page or section the text came from.
        assert chunk["parentType"] == "submission"
        assert chunk["parentId"]
        assert chunk["attachmentId"] == chunk["sourceId"]
        assert chunk["heading"]
        assert chunk["startPage"] is not None
    assert {c["heading"] for c in chunks} >= {"Requirements"}


def test_a_word_attachment_is_indexed_with_sections_and_no_pages(corpus, store):
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[
            (
                docx_bytes([("Requirements", BRIEF), ("Marking scheme", MARKING)]),
                "rubric.docx",
                DOCX_TYPE,
            )
        ],
    )

    index_everything(store)
    chunks = attachment_chunks(store)

    assert chunks
    assert {c["fileKind"] for c in chunks} == {"docx"}
    assert {c["heading"] for c in chunks} == {"Requirements", "Marking scheme"}
    # Word has no pages until something renders it, so a citation names the
    # section instead. The key still exists, which is what lets one chunker
    # serve both formats.
    assert {c["startPage"] for c in chunks} == {None}


def test_no_chunk_spans_two_sections_of_an_attachment(corpus, store):
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[
            (
                docx_bytes([("Requirements", BRIEF), ("Marking scheme", MARKING)]),
                "rubric.docx",
                DOCX_TYPE,
            )
        ],
    )

    index_everything(store)

    for chunk in attachment_chunks(store):
        if chunk["heading"] == "Requirements":
            assert "Ten marks are available" not in chunk["content"]
        else:
            assert "invalidation rule written as a comment" not in chunk["content"]


def test_an_empty_hand_in_with_a_file_is_still_indexed(corpus, store):
    """The regression this step had to avoid.

    A hand-in with no typed text used to be skipped before its attachments
    were ever looked at — and an attached PDF is the whole hand-in in that case.
    """
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        text="",
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "brief.pdf", PDF_TYPE)],
    )

    index_everything(store)

    assert store.chunks.count_documents({"sourceType": "submission"}) == 0
    assert attachment_chunks(store)


# --------------------------------------------------------------------------
# Who may see it
# --------------------------------------------------------------------------
def test_an_attachment_inherits_exactly_its_record_s_viewers(corpus, store):
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "brief.pdf", PDF_TYPE)],
    )

    index_everything(store)

    for chunk in attachment_chunks(store):
        assert sorted(chunk["viewers"]) == sorted([Corpus.ADITYA, Corpus.PRIYA])
        assert chunk["visibility"] == "student"
        assert chunk["ownerId"] == Corpus.ADITYA


def test_one_student_s_file_never_carries_another_student_as_a_viewer(corpus, store):
    """Both hand-ins are on the same brief, which is the case that goes wrong.

    The brief is shared; the files handed in against it are not.
    """
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "mine.pdf", PDF_TYPE)],
    )
    corpus.submission(
        Corpus.M2,
        Corpus.ZARA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "theirs.pdf", PDF_TYPE)],
    )

    index_everything(store)

    mine = attachment_chunks(store, title="mine.pdf")
    theirs = attachment_chunks(store, title="theirs.pdf")
    assert mine and theirs

    for chunk in mine:
        assert Corpus.ZARA not in chunk["viewers"]
        assert Corpus.KARAN not in chunk["viewers"]
        assert chunk["mentorshipId"] == Corpus.M1
    for chunk in theirs:
        assert Corpus.ADITYA not in chunk["viewers"]
        assert Corpus.PRIYA not in chunk["viewers"]
        assert chunk["mentorshipId"] == Corpus.M2


# --------------------------------------------------------------------------
# What is not indexed, and why
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    "name,content_type",
    [
        ("diagram.png", "image/png"),
        ("legacy.doc", "application/msword"),
        ("marks.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        ("archive.zip", "application/zip"),
        ("notes.txt", "text/plain; charset=utf-8"),
    ],
)
def test_a_format_without_an_extractor_is_skipped(corpus, store, caplog, name, content_type):
    corpus.submission(
        Corpus.M1, Corpus.ADITYA, files=[(b"not a document", name, content_type)]
    )

    with caplog.at_level(logging.INFO):
        index_everything(store)

    assert attachment_chunks(store) == []
    assert "not a format this service reads yet" in caplog.text


def test_a_scan_with_no_text_layer_produces_no_chunks_and_says_why(corpus, store, caplog):
    corpus.submission(
        Corpus.M1, Corpus.ADITYA, files=[(pdf_bytes(["", ""]), "scan.pdf", PDF_TYPE)]
    )

    with caplog.at_level(logging.INFO):
        index_everything(store)

    # Indexing the filename alone would make an unreadable file look
    # retrievable, which is worse than not indexing it.
    assert attachment_chunks(store) == []
    assert "needs OCR (S7)" in caplog.text


def test_an_attachment_whose_bytes_are_gone_is_skipped(corpus, store, caplog):
    """GridFS keeps the record and the bytes apart, so this really happens."""
    corpus.submission(Corpus.M1, Corpus.ADITYA, files=[])
    store.db.submissions.update_one(
        {},
        {
            "$set": {
                "attachments": [
                    {
                        "fileId": ObjectId(),
                        "name": "ghost.pdf",
                        "size": 1234,
                        "contentType": PDF_TYPE,
                        "uploadedAt": None,
                    }
                ]
            }
        },
    )

    with caplog.at_level(logging.WARNING):
        index_everything(store)

    assert attachment_chunks(store) == []
    assert "its bytes are gone" in caplog.text


def test_a_file_over_the_size_limit_is_skipped(corpus, store, caplog, monkeypatch):
    """The route caps uploads at 10 MB; this service does not trust that.

    The limit is lowered for the test rather than writing 10 MB into GridFS:
    what is being asserted is that the length is checked before the bytes are
    read, and the real number is the route's, asserted separately below.
    """
    monkeypatch.setattr(sources, "MAX_ATTACHMENT_BYTES", 1024)
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "huge.pdf", PDF_TYPE)],
    )

    with caplog.at_level(logging.WARNING):
        index_everything(store)

    assert attachment_chunks(store) == []
    assert "over the" in caplog.text


def test_the_limits_match_the_upload_route_s():
    """Repeated from server/lib/fileStore.js, so a drift shows up here."""
    assert sources.MAX_ATTACHMENT_BYTES == 10 * 1024 * 1024
    assert sources.MAX_ATTACHMENTS_PER_RECORD == 5


def test_more_files_than_the_route_allows_are_truncated(corpus, store, caplog):
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[
            (pdf_bytes([f"Requirements\n\n{BRIEF}"]), f"brief-{n}.pdf", PDF_TYPE)
            for n in range(7)
        ],
    )

    with caplog.at_level(logging.WARNING):
        index_everything(store)

    titles = {c["title"] for c in attachment_chunks(store)}
    assert len(titles) == sources.MAX_ATTACHMENTS_PER_RECORD
    assert "more than the 5 the route allows" in caplog.text


# --------------------------------------------------------------------------
# Reconciliation: what happens when a source goes away
# --------------------------------------------------------------------------
def test_removing_an_attachment_removes_its_chunks(corpus, store):
    sid = corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[
            (pdf_bytes([f"Requirements\n\n{BRIEF}"]), "kept.pdf", PDF_TYPE),
            (pdf_bytes([f"Marking scheme\n\n{MARKING}"]), "removed.pdf", PDF_TYPE),
        ],
    )
    index_everything(store)
    assert attachment_chunks(store, title="removed.pdf")

    store.db.submissions.update_one(
        {"_id": sid}, {"$pull": {"attachments": {"name": "removed.pdf"}}}
    )
    _, removed = index_everything(store)

    assert removed > 0
    assert attachment_chunks(store, title="removed.pdf") == []
    assert attachment_chunks(store, title="kept.pdf"), "the other file was collateral"


def test_deleting_a_hand_in_removes_its_text_and_its_files(corpus, store):
    sid = corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        text="My hand-in, with a file attached to it as well.",
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "brief.pdf", PDF_TYPE)],
    )
    index_everything(store)
    assert store.chunks.count_documents({"sourceType": "submission"}) > 0
    assert attachment_chunks(store)

    store.db.submissions.delete_one({"_id": sid})
    index_everything(store)

    assert store.chunks.count_documents({"sourceType": "submission"}) == 0
    assert attachment_chunks(store) == []


def test_deleting_a_mentorship_removes_everything_in_it(corpus, store):
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "mine.pdf", PDF_TYPE)],
    )
    corpus.submission(
        Corpus.M2,
        Corpus.ZARA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "theirs.pdf", PDF_TYPE)],
    )
    index_everything(store)
    assert store.chunks.count_documents({"mentorshipId": Corpus.M1}) > 0

    store.db.mentorships.delete_one({"_id": ObjectId(Corpus.M1)})
    index_everything(store)

    # A full run reconciles the whole index for exactly this case: a mentorship
    # that is gone cannot appear in a list derived from the ones that remain.
    assert store.chunks.count_documents({"mentorshipId": Corpus.M1}) == 0
    assert store.chunks.count_documents({"mentorshipId": Corpus.M2}) > 0


def test_an_ended_mentorship_is_reconciled_away_too(corpus, store):
    """Only active mentorships are indexed, so ending one must empty it."""
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "mine.pdf", PDF_TYPE)],
    )
    index_everything(store)
    assert store.chunks.count_documents({"mentorshipId": Corpus.M1}) > 0

    store.db.mentorships.update_one(
        {"_id": ObjectId(Corpus.M1)}, {"$set": {"status": "ended"}}
    )
    index_everything(store, Corpus.M2)

    assert store.chunks.count_documents({"mentorshipId": Corpus.M1}) > 0, (
        "a run scoped to M2 must not delete M1's chunks"
    )

    index_everything(store)
    assert store.chunks.count_documents({"mentorshipId": Corpus.M1}) == 0


def test_a_brief_shared_by_two_mentorships_is_two_sources(corpus, store):
    """Why reconciliation keys on the mentorship as well as the source.

    The seeded brief is set to both mentorships, so it is one record and two
    sources with the same id. Keying on type and id alone made the live copy
    vouch for the dead one, and ending one mentorship left its chunks in the
    index. This is the test that found it.
    """
    index_everything(store)
    briefs = list(store.chunks.find({"sourceType": "assignment"}))

    assert {c["mentorshipId"] for c in briefs} == {Corpus.M1, Corpus.M2}
    assert len({c["sourceId"] for c in briefs}) == 1

    store.db.mentorships.delete_one({"_id": ObjectId(Corpus.M2)})
    index_everything(store)

    remaining = list(store.chunks.find({"sourceType": "assignment"}))
    assert {c["mentorshipId"] for c in remaining} == {Corpus.M1}


def test_ending_the_last_active_mentorship_removes_its_chunks(corpus, store):
    """The case the early return in ingest.py got wrong.

    With every mentorship ended, a run finds nothing to index - and nothing to
    index is exactly when reconciliation has the most to delete.
    """
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "mine.pdf", PDF_TYPE)],
    )
    index_everything(store)
    assert store.chunks.count_documents({}) > 0

    store.db.mentorships.update_many({}, {"$set": {"status": "ended"}})
    _, removed = index_everything(store)

    assert removed > 0
    assert store.chunks.count_documents({}) == 0


def test_a_run_scoped_to_an_ended_mentorship_removes_its_chunks(corpus, store):
    """`--mentorship <id>` on a mentorship that has ended finds nothing, and
    must still empty it - while leaving every other mentorship alone."""
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "mine.pdf", PDF_TYPE)],
    )
    index_everything(store)
    other = store.chunks.count_documents({"mentorshipId": Corpus.M2})
    assert store.chunks.count_documents({"mentorshipId": Corpus.M1}) > 0

    store.db.mentorships.update_one(
        {"_id": ObjectId(Corpus.M1)}, {"$set": {"status": "ended"}}
    )
    index_everything(store, Corpus.M1)

    assert store.chunks.count_documents({"mentorshipId": Corpus.M1}) == 0
    assert store.chunks.count_documents({"mentorshipId": Corpus.M2}) == other


@pytest.mark.parametrize(
    "name,content_type",
    [("broken.pdf", PDF_TYPE), ("broken.docx", DOCX_TYPE)],
)
def test_a_corrupt_file_is_skipped_without_stopping_the_run(
    corpus, store, caplog, name, content_type
):
    """One student's broken upload must not take the index down for everyone.

    Before this, an exception from the extractor ended the run before
    reconciliation, so a single bad file also froze every deletion.
    """
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[
            (b"%PDF-1.7 this is not really a pdf", name, content_type),
            (pdf_bytes([f"Requirements\n\n{BRIEF}"]), "fine.pdf", PDF_TYPE),
        ],
    )

    with caplog.at_level(logging.WARNING):
        index_everything(store)

    titles = {c["title"] for c in attachment_chunks(store)}
    assert titles == {"fine.pdf"}
    assert "could not be read" in caplog.text


def test_a_scoped_run_never_deletes_another_mentorship_s_chunks(corpus, store):
    """The reason `reconcile` takes a scope at all.

    A run that visited one mentorship has no evidence about any other, and
    deleting on the strength of a partial view would empty the index one
    mentorship at a time.
    """
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "mine.pdf", PDF_TYPE)],
    )
    corpus.submission(
        Corpus.M2,
        Corpus.ZARA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "theirs.pdf", PDF_TYPE)],
    )
    index_everything(store)
    before = store.chunks.count_documents({"mentorshipId": Corpus.M2})

    written, removed = index_everything(store, Corpus.M1)

    assert removed == 0
    assert store.chunks.count_documents({"mentorshipId": Corpus.M2}) == before


def test_reconciliation_keeps_a_source_that_produced_no_chunks(corpus, store):
    """A brief emptied to nothing still exists, and must not look deleted."""
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        text="My hand-in.",
        files=[(pdf_bytes(["", ""]), "scan.pdf", PDF_TYPE)],
    )

    index_everything(store)
    _, removed = index_everything(store)

    assert removed == 0
    assert store.chunks.count_documents({"sourceType": "submission"}) > 0


def test_every_chunk_records_the_model_that_embedded_it(corpus, store):
    """What lets a search by a different model be refused instead of answered."""
    from config import EMBEDDING_MODEL

    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "brief.pdf", PDF_TYPE)],
    )
    index_everything(store)

    assert store.chunks.distinct("embeddingModel") == [EMBEDDING_MODEL]
    assert store.chunks.count_documents({"embeddingModel": {"$exists": False}}) == 0


def test_re_indexing_twice_leaves_the_same_index(corpus, store):
    corpus.submission(
        Corpus.M1,
        Corpus.ADITYA,
        files=[(pdf_bytes([f"Requirements\n\n{BRIEF}"]), "brief.pdf", PDF_TYPE)],
    )

    first, _ = index_everything(store)
    count = store.chunks.count_documents({})
    second, removed = index_everything(store)

    assert (first, removed) == (second, 0)
    assert store.chunks.count_documents({}) == count
