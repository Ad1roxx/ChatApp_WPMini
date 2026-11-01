"""S2 step 2b: the prefix, the reranker and the soft cap, on the larger corpus.

    cd ai && .venv/Scripts/python.exe eval/retrieval_s2.py

BUILD_NOTES Entry 63. Four configurations, one index (none of them changes the
chunks): the served default, the query prefix off, the cross-encoder on over
the 30 candidates, and the soft cap off. Each is scored on the original 65 and
the new 55 separately, never averaged together, and the decision rules written
into Entry 63 before the run are applied to the counts printed here.

The original records are scored on the six clear-cut label changes (Entry 51),
as every quoted figure is. In the new set, the extractor-limited questions are
reported on a row of their own and kept out of the decision rule.
"""

from __future__ import annotations

import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import store  # noqa: E402
from config import CANDIDATE_K, CHUNK_BUDGET_TOKENS, QUERY_INSTRUCTION, SERVED_K  # noqa: E402
from evaluate import ADITYA, M1, build_index, by_group, fixture, load_questions  # noqa: E402
from prefix_ablation import quoted_labels  # noqa: E402

S2_QUESTIONS = Path(__file__).resolve().parent / "questions_s2.jsonl"

# Fixed in Entry 63 before the run: the right source exists, but what the
# extractor keeps of it cannot answer, or lost its sections.
EXTRACTOR_LIMITED = ("s2-07", "s2-08", "s2-09", "s2-10", "s2-12", "s2-34", "s2-35")

# "served" names what served at Entry 63, when these were measured: the reranker
# has since been turned on (Entry 73), and "reranker on" is now what serves.
CONFIGS = {
    "served": dict(prefix=True, rerank=False, diversity="soft_cap"),
    "prefix off": dict(prefix=False, rerank=False, diversity="soft_cap"),
    "reranker on": dict(prefix=True, rerank=True, diversity="soft_cap"),
    "soft cap off": dict(prefix=True, rerank=False, diversity="none"),
}


def load_s2() -> list[dict]:
    with S2_QUESTIONS.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def rows(original: list[dict], new: list[dict]) -> dict[str, list[dict]]:
    groups = by_group(original)
    answerable_new = [q for q in new if q["kind"] in ("answerable", "injection")]
    return {
        "original: records": [q for q in quoted_labels(groups["records"]) if q["answerable"]],
        "original: documents": [q for q in groups["documents"] if q["answerable"]],
        "new: answerable": [q for q in answerable_new if q["id"] not in EXTRACTOR_LIMITED],
        "new: extractor-limited": [q for q in answerable_new if q["id"] in EXTRACTOR_LIMITED],
        "new: unanswerable": [q for q in new if q["kind"] == "none"],
        "new: cross-tenant": [q for q in new if q["kind"] == "leak"],
    }


def run(chunk_store, questions: list[dict], cfg: dict) -> tuple[dict, list[float]]:
    """Every question once: its hits' titles, top score, and any foreign chunk."""
    store.QUERY_INSTRUCTION = QUERY_INSTRUCTION if cfg["prefix"] else ""
    out, latencies = {}, []
    for q in questions:
        started = time.perf_counter()
        hits = chunk_store.search(M1, ADITYA, q["question"], k=SERVED_K, rerank=cfg["rerank"], diversity=cfg["diversity"])
        latencies.append((time.perf_counter() - started) * 1000)
        out[q["id"]] = {
            "titles": [h["title"] for h in hits],
            "top": hits[0]["score"] if hits else None,
            "foreign": sum(1 for h in hits if h.get("mentorshipId") != M1),
        }
    store.QUERY_INSTRUCTION = QUERY_INSTRUCTION
    return out, latencies


def first_rank(q: dict, result: dict) -> int | None:
    ranks = [i + 1 for i, t in enumerate(result["titles"]) if t in q["expected"]]
    return min(ranks) if ranks else None


def frac(n: int, d: int) -> str:
    return f"{n / d:.2f} ({n}/{d})" if d else "-"


