"""Turning application data into documents worth retrieving.

Only first-party text is indexed — things a person in the mentorship actually
wrote. Resources are links with a short note, so they contribute a title and a
note rather than the page behind them; fetching arbitrary URLs from the server
would be an SSRF hole for very little retrieval value.

## Who may see a chunk

Every document carries `viewers`: the user ids allowed to retrieve it. Two
shapes:

- **Shared** — an assignment brief, a goal, a resource. Both parties.
- **A student's own** — their hand-in text and the mentor's review of it. The
  student and their mentor, nobody else. A mentorship can have one student, but
  the same brief goes to several, and one student's hand-in is not the others'
  to read.

`viewers` is denormalised from the mentorship on purpose: it makes the filter a
single `$in` inside the vector query. It is the second lock, not the first —
Express checks mentorship membership before this service is ever called.

## Attachments

A record's attached PDFs and Word files are indexed as **separate documents**,
one per file, identified by the GridFS file id. They inherit the viewers of the
record they hang off, computed by that record's own rule rather than assumed to
be the same for all three — a hand-in's attachment is the student's and their
mentor's, an assignment's would be the whole mentorship's.

The walk is written against the shape of `attachmentSchema`, not against
submissions: today only submissions carry files, so the assignment and resource
calls yield nothing, and the day either gains uploads this file needs no change.
A hand-in with no typed text but a PDF attached used to produce no document at
all; now it produces one per file.
"""

from __future__ import annotations

import logging
from typing import Iterator

import gridfs
from bson import ObjectId

from extract import extract_docx, extract_pdf

log = logging.getLogger(__name__)

# The content types this service can read. Keyed by `contentType`, which the
# server decides from the extension and never takes from the upload
# (server/lib/fileStore.js) — so it is a fact about the file rather than a
# claim by whoever sent it.
#
# Everything else the allow-list permits is skipped with a reason: .doc is a
# different format from .docx and python-docx cannot read it, spreadsheets and
# slides have no extractor yet, and images need the OCR of S7.
EXTRACTABLE = {
    "application/pdf": extract_pdf,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": extract_docx,
}

# The server's own limits, repeated here as a floor rather than trusted.
# The upload route enforces both (server/lib/fileStore.js: MAX_FILE_BYTES,
# MAX_FILES_PER_SUBMISSION), but this service reads whatever is in the
# database — including rows written before a limit existed, or by a seeder.
# Extraction allocates on the order of the file size, so an unbounded read
# here is how one oversized row takes out an ingest run.
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_ATTACHMENTS_PER_RECORD = 5

ATTACHMENTS_BUCKET = "attachments"


def _ids(value) -> str:
    return str(value)


def _attachment_bytes(db, file_id) -> bytes | None:
    """The stored bytes, or None with a reason logged.

    GridFS keeps the metadata and the bytes in two collections, so a file can
    be referenced by a record and still be missing — a half-finished upload, or
    a delete that removed the record's entry but not the row. Either way it is
    not something to crash an ingest run over.
    """
    bucket = gridfs.GridFSBucket(db, bucket_name=ATTACHMENTS_BUCKET)
    try:
        with bucket.open_download_stream(file_id) as stream:
            if stream.length > MAX_ATTACHMENT_BYTES:
                log.warning(
                    "attachment %s is %.1f MB, over the %d MB limit - skipped",
                    file_id,
                    stream.length / (1024 * 1024),
                    MAX_ATTACHMENT_BYTES // (1024 * 1024),
                )
                return None
            return stream.read()
    except gridfs.NoFile:
        log.warning("attachment %s is referenced but its bytes are gone", file_id)
        return None


