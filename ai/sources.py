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

def _ids(value) -> str:
    return str(value)


def _attachment_bytes(db, file_id) -> bytes | None:
    """The stored bytes, or None with a reason logged.

    GridFS keeps the metadata and the bytes in two collections, so a file can
    be referenced by a record and still be missing — a half-finished upload, or
    a delete that removed the record's entry but not the row. Either way it is
    not something to crash an ingest run over.

    `db` is the app's database as `appdb.py` hands it out: read-only, GridFS
    included.
    """
    try:
        with db.open_download_stream(file_id) as stream:
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


# --------------------------------------------------------------------------
# The rules: whether a source is indexed, who sees it, and which version it is
# --------------------------------------------------------------------------
# One copy of each rule, called by three paths: the full walk (`documents`),
# the single-source sync (`source_documents`), and the read-time check in
# `store.search()`. A check that re-implemented these would agree with the
# indexer until the day one of them changed, and that day it would let through
# exactly the chunks it exists to stop.
#
# Every function here is pure over records already loaded - no database calls -
# so the read-time check can load a batch of records once and run the same
# rules over all of them.


def is_active(mentorship: dict | None) -> bool:
    """Only an active mentorship's material is indexed.

    Stricter than the app, which still shows an ended mentorship's content to
    both parties - an open S3 question, recorded in AGENT_PLAN.
    """
    return bool(mentorship) and mentorship.get("status") == "active"


def parties(mentorship: dict) -> list[str]:
    return [_ids(mentorship["student"]), _ids(mentorship["mentor"])]


def version_of(record: dict | None):
    """The record's last-update time, or None if it has none.

    Mongoose `timestamps: true` sets `updatedAt` on every save, and every route
    that writes an indexed record goes through `save()`, `create()` or
    `insertMany()` (checked in S1.5's inventory), so it moves on every write
    the app makes. Millisecond resolution: two different saves within one
    millisecond would share a version. Recorded, not engineered around.
    """
    return (record or {}).get("updatedAt")


def _later(own, inherited):
    """The later of a record's own version and one it inherits text from.

    The record's own version is required - without it there is nothing to
    compare against, and the chunk fails closed. The inherited one is optional:
    a hand-in whose assignment has gone still has its own history.
    """
    if own is None:
        return None
    return max(own, inherited) if inherited is not None else own


def assignment_entry(a: dict, mentorship: dict | None) -> dict | None:
    """The brief as one mentorship sees it, or None if it is not indexed there."""
    if not is_active(mentorship) or mentorship["_id"] not in a.get("mentorships", []):
        return None
    mid = _ids(mentorship["_id"])
    return {
        "mentorship_id": mid,
        "source_type": "assignment",
        "source_id": _ids(a["_id"]),
        "title": a.get("title", "Assignment"),
        "text": "\n\n".join(filter(None, [a.get("title", ""), a.get("instructions", "")])),
        "viewers": parties(mentorship),
        "visibility": "mentorship",
        "owner_id": None,
        "due_at": a.get("dueAt"),
        "version": version_of(a),
    }


def submission_parent(s: dict, assignment: dict | None, mentorship: dict | None) -> dict | None:
    """A hand-in's identity and audience, independent of whether it has text.

    Its files are indexed under this even when the text box is empty - an
    attached PDF is the whole hand-in in that case.
    """
    if not is_active(mentorship) or s.get("mentorship") != mentorship["_id"]:
        return None
    return {
        "mentorship_id": _ids(mentorship["_id"]),
        "parent_type": "submission",
        "parent_id": _ids(s["_id"]),
        "parent_title": f"Hand-in: {(assignment or {}).get('title', 'assignment')}",
        # Carried onto every chunk of the hand-in and its files, so deleting an
        # assignment can find them after the hand-ins themselves are gone.
        "assignment_id": _ids(s["assignment"]),
        # The student's own, and their mentor's. Not the other students' on
        # the same brief - which is why this is the submission's rule and not
        # the assignment's.
        "viewers": parties(mentorship),
        "visibility": "student",
        "owner_id": _ids(s["student"]),
    }


