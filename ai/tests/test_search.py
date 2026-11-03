"""The served search: what the pipeline asks for, and what reordering may do.

Three properties matter here, and none of them needs a database:

1. The permission filter is **inside** `$vectorSearch`, never applied to its
   results. That is the one thing in this service that would be a security bug
   rather than a quality one, and it is asserted against the pipeline itself.
2. Reranking and capping only ever **reorder** what the filtered search
   returned. No stage after the search can widen it.
3. The soft cap spreads results across records only when relevance cannot
   decide — and never returns fewer than k to satisfy itself.

The store is built with a Mongo client that is never used: constructing a
`MongoClient` connects to nothing, and `chunks` is replaced with a recorder.
"""

from __future__ import annotations

import pytest

import chunking
import store as store_module
from config import DIVERSITY_CAP, DIVERSITY_MARGIN, SERVED_K
from store import ChunkStore, soft_cap

M1 = "d00000000000000000000001"
ADITYA = "0000000000000000000000a1"


class Recorder:
    """Stands in for the collection: remembers the pipeline, returns the rows."""

    def __init__(self, rows, models=("BAAI/bge-small-en-v1.5",)):
        self.rows = rows
        self.models = list(models)
        self.pipelines = []

    def distinct(self, field):
        assert field == "embeddingModel"
        return self.models

    def aggregate(self, pipeline):
        self.pipelines.append(pipeline)
        return [dict(row) for row in self.rows]


def chunk(title, score, *, source_type="resource", source_id=None, **extra):
    return {
        "title": title,
        "content": f"text of {title}",
        "sourceType": source_type,
        "sourceId": source_id or title,
        "chunkIndex": 0,
        "score": score,
        **extra,
    }


@pytest.fixture
def served(monkeypatch):
    """A store whose search runs for real, over rows a recorder hands back.

    The read-time check is replaced by a pass-through here, and only here:
    these tests are about the shape of the pipeline, over rows that have no
    records behind them. The check itself runs for real, against Mongo, in
    test_read_check.py - and `test_the_check_runs_before_the_reranker` below
    pins where in this pipeline it sits.
    """
    monkeypatch.setattr(store_module, "embed_query", lambda query: [0.0] * 384)
    monkeypatch.setattr(store_module, "read_time_check", lambda records, hits, viewer: (hits, []))

    def build(rows, rerank_scores=None):
        store = ChunkStore(records=object())
        store.chunks = Recorder(rows)
        if rerank_scores is not None:
            monkeypatch.setattr(
                store_module, "reranker", lambda: _FakeReranker(rerank_scores)
            )
        return store

    return build


class _FakeReranker:
    """Scores by looking the passage's text up, so the order is the test's."""

    def __init__(self, by_content):
        self.by_content = by_content

    def predict(self, pairs, **_kwargs):
        return [self.by_content[content] for _, content in pairs]


def vector_stage(pipeline):
    return next(stage["$vectorSearch"] for stage in pipeline if "$vectorSearch" in stage)


# --------------------------------------------------------------------------
# 1. The permission filter is inside the search
# --------------------------------------------------------------------------
def test_the_permission_filter_is_inside_the_vector_search(served):
    store = served([chunk("a", 0.9)], rerank_scores={"text of a": 1.0})

    store.search(M1, ADITYA, "anything")

    stage = vector_stage(store.chunks.pipelines[0])
    assert stage["filter"] == {
        "mentorshipId": {"$eq": M1},
        "viewers": {"$in": [ADITYA]},
    }


def test_no_stage_after_the_search_filters_on_permissions(served):
    """If the filter moved out of the search, this is what would catch it.

    Filtering afterwards would mean the index had already spent its candidate
    budget on documents the caller may not see — so a query could come back
    empty *because* the nearest neighbours belonged to someone else.
    """
    store = served([chunk("a", 0.9)], rerank_scores={"text of a": 1.0})

    store.search(M1, ADITYA, "anything")

    later = store.chunks.pipelines[0][1:]
    assert not any(
        key in stage for stage in later for key in ("$match", "$redact", "$lookup")
    )


# --------------------------------------------------------------------------
# 2. Over-fetching, and what the later stages may do
# --------------------------------------------------------------------------
def test_the_search_over_fetches_when_something_will_reorder(served):
    rows = [chunk(f"c{n}", 1.0 - n / 100) for n in range(30)]
    store = served(rows, rerank_scores={row["content"]: 0.0 for row in rows})

    store.search(M1, ADITYA, "anything", k=4)

    assert vector_stage(store.chunks.pipelines[0])["limit"] >= 30


