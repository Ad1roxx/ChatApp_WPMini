"""Chunking: the properties that must hold for every chunk.

Three of these are the point of the module, and each is asserted directly
rather than through a proxy:

1. No chunk exceeds what the embedding model can read — counted with the
   model's own tokenizer, because that is the thing that truncates.
2. No chunk spans two sections.
3. Consecutive chunks of one section overlap.

The first needs the real model's tokenizer, so these tests load it. That costs
a few seconds once per run and is the whole reason the assertion is worth
anything: a character count would pass while the model silently truncated.
"""

from __future__ import annotations

import pytest

import chunking
from chunking import (
    HEADROOM_TOKENS,
    chunk_sections,
    chunk_text,
    effective_budget,
    split_oversized_sentence,
    split_sentences,
    token_count,
)
from config import (
    CHUNK_BUDGET_TOKENS,
    CHUNK_OVERLAP_TOKENS,
    EMBEDDING_MAX_TOKENS,
    EMBEDDING_MODEL,
    MIN_CHUNK_TOKENS,
)

# Three sections with deliberately disjoint vocabularies, so a chunk that
# crossed a boundary can be detected by the words in it rather than by
# bookkeeping the chunker itself produced.
MARKERS = {
    "Requirements": "zebra",
    "Deliverables": "quartz",
    "Marking Scheme": "nimbus",
}


def dense_section(heading: str, sentences: int) -> dict:
    marker = MARKERS[heading]
    text = " ".join(
        f"The {marker} rule {n} states that every {marker} submission must "
        f"record its {marker} outcome before the {marker} deadline passes."
        for n in range(sentences)
    )
    return {"heading": heading, "text": text, "index": 0}


def document(sentences: int = 30) -> list[dict]:
    return [
        dict(dense_section(heading, sentences), index=position)
        for position, heading in enumerate(MARKERS)
    ]


# --------------------------------------------------------------------------
# Property 1 — nothing exceeds the model's limit
# --------------------------------------------------------------------------
def test_the_configured_limit_is_the_model_s_real_limit():
    """EMBEDDING_MAX_TOKENS is a claim about the model; this checks it.

    Taken from the loaded model rather than from its documentation: the
    comment in config.py would keep saying 256 after a model switch.
    """
    from store import embedder

    assert EMBEDDING_MAX_TOKENS == embedder().max_seq_length


def test_no_chunk_exceeds_the_model_limit():
    chunks = [c["text"] for c in chunk_sections(document())]

    assert chunks
    oversized = [token_count(c) for c in chunks if token_count(c) > EMBEDDING_MAX_TOKENS]
    assert oversized == []


def test_no_chunk_exceeds_the_limit_even_when_a_larger_budget_is_asked_for():
    """The budget is a request. The model's ceiling is not negotiable."""
    chunks = [c["text"] for c in chunk_sections(document(), budget=5000)]

    assert chunks
    assert max(token_count(c) for c in chunks) <= EMBEDDING_MAX_TOKENS


UNIT = "the cache invalidation rule must clear every stale entry for that user"


def sentence_of(repeats: int) -> str:
    return " ".join([UNIT] * repeats) + "."


@pytest.mark.parametrize(
    "shape",
    [
        # The shape the review found: two short sentences, then one long
        # enough that it plus a carried overlap exceeds the budget. It produced
        # a 431-token chunk against a 400-token budget.
        [4, 4, 29],
        [4, 29, 4, 29, 4],
        [1, 1, 1, 30, 1, 1, 30],
        [28, 28, 28],
        [2] * 60,
    ],
)
def test_no_chunk_exceeds_its_budget_whatever_the_sentence_lengths(shape):
    """The budget, not merely the model's ceiling, is the guarantee.

    Asserting only "under the model limit" let a chunk run over budget for as
    long as the model happened to have room - true with bge-small's 512, and
    false with MiniLM's 256, where the same chunk would have been truncated.
    Uniform short sentences never exercise this, which is how it got past the
    first version of these tests.
    """
    text = " ".join(sentence_of(r) for r in shape)

    chunks = chunk_text(text)

    assert chunks
    assert max(token_count(c) for c in chunks) <= effective_budget()


