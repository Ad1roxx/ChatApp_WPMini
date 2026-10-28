"""The embedding model, and the asymmetry it was trained with.

These assert properties of the vectors themselves rather than of the
configuration that produced them. A test that only re-read `config.py` would
pass whatever the model actually did.
"""

from __future__ import annotations

import math

import pytest

from config import (
    EMBEDDING_DIMS,
    EMBEDDING_MAX_TOKENS,
    EMBEDDING_MODEL,
    QUERY_INSTRUCTION,
)
from store import embed_passages, embed_query, embedder


def norm(vector: list[float]) -> float:
    return math.sqrt(sum(value * value for value in vector))


# --------------------------------------------------------------------------
# The model is the one that was configured, and config says what is true of it
# --------------------------------------------------------------------------
def test_the_model_in_use_is_bge_small():
    assert EMBEDDING_MODEL == "BAAI/bge-small-en-v1.5"


def test_the_configured_width_is_the_model_s_width():
    """A mismatch here is the one failure the vector index catches for us.

    `numDimensions` in the index is set from EMBEDDING_DIMS, and Atlas rejects
    a query vector of any other length — but it rejects it at query time, in
    production, rather than at the point the model changed.
    """
    assert EMBEDDING_DIMS == embedder().get_embedding_dimension()
    assert len(embed_passages(["anything"])[0]) == EMBEDDING_DIMS


def test_the_configured_token_ceiling_is_the_model_s_ceiling():
    assert EMBEDDING_MAX_TOKENS == embedder().max_seq_length


def test_the_width_did_not_change_with_the_model():
    """Why the switch needed no index rebuild, asserted rather than asserted of.

    all-MiniLM-L6-v2 and bge-small-en-v1.5 are both 384-dimensional. If a
    future model is not, this is the test that says the index must be rebuilt
    before the model moves.
    """
    assert EMBEDDING_DIMS == 384


# --------------------------------------------------------------------------
# L2 normalisation
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    "text",
    [
        "short",
        "The marking scheme awards ten marks for the written explanation.",
        "word " * 400,
    ],
)
def test_passage_vectors_are_unit_length(text):
    assert norm(embed_passages([text])[0]) == pytest.approx(1.0, abs=1e-5)


def test_query_vectors_are_unit_length():
    assert norm(embed_query("what is the marking scheme?")) == pytest.approx(
        1.0, abs=1e-5
    )


def test_a_unit_vector_makes_a_dot_product_a_cosine():
    """Which is what lets a score be compared against another score at all."""
    first, second = embed_passages(
        [
            "Compound indexes are read left to right.",
            "An index nothing uses still costs you every write.",
        ]
    )

    dot = sum(a * b for a, b in zip(first, second))
    assert -1.0 - 1e-6 <= dot <= 1.0 + 1e-6


# --------------------------------------------------------------------------
# The passage/query asymmetry
# --------------------------------------------------------------------------
def test_the_query_instruction_is_the_one_bge_was_trained_with():
    assert QUERY_INSTRUCTION == (
        "Represent this sentence for searching relevant passages: "
    )


def test_the_query_prefix_is_applied_to_queries():
    """The prefixed text and the bare text embed differently, so it is used."""
    query = "how do compound indexes work?"

    assert embed_query(query) != embed_passages([query])[0]
    assert embed_query(query) == pytest.approx(
        embed_passages([f"{QUERY_INSTRUCTION}{query}"])[0], abs=1e-6
    )


def test_the_query_prefix_is_not_applied_to_passages():
    """The mistake this split exists to prevent: prefixing both sides.

    Nothing would fail. Retrieval would simply get worse, because every passage
    would be encoded as though it were a search intent.
    """
    passage = "Compound indexes are read left to right."

    bare = embed_passages([passage])[0]
    prefixed = embed_passages([f"{QUERY_INSTRUCTION}{passage}"])[0]

    assert bare != prefixed
    assert embed_passages([passage])[0] == pytest.approx(bare, abs=1e-6)


def test_the_prefix_changes_which_passage_a_question_is_nearest():
    """The prefix is not cosmetic: it moves the ranking, measurably.

    Which *direction* it moves it is a question about a corpus, not about two
    hand-picked sentences — a first attempt at this test asserted that the
    prefix pulls a question towards the passage answering it and away from a
    paraphrasing question, and that is simply not true pair by pair (it came
    out 0.01 the other way). The claim worth making in a unit test is that the
    two encodings rank differently at all; whether the prefix helps is settled
    on the 45 questions by `evaluate.py`, and recorded in BUILD_NOTES Entry 47.
    """
    question = "What is the deadline for the indexing assignment?"
    candidates = embed_passages(
        [
            "Hand the indexing assignment in by the 14th of March.",
            "When is the indexing assignment due, roughly?",
            "Compound indexes are read left to right.",
        ]
    )

    def ranked(vector):
        scores = [sum(x * y for x, y in zip(vector, c)) for c in candidates]
        return scores

    with_prefix = ranked(embed_query(question))
    without_prefix = ranked(embed_passages([question])[0])

    assert with_prefix != without_prefix


def test_passages_are_embedded_in_one_call_per_batch():
    """A batch and the same texts one at a time must agree.

    Worth asserting because batching is where a quiet reordering bug lives:
    the vectors are written beside their text by position.
    """
    texts = [
        "The first criterion is correctness.",
        "The second criterion is clarity.",
        "The third criterion is testing.",
    ]

    batched = embed_passages(texts)
    separate = [embed_passages([text])[0] for text in texts]

    for together, alone in zip(batched, separate):
        assert together == pytest.approx(alone, abs=1e-5)
