"""A section's heading read with its chunk, on and off, by the rule committed first.

    cd ai && .venv/Scripts/python.exe eval/heading_embed.py

BUILD_NOTES Entry 81. Needs the demo seeded (`npm run demo`, once): its records are read,
never written, and its own index stays as it is, because this builds one of its own in
`chatapp_demo_eval`. The original and S2 questions use the evaluation fixture, as always.
Both indexes are rebuilt for each setting, because what changes is the vectors. Search is
the served one: reranker on, soft cap, k=4. No provider is called.

Writes `eval/heading-embed-decision.txt`.
"""

from __future__ import annotations

import json
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import appdb  # noqa: E402
import chunking  # noqa: E402
from config import APP_MONGODB_URI, CHUNK_BUDGET_TOKENS, MONGODB_URI, SERVED_K  # noqa: E402
from evaluate import ADITYA, M1, build_index, fixture, load_questions  # noqa: E402
from retrieval_s2 import load_s2, rows  # noqa: E402
from store import ChunkStore  # noqa: E402

QUESTIONS = HERE / "questions_demo.jsonl"
OUT = HERE / "heading-embed-decision.txt"
DEMO_DB = "chatapp_demo"
MEASURE_DB = "chatapp_demo_eval"
ASKERS = {"meera": "00000000000000000000d001", "rohan": "00000000000000000000d002", "ananya": "00000000000000000000d003"}
TOPICS = {"backend": "Backend engineering for placement interviews", "data": "Data engineering fundamentals"}
SETTINGS = (("off", False), ("on", True))


def load_demo() -> list[dict]:
    return [json.loads(line) for line in QUESTIONS.read_text(encoding="utf-8").splitlines() if line.strip()]


def is_hit(hit: dict, label: dict) -> bool:
    return hit["title"] == label["title"] and (label["heading"] is None or hit.get("heading") == label["heading"])


def rank_of(hits: list[dict], labels: list[dict]) -> int | None:
    ranks = [i + 1 for i, hit in enumerate(hits) if any(is_hit(hit, label) for label in labels)]
    return ranks[0] if ranks else None


def file_rank(hits: list[dict], labels: list[dict]) -> int | None:
    return rank_of(hits, [{"title": label["title"], "heading": None} for label in labels])


def search(chunk_store, mentorship: str, viewer: str, question: str) -> list[dict]:
    return chunk_store.search(mentorship, viewer, question, k=SERVED_K, rerank=True, diversity="soft_cap")


def measure_existing(chunk_store, table: dict) -> dict:
    out = {}
    for name, questions in table.items():
        out[name] = {}
        for q in questions:
            hits = search(chunk_store, M1, ADITYA, q["question"])
            ranks = [i + 1 for i, hit in enumerate(hits) if hit["title"] in q["expected"]]
            out[name][q["id"]] = ranks[0] if ranks else None
    return out


def measure_demo(chunk_store, questions: list[dict], mentorships: dict) -> tuple[dict, list[float]]:
    out, latencies = {}, []
    for q in questions:
        started = time.perf_counter()
        hits = search(chunk_store, mentorships[q["mentorship"]], ASKERS[q["asker"]], q["question"])
        latencies.append((time.perf_counter() - started) * 1000)
        out[q["id"]] = {
            "rank": rank_of(hits, q["expected"]),
            "file": file_rank(hits, q["expected"]),
            "top": (hits[0]["title"], hits[0].get("heading")) if hits else None,
            "score": hits[0]["score"] if hits else None,
            "foreign": sum(1 for hit in hits if hit.get("mentorshipId") != mentorships[q["mentorship"]]),
        }
    return out, latencies


def at1(ranks) -> int:
    return sum(1 for rank in ranks if rank == 1)


def at3(ranks) -> int:
    return sum(1 for rank in ranks if rank and rank <= 3)


def mrr(ranks) -> float:
    ranks = list(ranks)
    return sum(1 / rank for rank in ranks if rank) / len(ranks) if ranks else 0.0


