"""Build the synthetic attachments the evaluation needs, and attach them.

    cd ai && .venv/Scripts/python.exe eval/seed_documents.py

Run after `node scripts/seed-rag-corpus.cjs`, which seeds the records this
attaches to. Idempotent: it clears the attachment store and every record's
attachment list before writing, so running it twice leaves one set of files.

## Why the documents are synthetic, and why they are built here

Real coursework is the wrong fixture: it cannot be committed, cannot be
regenerated, and the moment an answer depends on a file nobody else has, a
measurement stops being reproducible. These are invented, written to be
*answerable* — each carries a fact that appears nowhere else in the corpus, so
a question about it can only be answered by retrieving the right part of the
right file.

They are built in Python because writing a PDF needs PyMuPDF, which this
service already depends on. The seeder is Node; a second PDF writer there,
bought for test fixtures, would be a worse trade than crossing the boundary
once.

## What is deliberately in here

- **Multi-page PDFs with headings**, so a chunk can be wrong about its page or
  its section and be caught.
- **A table**, because a rubric is a table and S8 has to read one. In a PDF a
  table arrives flattened, which is exactly why one is here rather than
  assumed to work.
- **Word documents**, whose headings come from styles rather than from shape.
- **A scan with no text layer**, which must produce zero chunks and say it
  needs OCR. Generated as text rendered to an image, so the file really has no
  text layer rather than an empty one.
- **The same topic in both mentorships**, in similar words, so a leak across
  the permission filter would look like a good answer rather than an obvious
  bug.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gridfs  # noqa: E402
import pymupdf  # noqa: E402
from bson import ObjectId  # noqa: E402
from docx import Document  # noqa: E402
from pymongo import MongoClient  # noqa: E402

from config import EVAL_DB_NAME, MONGODB_URI  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import s2_documents  # noqa: E402

PDF_TYPE = "application/pdf"
DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

M1 = "d00000000000000000000001"
M2 = "d00000000000000000000002"


# --------------------------------------------------------------------------
# Building files
# --------------------------------------------------------------------------
def pdf(pages: list[str], *, heading_size: float = 15) -> bytes:
    """A text PDF, one page per string, wrapped into the text box.

    Each page's first line is its heading, set at `heading_size` over an 11 pt
    body - the way a report exported from a word processor sets them, and what
    the extractor reads a heading from (Entry 61). At 11 the heading is
    indistinguishable from the body, which is what a plain-text export does.
    """
    document = pymupdf.open()
    for text in pages:
        page = document.new_page()
        heading, _, body = text.partition("\n")
        if heading_size == 11:
            page.insert_textbox(pymupdf.Rect(56, 56, 540, 760), text, fontsize=11)
            continue
        spare = page.insert_textbox(pymupdf.Rect(56, 56, 540, 760), heading, fontsize=heading_size)
        top = 760 - spare + heading_size
        page.insert_textbox(pymupdf.Rect(56, top, 540, 760), body.strip("\n"), fontsize=11)
    data = document.tobytes()
    document.close()
    return data


def scanned_pdf(pages: list[str]) -> bytes:
    """A PDF of IMAGES of text: pages, no text layer, nothing to extract.

    Rendered from a text page and re-inserted as a picture. Greyscale at 96 DPI
    for a reason the first attempt found the hard way: at 150 DPI in colour the
    two pages came to **12.5 MB**, over the upload route's 10 MB limit, so the
    pipeline skipped it for size and never reached the question being asked.
    The size guard working is worth knowing; it is not what this fixture is for.

    S7's OCR evaluation will need harsher scans than this — lower resolution
    still, a slight rotation, noise — and the plan says so, because a pipeline
    tuned on a clean render will flatter itself.
    """
    source = pymupdf.open()
    for text in pages:
        page = source.new_page()
        page.insert_textbox(pymupdf.Rect(56, 56, 540, 760), text, fontsize=13)

    out = pymupdf.open()
    for page in source:
        pixmap = page.get_pixmap(dpi=96, colorspace=pymupdf.csGRAY)
        target = out.new_page(width=page.rect.width, height=page.rect.height)
        target.insert_image(page.rect, pixmap=pixmap)
    data = out.tobytes()
    source.close()
    out.close()
    return data


def docx(blocks: list[tuple[str, object]]) -> bytes:
    """A Word document. A string body is a paragraph; a list is a table."""
    document = Document()
    for heading, body in blocks:
        document.add_heading(heading, level=1)
        if isinstance(body, str):
            document.add_paragraph(body)
        else:
            table = document.add_table(rows=0, cols=len(body[0]))
            for row in body:
                cells = table.add_row().cells
                for cell, value in zip(cells, row):
                    cell.text = value
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


# --------------------------------------------------------------------------
# The documents
# --------------------------------------------------------------------------
# Each paragraph is long enough to survive extraction: the composition filter
# drops short, list-shaped lines, because in a real PDF those are page
# furniture rather than prose.
# Headings are plain words, set larger than the body. Until S2 they were
# numbered, because a PDF heading could only be recognised from a coursework
# word or a number, and an unnumbered "Method" was invisible (Entry 50). The
# extractor now reads the type size (Entry 61), so the fixture looks like a
# real student report: unnumbered, and none of these headings in the
# coursework vocabulary.
INDEXING_REPORT = pdf(
    [
        """Method