def main() -> None:
    chunk_store, records = fixture()
    chunk_store.ensure_vector_index()
    chunks = build_index(chunk_store, records, CHUNK_BUDGET_TOKENS)
    visible = chunk_store.chunks.count_documents({"mentorshipId": M1, "viewers": ADITYA})

    original, new = load_questions(), load_s2()
    table = rows(original, new)
    everything = original + new

    # Load both models before anything is timed.
    chunk_store.search(M1, ADITYA, "warm up", rerank=True)

    results, latency = {}, {}
    for name, cfg in CONFIGS.items():
        results[name], latency[name] = run(chunk_store, everything, cfg)

    print("S2 step 2b - BUILD_NOTES Entry 63. Labels as pushed in 46c68cc.")
    print(f"index: {chunks} chunks; {visible} visible in M1 to Aditya; candidates {CANDIDATE_K}, k={SERVED_K}")
    print("original records scored on the six clear-cut label changes (Entry 51)\n")

    for name in CONFIGS:
        print(f"== {name}   median {statistics.median(latency[name]):.0f} ms a search, "
              f"p95 {sorted(latency[name])[int(0.95 * len(latency[name])) - 1]:.0f} ms, over {len(latency[name])} searches")
        r = results[name]
        for row, questions in table.items():
            if row in ("new: unanswerable", "new: cross-tenant"):
                continue
            ranks = [first_rank(q, r[q["id"]]) for q in questions]
            n = len(ranks)
            at1 = sum(1 for x in ranks if x == 1)
            at3 = sum(1 for x in ranks if x and x <= 3)
            mrr = sum(1 / x for x in ranks if x) / n
            print(f"  {row:<24} recall@1 {frac(at1, n):<13} recall@3 {frac(at3, n):<13} MRR {mrr:.3f}")
        for label, answerable, unanswerable in (
            ("original", [q for q in original if q["answerable"]], [q for q in original if not q["answerable"]]),
            ("new", table["new: answerable"], table["new: unanswerable"]),
        ):
            sep = min(r[q["id"]]["top"] for q in answerable) - max(r[q["id"]]["top"] or 0 for q in unanswerable)
            print(f"  separation, {label:<9} {sep:+.3f}  (lowest answerable top score minus highest unanswerable)")
        leaks = sum(r[q["id"]]["foreign"] for q in table["new: cross-tenant"])
        everywhere = sum(x["foreign"] for x in r.values())
        print(f"  cross-tenant: {leaks} chunks from another mentorship over {len(table['new: cross-tenant'])} questions "
              f"({everywhere} over all {len(r)})")
        print()

    print("== the decision rule (Entry 63): recall@1 counts, extractor-limited left out")
    decision = {"original": table["original: records"] + table["original: documents"], "new": table["new: answerable"]}
    base = {s: sum(1 for q in qs if first_rank(q, results["served"][q["id"]]) == 1) for s, qs in decision.items()}
    for name in CONFIGS:
        got = {s: sum(1 for q in qs if first_rank(q, results[name][q["id"]]) == 1) for s, qs in decision.items()}
        delta = {s: got[s] - base[s] for s in got}
        total = sum(got.values())
        line = (f"  {name:<13} original {got['original']}/{len(decision['original'])} ({delta['original']:+d})  "
                f"new {got['new']}/{len(decision['new'])} ({delta['new']:+d})  "
                f"combined {total}/{sum(len(v) for v in decision.values())} ({sum(delta.values()):+d})")
        if name != "served":
            meets = sum(delta.values()) >= 3 and min(delta.values()) >= -1
            if name == "reranker on":
                meets = meets and statistics.median(latency[name]) < 1000
            line += "   meets the rule" if meets else "   does not meet the rule"
        print(line)

    print("\n== questions whose recall@1 differs from the served default")
    scored = {q["id"]: q for qs in decision.values() for q in qs}
    scored.update({q["id"]: q for q in table["new: extractor-limited"]})
    for name in CONFIGS:
        if name == "served":
            continue
        won = [i for i, q in scored.items()
               if first_rank(q, results[name][i]) == 1 and first_rank(q, results["served"][i]) != 1]
        lost = [i for i, q in scored.items()
                if first_rank(q, results[name][i]) != 1 and first_rank(q, results["served"][i]) == 1]
        print(f"  {name:<13} right only here: {won or '-'}")
        print(f"  {'':<13} right only served: {lost or '-'}")
        # The cap (3 a record, k=4) can only ever touch the fourth slot, so
        # recall@1 and @3 cannot see it; this can.
        changed = sum(1 for i in results[name] if results[name][i]["titles"] != results["served"][i]["titles"])
        print(f"  {'':<13} results differing from served, in titles or their order: {changed}/{len(results[name])}")


if __name__ == "__main__":
    main()