def main() -> None:
    records = appdb.connect(APP_MONGODB_URI, DEMO_DB)
    mentorships = {
        key: str(records.mentorships.find_one({"topic": topic, "status": "active"})["_id"])
        for key, topic in TOPICS.items()
    }
    demo_store = ChunkStore(MONGODB_URI, MEASURE_DB, records=records)
    demo_store.ensure_vector_index()
    fixture_store, fixture_records = fixture()
    fixture_store.ensure_vector_index()

    table = rows(load_questions(), load_s2())
    existing_sets = {
        "original": table["original: records"] + table["original: documents"],
        "s2": table["new: answerable"],
    }
    demo = load_demo()
    answerable = [q for q in demo if q["answerable"]]
    configured = chunking.EMBED_HEADINGS

    demo_results, existing, chunk_counts, latency = {}, {}, {}, {}
    try:
        for name, flag in SETTINGS:
            chunking.EMBED_HEADINGS = flag
            count = build_index(demo_store, records, CHUNK_BUDGET_TOKENS)
            fixture_count = build_index(fixture_store, fixture_records, CHUNK_BUDGET_TOKENS)
            chunk_counts[name] = (count, fixture_count)
            search(demo_store, mentorships["backend"], ASKERS["rohan"], "warm up")
            demo_results[name], latency[name] = measure_demo(demo_store, demo, mentorships)
            existing[name] = measure_existing(fixture_store, existing_sets)
    finally:
        # The fixture left as serving has it, whatever happened.
        chunking.EMBED_HEADINGS = configured
        build_index(fixture_store, fixture_records, CHUNK_BUDGET_TOKENS)

    out = ["A section's heading read with its chunk - BUILD_NOTES Entry 81. Rule and labels committed in a6a2638, before this ran.", ""]
    out.append(f"  chunks, demo and fixture: off {chunk_counts['off']}, on {chunk_counts['on']}")
    out += ["", f"  {'set':<30} {'setting':<8} {'recall@1':>10} {'recall@3':>10} {'MRR':>7}"]
    groups = {"new (right file and section)": answerable, "  demo": [q for q in answerable if q["group"] == "demo"],
              "  more": [q for q in answerable if q["group"] == "more"]}
    for label, questions in groups.items():
        for name, _ in SETTINGS:
            ranks = [demo_results[name][q["id"]]["rank"] for q in questions]
            out.append(f"  {label:<30} {name:<8} {at1(ranks):>7}/{len(ranks)} {at3(ranks):>7}/{len(ranks)} {mrr(ranks):>7.3f}")
    for name, _ in SETTINGS:
        ranks = [demo_results[name][q["id"]]["file"] for q in answerable]
        out.append(f"  {'new (right file only)':<30} {name:<8} {at1(ranks):>7}/{len(ranks)} {at3(ranks):>7}/{len(ranks)} {mrr(ranks):>7.3f}")
    for label, questions in existing_sets.items():
        for name, _ in SETTINGS:
            ranks = [existing[name][label][q["id"]] for q in questions]
            out.append(f"  {label:<30} {name:<8} {at1(ranks):>7}/{len(ranks)} {at3(ranks):>7}/{len(ranks)} {mrr(ranks):>7.3f}")

    unanswerable = [q for q in demo if q["kind"] == "none"]
    leaks = {name: sum(r["foreign"] for r in demo_results[name].values()) for name, _ in SETTINGS}
    out += ["", "  not in the rule:"]
    for name, _ in SETTINGS:
        highest = max(demo_results[name][q["id"]]["score"] or 0 for q in unanswerable)
        lowest = min(demo_results[name][q["id"]]["score"] or 0 for q in answerable)
        out.append(f"    {name:<4} reranker's top score: highest unanswerable {highest:+.2f}, lowest answerable {lowest:+.2f}; "
                   f"search median {statistics.median(latency[name]):.0f} ms")
    out.append(f"    chunks from another mentorship, any question: off {leaks['off']}, on {leaks['on']}")

    out += ["", "== questions whose recall@1 changed, new set"]
    for q in answerable:
        off, on = demo_results["off"][q["id"]], demo_results["on"][q["id"]]
        if (off["rank"] == 1) != (on["rank"] == 1):
            out.append(f"  {'gained' if on['rank'] == 1 else 'LOST  '} {q['id']}  {q['question']}")
            out.append(f"         off: {off['top']}")
            out.append(f"         on:  {on['top']}")
    out += ["", "== still wrong with it on, new set"]
    for q in answerable:
        on = demo_results["on"][q["id"]]
        if on["rank"] != 1:
            out.append(f"  {q['id']}  {q['question']}  rank {on['rank']}; top {on['top']}")
    out += ["", "== questions whose recall@1 changed, existing sets"]
    for label, questions in existing_sets.items():
        for q in questions:
            off, on = existing["off"][label][q["id"]], existing["on"][label][q["id"]]
            if (off == 1) != (on == 1):
                out.append(f"  {'gained' if on == 1 else 'LOST  '} {label} {q['id']}  {q['question']}")

    gained = at1(demo_results["on"][q["id"]]["rank"] for q in answerable) - at1(demo_results["off"][q["id"]]["rank"] for q in answerable)
    deltas = {label: at1(existing["on"][label].values()) - at1(existing["off"][label].values()) for label in existing_sets}
    checks = {
        f"recall@1 on the new questions improves by at least 3 ({gained:+d})": gained >= 3,
        f"original loses no more than 1 ({deltas['original']:+d})": deltas["original"] >= -1,
        f"s2 loses no more than 1 ({deltas['s2']:+d})": deltas["s2"] >= -1,
    }
    out += ["", "== the rule"] + [f"  {'met' if ok else 'NOT met':<8} {name}" for name, ok in checks.items()]
    if any(leaks.values()):
        out.append("  STOP: a chunk from another mentorship appeared in the results.")
    adopted = all(checks.values()) and not any(leaks.values())
    out += ["", f"  DECISION: {'adopt it' if adopted else 'do not adopt it'}"]

    OUT.write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    main()
