"""Documents to clean, section-structured text.

Ported from RAG-Project at commit `695795a` (`ingestion/extract.py`), adapted
from research papers to the things people actually attach to a mentorship:
assignment briefs, rubrics and student hand-ins.

## What was taken, and why each exists

Every cleanup below was written because of a defect observed in a real PDF, and
each one survives the port because the defect is not specific to papers:

- **Block filtering by words-per-line.** PyMuPDF returns a page as blocks.
  Body text comes back as one block whose lines hold eight to twelve words; the
  internals of a figure or a diagram come back with one or two words per line,
  because every label is its own line. Shape separates them far better than
  length does.
- **A composition filter for flattened tables.** A table row survives the
  shape test — it is long and dense — and is still useless once its column
  headers are gone. Prose is overwhelmingly alphabetic; a table row is mostly
  numeric. That is what distinguishes them.
- **The hyphenation vocabulary trick.** A hyphen at a line break is either
  soft (`representa-\\ntion`) or real (`task-\\nspecific`), and the characters
  on the page are identical. The document resolves it: if `representation`
  appears elsewhere unbroken the hyphen was soft, and if `task-specific`
  appears elsewhere intact it was real.
- **Unicode folding.** NFKC expands the ligatures PDF generators leave behind,
  so `ﬁne-tuned` becomes `fine-tuned`. To a tokenizer those are different
  strings, which quietly costs retrieval.
- **Page tracking.** Every section records the pages it spans, so a citation
  can name a location a person can actually turn to.

## What was deliberately NOT taken

- **The references-section cut.** RAG-Project drops everything from the
  `References` heading onward, because in a paper that section is lexically
  dense with query terms and informationally empty. A student hand-in has no
  references section, and a rubric certainly does not — porting the rule would
  silently delete real content from the end of somebody's work. Conflict C10 in
  `docs/AGENT_PLAN.md`.
- **Everything arXiv-specific:** the margin-stamp regex, the metadata contract,
  the on-disk paths, and a heading vocabulary built from paper structure.

## Scanned documents

A PDF with no text layer yields no sections and says so, rather than throwing
or silently returning nothing. OCR is S7; this module only has to notice.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass, field

import pymupdf  # AGPL; see the BUILD_NOTES entry for why that is acceptable here

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Block filtering
# --------------------------------------------------------------------------
MIN_WORDS_PER_LINE = 3.0
# Above this many words a block is prose whatever its line shape.
ALWAYS_KEEP_WORD_COUNT = 25
# Prose is mostly words; a flattened table row is mostly numbers.
MIN_ALPHABETIC_TOKEN_RATIO = 0.5
HAS_LETTER = re.compile(r"[A-Za-z]")

# --------------------------------------------------------------------------
# Heading detection
# --------------------------------------------------------------------------
NUMBERED_HEADING = re.compile(r"^(?P<number>\d+(?:\.\d+){0,3})\.?\s+(?P<title>[A-Z].{1,80})$")
LETTERED_HEADING = re.compile(r"^(?P<number>[A-Z](?:\.\d+){0,2})\s+(?P<title>[A-Z].{1,80})$")
# "2 Approach 6" is a contents line pointing at page 6, not a heading.
TOC_PAGE_NUMBER = re.compile(r"\s\d{1,3}$")

TITLE_CASE_STOPWORDS = {
    "a", "an", "the", "of", "and", "or", "for", "in", "on", "with", "to",
    "from", "by", "at", "as", "is", "are", "via", "over", "into",
}
MIN_TITLE_CASE_RATIO = 0.6
MAX_HEADING_WORDS = 10

# Unnumbered headings worth recognising in coursework, briefs and rubrics.
#
# The single generic words a results table uses as column headers — "model",
# "results", "method", "score", "total", "marks" — are deliberately absent,
# for the reason RAG-Project recorded: the risks are asymmetric. A missed
# heading merges one section into its neighbour and costs a little citation
# precision. A false heading corrupts the document's structure from that point
# on, and their corpus produced a 50,000-character phantom section exactly that
# way. Documents that section on those words almost always number them
# ("3 Results"), which the numbered pattern catches anyway.
UNNUMBERED_HEADINGS = {
    "abstract", "introduction", "overview", "summary", "background",
    "aims", "objectives", "requirements", "deliverables", "scope",
    "marking scheme", "marking criteria", "assessment criteria", "rubric",
    "instructions", "task", "tasks", "brief",
    "approach", "methodology", "implementation", "design",
    "testing", "evaluation", "analysis", "discussion", "limitations",
    "conclusion", "conclusions", "future work", "reflection",
    "references", "bibliography", "appendix", "acknowledgements",
    "acknowledgments", "notes",
}

WORD = re.compile(r"[A-Za-z]+(?:-[A-Za-z]+)*")
HYPHEN_LINEBREAK = re.compile(r"([A-Za-z]+)-\n([A-Za-z]+)")

# Fewer extractable characters than this across the whole document means there
# is no text layer worth having — a scan, a photograph, or a PDF of images.
MIN_TEXT_CHARS = 20


@dataclass
class Section:
    heading: str
    start_page: int
    end_page: int
    lines: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------
# Text cleaning
# --------------------------------------------------------------------------
def normalise_unicode(text: str) -> str:
    """Fold typographic characters to plain equivalents."""
    text = unicodedata.normalize("NFKC", text)
    for source, target in {
        "‘": "'", "’": "'", "“": '"', "”": '"',
        "–": "-", "—": "-", "−": "-",
        " ": " ", "​": "",
    }.items():
        text = text.replace(source, target)
    return text


def build_hyphen_vocabularies(text: str) -> tuple[set[str], set[str]]:
    """Learn which word forms this document itself uses.

    Returns (plain, hyphenated): words seen unbroken, and compounds seen
    intact. These are the evidence `dehyphenate` consults.
    """
    plain: set[str] = set()
    hyphenated: set[str] = set()
    for line in text.split("\n"):
        # A trailing hyphenated fragment is the thing being interpreted, not
        # evidence about the vocabulary.
        line = re.sub(r"[A-Za-z]+-$", "", line.strip())
        for match in WORD.finditer(line):
            word = match.group(0).lower()
            (hyphenated if "-" in word else plain).add(word)
    return plain, hyphenated


def dehyphenate(text: str, plain: set[str], hyphenated: set[str]) -> str:
    """Resolve line-break hyphens using the document's own vocabulary."""

    def resolve(match: re.Match[str]) -> str:
        left, right = match.group(1), match.group(2)
        if (left + right).lower() in plain:
            return left + right
        if f"{left}-{right}".lower() in hyphenated:
            return f"{left}-{right}"
        # No evidence either way: soft hyphenation is far more common in
        # justified text, so joining is the better default.
        return left + right

    return HYPHEN_LINEBREAK.sub(resolve, text)