def test_no_chunk_exceeds_a_small_budget_either():
    """The same guarantee where the overlap is a large share of the budget."""
    text = " ".join(sentence_of(r) for r in [3, 3, 9, 3, 9, 9, 3])

    chunks = chunk_text(text, budget=128, overlap=60)

    assert max(token_count(c) for c in chunks) <= 128


def test_a_hard_split_never_runs_over_by_the_last_word():
    sentence = " ".join(f"requirement{n} must be met" for n in range(300))

    parts = split_oversized_sentence(sentence, 50)

    assert max(token_count(p) for p in parts) <= 50


def test_effective_budget_clamps_to_the_model_with_headroom():
    assert effective_budget(5000) == EMBEDDING_MAX_TOKENS - HEADROOM_TOKENS
    assert effective_budget(64) == 64
    assert effective_budget() == min(
        CHUNK_BUDGET_TOKENS, EMBEDDING_MAX_TOKENS - HEADROOM_TOKENS
    )


def test_the_default_budget_fits_todays_model():
    """The configured 400 is reachable in full, and was not always.

    Under all-MiniLM-L6-v2 (256 tokens) this same budget was clamped to 240,
    and the test written at step 4 asserted exactly that — then failed on the
    switch to bge-small-en-v1.5, which is the point of writing it. 512 tokens
    leaves room for the budget and the headroom both.
    """
    assert CHUNK_BUDGET_TOKENS == 400
    assert effective_budget() == CHUNK_BUDGET_TOKENS
    assert CHUNK_BUDGET_TOKENS + HEADROOM_TOKENS <= EMBEDDING_MAX_TOKENS


# --------------------------------------------------------------------------
# Property 2 — chunks never cross a section boundary
# --------------------------------------------------------------------------
def test_no_chunk_spans_two_sections():
    chunks = chunk_sections(document())

    assert chunks
    for chunk in chunks:
        present = {word for word in MARKERS.values() if word in chunk["text"]}
        assert present == {MARKERS[chunk["heading"]]}


def test_a_short_section_is_not_merged_into_its_neighbour():
    """Even sections small enough to share one chunk's budget stay apart.

    Only a document's opening fragment folds (`fold_opening_fragment`), so this
    document opens with a section above the minimum.
    """
    sections = [
        {"heading": "Overview", "text": "word " * 40, "index": 0},
        {"heading": "Requirements", "text": "The zebra rule applies.", "index": 1},
        {"heading": "Deliverables", "text": "The quartz rule applies.", "index": 2},
    ]

    chunks = chunk_sections(sections)

    assert len(chunks) == 3
    assert [c["heading"] for c in chunks] == ["Overview", "Requirements", "Deliverables"]


def test_each_chunk_records_where_it_came_from():
    sections = [
        {
            "heading": "Marking Scheme",
            "text": dense_section("Marking Scheme", 30)["text"],
            "index": 4,
            "start_page": 2,
            "end_page": 3,
        }
    ]

    chunks = chunk_sections(sections)

    assert len(chunks) > 1
    assert [c["chunk_index"] for c in chunks] == list(range(len(chunks)))
    assert {c["section_index"] for c in chunks} == {4}
    assert {(c["start_page"], c["end_page"]) for c in chunks} == {(2, 3)}


# --------------------------------------------------------------------------
# Property 3 — consecutive chunks of one section overlap
# --------------------------------------------------------------------------
def test_consecutive_chunks_of_a_section_overlap():
    chunks = [c["text"] for c in chunk_sections([dense_section("Requirements", 40)])]

    assert len(chunks) > 1
    for earlier, later in zip(chunks, chunks[1:]):
        shared = set(split_sentences(earlier)) & set(split_sentences(later))
        assert shared, f"no overlap between {earlier[-60:]!r} and {later[:60]!r}"


