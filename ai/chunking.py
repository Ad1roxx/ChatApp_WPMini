"""Splitting text into pieces small enough to embed and large enough to mean something.

Ported from RAG-Project at commit `695795a` (`ingestion/chunk.py`), replacing
the character-based splitter this service used until now.

## Why tokens, not characters

The old splitter cut at 800 characters. Characters are a proxy for the thing
that actually matters, and a loose one: the embedding model has a limit
measured in **its own tokens**, and text over that limit is not rejected — it
is silently truncated, and the tail is embedded as though it had never been
written. Nothing downstream looks wrong. Retrieval just quietly gets worse.

800 characters is roughly 200 tokens, so the old chunks happened to fit under
MiniLM's 256-token ceiling. That was luck, not design, and it would have
stopped being true the moment a PDF arrived with denser text.

## The budget is coupled to the model

`CHUNK_BUDGET_TOKENS` is a request, not a guarantee: it is clamped to what the
configured model can actually read, minus headroom. Switching to a model with a
larger window widens the real budget automatically, and switching to a smaller
one narrows it rather than overflowing. Chunk size and model limit are one
decision, so they live in one place.

## Three commitments

1. **Chunks never cross a section boundary.** A passage that is half
   Requirements and half Marking Scheme describes no single thing, so its
   vector lands between two topics and answers neither question well.
2. **Chunks are measured in the embedding model's own tokenizer**, for the
   reason above.
3. **Chunks overlap at the seams.** The sentence that answers a question and
   the sentence that names its subject are often neighbours; split between
   them with no overlap and neither chunk is retrievable on its own.
"""

from __future__ import annotations

import re
from typing import Iterator

from config import (
    CHUNK_BUDGET_TOKENS,
    CHUNK_OVERLAP_TOKENS,
    CONTEXT_HEADERS,
    EMBED_HEADINGS,
    EMBEDDING_MAX_TOKENS,
    MIN_CHUNK_TOKENS,
)

# Headroom under the model's hard limit: a tokenizer's special tokens occupy
# slots, and a section's heading can be read with its chunk, so a chunk at the
# ceiling must still leave room for the longest heading (`text_for_models`).
HEADING_MAX_TOKENS = 32
HEADER_MAX_TOKENS = 48
HEADROOM_TOKENS = 16 + HEADER_MAX_TOKENS

# What the extractor calls text that comes before any heading. Nobody wrote it,
# and it says nothing about the chunk.
PLACEHOLDER_HEADING = "Document"

def tokenizer():
    """The embedding model's own tokenizer, taken from the loaded model.

    Sizing chunks with any other tokenizer makes the budget a guess. This is
    the one that decides what gets truncated, so it is the one that counts.

    It comes from `store.embedder()` rather than from `AutoTokenizer` on the
    model name, for two reasons. The configured name is the one
    sentence-transformers accepts (`all-MiniLM-L6-v2`), which is not a Hub
    identifier on its own — `AutoTokenizer` rejects it. And the process that
    chunks is the process that embeds, so this reuses the model already loaded
    instead of fetching a second copy of its vocabulary.
    """
    from store import embedder

    return embedder().tokenizer


def token_count(text: str) -> int:
    return len(tokenizer().encode(text, add_special_tokens=False))


def names_to_roles(text: str, parties: dict | None) -> str:
    """The two parties' display names in `text`, as "the student" and "the mentor".

    Whole names in any case, then each part of a name as written, so "Rohan's" and
    "Meera Iyer" both change and "will" does not change for a mentor called Will. A
    part both parties share says nothing about which is meant, so it stays.
    """
    if not parties:
        return text
    roles = {role: (parties.get(role) or "").split() for role in ("student", "mentor")}
    whole = [(" ".join(parts), f"the {role}") for role, parts in roles.items() if parts]
    shared = set(roles["student"]) & set(roles["mentor"])
    single = [(part, f"the {role}") for role, parts in roles.items() for part in parts if part not in shared and len(part) > 1]
    for name, role in sorted(whole, key=lambda pair: -len(pair[0])):
        text = re.sub(rf"(?<!\w){re.escape(name)}(?!\w)", role, text, flags=re.IGNORECASE)
    for name, role in sorted(single, key=lambda pair: -len(pair[0])):
        text = re.sub(rf"(?<!\w){re.escape(name)}(?!\w)", role, text)
    return text


REVIEW_MARK = "Mentor's review:"


def _clip_header(header: str) -> str:
    words = header.split()
    while len(words) > 1 and token_count(" ".join(words)) > HEADER_MAX_TOKENS:
        words.pop()
    return " ".join(words)


