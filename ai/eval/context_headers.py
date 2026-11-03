"""Contextual headers, names as roles and the folded opening fragment, by the rule committed first.

    cd ai && .venv/Scripts/python.exe eval/context_headers.py

BUILD_NOTES Entries 85 and 87: this now applies Entry 87's rule, on `questions_mechanism.jsonl`.
Entry 85's run is recorded in `context-headers-decision.txt` and git. No provider is called. Needs the demo seeded. Records are read, never
written, and both indexes it builds are its own: `chatapp_demo_eval` and `chatapp_eval_ctx`.
Never `chatapp_eval`'s index, which the names re-test may be searching. Search is the served
one: reranker on, soft cap, k=4.

Writes `eval/context-headers-mechanism-decision.txt`.
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
from answer import search_query  # noqa: E402
from chunking import MIN_CHUNK_TOKENS, token_count  # noqa: E402
from config import APP_MONGODB_URI, CHUNK_BUDGET_TOKENS, EVAL_DB_NAME, MONGODB_URI, SERVED_K  # noqa: E402
from evaluate import ADITYA, M1, build_index, load_questions  # noqa: E402
from evaluate_answers import fixture_parties  # noqa: E402
from retrieval_s2 import load_s2, rows  # noqa: E402
from store import ChunkStore  # noqa: E402

HEADER_DB = {"demo": "chatapp_demo_eval", "fixture": "chatapp_eval_ctx"}
OUT = HERE / "context-headers-mechanism-decision.txt"
DEMO_DB = "chatapp_demo"
ASKERS = {"meera": "00000000000000000000d001", "rohan": "00000000000000000000d002", "ananya": "00000000000000000000d003"}
TOPICS = {"backend": "Backend engineering for placement interviews", "data": "Data engineering fundamentals"}
# (name, headers and folding, names as roles in the query)
SETTINGS = (("off", False, False), ("headers only", True, False), ("on", True, True))
FILE_SETS = ("fresh", "demo")


def load(name: str) -> list[dict]:
    return [json.loads(line) for line in (HERE / name).read_text(encoding="utf-8").splitlines() if line.strip()]


def is_label(hit: dict, q: dict) -> bool:
    expected = q["expected"]
    if expected and isinstance(expected[0], dict):
        return any(hit["title"] == e["title"] and (e["heading"] is None or hit.get("heading") == e["heading"]) for e in expected)
    return hit["title"] in expected


def right_file(hit: dict, q: dict) -> bool:
    return any(hit["title"] == e["title"] for e in q["expected"])


def measure(store, q, mentorship, viewer, parties, substitute):
    chunking_on = chunking.CONTEXT_HEADERS
    # search_query reads the setting, which stays as the index was built; "headers only" asks the question as written.
    query = search_query(q["question"], parties) if (chunking_on and substitute) else q["question"]
    started = time.perf_counter()
    hits = store.search(mentorship, viewer, query, k=SERVED_K, rerank=True, diversity="soft_cap")
    took = (time.perf_counter() - started) * 1000
    ranks = [i + 1 for i, hit in enumerate(hits) if is_label(hit, q)]
    top = hits[0] if hits else None
    return {
        "rank": ranks[0] if ranks else None,
        "ms": took,
        "top": (top["title"], top.get("heading")) if top else None,
        "file_at_1": bool(top) and bool(q["expected"]) and isinstance(q["expected"][0], dict) and right_file(top, q),
        "brief": bool(top) and top["sourceType"] == "assignment" and not (ranks and ranks[0] == 1),
        "fragment": bool(top) and top["sourceType"] == "attachment" and token_count(top["content"]) < MIN_CHUNK_TOKENS and not (ranks and ranks[0] == 1),
        "foreign": sum(1 for hit in hits if hit.get("mentorshipId") != mentorship),
    }


def at1(values) -> int:
    return sum(1 for v in values if v["rank"] == 1)


def at3(values) -> int:
    return sum(1 for v in values if v["rank"] and v["rank"] <= 3)


def mrr(values) -> float:
    values = list(values)
    return sum(1 / v["rank"] for v in values if v["rank"]) / len(values) if values else 0.0


def sizes(store) -> str:
    counts = sorted(token_count(c["content"]) for c in store.chunks.find({"sourceType": "attachment"}, {"content": 1}))
    under = sum(1 for n in counts if n < MIN_CHUNK_TOKENS)
    return f"file chunks {len(counts)}, under {MIN_CHUNK_TOKENS} tokens {under}, smallest {counts[0] if counts else '-'}, median {statistics.median(counts) if counts else '-'}"


def main() -> None:
    demo_records = appdb.connect(APP_MONGODB_URI, DEMO_DB)
    fixture_records = appdb.connect(MONGODB_URI, EVAL_DB_NAME)
    mentorships = {key: str(demo_records.mentorships.find_one({"topic": t, "status": "active"})["_id"]) for key, t in TOPICS.items()}

    def names(mid_key: str) -> dict:
        from bson import ObjectId

        m = demo_records.mentorships.find_one({"_id": ObjectId(mentorships[mid_key])}, {"mentor": 1, "student": 1})
        return {who: demo_records.users.find_one({"_id": m[who]}, {"displayName": 1})["displayName"] for who in ("mentor", "student")}

    demo_parties = {key: names(key) for key in TOPICS}
    fixture_names = fixture_parties(fixture_records)

    demo_store = ChunkStore(MONGODB_URI, HEADER_DB["demo"], records=demo_records)
    fixture_store = ChunkStore(MONGODB_URI, HEADER_DB["fixture"], records=fixture_records)
    demo_store.ensure_vector_index()
    fixture_store.ensure_vector_index()

    table = rows(load_questions(), load_s2())
    sets = {
        "mechanism": load("questions_mechanism.jsonl"),
        "fresh": [q for q in load("questions_demo_fresh.jsonl") if q["answerable"]],
        "demo": [q for q in load("questions_demo.jsonl") if q["answerable"]],
        "original": table["original: records"] + table["original: documents"],
        "s2": table["new: answerable"],
    }
    unscored = [q for q in load("questions_demo.jsonl") if not q["answerable"]]
    configured = chunking.CONTEXT_HEADERS

    results, stats = {}, {}
    try:
        built = {}
        for name, headers, substitute in SETTINGS:
            chunking.CONTEXT_HEADERS = headers
            if headers not in built:
                built[headers] = (
                    build_index(demo_store, demo_records, CHUNK_BUDGET_TOKENS),
                    build_index(fixture_store, fixture_records, CHUNK_BUDGET_TOKENS),
                    sizes(demo_store),
                    sizes(fixture_store),
                )
            demo_store.search(mentorships["backend"], ASKERS["rohan"], "warm up", rerank=True)
            results[name] = {}
            for label, questions in sets.items():
                results[name][label] = {}
                for q in questions:
                    if label in FILE_SETS:
                        results[name][label][q["id"]] = measure(demo_store, q, mentorships[q["mentorship"]], ASKERS[q["asker"]], demo_parties[q["mentorship"]], substitute)
                    else:
                        results[name][label][q["id"]] = measure(fixture_store, q, M1, ADITYA, fixture_names, substitute)
            results[name]["unscored"] = {
                q["id"]: measure(demo_store, q, mentorships[q["mentorship"]], ASKERS[q["asker"]], demo_parties[q["mentorship"]], substitute) for q in unscored
            }
            stats[name] = built[headers]
    finally:
        chunking.CONTEXT_HEADERS = configured

    out = ["Contextual headers, names as roles, opening fragment folded - BUILD_NOTES Entry 87. Labels and rule committed before this ran.", ""]
    for name, _, _ in SETTINGS:
        s = stats[name]
        out.append(f"  {name:<13} chunks: demo {s[0]}, fixture {s[1]}; demo {s[2]}; fixture {s[3]}")
    out += ["", f"  {'set':<10} {'setting':<14} {'recall@1':>9} {'recall@3':>9} {'MRR':>7} {'wrong: brief top':>17} {'wrong: fragment top':>20}"]
    for label, questions in sets.items():
        for name, _, _ in SETTINGS:
            values = list(results[name][label].values())
            n = len(values)
            out.append(f"  {label:<10} {name:<14} {at1(values):>6}/{n} {at3(values):>6}/{n} {mrr(values):>7.3f} {sum(v['brief'] for v in values):>17} {sum(v['fragment'] for v in values):>20}")
    for label in ("mechanism", *FILE_SETS):
        for name, _, _ in SETTINGS:
            values = list(results[name][label].values())
            out.append(f"  {label + ', right file at 1':<26} {name:<14} {sum(v['file_at_1'] for v in values)}/{len(values)}")

    leaks = {name: sum(v["foreign"] for group in results[name].values() for v in group.values()) for name, _, _ in SETTINGS}
    out += ["", "  chunks from another mentorship, every question: " + ", ".join(f"{k} {v}" for k, v in leaks.items())]
    out.append("  search median ms: " + ", ".join(f"{name} {statistics.median(v['ms'] for g in results[name].values() for v in g.values()):.0f}" for name, _, _ in SETTINGS))

    for label, questions in sets.items():
        out += ["", f"== {label}: recall@1 changed, off -> on"]
        for q in questions:
            off, on = results["off"][label][q["id"]], results["on"][label][q["id"]]
            if (off["rank"] == 1) != (on["rank"] == 1):
                out.append(f"  {'gained' if on['rank'] == 1 else 'LOST  '} {q['id']}  {q['question']}")
                if label in ("mechanism", *FILE_SETS):
                    out.append(f"         off: {off['top']}")
                    out.append(f"         on:  {on['top']}")
    for label in ("mechanism", *FILE_SETS):
        out += ["", f"== {label}: still wrong with it on"]
        for q in sets[label]:
            on = results["on"][label][q["id"]]
            if on["rank"] != 1:
                out.append(f"  {q['id']}  {q['question']}  rank {on['rank']}; top {on['top']}")

    deltas = {label: at1(results["on"][label].values()) - at1(results["off"][label].values()) for label in sets}
    checks = {f"recall@1 on the new questions improves by at least 3 ({deltas['mechanism']:+d})": deltas["mechanism"] >= 3}
    checks.update({f"{label} loses no more than 1 ({deltas[label]:+d})": deltas[label] >= -1 for label in ("fresh", "demo", "original", "s2")})
    out += ["", "== the rule"] + [f"  {'met' if ok else 'NOT met':<8} {name}" for name, ok in checks.items()]
    if any(leaks.values()):
        out.append("  STOP: a chunk from another mentorship appeared in the results.")
    adopted = all(checks.values()) and not any(leaks.values())
    out += ["", f"  DECISION: {'adopt it' if adopted else 'do not adopt it'}"]

    OUT.write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    main()
