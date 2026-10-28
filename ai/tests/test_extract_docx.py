"""Word extraction: headings, order, tables, and the empty case.

Documents are built in memory with python-docx rather than checked in as
binary fixtures. A fixture would be opaque — nobody can read a .docx in a diff
— and these tests are about structure, which is exactly what the builder makes
explicit.
"""

from __future__ import annotations

import io

import pytest
from docx import Document

from extract import extract_docx


def _docx(build) -> bytes:
    document = Document()
    build(document)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def test_headings_become_sections():
    data = _docx(
        lambda d: (
            d.add_heading("Requirements", level=1),
            d.add_paragraph("Add an index to each of the three slow queries."),
            d.add_heading("Marking scheme", level=1),
            d.add_paragraph("Five marks for the plans, five for the reasoning."),
        )
    )

    result = extract_docx(data, filename="brief.docx")
    headings = [section["heading"] for section in result["sections"]]

    assert headings == ["Requirements", "Marking scheme"]
    assert "three slow queries" in result["sections"][0]["text"]
    assert "five for the reasoning" in result["sections"][1]["text"]


def test_paragraph_order_is_preserved():
    data = _docx(
        lambda d: (
            d.add_heading("Steps", level=1),
            d.add_paragraph("First, run EXPLAIN on every query."),
            d.add_paragraph("Second, add the index."),
            d.add_paragraph("Third, run EXPLAIN again and compare."),
        )
    )

    text = extract_docx(data)["sections"][0]["text"]

    assert text.index("First") < text.index("Second") < text.index("Third")


def test_an_empty_document_yields_no_sections():
    result = extract_docx(_docx(lambda d: None), filename="empty.docx")

    assert result["sections"] == []
    assert result["reason"] == "no text found"
    # Not an OCR problem: there is nothing to read, not an unreadable scan.
    assert result["needs_ocr"] is False


def test_a_document_of_blank_paragraphs_is_also_empty():
    data = _docx(lambda d: (d.add_paragraph("   "), d.add_paragraph("")))

    assert extract_docx(data)["sections"] == []


def test_a_table_is_kept_with_its_cells_separated():
    # The opposite of the PDF rule, and deliberately so: a .docx table still
    # has cells, so the row stays readable. Rubrics are written like this.
    def build(document):
        document.add_heading("Marking scheme", level=1)
        table = document.add_table(rows=2, cols=2)
        table.cell(0, 0).text = "Criterion"
        table.cell(0, 1).text = "Marks"
        table.cell(1, 0).text = "Index chosen correctly"
        table.cell(1, 1).text = "5"

    text = extract_docx(_docx(build))["sections"][0]["text"]

    assert "Criterion | Marks" in text
    assert "Index chosen correctly | 5" in text


def test_a_table_before_any_heading_still_lands_somewhere():
    def build(document):
        table = document.add_table(rows=1, cols=2)
        table.cell(0, 0).text = "Criterion"
        table.cell(0, 1).text = "Marks"

    result = extract_docx(_docx(build))

    assert len(result["sections"]) == 1
    assert result["sections"][0]["heading"] == "Document"


def test_text_before_the_first_heading_is_kept():
    data = _docx(
        lambda d: (
            d.add_paragraph("Read the brief carefully before you start."),
            d.add_heading("Tasks", level=1),
            d.add_paragraph("Do the thing."),
        )
    )

    result = extract_docx(data)

    assert result["sections"][0]["heading"] == "Document"
    assert "Read the brief carefully" in result["sections"][0]["text"]
    assert result["sections"][1]["heading"] == "Tasks"


def test_a_heading_typed_as_plain_text_is_still_a_heading():
    # Common in student work: the word is bolded by hand, not styled.
    data = _docx(
        lambda d: (
            d.add_paragraph("Requirements"),
            d.add_paragraph("The submission must include an invalidation rule."),
        )
    )

    result = extract_docx(data)

    assert result["sections"][0]["heading"] == "Requirements"
    assert "invalidation rule" in result["sections"][0]["text"]


def test_word_documents_have_no_pages():
    # A .docx has no pages until something renders it, so a citation names the
    # section instead. Both extractors return the same keys so chunking never
    # has to ask which format it is holding.
    data = _docx(lambda d: (d.add_heading("Tasks", level=1), d.add_paragraph("Body.")))

    result = extract_docx(data)

    assert result["kind"] == "docx"
    assert result["page_count"] is None
    assert result["sections"][0]["start_page"] is None
    assert result["sections"][0]["end_page"] is None


@pytest.mark.parametrize("level,expected", [(0, "Title"), (1, "Heading 1"), (2, "Heading 2")])
def test_title_and_heading_styles_are_all_recognised(level, expected):
    data = _docx(
        lambda d: (
            d.add_heading("Section name", level=level),
            d.add_paragraph("Body text under it."),
        )
    )

    result = extract_docx(data)

    assert result["sections"][0]["heading"] == "Section name"
    assert "Body text under it." in result["sections"][0]["text"]