def submission_entry(s: dict, assignment: dict | None, mentorship: dict | None) -> dict | None:
    """The hand-in text and the mentor's review, or None if not indexed."""
    parent = submission_parent(s, assignment, mentorship)
    if parent is None:
        return None

    review = (s.get("review") or {}).get("note", "")
    body = "\n\n".join(
        filter(None, [s.get("text", ""), f"Mentor's review: {review}" if review else ""])
    )
    if not body.strip():
        return None

    return {
        "mentorship_id": parent["mentorship_id"],
        "source_type": "submission",
        "source_id": parent["parent_id"],
        "title": parent["parent_title"],
        "text": body,
        "viewers": parent["viewers"],
        "visibility": parent["visibility"],
        "owner_id": parent["owner_id"],
        "assignment_id": parent["assignment_id"],
        # The title comes from the assignment, so a renamed brief makes this
        # chunk stale even though the hand-in never changed. Taking the later
        # of the two versions is what lets the read-time check see that - and
        # S2 will put this title in a citation.
        "version": _later(version_of(s), version_of(assignment)),
    }


def goal_entry(g: dict, mentorship: dict | None) -> dict | None:
    """A goal with its milestones as the body. Archived goals stay indexed,
    because the app still shows them to both parties."""
    if not is_active(mentorship) or g.get("mentorship") != mentorship["_id"]:
        return None
    milestones = "\n".join(
        f"- {m.get('title', '')}" + (" (done)" if m.get("done") else "")
        for m in g.get("milestones", [])
    )
    return {
        "mentorship_id": _ids(mentorship["_id"]),
        "source_type": "goal",
        "source_id": _ids(g["_id"]),
        "title": g.get("title", "Goal"),
        "text": "\n\n".join(filter(None, [g.get("title", ""), milestones])),
        "viewers": parties(mentorship),
        "visibility": "mentorship",
        "owner_id": None,
        "version": version_of(g),
    }


def resource_entry(r: dict, mentorship: dict | None) -> dict | None:
    """The title and the note - never the page behind the link."""
    if not is_active(mentorship) or r.get("mentorship") != mentorship["_id"]:
        return None
    return {
        "mentorship_id": _ids(mentorship["_id"]),
        "source_type": "resource",
        "source_id": _ids(r["_id"]),
        "title": r.get("title", "Resource"),
        "text": "\n\n".join(filter(None, [r.get("title", ""), r.get("note", "")])),
        "viewers": parties(mentorship),
        "visibility": "mentorship",
        "owner_id": None,
        "url": r.get("url"),
        "version": version_of(r),
    }


def record_parent(source_type: str, record: dict, mentorship: dict | None, assignment=None):
    """The parent context any record type lends its attachments.

    Today only hand-ins carry files. Briefs and resources are walked anyway,
    with their own audience, so the day either gains uploads its files are
    indexed with that record's viewers rather than whatever the next person
    assumes.
    """
    if source_type == "submission":
        return submission_parent(record, assignment, mentorship)
    if source_type == "assignment":
        entry = assignment_entry(record, mentorship)
    elif source_type == "resource":
        entry = resource_entry(record, mentorship)
    else:
        return None
    if entry is None:
        return None
    return {
        "mentorship_id": entry["mentorship_id"],
        "parent_type": source_type,
        "parent_id": entry["source_id"],
        "parent_title": entry["title"],
        "viewers": entry["viewers"],
        "visibility": entry["visibility"],
        "owner_id": entry["owner_id"],
    }


