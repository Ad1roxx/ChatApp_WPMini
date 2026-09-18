"""Splitting text into pieces small enough to embed and large enough to mean something.

Two strategies, because the evaluation compares them rather than assuming one:

- `fixed_chunks` splits on paragraph boundaries and packs up to a character
  budget, with an overlap so a sentence spanning a boundary is not lost to both
  sides.
- `heading_chunks` keeps a Markdown-ish heading with the text beneath it, so a
  chunk carries the context its author gave it.

Neither is clever. Clever chunking is where RAG projects quietly lose their
recall, and the way to find out which is better here is to measure it.
"""

from __future__ import annotations

import re

_HEADING = re.compile(r"^\s{0,3}(#{1,6}\s+.+|[A-Z][^\n]{0,60}:)\s*$")


def _paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text or "") if p.strip()]


def fixed_chunks(
    text: str, max_chars: int = 800, overlap: int = 120
) -> list[str]:
    """Pack paragraphs up to `max_chars`, carrying `overlap` characters forward."""
    chunks: list[str] = []
    current = ""

    for para in _paragraphs(text):
        # A paragraph longer than the budget is split on its own, rather than
        # being allowed to produce one enormous chunk.
        while len(para) > max_chars:
            head, para = para[:max_chars], para[max_chars - overlap :]
            chunks.append(head.strip())

        if not current:
            current = para
        elif len(current) + len(para) + 2 <= max_chars:
            current = f"{current}\n\n{para}"
        else:
            chunks.append(current.strip())
            tail = current[-overlap:] if overlap else ""
            current = f"{tail}\n\n{para}".strip() if tail else para

    if current.strip():
        chunks.append(current.strip())

    return [c for c in chunks if c]


def heading_chunks(text: str, max_chars: int = 800) -> list[str]:
    """Group each heading with the lines under it, then bound the size."""
    lines = (text or "").splitlines()
    sections: list[list[str]] = []
    current: list[str] = []

    for line in lines:
        if _HEADING.match(line) and current:
            sections.append(current)
            current = [line]
        else:
            current.append(line)

    if current:
        sections.append(current)

    chunks: list[str] = []
    for section in sections:
        body = "\n".join(section).strip()
        if not body:
            continue
        # A section over budget falls back to the fixed splitter, so the
        # strategy degrades rather than emitting something unembeddable.
        chunks.extend(
            [body] if len(body) <= max_chars else fixed_chunks(body, max_chars)
        )

    return chunks


STRATEGIES = {"fixed": fixed_chunks, "heading": heading_chunks}