Every query was run with EXPLAIN before and after the index was added, and the
plan recorded in full rather than summarised. The row counts below come from
the executionStats block, not from timings, because timings on a laptop under
a build are noise dressed up as evidence.

Three queries were in scope: the member lookup by status, the feed query by
author and date, and the report that filters on created date alone.""",
        """Query plans

The member lookup went from a collection scan over forty eight thousand
documents to an index scan returning twelve. That is the only query where the
index changed the plan shape rather than merely the cost.

The feed query was already using the index on author, and adding the created
date to it made the sort disappear from the plan. The report query on created
date alone did not improve at all, because the compound index begins with
author and the prefix rule means a query on the second field cannot use it.""",
        """Results

The third query is the one worth keeping: it is slow, it stays slow, and the
honest fix is a second index on created date rather than pretending the
existing one helps. An index nothing uses still costs a write on every insert,
so the decision is whether the report is run often enough to pay for it.

Conclusion: two of the three queries improved, and the compound index on
status and created date is the one to keep.""",
    ]
)

CACHE_NOTES = pdf(
    [
        """Invalidation rule

Adding an item to a reading list clears the cached list for that user and
nothing else, because the endpoint is per-user and no other key can contain
the new item. Deleting an item does the same. Editing the title of an item
clears both the list and the item's own entry.

The rule is written here rather than inferred from the code, because a cache
whose invalidation nobody can state is a bug that has not been met yet.""",
        """Time to live

The table below is the decision, not a default copied from a tutorial. A TTL
is a statement about how wrong the endpoint is willing to be.

Endpoint         TTL      Why
reading list     60s      a stale list is visible and harmless
item detail      300s     edited rarely, read often
search results   0s       never cached, the query space is unbounded

Two requests arriving together on a cold cache both reach the database. The
fix is to cache the pending promise rather than the finished value, so the
second caller waits on the first rather than starting its own query.""",
    ]
)

AUTH_DESIGN = docx(
    [
        (
            "Threat model",
            """The attacker assumed here has cross-site scripting on one page of the
application and no access to the server. That is the case worth designing for,
because it is the one that an access token in local storage loses outright: any
script on the page can read local storage, and a stolen access token is as good
as a session until it expires.""",
        ),
        (
            "Token lifetimes",
            """The access token expires after fifteen minutes and carries the user id and
role. The refresh token lives for fourteen days, sits in an httpOnly cookie
with SameSite set to strict, and is rotated on every use: a refresh returns a
new refresh token and invalidates the one presented. Replay of an old refresh
token is therefore detectable, and the whole family is revoked when it happens.""",
        ),
        (
            "Open questions",
            """Rotation is written here as settled and is not, in one respect: a client
that loses the response to a refresh request will present a token that has just
been invalidated, and be logged out through no fault of its own. A short grace
window on the previous token fixes it and weakens replay detection by exactly
that window, which is a trade nobody on this project has decided yet.""",
        ),
    ]
)

N_PLUS_ONE = docx(
    [
        (
            "Before",
            """The comments loader issued one query for the posts and then one query per
post for its author, which is forty one queries for a page of forty posts. The
query log is pasted below in full, and the shape is unmistakable once seen: the
same statement repeating with a different identifier.""",
        ),
        (
            "After",
            """A single lookup joined the authors in one pass, taking the page from forty
one queries to two. The lookup is acceptable at this size and would not be at a
million posts, where the author's display name would be denormalised onto the
post instead and kept in step on rename.""",
        ),
    ]
)

RUBRIC = docx(
    [
        (
            "Marking scheme",
            [
                ["Criterion", "Marks", "What earns them"],
                ["Query plans", "10", "Plan before and after, for every query"],
                ["Reasoning", "10", "Why the index helped, or why it did not"],
                ["Writing", "5", "A reader who has not seen the repo can follow it"],
            ],
        ),
        (
            "How partial marks work",
            """A hand-in with the plans and no reasoning scores ten out of twenty five,