def attachment_entries(record: dict, parent: dict | None) -> list[dict]:
    """Every extractable file on `record`, as index entries without their text.

    No bytes are read here, so the read-time check can call it per search. The
    version of an attachment is its upload time: a GridFS file is written once
    and never changed, so the only thing that can make its chunks stale is the
    file leaving the record, or the record leaving the index - both of which
    this function's answer already reflects.

    The parent's title is carried but not versioned. It comes from the
    assignment, and versioning these chunks by it would mean re-extracting
    every attached PDF whenever a brief's due date moved. Search fills it in
    from the live record instead (S1.5 step 2), so it can never be stale.
    """
    if parent is None:
        return []

    files = record.get("attachments") or []
    if len(files) > MAX_ATTACHMENTS_PER_RECORD:
        log.warning(
            "%s %s has %d attachments, more than the %d the route allows - "
            "indexing the first %d",
            parent["parent_type"],
            parent["parent_id"],
            len(files),
            MAX_ATTACHMENTS_PER_RECORD,
            MAX_ATTACHMENTS_PER_RECORD,
        )
        files = files[:MAX_ATTACHMENTS_PER_RECORD]

    entries = []
    for attachment in files:
        name = attachment.get("name") or "attachment"
        if attachment.get("contentType") not in EXTRACTABLE:
            log.info(
                "%s: %s is not a format this service reads yet - skipped",
                name,
                attachment.get("contentType"),
            )
            continue
        entries.append(
            {
                **parent,
                "source_type": "attachment",
                "source_id": _ids(attachment["fileId"]),
                "attachment_id": _ids(attachment["fileId"]),
                "file_id": attachment["fileId"],
                "content_type": attachment["contentType"],
                "title": name,
                "version": attachment.get("uploadedAt"),
            }
        )
    return entries


# --------------------------------------------------------------------------
# Reading the files
# --------------------------------------------------------------------------
def extract_attachment(db, entry: dict) -> dict | None:
    """Read and extract one attachment entry into an indexable document.

    None, with the reason logged, when there is nothing to index: bytes gone,
    over the size limit, unreadable, or a scan with no text layer.
    """
    name = entry["title"]
    data = _attachment_bytes(db, entry["file_id"])
    if data is None:
        return None

    try:
        extracted = EXTRACTABLE[entry["content_type"]](data, filename=name)
    except Exception as err:  # noqa: BLE001 - see below
        # Broad on purpose. A truncated PDF raises from PyMuPDF, a renamed zip
        # raises BadZipFile from python-docx, and a malformed part raises
        # something else again; the list is open-ended because the input is
        # anything a student can upload. Whatever it is, one bad file must not
        # end the run: that would skip reconciliation too, freezing every
        # deletion behind one student's broken upload.
        log.warning("%s could not be read (%s: %s) - skipped", name, type(err).__name__, err)
        return None

    if not extracted["sections"]:
        # A scan with no text layer lands here, having already logged that it
        # needs OCR. Zero chunks is the correct outcome, not an error: indexing
        # the filename alone would make an unreadable file look retrievable.
        log.info("%s: nothing to index (%s)", name, extracted.get("reason", ""))
        return None

    document = {key: value for key, value in entry.items() if key not in ("file_id", "content_type")}
    # Sections rather than one blob of text: a chunk must not span two of
    # them, and the chunker cannot honour that once they are joined.
    document["sections"] = extracted["sections"]
    document["file_kind"] = extracted["kind"]
    document["page_count"] = extracted.get("page_count")
    return document


def with_attachments(db, record: dict, parent: dict | None) -> Iterator[dict]:
    for entry in attachment_entries(record, parent):
        document = extract_attachment(db, entry)
        if document is not None:
            yield document


# --------------------------------------------------------------------------
# The full walk
# --------------------------------------------------------------------------
def _mentorship_map(db, mentorship_id: str | None) -> dict:
    query = {"status": "active"}
    if mentorship_id:
        query["_id"] = ObjectId(mentorship_id)
    return {m["_id"]: m for m in db.mentorships.find(query)}