def flatten(text: str) -> str:
    """Line breaks inside a paragraph carry no meaning once hyphens are fixed."""
    return re.sub(r"\s+", " ", text).strip()


# --------------------------------------------------------------------------
# Structure detection
# --------------------------------------------------------------------------
def looks_like_title(title: str) -> bool:
    """True if `title` is capitalised like a heading rather than a sentence."""
    significant = [w for w in title.split() if w.lower() not in TITLE_CASE_STOPWORDS]
    if not significant:
        return False
    capitalised = sum(1 for word in significant if word[:1].isupper())
    return capitalised / len(significant) >= MIN_TITLE_CASE_RATIO


def heading_of(block_text: str) -> str | None:
    """The heading this block is, or None if it is body text."""
    candidate = flatten(normalise_unicode(block_text))
    if not candidate or len(candidate.split()) > MAX_HEADING_WORDS:
        return None

    stripped = candidate.rstrip(".").strip()
    if stripped.lower() in UNNUMBERED_HEADINGS:
        return stripped

    for pattern, needs_title_case in ((NUMBERED_HEADING, False), (LETTERED_HEADING, True)):
        match = pattern.match(stripped)
        if not match:
            continue
        title = match.group("title").strip()
        # Titles may contain periods ("4.2 SQuAD v1.1"), so the guards are a
        # sentence-ending period and a trailing page number.
        if title.endswith(".") or TOC_PAGE_NUMBER.search(title):
            return None
        if needs_title_case and not looks_like_title(title):
            return None
        return f"{match.group('number')} {title}"

    return None