and one with reasoning and no plans scores ten as well: the plans are evidence
and the reasoning is the point, and neither stands alone. Late work loses five
marks, once, not per day.""",
        ),
    ]
)

WHITEBOARD = scanned_pdf(
    [
        "Whiteboard: cache invalidation\n\nwrite-through vs write-around\n\nTTL is a lie you agree to",
        "Second photo: the herd problem\n\ntwo requests, one cold key",
    ]
)

# Mentorship 2's version of the same work, in similar words and with different
# numbers. If the permission filter fails, a question about Aditya's report
# will answer confidently out of Zara's.
# Headings at body size on purpose: this is the fixture that exercises the
# fallback, where everything before the first recognised heading becomes one
# section called "Document" - no number, no coursework word, no larger type.
# It is also M2's copy, so a leak would be answered out of a document whose
# sections are not even cleanly divided.
ZARA_REPORT = pdf(
    [
        """Method

Each of the three slow queries was run with EXPLAIN before and after, and the
plan written down. The counts come from executionStats rather than from
timings, which on a shared laptop measure the other tabs.""",
        """Query plans

The status lookup went from a collection scan over nine thousand documents to
an index scan returning four. The compound index on status and created date is
the one that mattered; the second index made no difference at all, which is the
prefix rule rather than a mistake in the index.

The third query filters on created date alone and cannot use an index that
begins with status, so it was left as it is.""",
    ],
    heading_size=11,
)


DOCUMENTS = {
    # mentorship, assignment title, [(filename, bytes, content type)]
    M1: [
        ("Database indexing exercise", [
            ("indexing-report.pdf", INDEXING_REPORT, PDF_TYPE),
            ("marking-scheme.docx", RUBRIC, DOCX_TYPE),
        ]),
        ("Add caching to the reading list endpoint", [
            ("cache-notes.pdf", CACHE_NOTES, PDF_TYPE),
            ("whiteboard-scan.pdf", WHITEBOARD, PDF_TYPE),
        ]),
        ("REST authentication with refresh tokens", [
            ("auth-design.docx", AUTH_DESIGN, DOCX_TYPE),
        ]),
        ("Explain N+1 queries with a worked example", [
            ("n-plus-one.docx", N_PLUS_ONE, DOCX_TYPE),
        ]),
    ],
    M2: [
        ("Indexing homework", [
            ("zara-indexing-report.pdf", ZARA_REPORT, PDF_TYPE),
        ]),
    ],
}

# S2's documents: the formats students hand in, not only the ones the
# extractor reads well (s2_documents.py says which is which).
DOCUMENTS[M1] += s2_documents.M1_FILES
DOCUMENTS[M2] += s2_documents.M2_FILES


def main() -> None:
    # The evaluation fixture. A seeder writes, so it opens its own client; it
    # is never pointed at the app's database or the served index.
    client = MongoClient(MONGODB_URI)
    db = client[EVAL_DB_NAME]
    bucket = gridfs.GridFSBucket(db, bucket_name="attachments")

    # Idempotent: the bytes and the references both go, so a second run cannot
    # leave a file referenced twice or an orphan behind.
    db["attachments.files"].delete_many({})
    db["attachments.chunks"].delete_many({})
    db.submissions.update_many({}, {"$set": {"attachments": []}})

    attached = 0
    for mentorship, records in DOCUMENTS.items():
        for assignment_title, files in records:
            assignment = db.assignments.find_one({"title": assignment_title})
            if not assignment:
                raise SystemExit(
                    f"no assignment titled {assignment_title!r} - seed the corpus first"
                )

            submission = db.submissions.find_one(
                {
                    "assignment": assignment["_id"],
                    "mentorship": ObjectId(mentorship),
                }
            )
            if not submission:
                raise SystemExit(
                    f"no hand-in for {assignment_title!r} - seed the corpus first"
                )

            entries = []
            for name, data, content_type in files:
                stream = bucket.open_upload_stream(name)
                with stream:
                    stream.write(data)
                entries.append(
                    {
                        "fileId": stream._id,
                        "name": name,
                        "size": len(data),
                        "contentType": content_type,
                        "uploadedAt": submission.get("submittedAt"),
                    }
                )
                attached += 1

            db.submissions.update_one(
                {"_id": submission["_id"]}, {"$set": {"attachments": entries}}
            )
            print(f"  {assignment_title}: {', '.join(name for name, _, _ in files)}")

    print(f"attached {attached} files to {sum(len(r) for r in DOCUMENTS.values())} hand-ins")
    # Not ingest.py: that builds the SERVED index from the app's database.
    # These two build their own index in this fixture and measure it.
    print("now run: .venv/Scripts/python.exe check_retrieval.py  (or evaluate.py)")
    client.close()


if __name__ == "__main__":
    main()