def attachment_documents(
    db,
    record: dict,
    *,
    mentorship_id: str,
    parent_type: str,
    parent_id: str,
    parent_title: str,
    viewers: list[str],
    visibility: str,
    owner_id: str | None,
) -> Iterator[dict]:
    """One document per extractable file attached to `record`.

    `source_type` is "attachment" and `source_id` is the GridFS file id, which
    is unique across the whole store — so re-indexing one file replaces exactly
    its own chunks, and deleting it leaves nothing behind that reconciliation
    cannot find.
    """
    files = record.get("attachments") or []

    if len(files) > MAX_ATTACHMENTS_PER_RECORD:
        log.warning(
            "%s %s has %d attachments, more than the %d the route allows - "
            "indexing the first %d",
            parent_type,
            parent_id,
            len(files),
            MAX_ATTACHMENTS_PER_RECORD,
            MAX_ATTACHMENTS_PER_RECORD,
        )
        files = files[:MAX_ATTACHMENTS_PER_RECORD]

    for attachment in files:
        name = attachment.get("name") or "attachment"
        extractor = EXTRACTABLE.get(attachment.get("contentType"))
        if extractor is None:
            log.info(
                "%s: %s is not a format this service reads yet - skipped",
                name,
                attachment.get("contentType"),
            )
            continue

        data = _attachment_bytes(db, attachment["fileId"])
        if data is None:
            continue

        try:
            extracted = extractor(data, filename=name)
        except Exception as err:  # noqa: BLE001 - see below
            # Broad on purpose. A truncated PDF raises from PyMuPDF, a renamed
            # zip raises BadZipFile from python-docx, and a malformed part
            # raises something else again; the list is open-ended because the
            # input is anything a student can upload. Whatever it is, one bad
            # file must not end the run: that would skip reconciliation too,
            # freezing every deletion behind one student's broken upload.
            log.warning(
                "%s could not be read (%s: %s) - skipped",
                name,
                type(err).__name__,
                err,
            )
            continue

        if not extracted["sections"]:
            # A scan with no text layer lands here, having already logged that
            # it needs OCR. Zero chunks is the correct outcome, not an error:
            # indexing the filename alone would make an unreadable file look
            # retrievable.
            log.info("%s: nothing to index (%s)", name, extracted.get("reason", ""))
            continue

        yield {
            "mentorship_id": mentorship_id,
            "source_type": "attachment",
            "source_id": _ids(attachment["fileId"]),
            "title": name,
            # Sections rather than one blob of text: a chunk must not span two
            # of them, and the chunker cannot honour that once they are joined.
            "sections": extracted["sections"],
            "viewers": viewers,
            "visibility": visibility,
            "owner_id": owner_id,
            # Where a citation points. The parent is what a person can open;
            # the attachment id is which file, and the section carries the page.
            "parent_type": parent_type,
            "parent_id": parent_id,
            "parent_title": parent_title,
            "attachment_id": _ids(attachment["fileId"]),
            "file_kind": extracted["kind"],
            "page_count": extracted.get("page_count"),
        }


def _mentorship_map(db, mentorship_id: str | None) -> dict[str, dict]:
    query = {"status": "active"}
    if mentorship_id:
        query["_id"] = ObjectId(mentorship_id)
    return {_ids(m["_id"]): m for m in db.mentorships.find(query)}


