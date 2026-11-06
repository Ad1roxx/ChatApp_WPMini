"""What extraction could not read is counted, and counting changes nothing else.

S4 Step 4 (BUILD_NOTES Entry 96). The Copilot's file summary says "some
content couldn't be read" when any count is above zero, so each count must
rise for the thing it names and stay at zero for a file with none of it.
`eval/extract_identity.py` is the proof that stored files' chunks did not
move; the tests here pin the counting itself.
"""

from __future__ import annotations

import io

import pymupdf
from docx import Document
from docx.shared import Inches

import extract
from extract import DROPPED_BLOCK_MIN_WORDS, extract_docx, extract_pdf, has_unread

PROSE = (
    "The cache is invalidated whenever the underlying record changes, so a reader "
    "never sees a value older than the last write that it could have observed."
)
TABLE_ROW = "p50 120 ms 340 ms 1,200 2.08E+00 60 1,000 4,096 0.95 17 22"


def _png() -> bytes:
    pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 8, 8), 0)
    pixmap.clear_with(200)
    return pixmap.tobytes("png")


def _pdf(pages: list[dict]) -> bytes:
    """Each page: optional `text`, `table` (a numeric row), `image`, `label`."""
    document = pymupdf.open()
    for spec in pages:
        page = document.new_page()
        y = 56
        if spec.get("text"):
            page.insert_textbox(pymupdf.Rect(56, y, 540, y + 120), spec["text"], fontsize=11)
            y += 140
        if spec.get("table"):
            page.insert_textbox(pymupdf.Rect(56, y, 540, y + 40), spec["table"], fontsize=11)
            y += 60
        if spec.get("label"):
            page.insert_textbox(pymupdf.Rect(56, y, 540, y + 40), spec["label"], fontsize=11)
            y += 60
        if spec.get("image"):
            page.insert_image(pymupdf.Rect(56, y, 156, y + 100), stream=_png())
    data = document.tobytes()
    document.close()
    return data


def _docx(build) -> bytes:
    document = Document()
    build(document)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


# --------------------------------------------------------------------------
# PDF
# --------------------------------------------------------------------------
def test_a_clean_pdf_has_nothing_unread():
    result = extract_pdf(_pdf([{"text": PROSE}, {"text": PROSE}]))
    assert result["unread"] == {"pages_without_text": 0, "dropped_blocks": 0, "images": 0}
    assert not has_unread(result["unread"])


def test_a_page_with_no_text_is_counted():
    result = extract_pdf(_pdf([{"text": PROSE}, {}, {"text": PROSE}]))
    assert result["unread"]["pages_without_text"] == 1
    assert result["sections"], "the other pages are still read"


def test_a_flattened_table_row_is_counted_as_dropped():
    result = extract_pdf(_pdf([{"text": PROSE, "table": TABLE_ROW}]))
    assert result["unread"]["dropped_blocks"] == 1
    assert "2.08E+00" not in " ".join(s["text"] for s in result["sections"])


def test_a_lone_page_number_is_not_counted():
    # Dropped, as before, but not something a reader would miss.
    assert len("12".split()) < DROPPED_BLOCK_MIN_WORDS
    result = extract_pdf(_pdf([{"text": PROSE, "label": "12"}]))
    assert result["unread"]["dropped_blocks"] == 0


def test_an_image_is_counted():
    result = extract_pdf(_pdf([{"text": PROSE, "image": True}]))
    assert result["unread"]["images"] == 1


def test_a_scan_counts_every_page_as_without_text():
    result = extract_pdf(_pdf([{"image": True}, {"image": True}]))
    assert result["needs_ocr"] is True
    assert result["unread"] == {"pages_without_text": 2, "dropped_blocks": 0, "images": 2}


def test_counting_does_not_change_the_sections(monkeypatch):
    data = _pdf([{"text": PROSE, "table": TABLE_ROW, "image": True}, {}, {"text": PROSE}])
    counted = extract_pdf(data)
    monkeypatch.setattr(extract, "_pdf_unread", lambda document: {})
    uncounted = extract_pdf(data)
    assert counted["sections"] == uncounted["sections"]


# --------------------------------------------------------------------------
# Word
# --------------------------------------------------------------------------
def test_a_plain_word_file_has_nothing_unread():
    result = extract_docx(_docx(lambda d: (d.add_heading("Requirements", 1), d.add_paragraph(PROSE))))
    assert result["unread"] == {"tables": 0, "images": 0}
    assert not has_unread(result["unread"])


def test_a_word_table_is_counted_although_its_text_is_kept():
    def build(d):
        d.add_heading("Marking scheme", 1)
        table = d.add_table(rows=2, cols=2)
        table.cell(0, 0).text, table.cell(0, 1).text = "Criterion", "Marks"
        table.cell(1, 0).text, table.cell(1, 1).text = "Design", "10"

    result = extract_docx(_docx(build))
    assert result["unread"]["tables"] == 1
    assert "Criterion | Marks" in result["sections"][0]["text"]


def test_a_table_inside_a_table_is_counted_too():
    def build(d):
        d.add_paragraph(PROSE)
        outer = d.add_table(rows=1, cols=1)
        outer.cell(0, 0).add_table(rows=1, cols=1).cell(0, 0).text = "nested"

    assert extract_docx(_docx(build))["unread"]["tables"] == 2


def test_a_word_picture_is_counted():
    def build(d):
        d.add_paragraph(PROSE)
        d.add_picture(io.BytesIO(_png()), width=Inches(1))

    assert extract_docx(_docx(build))["unread"]["images"] == 1


def test_has_unread():
    assert not has_unread(None) and not has_unread({}) and not has_unread({"tables": 0, "images": 0})
    assert has_unread({"tables": 0, "images": 1})