def context_headers(doc: dict, pieces: list[dict], parties: dict | None = None) -> list[str]:
    """One header per chunk: its record type, its owner by role, its title and section.

    Roles only: a party's name in a title becomes their role. Read by the embedder and
    the reranker alone (`text_for_models`), never stored as content, cited or put in a prompt.
    """
    source_type = doc.get("source_type")
    parent_type = doc.get("parent_type")
    named = names_to_roles((doc.get("parent_title") if source_type == "attachment" else doc.get("title")) or "", parties)
    title = named.removeprefix("Hand-in: ")

    headers, in_review = [], False
    for piece in pieces:
        text = piece.get("text", "")
        if source_type == "assignment":
            header = f"Assignment brief (the mentor's instructions): {title}"
        elif source_type == "submission":
            has_mark = REVIEW_MARK in text
            if text.lstrip().startswith(REVIEW_MARK) or in_review:
                header = f"Mentor's review of the student's hand-in for '{title}'"
            elif has_mark:
                header = f"Student's hand-in for '{title}', and the mentor's review of it"
            else:
                header = f"Student's hand-in for '{title}'"
            in_review = in_review or has_mark
        elif source_type == "goal":
            header = f"Student's goal: {title}"
        elif source_type == "resource":
            who = doc.get("added_by_role")
            header = f"Resource shared by the {who}: {title}" if who else f"Resource: {title}"
        elif parent_type == "submission":
            header = f"Student's hand-in for '{title}'"
        elif parent_type == "assignment":
            header = f"Attachment to the assignment brief (the mentor's instructions): {title}"
        else:
            header = f"File on the resource: {title}"
        heading = " ".join((piece.get("heading") or "").split())
        if heading and heading != PLACEHOLDER_HEADING:
            header += f", section: {names_to_roles(heading, parties)}"
        headers.append(_clip_header(header))
    return headers


def fold_opening_fragment(sections: list[dict]) -> list[dict]:
    """A document's opening section below the minimum goes into the next section.

    A title and a byline are a whole "section", so `MIN_CHUNK_TOKENS`, which applies
    inside one piece of text, never reached them, and they competed as chunks of their
    own (BUILD_NOTES Entry 85). No text is lost, and the next section's heading stands.
    Later short sections stay apart: commitment 1 above.
    """
    if len(sections) < 2 or token_count(sections[0].get("text", "")) >= MIN_CHUNK_TOKENS:
        return sections
    first, second = sections[0], sections[1]
    starts = [p for p in (first.get("start_page"), second.get("start_page")) if p is not None]
    merged = {**second, "text": f"{first.get('text', '')} {second.get('text', '')}".strip()}
    if starts:
        merged["start_page"] = min(starts)
    return [merged, *sections[2:]]


def text_for_models(text: str, heading: str | None, header: str | None = None) -> str:
    """What the embedder and the reranker read for a chunk: its header or heading, then its text.

    Only they read this. What is stored, cited and put in the prompt stays the text
    alone, and the prompt already names the section. Without it, a question that
    names a section cannot find it by that name (BUILD_NOTES Entries 80, 81, 85).
    """
    if CONTEXT_HEADERS:
        return f"{header}\n{text}" if header else text
    heading = " ".join((heading or "").split())
    if not EMBED_HEADINGS or not heading or heading == PLACEHOLDER_HEADING:
        return text
    words = heading.split()
    while len(words) > 1 and token_count(" ".join(words)) > HEADING_MAX_TOKENS:
        words.pop()
    return f"{' '.join(words)}\n{text}"


def effective_budget(requested: int | None = None) -> int:
    """What a chunk may actually hold, given the model in use."""
    requested = CHUNK_BUDGET_TOKENS if requested is None else requested
    return min(requested, EMBEDDING_MAX_TOKENS - HEADROOM_TOKENS)


# --------------------------------------------------------------------------
# Sentence splitting
# --------------------------------------------------------------------------
# Chunk boundaries land on sentence boundaries so no chunk starts or ends
# mid-thought. That means splitting sentences correctly, and prose is full of
# periods that end nothing.
ABBREVIATIONS = {
    "et al.", "e.g.", "i.e.", "cf.", "etc.", "vs.", "resp.", "approx.",
    "fig.", "eq.", "sec.", "tab.", "no.", "pp.", "al.", "dr.", "prof.",
    "inc.", "ltd.", "st.", "ca.", "ref.", "refs.", "eqs.", "figs.",
}
SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+")
# A single capital followed by a period is an initial ("J. Devlin"), not an end.
INITIAL = re.compile(r"\b[A-Z]\.$")


def split_sentences(text: str) -> list[str]:
    """Split on sentence boundaries, re-joining the false ones."""
    sentences: list[str] = []

    for piece in SENTENCE_BOUNDARY.split(text or ""):
        piece = piece.strip()
        if not piece:
            continue
        if sentences:
            previous = sentences[-1]
            tail = previous.split()[-1].lower() if previous.split() else ""
            if tail in ABBREVIATIONS or INITIAL.search(previous):
                sentences[-1] = f"{previous} {piece}"
                continue
        sentences.append(piece)

    return sentences


def split_oversized_sentence(sentence: str, limit: int) -> list[str]:
    """Hard-split one sentence that exceeds the whole budget.

    Rare but real — a list of forty requirements with no full stop, or a table
    row rendered as one line. Without this the chunk overflows the model's
    limit and is truncated invisibly, which is the failure this module exists
    to prevent.
    """
    parts: list[str] = []
    current: list[str] = []

    for word in sentence.split():
        # Check BEFORE adding: emitting once the count reaches the limit lets
        # the word that crossed it ride along, so a part could end a few
        # tokens over - the exact overflow this function exists to prevent.
        if current and token_count(" ".join(current + [word])) > limit:
            parts.append(" ".join(current))
            current = []
        current.append(word)

    if current:
        parts.append(" ".join(current))
    return parts


