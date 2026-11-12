"""S8 Step 5: the export is exactly the edited draft (report_export.py).

For both formats: the file's text, in order, is the plan's text and nothing
else but the draft marker; every value of the draft is in it; markup in a value
prints as characters; long values, Unicode and many-row tables export; the
marker is on every page.
"""

from __future__ import annotations

import io
import re

import fitz
import pytest
from docx import Document

import report_export as rx

XSS = '<script>alert(1)</script><img src=x onerror=alert(2)> <b>bold?</b> <a href="javascript:x">link</a> & &amp;'
UNICODE = "Café, naïve, Zürich, Ελληνικά, Кириллица, ₹500, “quotes” — dash, ½, ✓"
LONG = ("The invalidation rule clears one user's list. " * 260).strip()


def draft(**over) -> dict:
    d = {
        "title": "Coverage report: Backend interviews",
        "header": {"student": "Aditya Student", "mentor": "Priya Mentor", "mentorship": "Backend interviews",
                   "period": "1 Nov 2026 to 13 Nov 2026", "assignments": ["Caching exercise", XSS]},
        "sections": [{
            "id": "s1", "assignment": "Caching exercise", "mode": "rubric", "modeLabel": "Assessed against the rubric",
            "checklist": "Rubric checklist, version 2", "status": "", "brief": "Add caching. " + UNICODE,
            "submitted": "Handed in 12 Nov 2026, 1 day late", "files": ["report.pdf", "notes.docx"],
            "history": ["Handed in, 12 Nov 2026", "Changes asked for, 13 Nov 2026"],
            "criteria": [
                {"id": "k1", "criterion": "States the invalidation rule", "label": "Met", "present": "The rule is stated.",
                 "absent": "", "reason": "", "evidence": [{"quote": "adding an item clears that user's list only",
                                                           "where": "the hand-in's text"}],
                 "suggestedMarks": "9 of 10", "note": "Agree. " + XSS},
                {"id": "k2", "criterion": "Explains staleness", "label": "Partially met", "present": "Says what goes stale.",
                 "absent": "Not why.", "reason": "", "evidence": [{"quote": LONG, "where": "report.pdf, page 3"}],
                 "suggestedMarks": "", "note": ""},
                *[{"id": f"k{i}", "criterion": f"Criterion {i}", "label": "Not found in submission", "present": "",
                   "absent": f"Nothing on criterion {i}.", "reason": "", "evidence": [], "suggestedMarks": "", "note": ""}
                  for i in range(3, 40)],
            ],
            "points": [],
            "strengths": [{"id": "st1", "text": "A clear rule.", "evidence": [{"quote": "clears that user's list only", "where": "the hand-in's text"}]}],
            "gaps": [{"id": "g1", "text": "No reason for staleness."}],
            "lookClosely": [{"id": "l1", "where": "report.pdf, page 3", "why": "Partially met; check the reasoning. " + UNICODE}],
            "notAssessed": [{"id": "n1", "where": "scan.pdf", "reason": "no readable text"}],
        }],
        "trends": [{"id": "t1", "text": "Late twice in a row."}],
        "mentorNotes": "Talk about invalidation next session. " + XSS + "\nSecond line.",
    }
    d.update(over)
    return d


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def docx_text(data: bytes) -> tuple[str, str]:
    doc = Document(io.BytesIO(data))
    body = []
    for el in doc.element.body.iterchildren():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag == "p":
            # A line break inside a value is <w:br/>: read as a space.
            body.append("".join((t.text or "") if t.tag.endswith("}t") else " " for t in el.iter()
                                if t.tag.endswith("}t") or t.tag.endswith("}br")))
        elif tag == "tbl":
            for t in el.iter():
                if t.tag.endswith("}t"):
                    body.append(t.text or "")
                elif t.tag.endswith("}p"):
                    body.append(" ")
    header = " ".join(p.text for p in doc.sections[0].header.paragraphs)
    return norm(" ".join(body)), header


def pdf_pages(data: bytes) -> list[str]:
    with fitz.open(stream=data, filetype="pdf") as pdf:
        return [page.get_text() for page in pdf]


def squash(text: str) -> str:
    return re.sub(r"\s+", "", text)