def documents(db, mentorship_id: str | None = None) -> Iterator[dict]:
    """Yield one document per piece of text worth indexing."""
    mentorships = _mentorship_map(db, mentorship_id)
    if not mentorships:
        return

    oids = [ObjectId(mid) for mid in mentorships]

    def parties(mid: str) -> list[str]:
        m = mentorships[mid]
        return [_ids(m["student"]), _ids(m["mentor"])]

    # ---- Assignment briefs: shared by everyone the work was set for ----
    for a in db.assignments.find({"mentorships": {"$in": oids}}):
        body = "\n\n".join(filter(None, [a.get("title", ""), a.get("instructions", "")]))
        for mid_obj in a.get("mentorships", []):
            mid = _ids(mid_obj)
            if mid not in mentorships:
                continue
            yield {
                "mentorship_id": mid,
                "source_type": "assignment",
                "source_id": _ids(a["_id"]),
                "title": a.get("title", "Assignment"),
                "text": body,
                "viewers": parties(mid),
                "visibility": "mentorship",
                "owner_id": None,
                "due_at": a.get("dueAt"),
            }
            # A brief has no attachment field today. The call is here so that
            # the day it gains one, its files are indexed with the brief's own
            # viewers rather than with whatever the next person assumes.
            yield from attachment_documents(
                db,
                a,
                mentorship_id=mid,
                parent_type="assignment",
                parent_id=_ids(a["_id"]),
                parent_title=a.get("title", "Assignment"),
                viewers=parties(mid),
                visibility="mentorship",
                owner_id=None,
            )

    # ---- Hand-ins and the reviews of them: the student's, and their mentor's ----
    for s in db.submissions.find({"mentorship": {"$in": oids}}):
        mid = _ids(s["mentorship"])
        if mid not in mentorships:
            continue

        review = (s.get("review") or {}).get("note", "")
        body = "\n\n".join(
            filter(None, [s.get("text", ""), f"Mentor's review: {review}" if review else ""])
        )
        assignment = db.assignments.find_one({"_id": s["assignment"]}) or {}
        title = f"Hand-in: {assignment.get('title', 'assignment')}"

        # An empty hand-in yields no text document - but it may still have a
        # PDF attached, which in that case is the whole hand-in. The `continue`
        # that used to sit here skipped the files along with the text.
        if body.strip():
            yield {
                "mentorship_id": mid,
                "source_type": "submission",
                "source_id": _ids(s["_id"]),
                "title": title,
                "text": body,
                "viewers": parties(mid),
                "visibility": "student",
                "owner_id": _ids(s["student"]),
            }

        # The student's own, and their mentor's. Not the other students' on the
        # same brief - which is why this uses the submission's rule rather than
        # the assignment's.
        yield from attachment_documents(
            db,
            s,
            mentorship_id=mid,
            parent_type="submission",
            parent_id=_ids(s["_id"]),
            parent_title=title,
            viewers=parties(mid),
            visibility="student",
            owner_id=_ids(s["student"]),
        )

    # ---- Goals, with their milestones as the body ----
    for g in db.goals.find({"mentorship": {"$in": oids}}):
        mid = _ids(g["mentorship"])
        if mid not in mentorships:
            continue

        milestones = "\n".join(
            f"- {m.get('title', '')}" + (" (done)" if m.get("done") else "")
            for m in g.get("milestones", [])
        )
        yield {
            "mentorship_id": mid,
            "source_type": "goal",
            "source_id": _ids(g["_id"]),
            "title": g.get("title", "Goal"),
            "text": "\n\n".join(filter(None, [g.get("title", ""), milestones])),
            "viewers": parties(mid),
            "visibility": "mentorship",
            "owner_id": None,
        }

    # ---- Resources: the title and the note, never the page behind the link ----
    for r in db.resources.find({"mentorship": {"$in": oids}}):
        mid = _ids(r["mentorship"])
        if mid not in mentorships:
            continue

        yield {
            "mentorship_id": mid,
            "source_type": "resource",
            "source_id": _ids(r["_id"]),
            "title": r.get("title", "Resource"),
            "text": "\n\n".join(filter(None, [r.get("title", ""), r.get("note", "")])),
            "viewers": parties(mid),
            "visibility": "mentorship",
            "owner_id": None,
            "url": r.get("url"),
        }
        # Same as the brief: no attachment field yet, and the seam belongs here
        # rather than in a future reader's head. The page behind the link is
        # still never fetched - an uploaded file is not an arbitrary URL.
        yield from attachment_documents(
            db,
            r,
            mentorship_id=mid,
            parent_type="resource",
            parent_id=_ids(r["_id"]),
            parent_title=r.get("title", "Resource"),
            viewers=parties(mid),
            visibility="mentorship",
            owner_id=None,
        )