def test_the_search_asks_for_exactly_k_when_nothing_will_reorder(served):
    """Over-fetching 30 to keep the first 4 of the same order buys nothing."""
    store = served([chunk("a", 0.9)])

    store.search(M1, ADITYA, "anything", k=4, rerank=False, diversity="none")

    assert vector_stage(store.chunks.pipelines[0])["limit"] == 4


def test_reranking_reorders_and_never_adds(served):
    rows = [chunk("near", 0.90), chunk("far", 0.10)]
    # The cross-encoder disagrees with the index, which is the whole point.
    store = served(rows, rerank_scores={"text of near": -4.0, "text of far": 7.5})

    results = store.search(M1, ADITYA, "anything", k=4, rerank=True, diversity="none")

    assert [r["title"] for r in results] == ["far", "near"]
    assert {r["title"] for r in results} <= {"near", "far"}
    assert [r["score"] for r in results] == [7.5, -4.0]


def test_the_reranker_reads_the_heading_only_with_the_setting_on(served, monkeypatch):
    rows = [chunk("near", 0.90, heading="Action items")]
    seen = []

    class Recording:
        def predict(self, pairs, **_kwargs):
            seen.extend(content for _, content in pairs)
            return [1.0] * len(pairs)

    store = served(rows)
    monkeypatch.setattr(store_module, "reranker", lambda: Recording())

    store.search(M1, ADITYA, "anything", k=4, rerank=True, diversity="none")
    monkeypatch.setattr(chunking, "EMBED_HEADINGS", True)
    results = store.search(M1, ADITYA, "anything", k=4, rerank=True, diversity="none")

    assert seen == ["text of near", "Action items\ntext of near"]
    assert results[0]["content"] == "text of near"


def test_without_the_reranker_the_index_order_is_kept(served):
    rows = [chunk("near", 0.90), chunk("far", 0.10)]
    store = served(rows)

    results = store.search(M1, ADITYA, "anything", k=4, rerank=False, diversity="none")

    assert [r["title"] for r in results] == ["near", "far"]
    assert [r["score"] for r in results] == [0.90, 0.10]


def test_an_unknown_diversity_mode_is_refused(served):
    """A typo in AI_DIVERSITY must fail, not quietly turn the stage off."""
    store = served([chunk("a", 0.9)])

    with pytest.raises(ValueError, match="unknown diversity"):
        store.search(M1, ADITYA, "anything", rerank=False, diversity="softcap")


def test_an_index_from_another_model_is_refused(served):
    """Same width, different model: the vectors mean nothing to each other.

    The review that found this measured it: a bge-small query over MiniLM
    vectors scored 0.16 recall@1 against 0.74, and raised nothing.
    """
    store = served([chunk("a", 0.9)])
    store.chunks.models = ["all-MiniLM-L6-v2"]

    with pytest.raises(store_module.ModelMismatch, match="all-MiniLM-L6-v2"):
        store.search(M1, ADITYA, "anything", rerank=False)
    assert store.chunks.pipelines == [], "it searched before refusing"


def test_an_index_from_this_model_is_searched(served):
    store = served([chunk("a", 0.9)])

    assert store.search(M1, ADITYA, "anything", rerank=False)


def test_an_empty_index_is_not_a_mismatch(served):
    store = served([])
    store.chunks.models = []

    assert store.search(M1, ADITYA, "anything", rerank=False) == []


def test_the_check_runs_before_the_reranker(served, monkeypatch):
    """A dropped chunk must never reach the cross-encoder, the cap, or the
    caller - so the check sits between the vector search and everything else."""
    rows = [chunk("kept", 0.9), chunk("gone", 0.8)]
    store = served(rows, rerank_scores={"text of kept": 1.0, "text of gone": 9.0})
    seen_by_check = []

    def check(records, hits, viewer):
        seen_by_check.extend(h["title"] for h in hits)
        return [h for h in hits if h["title"] != "gone"], []

    monkeypatch.setattr(store_module, "read_time_check", check)

    results = store.search(M1, ADITYA, "anything", rerank=True, diversity="soft_cap")

    assert seen_by_check == ["kept", "gone"], "the check did not see the raw candidates"
    # "gone" outscores "kept" with the reranker; it is absent because the
    # check removed it first, not because it lost.
    assert [r["title"] for r in results] == ["kept"]


def test_the_check_is_given_the_callers_id(served, monkeypatch):
    callers = []
    monkeypatch.setattr(
        store_module, "read_time_check", lambda records, hits, viewer: (callers.append(viewer), (hits, []))[1]
    )
    store = served([chunk("a", 0.9)])

    store.search(M1, ADITYA, "anything", rerank=False)

    assert callers == [ADITYA]