def test_the_overlap_stays_within_its_budget():
    chunks = [c["text"] for c in chunk_sections([dense_section("Requirements", 40)])]

    for earlier, later in zip(chunks, chunks[1:]):
        shared = [s for s in split_sentences(later) if s in set(split_sentences(earlier))]
        assert token_count(" ".join(shared)) <= CHUNK_OVERLAP_TOKENS


def test_overlap_does_not_lose_text():
    """Every sentence of the section survives into at least one chunk."""
    section = dense_section("Deliverables", 25)
    chunks = [c["text"] for c in chunk_sections([section])]

    for sentence in split_sentences(section["text"]):
        assert any(sentence in chunk for chunk in chunks)


# --------------------------------------------------------------------------
# Sentence splitting
# --------------------------------------------------------------------------
def test_sentences_split_on_real_boundaries():
    assert split_sentences("One thing. Another thing! A third?") == [
        "One thing.",
        "Another thing!",
        "A third?",
    ]


def test_an_abbreviation_does_not_end_a_sentence():
    text = "Use the index described by Chandra et al. in the second reading."

    assert split_sentences(text) == [text]


def test_other_abbreviations_do_not_end_a_sentence():
    for text in (
        "Pick one store, e.g. Redis, and say why.",
        "Cache the result, i.e. the rendered page, for a minute.",
        "See fig. 4 for the hit rate.",
    ):
        assert split_sentences(text) == [text]


def test_an_initial_does_not_end_a_sentence():
    text = "The paper by J. Dean describes the same failure."

    assert split_sentences(text) == [text]


def test_empty_text_produces_no_sentences():
    assert split_sentences("") == []
    assert split_sentences("   \n  ") == []


# --------------------------------------------------------------------------
# Edge cases
# --------------------------------------------------------------------------
def test_one_sentence_longer_than_the_whole_budget_is_hard_split():
    """A forty-item list with no full stop is one sentence to any splitter."""
    sentence = " ".join(f"requirement {n} must be met" for n in range(200))
    budget = effective_budget()

    parts = split_oversized_sentence(sentence, budget)

    assert len(parts) > 1
    assert all(token_count(p) <= budget for p in parts)
    assert " ".join(parts).split() == sentence.split()


def test_an_oversized_sentence_inside_a_section_still_fits_the_model():
    sentence = " ".join(f"requirement {n} must be met" for n in range(400))
    chunks = [c["text"] for c in chunk_sections([{"heading": "R", "text": sentence, "index": 0}])]

    assert len(chunks) > 1
    assert max(token_count(c) for c in chunks) <= EMBEDDING_MAX_TOKENS


def test_a_short_piece_of_text_is_kept_whole():
    """A resource note is short on purpose, and it is all there is."""
    note = "Read chapter 3 before the session."
    assert token_count(note) < MIN_CHUNK_TOKENS

    assert chunk_text(note) == [note]


def test_empty_text_produces_no_chunks():
    assert chunk_text("") == []
    assert chunk_sections([]) == []
    assert chunk_sections([{"heading": "R", "text": "", "index": 0}]) == []


def test_a_trailing_fragment_is_folded_into_its_neighbour():
    """A remainder below the minimum joins the previous chunk, not the index."""
    section = dense_section("Requirements", 40)
    chunks = [c["text"] for c in chunk_sections([section])]

    assert len(chunks) > 1
    assert token_count(chunks[-1]) >= MIN_CHUNK_TOKENS


def test_the_tokenizer_is_the_embedding_model_s_own():
    """Counting with any other tokenizer makes the budget a guess."""
    from store import embedder

    assert chunking.tokenizer() is embedder().tokenizer
    assert EMBEDDING_MODEL == "BAAI/bge-small-en-v1.5"