def documents(db, mentorship_id: str | None = None) -> Iterator[dict]:
    """Yield one document per piece of text worth indexing.

    `db` is the app's database, read-only (`appdb.py`). The index is written
    elsewhere; nothing here can write back to where the records live.
    """
    mentorships = _mentorship_map(db, mentorship_id)
    if not mentorships:
        return

    oids = list(mentorships)

    # ---- Assignment briefs: shared by everyone the work was set for ----
    for a in db.assignments.find({"mentorships": {"$in": oids}}):
        for mid in a.get("mentorships", []):
            entry = assignment_entry(a, mentorships.get(mid))
            if entry is None:
                continue
            yield entry
            yield from with_attachments(db, a, record_parent("assignment", a, mentorships[mid]))

    # ---- Hand-ins and the reviews of them: the student's, and their mentor's ----
    assignments = {a["_id"]: a for a in db.assignments.find({"mentorships": {"$in": oids}})}
    for s in db.submissions.find({"mentorship": {"$in": oids}}):
        mentorship = mentorships.get(s["mentorship"])
        assignment = assignments.get(s["assignment"]) or db.assignments.find_one(
            {"_id": s["assignment"]}
        )
        entry = submission_entry(s, assignment, mentorship)
        if entry is not None:
            yield entry
        # Not skipped with the text: an empty hand-in may still have a file.
        yield from with_attachments(db, s, submission_parent(s, assignment, mentorship))

    # ---- Goals, with their milestones as the body ----
    for g in db.goals.find({"mentorship": {"$in": oids}}):
        entry = goal_entry(g, mentorships.get(g["mentorship"]))
        if entry is not None:
            yield entry

    # ---- Resources: the title and the note, never the page behind the link ----
    for r in db.resources.find({"mentorship": {"$in": oids}}):
        mentorship = mentorships.get(r["mentorship"])
        entry = resource_entry(r, mentorship)
        if entry is None:
            continue
        yield entry
        yield from with_attachments(db, r, record_parent("resource", r, mentorship))


# --------------------------------------------------------------------------
# One source
# --------------------------------------------------------------------------
SOURCE_TYPES = ("assignment", "submission", "goal", "resource")


def source_documents(db, source_type: str, source_id: str) -> list[dict]:
    """Everything one source should contribute to the index, as it is now.

    The same rules as the full walk, for one record: its text in every
    mentorship it belongs to (a brief can be set to several), and its files.
    An empty list means "nothing" - the record is gone, or no longer indexed -
    and a sync makes the index agree.
    """
    if source_type not in SOURCE_TYPES:
        raise ValueError(f"unknown source type {source_type!r}")

    oid = ObjectId(source_id)

    if source_type == "assignment":
        a = db.assignments.find_one({"_id": oid})
        if a is None:
            return []
        documents_ = []
        for mentorship in db.mentorships.find({"_id": {"$in": a.get("mentorships", [])}}):
            entry = assignment_entry(a, mentorship)
            if entry is None:
                continue
            documents_.append(entry)
            documents_.extend(with_attachments(db, a, record_parent("assignment", a, mentorship)))
        return documents_

    if source_type == "submission":
        s = db.submissions.find_one({"_id": oid})
        if s is None:
            return []
        mentorship = db.mentorships.find_one({"_id": s["mentorship"]})
        assignment = db.assignments.find_one({"_id": s["assignment"]})
        entry = submission_entry(s, assignment, mentorship)
        files = list(with_attachments(db, s, submission_parent(s, assignment, mentorship)))
        return ([entry] if entry else []) + files

    collection = db.goals if source_type == "goal" else db.resources
    record = collection.find_one({"_id": oid})
    if record is None:
        return []
    mentorship = db.mentorships.find_one({"_id": record["mentorship"]})
    if source_type == "goal":
        entry = goal_entry(record, mentorship)
        return [entry] if entry else []
    entry = resource_entry(record, mentorship)
    if entry is None:
        return []
    return [entry, *with_attachments(db, record, record_parent("resource", record, mentorship))]