def test_k_is_honoured(served):
    rows = [chunk(f"c{n}", 1.0 - n / 100) for n in range(10)]
    store = served(rows)

    results = store.search(M1, ADITYA, "anything", k=2, rerank=False)

    assert len(results) == 2


def test_the_reranker_is_on_by_default_at_its_measured_batch_size(served, monkeypatch):
    """Entry 73. It earned the default on S2's corpus, once the batch size that
    made it slow was fixed: at 32 every candidate is padded to the longest."""
    from config import RERANK, RERANK_BATCH_SIZE

    store = served([chunk("near", 0.9), chunk("far", 0.1)],
                   rerank_scores={"text of near": -4.0, "text of far": 7.5})
    seen = {}
    fake = store_module.reranker()
    original = fake.predict

    def predict(pairs, **kwargs):
        seen.update(kwargs)
        return original(pairs, **kwargs)

    fake.predict = predict
    monkeypatch.setattr(store_module, "reranker", lambda: fake)

    results = store.search(M1, ADITYA, "anything")

    assert RERANK is True
    assert RERANK_BATCH_SIZE == 4
    assert seen == {"batch_size": 4}
    assert [r["score"] for r in results] == [7.5, -4.0], "the cross-encoder's order was not used"


def test_the_reranker_can_be_turned_off(served, monkeypatch):
    called = []
    monkeypatch.setattr(store_module, "reranker", lambda: called.append(1))
    monkeypatch.setattr(store_module, "RERANK", False)
    store = served([chunk("near", 0.9), chunk("far", 0.1)])
    # `served` patches reranker only when given scores, so this one stands.
    monkeypatch.setattr(store_module, "reranker", lambda: called.append(1))

    results = store.search(M1, ADITYA, "anything")

    assert called == [], "the cross-encoder was loaded"
    assert [r["score"] for r in results] == [0.9, 0.1], "the cosine order changed"


def test_the_soft_cap_stays_on_by_default(served):
    """Off goes the reranker only: the cap still over-fetches so it has
    alternatives to choose between."""
    from config import DIVERSITY

    rows = [chunk(f"c{n}", 1.0 - n / 100) for n in range(30)]
    store = served(rows)

    store.search(M1, ADITYA, "anything", k=4)

    assert DIVERSITY == "soft_cap"
    assert vector_stage(store.chunks.pipelines[0])["limit"] >= 30


def test_the_served_default_is_four(served):
    rows = [chunk(f"c{n}", 1.0 - n / 100, source_id=f"s{n}") for n in range(10)]
    store = served(rows)

    results = store.search(M1, ADITYA, "anything", rerank=False)

    assert SERVED_K == 4
    assert len(results) == 4


def test_a_chunk_s_position_in_its_file_is_returned(served):
    """A citation needs the record, the file and the page; all are projected."""
    store = served([chunk("brief.pdf", 0.9)])

    store.search(M1, ADITYA, "anything", rerank=False)

    projected = next(
        stage["$project"] for stage in store.chunks.pipelines[0] if "$project" in stage
    )
    for field in ("parentType", "parentId", "attachmentId", "heading", "startPage"):
        assert projected.get(field) == 1


# --------------------------------------------------------------------------
# 3. The soft cap
# --------------------------------------------------------------------------
def from_one_record(scores, *, record="submission"):
    """Chunks of one record, in rank order.

    Note what the margin is measured against: `soft_cap` min-maxes the scores
    across THIS candidate set before comparing them, so what counts as "close
    behind" depends on the spread of the candidates, not on the raw gap. A
    0.02 gap is decisive among candidates spanning 0.05 and negligible among
    candidates spanning 0.9. These fixtures therefore state scores explicitly
    rather than stepping by a constant: a step hides which side of the margin
    the result lands on.
    """
    return [
        chunk(
            f"{record}-{i}",
            score,
            source_type="attachment",
            source_id=f"{record}-file-{i}",
            parentType=record,
            parentId=record,
        )
        for i, score in enumerate(scores)
    ]


def test_a_file_and_the_hand_in_it_was_attached_to_are_one_record():
    """The cap limits records, not chunks or files.

    A PDF's chunks and the hand-in text above them are one hand-in, so a
    20-page attachment must not win every slot by being its own source.
    """
    rows = from_one_record([1.0, 0.9, 0.8, 0.7, 0.6]) + [
        chunk("hand-in", 0.5, source_type="submission", source_id="submission")
    ]

    selected = soft_cap(rows, k=4, cap=3, margin=0.2)

    assert len({(c.get("parentId") or c["sourceId"]) for c in selected}) == 1
    # Still four results: the cap bends rather than shrinking the context.
    assert len(selected) == 4


