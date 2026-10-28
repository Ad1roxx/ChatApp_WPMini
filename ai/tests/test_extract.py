"""Extraction heuristics, tested where the logic actually lives.

The cleanup rules are pure functions over text, so they are tested directly
rather than through a generated PDF — a PDF round trip would test PyMuPDF's
layout engine as much as our rules, and would fail for reasons that have
nothing to do with the thing under test.

Two tests do use a real PDF, because page tracking and "there is no text layer"
are properties of a document, not of a string.
"""

from __future__ import annotations

import logging

import pymupdf
import pytest

from extract import (
    build_hyphen_vocabularies,
    dehyphenate,
    extract_pdf,
    heading_of,
    is_content_block,
    normalise_unicode,
)


# --------------------------------------------------------------------------
# Hyphenation — the genuinely ambiguous case
# --------------------------------------------------------------------------
def test_a_soft_hyphen_is_joined():
    # "representation" appears unbroken elsewhere, so the break was soft.
    document = "we learn a representation of the input\nrepresenta-\ntion quality"
    plain, hyphenated = build_hyphen_vocabularies(document)

    assert "representation" in dehyphenate(document, plain, hyphenated)
    assert "representa-tion" not in dehyphenate(document, plain, hyphenated)


def test_a_real_hyphen_is_kept():
    # "task-specific" appears intact elsewhere, so the break was a real hyphen.
    document = "a task-specific head is added\nwe train a task-\nspecific layer"
    plain, hyphenated = build_hyphen_vocabularies(document)

    assert "task-specific layer" in dehyphenate(document, plain, hyphenated)


def test_both_resolutions_in_one_document():
    # The point of the vocabulary approach: the same document resolves the two
    # cases differently, and no local rule could.
    document = (
        "the representation is learned end to end\n"
        "a task-specific head is added on top\n"
        "this representa-\ntion feeds a task-\nspecific classifier"
    )
    plain, hyphenated = build_hyphen_vocabularies(document)
    resolved = dehyphenate(document, plain, hyphenated)

    assert "this representation feeds" in resolved
    assert "a task-specific classifier" in resolved


def test_an_unknown_hyphen_defaults_to_joining():
    document = "unseenwo-\nrd appears once"
    plain, hyphenated = build_hyphen_vocabularies(document)

    assert "unseenword" in dehyphenate(document, plain, hyphenated)


# --------------------------------------------------------------------------
# Block filtering
# --------------------------------------------------------------------------
def test_a_flattened_table_row_is_dropped():
    # Long and dense, so it passes every shape test. Its column headers are
    # gone, so the numbers mean nothing and it must not be indexed.
    row = "T5-Small 2.08E+00 1.80E+20 60 1,000 3 3 1 0.5 12.4 98.2 0.31"
    assert is_content_block(row) is False


def test_prose_is_kept():
    prose = (
        "The cache should be invalidated when an item is added, because the\n"
        "endpoint is scoped per user and a stale list is worse than a slow one.\n"
        "Write the rule down before writing the code."
    )
    assert is_content_block(prose) is True


def test_figure_internals_are_dropped():
    # One or two words a line is what a diagram's labels look like.
    labels = "Tok 1\nTok 2\nE[CLS]\nTrm\nTrm\nC"
    assert is_content_block(labels) is False


def test_a_long_block_is_kept_whatever_its_line_shape():
    # Above the word-count threshold, prose is prose even if it extracted with
    # awkward line breaks.
    long_block = "\n".join(["word"] * 30)
    assert is_content_block(long_block) is True


# --------------------------------------------------------------------------
# Heading detection
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    "line,expected",
    [
        ("3.1 Model Architecture", "3.1 Model Architecture"),
        ("2 Requirements", "2 Requirements"),
        ("Marking scheme", "Marking scheme"),
        ("Deliverables", "Deliverables"),
        ("References", "References"),
    ],
)
def test_headings_are_recognised(line, expected):
    assert heading_of(line) == expected


@pytest.mark.parametrize(
    "line",
    [
        "2 Approach 6",  # a contents line pointing at page 6
        "The cache should be invalidated when an item is added to the list.",
        "Marks",  # a column header, deliberately not in the heading set
        "Results",  # same
        "",
    ],
)
def test_non_headings_are_rejected(line):
    assert heading_of(line) is None


def test_references_is_a_heading_not_a_stop_signal():
    # RAG-Project cut everything from here on. We keep it (conflict C10): in
    # coursework the end of a document is still the student's work.
    assert heading_of("References") == "References"


# --------------------------------------------------------------------------
# Unicode
# --------------------------------------------------------------------------
def test_ligatures_are_folded():
    assert normalise_unicode("ﬁne-tuned") == "fine-tuned"


def test_typographic_punctuation_is_folded():
    assert normalise_unicode("“quoted” – dashed") == '"quoted" - dashed'


# --------------------------------------------------------------------------
# Real PDFs
# --------------------------------------------------------------------------
def _pdf(pages: list[str]) -> bytes:
    """Build a PDF whose pages hold the given text, wrapped into paragraphs."""
    document = pymupdf.open()
    for text in pages:
        page = document.new_page()
        if text:
            page.insert_textbox(pymupdf.Rect(56, 56, 540, 760), text, fontsize=11)
    data = document.tobytes()
    document.close()
    return data


def test_page_numbers_are_preserved():
    body = (
        "The submission must include an invalidation rule written as a comment, "
        "and a short explanation of which entries become stale when an item is "
        "added to the list."
    )
    continued = (
        "It should also describe what happens when two requests arrive together "
        "on a cold cache, which is the case most implementations get wrong."
    )
    data = _pdf([f"Requirements\n\n{body}", continued])

    result = extract_pdf(data, filename="brief.pdf")

    assert result["needs_ocr"] is False
    assert result["page_count"] == 2
    assert result["sections"], "expected at least one section"

    first = result["sections"][0]
    assert first["start_page"] == 1
    # The second page continues the same section, so it must be recorded.
    assert result["sections"][-1]["end_page"] == 2


def test_a_document_without_a_text_layer_yields_nothing_and_says_why(caplog):
    # A scan or a photograph: pages exist, text does not.
    data = _pdf(["", ""])

    with caplog.at_level(logging.WARNING):
        result = extract_pdf(data, filename="scan.pdf")

    assert result["sections"] == []
    assert result["needs_ocr"] is True
    assert "needs OCR (S7)" in result["reason"]
    assert "needs OCR (S7)" in caplog.text
    # It must not throw, and it must still report what it saw.
    assert result["page_count"] == 2


def test_extraction_does_not_stop_at_a_references_heading():
    tail = (
        "This appendix lists the queries that were tested, together with the "
        "plan each one produced before and after the index was added."
    )
    data = _pdf([f"References\n\nSome citation line here.\n\nAppendix\n\n{tail}"])

    result = extract_pdf(data, filename="report.pdf")
    everything = " ".join(section["text"] for section in result["sections"])

    assert "queries that were tested" in everything
