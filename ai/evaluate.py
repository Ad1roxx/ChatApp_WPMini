"""Measure the retrieval, rather than assert that it exists.

    python evaluate.py                          the served configuration
    python evaluate.py --budget 256             a smaller token budget
    python evaluate.py --compare                several token budgets
    python evaluate.py --ablation               one retrieval stage at a time

Each question in eval/questions.jsonl carries the source that should answer it,
or none at all. Three kinds of question, and the third is the interesting one:

- answerable from this mentorship's material
- unanswerable by anyone — the topic is simply not in the corpus
- **unanswerable by ME, but present in the corpus under another mentorship**

The last kind is a security probe wearing an evaluation's clothes. If those
ever retrieve something confidently, the filter has failed in the way that
matters, and a leak would look exactly like a good answer.

## What is measured

recall@k   did any expected source appear in the top k
MRR        1/rank of the first expected source, averaged
separation the gap between top scores on answerable and unanswerable questions
latency    median wall-clock time for one search, as served

There is no LLM here, so "abstention" is measured as the score a generation
step would have to threshold on. A retriever whose best unanswerable score sits
above its worst answerable score cannot be made to say "I do not know" by any
prompt, and that is worth knowing before writing the prompt.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

from chunking import chunk_document, effective_budget
from config import CHUNK_BUDGET_TOKENS
from sources import documents
from store import ChunkStore

M1 = "d00000000000000000000001"
ADITYA = "0000000000000000000000a1"

QUESTIONS = Path(__file__).parent / "eval" / "questions.jsonl"
KS = (1, 3, 5)

# The stages being measured, in the order they were added. Each row turns one
# thing on, so a number can be attributed to the thing that produced it rather
# than to "the new pipeline".
STAGES = (
    ("dense only", {"rerank": False, "diversity": "none"}),
    ("+ reranker", {"rerank": True, "diversity": "none"}),
    ("+ soft cap", {"rerank": True, "diversity": "soft_cap"}),
)


def load_questions() -> list[dict]:
    with QUESTIONS.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def build_index(store: ChunkStore, budget: int) -> int:
    """Re-chunk and re-embed everything with one configuration."""
    store.drop_all()

    written = 0
    for doc in documents(store.db):
        pieces = chunk_document(doc, budget=budget)
        written += store.replace_source(doc, pieces)

    if not store.wait_until_searchable(written):
        raise TimeoutError("the index never caught up with the writes")
    return written


def evaluate(
    store: ChunkStore,
    questions: list[dict],
    rerank: bool | None = None,
    diversity: str | None = None,
) -> dict:
    hits = {k: 0 for k in KS}
    reciprocal: list[float] = []
    answerable_scores: list[float] = []
    unanswerable_scores: list[float] = []
    leaks: list[str] = []
    misses: list[str] = []

    answerable = [q for q in questions if q["answerable"]]

    latencies: list[float] = []

    for q in questions:
        # The served search, not a copy of it: a measurement of a pipeline
        # nobody runs is worth nothing. k is max(KS) so recall@5 can be
        # computed; the served default is smaller, which only ever helps
        # precision and cannot change recall@1.
        started = time.perf_counter()
        results = store.search(
            M1,
            ADITYA,
            q["question"],
            k=max(KS),
            rerank=rerank,
            diversity=diversity,
        )
        latencies.append(time.perf_counter() - started)
        titles = [r["title"] for r in results]
        top_score = results[0]["score"] if results else 0.0

        if q["answerable"]:
            answerable_scores.append(top_score)
            ranks = [i + 1 for i, t in enumerate(titles) if t in q["expected"]]
            first = min(ranks) if ranks else None

            for k in KS:
                if first is not None and first <= k:
                    hits[k] += 1
            reciprocal.append(1 / first if first else 0.0)

            if first is None:
                misses.append(f"{q['id']}: {q['question']} -> {titles[:3]}")
        else:
            unanswerable_scores.append(top_score)
            # Every chunk returned here belongs to this mentorship by
            # construction; a "leak" would be the filter failing, which the
            # isolation check covers. What this records is the retriever
            # sounding confident about a question it cannot answer.
            leaks.append((top_score, f"{q['id']}: {q['question']}", titles[:1]))

    n = len(answerable)
    return {
        "answerable": n,
        "unanswerable": len(questions) - n,
        "recall": {k: hits[k] / n for k in KS},
        "mrr": sum(reciprocal) / n,
        "answerable_top_mean": statistics.mean(answerable_scores),
        "answerable_top_min": min(answerable_scores),
        "unanswerable_top_mean": statistics.mean(unanswerable_scores),
        "unanswerable_top_max": max(unanswerable_scores),
        "confident_on_unanswerable": leaks,
        "misses": misses,
        "median_latency_ms": statistics.median(latencies) * 1000,
    }


def report(name: str, chunks: int, result: dict) -> None:
    r = result["recall"]
    print(f"\n=== {name} ===")
    print(f"  chunks indexed        {chunks}")
    print(f"  recall@1 / @3 / @5    {r[1]:.2f} / {r[3]:.2f} / {r[5]:.2f}")
    print(f"  MRR                   {result['mrr']:.3f}")
    print(
        "  top score             answerable mean {:.3f} (min {:.3f}) · "
        "unanswerable mean {:.3f} (max {:.3f})".format(
            result["answerable_top_mean"],
            result["answerable_top_min"],
            result["unanswerable_top_mean"],
            result["unanswerable_top_max"],
        )
    )
    print(f"  median latency        {result['median_latency_ms']:.0f} ms")
    gap = result["answerable_top_min"] - result["unanswerable_top_max"]
    print(
        f"  separation            {gap:+.3f} "
        f"({'a threshold exists' if gap > 0 else 'no single threshold separates them'})"
    )

    worst = sorted(result["confident_on_unanswerable"], reverse=True)[:3]
    if worst:
        print("  most confident on a question it cannot answer:")
        for score, question, titles in worst:
            print(f"    {score:.3f}  {question}")
            print(f"           -> {titles[0] if titles else '(nothing)'}")

    if result["misses"]:
        print(f"  missed ({len(result['misses'])}):")
        for m in result["misses"]:
            print(f"    {m}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure retrieval quality.")
    parser.add_argument("--budget", type=int, default=CHUNK_BUDGET_TOKENS)
    parser.add_argument("--compare", action="store_true", help="several token budgets")
    parser.add_argument(
        "--ablation",
        action="store_true",
        help="dense only, then the reranker, then the soft cap",
    )
    args = parser.parse_args()

    questions = load_questions()
    print(f"{len(questions)} questions from {QUESTIONS.name}")

    store = ChunkStore()
    store.ensure_vector_index()

    # Budgets rather than chunking strategies: the strategies compared in
    # Entry 41 were fixed-versus-heading over character counts, and the heading
    # one was measured as not applicable to a corpus with no headings. What is
    # worth comparing now is how much text one chunk may hold.
    #
    # Named and de-duplicated by the *effective* budget, because a request
    # above the model's limit is clamped to it. bge-small-en-v1.5 reads 512, so
    # all three budgets below are reachable today; under all-MiniLM-L6-v2 both
    # 400 and 256 came out at 240, and running one configuration twice under
    # two names would have read as a measurement rather than as the clamp.
    requested = [400, 256, 128] if args.compare else [args.budget]
    configurations: list[tuple[str, int]] = []
    for budget in dict.fromkeys(effective_budget(b) for b in requested):
        configurations.append((f"tokens {budget}", budget))

    for name, budget in configurations:
        chunks = build_index(store, budget)

        if args.ablation:
            for stage, settings in STAGES:
                report(f"{name}, {stage}", chunks, evaluate(store, questions, **settings))
        else:
            report(f"{name}, as served", chunks, evaluate(store, questions))

    print()


if __name__ == "__main__":
    main()