# --------------------------------------------------------------------------
# The read-time check: what each candidate chunk's source says NOW
# --------------------------------------------------------------------------
# Used by store.search() on every query. Two functions, split so the database
# reads happen once per search, as a batch, and the verdicts are the same pure
# rules the indexer runs.


def _oid(value):
    try:
        return ObjectId(value)
    except Exception:  # noqa: BLE001 - a malformed id names no record
        return None


def load_records(db, hits: list[dict]) -> dict:
    """Load every record the candidates depend on: one query per collection.

    At most six round trips however many candidates there are - the
    candidates' records, their mentorships, and the assignments their hand-ins
    take a title from.
    """
    wanted = {"assignments": set(), "submissions": set(), "goals": set(), "resources": set()}
    collection_of = {
        "assignment": "assignments",
        "submission": "submissions",
        "goal": "goals",
        "resource": "resources",
    }
    mentorship_ids = set()

    for hit in hits:
        mentorship_ids.add(_oid(hit.get("mentorshipId")))
        if hit["sourceType"] == "attachment":
            wanted[collection_of.get(hit.get("parentType"), "submissions")].add(_oid(hit.get("parentId")))
        elif hit["sourceType"] in collection_of:
            wanted[collection_of[hit["sourceType"]]].add(_oid(hit["sourceId"]))

    def by_id(collection: str, ids: set) -> dict:
        ids = [i for i in ids if i is not None]
        return {r["_id"]: r for r in db[collection].find({"_id": {"$in": ids}})} if ids else {}

    loaded = {name: by_id(name, ids) for name, ids in wanted.items()}

    # A hand-in's title and version come from its assignment.
    missing = {s["assignment"] for s in loaded["submissions"].values()} - set(loaded["assignments"])
    loaded["assignments"].update(by_id("assignments", missing))
    loaded["mentorships"] = by_id("mentorships", mentorship_ids)
    return loaded


def current_entry(loaded: dict, hit: dict) -> tuple[dict | None, str | None]:
    """The entry the index should hold for this chunk's source, right now.

    Returns `(entry, None)` if the source is still indexed, or `(None, reason)`
    if it is not. The reasons are what the check logs, so a dropped chunk can
    always be explained.
    """
    mentorship = loaded["mentorships"].get(_oid(hit.get("mentorshipId")))
    source_type = hit["sourceType"]

    if source_type == "attachment":
        parent_type = hit.get("parentType") or "submission"
        collection = {"submission": "submissions", "assignment": "assignments", "resource": "resources"}.get(
            parent_type
        )
        record = loaded.get(collection, {}).get(_oid(hit.get("parentId"))) if collection else None
        if record is None:
            return None, "source gone"
        assignment = loaded["assignments"].get(record.get("assignment")) if parent_type == "submission" else None
        parent = record_parent(parent_type, record, mentorship, assignment)
        if parent is None:
            return None, "no longer indexed"
        for entry in attachment_entries(record, parent):
            if entry["source_id"] == hit["sourceId"]:
                return entry, None
        return None, "attachment removed"

    record = loaded.get(
        {"assignment": "assignments", "submission": "submissions", "goal": "goals", "resource": "resources"}.get(
            source_type, ""
        ),
        {},
    ).get(_oid(hit["sourceId"]))
    if record is None:
        return None, "source gone"

    if source_type == "assignment":
        entry = assignment_entry(record, mentorship)
    elif source_type == "submission":
        entry = submission_entry(record, loaded["assignments"].get(record.get("assignment")), mentorship)
    elif source_type == "goal":
        entry = goal_entry(record, mentorship)
    else:
        entry = resource_entry(record, mentorship)
    return (entry, None) if entry is not None else (None, "no longer indexed")