def consumed(text: str, pieces: list[str]) -> str:
    """Remove each piece from `text` in order, insisting each is found after the last; return what is left."""
    left, at = [], 0
    for piece in pieces:
        p = norm(piece)
        i = text.find(p, at)
        assert i >= 0, f"not in the export, in order: {p[:80]!r}"
        left.append(text[at:i])
        at = i + len(p)
    left.append(text[at:])
    return norm(" ".join(left))


TEMPLATE_ONLY = re.compile(r"^[\s•“”—()]*$")


def test_the_plan_holds_every_value_of_the_draft():
    d = draft()
    texts = " ".join(rx.plan_text(rx.plan(d)))

    def values(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if k not in ("id", "mode"):
                    yield from values(v)
        elif isinstance(x, list):
            for v in x:
                yield from values(v)
        elif isinstance(x, str) and x:
            yield x

    for v in values(d):
        assert norm(v) in norm(texts), v[:60]


def test_the_word_export_is_the_plan_and_nothing_else():
    d = draft()
    body, header = docx_text(rx.to_docx(d))
    assert header == rx.MARKER
    rest = consumed(body, rx.plan_text(rx.plan(d)))
    assert rest == "", f"text in the Word file that is not in the draft: {rest[:200]!r}"


def test_the_pdf_export_is_the_plan_and_nothing_else_with_the_marker_on_every_page():
    d = draft()
    pages = pdf_pages(rx.to_pdf(d))
    assert len(pages) > 2
    assert all(p.lstrip().startswith(rx.MARKER) for p in pages), "the marker is on every page"
    # The PDF wraps lines and splits long values across rows: compare without whitespace, in order. The
    # marker and the criteria table's header row repeat on every page: template, taken out wherever they are.
    flat = squash(" ".join(pages))
    head = [b for b in rx.plan(d) if b[0] == "table" and any(b[1])][0][1]
    for template in (squash(rx.MARKER), squash("".join(head))):
        flat = flat.replace(template, "")
    pieces = [squash(t) for t in rx.plan_text(rx.plan(d)) if t != rx.MARKER and t not in head]
    rest = consumed(flat, pieces)
    assert TEMPLATE_ONLY.match(rest), f"text in the PDF that is not in the draft: {rest[:200]!r}"


@pytest.mark.parametrize("fmt", ["docx", "pdf"])
def test_markup_in_a_value_prints_as_characters(fmt):
    data, _ = rx.export(draft(), fmt)
    text = squash(docx_text(data)[0] if fmt == "docx" else " ".join(pdf_pages(data)))
    for literal in ("<script>alert(1)</script>", "<b>bold?</b>", '<a href="javascript:x">link</a>', "& &amp;"):
        assert squash(literal) in text, literal


@pytest.mark.parametrize("fmt", ["docx", "pdf"])
def test_unicode_and_long_values_export_whole(fmt):
    data, _ = rx.export(draft(), fmt)
    text = squash(docx_text(data)[0] if fmt == "docx" else " ".join(pdf_pages(data)))
    if fmt == "pdf":
        head = [b for b in rx.plan(draft()) if b[0] == "table" and any(b[1])][0][1]
        for template in (squash(rx.MARKER), squash("".join(head))):
            text = text.replace(template, "")
    assert squash(UNICODE) in text
    assert squash(LONG) in text, "a long quote is split, never cut"


def test_characters_xml_cannot_hold_are_removed_not_fatal():
    d = draft(mentorNotes="Before\x00\x07\x1fafter")
    assert "Beforeafter" in docx_text(rx.to_docx(d))[0]
    assert "Beforeafter" in norm(" ".join(pdf_pages(rx.to_pdf(d))))


def test_an_empty_draft_still_exports_with_the_marker():
    d = {"title": "Coverage report", "header": {}, "sections": [], "trends": [], "mentorNotes": ""}
    assert rx.MARKER in norm(" ".join(pdf_pages(rx.to_pdf(d))))
    body, header = docx_text(rx.to_docx(d))
    assert rx.MARKER in body and header == rx.MARKER


def test_the_export_reads_and_calls_nothing():
    import ast
    from pathlib import Path
    tree = ast.parse(Path(rx.__file__).read_text(encoding="utf-8"))
    mods = {(n.module or "").split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)} | {
        a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    assert not mods & {"httpx", "requests", "urllib", "socket", "store", "appdb", "sources", "pymongo"}