def test_the_cap_yields_a_slot_when_another_record_is_close_behind():
    """Normalised, own-4 and other are 0.09 apart: inside the 0.2 margin."""
    rows = [
        chunk("own-1", 1.00, source_id="a", parentType="r", parentId="a"),
        chunk("own-2", 0.95, source_id="a", parentType="r", parentId="a"),
        chunk("own-3", 0.90, source_id="a", parentType="r", parentId="a"),
        chunk("own-4", 0.50, source_id="a", parentType="r", parentId="a"),
        chunk("other", 0.45, source_id="b", parentType="r", parentId="b"),
    ]

    selected = soft_cap(rows, k=4, cap=3, margin=0.2)

    assert [c["title"] for c in selected] == ["own-1", "own-2", "own-3", "other"]


def test_the_cap_does_not_yield_when_relevance_is_decisive():
    """One document genuinely owning the answer is not a diversity failure.

    A blind cap would force the distant chunk in and spend a slot on it.
    """
    rows = [
        chunk("own-1", 1.00, source_id="a", parentType="r", parentId="a"),
        chunk("own-2", 0.98, source_id="a", parentType="r", parentId="a"),
        chunk("own-3", 0.96, source_id="a", parentType="r", parentId="a"),
        chunk("own-4", 0.94, source_id="a", parentType="r", parentId="a"),
        chunk("other", 0.10, source_id="b", parentType="r", parentId="b"),
    ]

    selected = soft_cap(rows, k=4, cap=3, margin=0.2)

    assert [c["title"] for c in selected] == ["own-1", "own-2", "own-3", "own-4"]


def test_the_same_raw_gap_can_fall_either_side_of_the_margin():
    """The consequence of normalising per query, asserted rather than implied.

    Identical records, identical 0.05 gap at the cap boundary. In the first
    set the candidates span 0.05, so that gap is the whole spread and
    relevance decides; in the second they span 0.9, so the same gap is noise
    and diversity decides. This is why the margin cannot be read as a score
    difference, and why nothing thresholds on these numbers (Entry 41).
    """
    def pair(scores):
        return [
            chunk("own-1", scores[0], source_id="a", parentType="r", parentId="a"),
            chunk("own-2", scores[1], source_id="a", parentType="r", parentId="a"),
            chunk("own-3", scores[2], source_id="a", parentType="r", parentId="a"),
            chunk("own-4", scores[3], source_id="a", parentType="r", parentId="a"),
            chunk("other", scores[4], source_id="b", parentType="r", parentId="b"),
        ]

    tight = soft_cap(pair([1.00, 0.99, 0.98, 0.97, 0.95]), k=4, cap=3, margin=0.2)
    wide = soft_cap(pair([1.00, 0.95, 0.90, 0.15, 0.10]), k=4, cap=3, margin=0.2)

    assert [c["title"] for c in tight] == ["own-1", "own-2", "own-3", "own-4"]
    assert [c["title"] for c in wide] == ["own-1", "own-2", "own-3", "other"]


def test_the_cap_never_returns_fewer_than_k():
    rows = from_one_record([1.0, 0.9, 0.8, 0.7, 0.6, 0.5])

    assert len(soft_cap(rows, k=4, cap=1, margin=1.0)) == 4


def test_the_cap_returns_everything_when_there_is_less_than_k():
    rows = from_one_record([1.0, 0.9])

    assert len(soft_cap(rows, k=4, cap=3, margin=0.2)) == 2


def test_the_cap_on_nothing_is_nothing():
    assert soft_cap([], k=4, cap=3, margin=0.2) == []


def test_identical_scores_do_not_crash_the_normalisation():
    """min == max, which is a division by zero if written carelessly."""
    rows = [
        chunk(f"c{n}", 0.5, source_id=f"s{n}", parentType="r", parentId=f"s{n}")
        for n in range(6)
    ]

    assert len(soft_cap(rows, k=4, cap=3, margin=0.2)) == 4


def test_the_cap_spreads_across_records_when_all_are_comparable():
    # A owns the top three; A's fourth and B's best are 0.02 apart once
    # normalised over a set spanning 0.9, so the slot is yielded.
    rows = (
        from_one_record([1.00, 0.98, 0.96, 0.80], record="A")
        + from_one_record([0.78, 0.50, 0.30, 0.10], record="B")
    )

    selected = soft_cap(rows, k=4, cap=DIVERSITY_CAP, margin=DIVERSITY_MARGIN)

    records = {(c.get("parentId") or c["sourceId"]) for c in selected}
    assert records == {"A", "B"}


def test_the_configured_cap_and_margin_are_the_ported_ones():
    """Changed from RAG-Project only in what they are keyed on."""
    assert (DIVERSITY_CAP, DIVERSITY_MARGIN) == (3, 0.2)
