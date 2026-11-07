"""Does re-indexing leave every ranking on the 120 questions exactly as it was?

    cd ai
    .venv/Scripts/python.exe eval/rankings_identity.py --capture   # before re-indexing; committed
    .venv/Scripts/python.exe eval/rankings_identity.py             # after it

BUILD_NOTES Entry 100. Entry 96 asked that rankings be identical on all 120
questions after the re-index that stores extraction's unread counts, "checked the
same way as the reranker speed-up" (Entry 73). That check compares against
`s2-reranker-rankings.json`, captured on 2026-11-02, before contextual headers
changed every chunk's text (Entries 88, 90). Against it the current index is 0/120
before anything is re-indexed, so it cannot tell a re-index apart from the
headers. This takes the same measurement, with the same code, against a reference
captured just before the re-index instead.

Through `reranker_speed.py`'s own pieces: the real `ChunkStore.search()` on the
evaluation fixture, reranker on, served k, soft cap, with the reranker wrapped to
record its order over every candidate. Judged on that order and on the final
results, for all 120 questions. No provider is called.

`--capture` refuses to overwrite the reference.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import store  # noqa: E402
from evaluate import ADITYA, M1, fixture, load_questions  # noqa: E402
from reranker_speed import Recording, TorchRuntime, run  # noqa: E402
from retrieval_s2 import load_s2  # noqa: E402

REFERENCE = HERE / "s4-rankings-before-reindex.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture", action="store_true")
    parser.add_argument("--control-truncate", type=int, default=None,
                        help="a control that SHOULD fail: the reranker sees each passage cut to this many characters")
    args = parser.parse_args()
    if args.capture and REFERENCE.exists():
        raise SystemExit(f"{REFERENCE.name} exists and is not rewritten")

    if args.capture and args.control_truncate:
        raise SystemExit("a control is never captured")
    runtime = TorchRuntime(None)  # no batch override: exactly as search() serves it
    if args.control_truncate:
        inner, cut = runtime.predict, args.control_truncate
        runtime.predict = lambda pairs, **kw: inner([(q, d[:cut]) for q, d in pairs], **kw)
    recording = Recording(runtime)
    store._reranker = recording
    chunk_store, _ = fixture()
    questions = load_questions() + load_s2()
    chunk_store.search(M1, ADITYA, "warm up", rerank=True)  # both models loaded first, as reranker_speed.py does
    results, _ = run(chunk_store, recording, questions)

    if args.capture:
        REFERENCE.write_text(json.dumps({
            "about": "BUILD_NOTES Entry 100: the reranker's order over all candidates and the final results, per "
                     "question, on the evaluation index just before the re-index that stores unread counts.",
            "questions": results,
        }, indent=0), encoding="utf-8")
        print(f"captured {len(results)} questions")
        return

    reference = json.loads(REFERENCE.read_text(encoding="utf-8"))["questions"]
    n = len(reference)
    order_diff = [q for q in reference if results.get(q, {}).get("order") != reference[q]["order"]]
    final_diff = [q for q in reference if results.get(q, {}).get("final") != reference[q]["final"]]
    print(f"order over all candidates identical: {n - len(order_diff)}/{n}" + (f"  differs: {order_diff}" if order_diff else ""))
    print(f"final results identical: {n - len(final_diff)}/{n}" + (f"  differs: {final_diff}" if final_diff else ""))
    print("IDENTICAL" if not order_diff and not final_diff and len(results) == n else "NOT IDENTICAL")
    raise SystemExit(0 if not order_diff and not final_diff else 1)


if __name__ == "__main__":
    main()