def is_content_block(block_text: str) -> bool:
    """Keep prose; drop figure internals, page numbers and flattened tables."""
    lines = [line for line in block_text.split("\n") if line.strip()]
    if not lines:
        return False
    words = block_text.split()
    if not words:
        return False

    # Composition first: it is the only test that catches a flattened table
    # row, which is long enough to pass every shape-based check below.
    alphabetic = sum(1 for word in words if HAS_LETTER.search(word))
    if alphabetic / len(words) < MIN_ALPHABETIC_TOKEN_RATIO:
        return False

    if len(words) >= ALWAYS_KEEP_WORD_COUNT:
        return True
    return len(words) / len(lines) >= MIN_WORDS_PER_LINE


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------
def _collect_sections(document) -> tuple[list[Section], str]:
    """Walk the document page by page, splitting blocks into sections.

    Also returns the raw text, which de-hyphenation needs in order to learn the
    document's vocabulary before any cleaning happens.

    Unlike the original, nothing stops collection early: there is no
    references-section cut (C10).
    """
    sections: list[Section] = []
    current: Section | None = None
    raw_parts: list[str] = []

    for page_number, page in enumerate(document, start=1):
        for block in page.get_text("blocks"):
            block_text = block[4].strip()
            if not block_text:
                continue

            heading = heading_of(block_text)
            if heading is not None:
                current = Section(heading=heading, start_page=page_number, end_page=page_number)
                sections.append(current)
                continue

            if not is_content_block(block_text):
                continue

            if current is None:
                # Text before any heading is still the document's own content
                # here — a brief often opens with a paragraph. A paper's title
                # block was discardable; this is not.
                current = Section(heading="Document", start_page=page_number, end_page=page_number)
                sections.append(current)

            current.lines.append(block_text)
            current.end_page = page_number
            raw_parts.append(block_text)

    return sections, "\n".join(raw_parts)


def extract_pdf(data: bytes, *, filename: str = "document.pdf") -> dict:
    """Extract sections from PDF bytes.

    Bytes rather than a path because attachments live in GridFS, not on disk.

    Returns `{filename, kind, page_count, needs_ocr, reason, sections}` where
    each section is `{index, heading, start_page, end_page, text}`.
    """
    document = pymupdf.open(stream=data, filetype="pdf")
    try:
        page_count = document.page_count
        sections, raw_text = _collect_sections(document)

        if len(raw_text.strip()) < MIN_TEXT_CHARS:
            # A scan, a photograph, or a PDF of images. Not an error, and not
            # something to paper over with an empty string downstream.
            log.warning(
                "%s: no extractable text - needs OCR (S7); %d page(s)",
                filename,
                page_count,
            )
            return {
                "filename": filename,
                "kind": "pdf",
                "page_count": page_count,
                "needs_ocr": True,
                "reason": "no extractable text - needs OCR (S7)",
                "sections": [],
            }

        plain_vocab, hyphen_vocab = build_hyphen_vocabularies(normalise_unicode(raw_text))

        cleaned: list[dict] = []
        for index, section in enumerate(sections):
            body = normalise_unicode("\n".join(section.lines))
            body = dehyphenate(body, plain_vocab, hyphen_vocab)
            body = flatten(body)
            if not body:
                # A heading whose body did not survive filtering — a
                # figure-only subsection, say.
                continue
            cleaned.append(
                {
                    "index": len(cleaned),
                    "heading": section.heading,
                    "start_page": section.start_page,
                    "end_page": section.end_page,
                    "text": body,
                }
            )

        return {
            "filename": filename,
            "kind": "pdf",
            "page_count": page_count,
            "needs_ocr": False,
            "reason": "",
            "sections": cleaned,
        }
    finally:
        document.close()