# --------------------------------------------------------------------------
# Packing
# --------------------------------------------------------------------------
def pack_sentences(
    sentences: list[str], budget: int, overlap: int
) -> Iterator[str]:
    """Greedily fill chunks with whole sentences, overlapping at the seams."""
    current: list[str] = []
    current_tokens = 0

    for sentence in sentences:
        sentence_tokens = token_count(sentence)

        if sentence_tokens > budget:
            if current:
                yield " ".join(current)
                current, current_tokens = [], 0
            for part in split_oversized_sentence(sentence, budget):
                yield part
            continue

        if current_tokens + sentence_tokens > budget and current:
            yield " ".join(current)
            # Carry the tail of the finished chunk into the next one.
            carried: list[str] = []
            carried_tokens = 0
            for previous in reversed(current):
                previous_tokens = token_count(previous)
                if carried_tokens + previous_tokens > overlap:
                    break
                carried.insert(0, previous)
                carried_tokens += previous_tokens
            # The overlap is a want; the budget is a guarantee. A long next
            # sentence plus a full overlap can exceed the budget - measured at
            # 431 tokens against 400 before this - so the carried tail gives
            # way, oldest sentence first, until the new one fits.
            while carried and carried_tokens + sentence_tokens > budget:
                carried_tokens -= token_count(carried.pop(0))
            current, current_tokens = carried, carried_tokens

        current.append(sentence)
        current_tokens += sentence_tokens

    if current:
        yield " ".join(current)


def chunk_text(
    text: str, *, budget: int | None = None, overlap: int | None = None
) -> list[str]:
    """Split one piece of text — a brief, a note, one section — into chunks."""
    budget = effective_budget(budget)
    overlap = CHUNK_OVERLAP_TOKENS if overlap is None else overlap

    sentences = split_sentences(text)
    if not sentences:
        return []

    chunks: list[str] = []
    for piece in pack_sentences(sentences, budget, overlap):
        if (
            chunks
            and token_count(piece) < MIN_CHUNK_TOKENS
            and token_count(f"{chunks[-1]} {piece}") <= budget
        ):
            # A tiny trailing remainder is folded into the previous chunk
            # rather than indexed as a fragment. Dropping it would lose real
            # text; indexing it alone would add a weak competitor for the
            # queries its own neighbours should win. Only when it fits,
            # though: a fragment is a lesser evil than an over-budget chunk.
            chunks[-1] = f"{chunks[-1]} {piece}"
            continue
        chunks.append(piece)

    # A whole piece of text shorter than the minimum is kept: a resource note
    # or a one-line brief is short on purpose, and it is all there is.
    return chunks


def chunk_document(
    doc: dict, *, budget: int | None = None, overlap: int | None = None
) -> list[dict]:
    """Chunk one document from `sources.py`, whichever shape it arrived in.

    A record's own text is one string. An attachment is a list of sections,
    because a chunk must not span two of them and that is impossible to honour
    once they have been joined into one string. Both come back as the same list
    of dicts, so the store writes one kind of thing.
    """
    if doc.get("sections"):
        return chunk_sections(doc["sections"], budget=budget, overlap=overlap)

    return [
        {"text": piece}
        for piece in chunk_text(doc.get("text", ""), budget=budget, overlap=overlap)
    ]


def chunk_sections(
    sections: list[dict], *, budget: int | None = None, overlap: int | None = None
) -> list[dict]:
    """Chunk an extracted document, never crossing a section boundary.

    Each chunk carries where it came from, so a citation can name a section and
    a page rather than an offset nobody can act on.
    """
    chunks: list[dict] = []

    for section in fold_opening_fragment(sections) if CONTEXT_HEADERS else sections:
        pieces = chunk_text(section.get("text", ""), budget=budget, overlap=overlap)
        for position, piece in enumerate(pieces):
            chunks.append(
                {
                    "text": piece,
                    "heading": section.get("heading", ""),
                    "section_index": section.get("index", 0),
                    "chunk_index": position,
                    "start_page": section.get("start_page"),
                    "end_page": section.get("end_page"),
                }
            )

    return chunks


def file_sections(chunks: list[dict]) -> list[dict]:
    """A file's chunks, in order, grouped back into its sections.

    Chunks of one section overlap a little; the overlap is kept rather than
    guessed at, because a summary is not hurt by a repeated sentence. Used by
    the Copilot's file summary (agent.py) and S8's criteria extraction (criteria.py).
    """
    sections: dict[int, dict] = {}
    for c in sorted(chunks, key=lambda c: c.get("chunkIndex", 0)):
        index = c.get("sectionIndex") or 0
        entry = sections.setdefault(index, {"index": index, "heading": c.get("heading") or "", "parts": []})
        entry["parts"].append(c.get("content", ""))
    return [{**v, "text": "\n".join(v["parts"])} for _, v in sorted(sections.items())]
