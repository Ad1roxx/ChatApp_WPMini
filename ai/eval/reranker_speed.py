"""Can the reranker be faster without changing a single ranking?

    cd ai
    .venv/Scripts/python.exe eval/reranker_speed.py --reference
    .venv/Scripts/python.exe eval/reranker_speed.py --runtime torch --threads 16 --batch 8
    .venv/Scripts/python.exe eval/reranker_speed.py --runtime onnx --threads 8 --batch 8

BUILD_NOTES Entry 73. D7 keeps the reranker off for one reason: about 1.3 s a
search against a 1 s rule. A speed-up that cannot change a ranking needs no new
labels, but it has to prove it did not. Same model, same 30 candidates, same
inputs: only the runtime may change.

`s2-retrieval.txt` records the reranker's counts, not its rankings, and different
orders can give the same counts. So `--reference` first captures what the current
runtime does - every question's order over all its candidates, and the final
results after the soft cap - and checks that it reproduces that file's reranker
rows exactly. The reference is committed before any runtime is tried.

A runtime then runs in its own process through the real `ChunkStore.search()`,
with only the object behind `store.reranker()` replaced, and is judged on:

- the order of ALL candidates, for all 120 questions, identical to the reference;
- the final results after the cap, identical;
- recall and MRR rows identical to `s2-retrieval.txt`;
- median latency per search under 1,000 ms, the rule from Entry 63.

Runs on the evaluation fixture. No provider is called, so this spends no quota.
Each run is appended to `eval/s2-reranker-speed.txt`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402

import store  # noqa: E402
from config import RERANK_BATCH_SIZE, RERANK_MODEL, SERVED_K  # noqa: E402
from evaluate import ADITYA, M1, fixture, load_questions  # noqa: E402
from retrieval_s2 import first_rank, frac, load_s2, rows  # noqa: E402

REFERENCE = HERE / "s2-reranker-rankings.json"
RETRIEVAL = HERE / "s2-retrieval.txt"
LOG = HERE / "s2-reranker-speed.txt"
ROWS = ("original: records", "original: documents", "new: answerable", "new: extractor-limited")


def chunk_key(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


class TorchRuntime:
    """The runtime that serves today: sentence-transformers' CrossEncoder."""

    def __init__(self, batch: int | None):
        from sentence_transformers import CrossEncoder

        self.model = CrossEncoder(RERANK_MODEL)
        self.batch = batch

    def predict(self, pairs, **kwargs):
        # With no --batch, whatever search() itself asks for: the served path.
        if self.batch:
            kwargs["batch_size"] = self.batch
        return self.model.predict(pairs, show_progress_bar=False, **kwargs)


class OnnxRuntime:
    """The same weights exported to ONNX, run by onnxruntime, unquantised.

    Tokenised exactly as CrossEncoder does: the same tokenizer, the same pair
    encoding, the same truncation length. Scores are the raw logit, as the
    model's own configuration gives. Sorted by length so padding is not wasted.
    """

    def __init__(self, threads: int, batch: int):
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from transformers import AutoTokenizer

        self.tokenizer = AutoTokenizer.from_pretrained(RERANK_MODEL)
        path = hf_hub_download(RERANK_MODEL, "onnx/model.onnx")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        self.session = ort.InferenceSession(path, options, providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.session.get_inputs()}
        self.batch = batch
        self.max_length = self.tokenizer.model_max_length

    def predict(self, pairs, **_kwargs):
        order = sorted(range(len(pairs)), key=lambda i: len(pairs[i][1]))
        scores = np.zeros(len(pairs), dtype=np.float32)
        for start in range(0, len(order), self.batch):
            chunk = order[start:start + self.batch]
            enc = self.tokenizer(
                [pairs[i][0] for i in chunk], [pairs[i][1] for i in chunk],
                padding=True, truncation=True, max_length=self.max_length, return_tensors="np",
            )
            feed = {k: v.astype(np.int64) for k, v in enc.items() if k in self.inputs}
            logits = self.session.run(None, feed)[0]
            scores[chunk] = logits[:, 0]
        return scores


class Recording:
    """Wraps a runtime; keeps each search's candidates in scored order."""

    def __init__(self, runtime):
        self.runtime, self.last = runtime, []

    def predict(self, pairs, **kwargs):
        scores = self.runtime.predict(pairs, **kwargs)
        # The same stable descending sort search() itself applies.
        order = sorted(range(len(pairs)), key=lambda i: float(scores[i]), reverse=True)
        self.last = [(chunk_key(pairs[i][1]), float(scores[i])) for i in order]
        return scores


def run(chunk_store, recording, questions) -> tuple[dict, list[float]]:
    out, latencies = {}, []
    for q in questions:
        started = time.perf_counter()
        hits = chunk_store.search(M1, ADITYA, q["question"], k=SERVED_K, rerank=True, diversity="soft_cap")
        latencies.append((time.perf_counter() - started) * 1000)
        out[q["id"]] = {
            "order": [k for k, _ in recording.last],
            "scores": [s for _, s in recording.last],
            "final": [[h["sourceType"], h["sourceId"], h["chunkIndex"]] for h in hits],
            "titles": [h["title"] for h in hits],
        }
    return out, latencies


def row_lines(results: dict, table: dict) -> list[str]:
    """The recall rows, in exactly the format retrieval_s2.py prints them."""
    lines = []
    for row in ROWS:
        ranks = [first_rank(q, results[q["id"]]) for q in table[row]]
        n = len(ranks)
        at1 = sum(1 for x in ranks if x == 1)
        at3 = sum(1 for x in ranks if x and x <= 3)
        mrr = sum(1 / x for x in ranks if x) / n
        lines.append(f"  {row:<24} recall@1 {frac(at1, n):<13} recall@3 {frac(at3, n):<13} MRR {mrr:.3f}")
    return lines


def recorded_rows() -> list[str]:
    """s2-retrieval.txt's reranker rows, read from the file."""
    text = RETRIEVAL.read_text(encoding="utf-8")
    block = text.split("== reranker on")[1].split("\n== ")[0]
    return [line.rstrip() for line in block.splitlines() if re.match(r"  (original|new): ", line)]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", action="store_true", help="capture the current runtime's rankings")
    parser.add_argument("--runtime", choices=("torch", "onnx"), default="torch")
    parser.add_argument("--threads", type=int, default=None, help="default: torch's own default")
    parser.add_argument("--batch", type=int, default=None, help="default: CrossEncoder's own default (32)")
    parser.add_argument("--control-truncate", type=int, default=None,
                        help="a control that SHOULD fail: cut each passage to this many characters")
    args = parser.parse_args()

    import torch

    if args.threads and args.runtime == "torch":
        torch.set_num_threads(args.threads)
    label = (f"{args.runtime} threads={args.threads or torch.get_num_threads()} "
             f"batch={args.batch or RERANK_BATCH_SIZE}"
             + (" (exactly as search() serves it)" if not (args.threads or args.batch) else ""))
    if args.reference and REFERENCE.exists():
        raise SystemExit(f"{REFERENCE.name} exists: it was captured at batch 32, before any speed-up, and is not rewritten")

    if args.runtime == "onnx":
        runtime = OnnxRuntime(args.threads or torch.get_num_threads(), args.batch or 32)
    else:
        runtime = TorchRuntime(args.batch)
    if args.control_truncate:
        label += f" CONTROL: passages cut to {args.control_truncate} characters"
        inner, cut = runtime.predict, args.control_truncate
        runtime.predict = lambda pairs, **kw: inner([(q, d[:cut]) for q, d in pairs], **kw)
    recording = Recording(runtime)
    store._reranker = recording  # search() calls store.reranker().predict(...)

    chunk_store, _ = fixture()
    original, new = load_questions(), load_s2()
    table = rows(original, new)
    everything = original + new

    # Warm: both models loaded, and caches filled, before anything is timed.
    chunk_store.search(M1, ADITYA, "warm up", rerank=True)
    results, latencies = run(chunk_store, recording, everything)
    median, p95 = statistics.median(latencies), sorted(latencies)[int(0.95 * len(latencies)) - 1]

    lines = row_lines(results, table)
    same_rows = lines == recorded_rows()

    if args.reference:
        if not same_rows:
            print("\n".join(["computed:", *lines, "recorded:", *recorded_rows()]))
            raise SystemExit("the current runtime does not reproduce s2-retrieval.txt's reranker rows")
        REFERENCE.write_text(json.dumps({
            "about": "BUILD_NOTES Entry 73: the PyTorch reranker's order over all candidates and final results, "
                     "per question. Captured before any faster runtime was tried. Chunk keys are hashes of the text scored.",
            "rows": lines,
            "questions": results,
        }, indent=0), encoding="utf-8")
        verdict = [f"reference captured: {len(results)} questions; reranker rows identical to s2-retrieval.txt"]
    else:
        reference = json.loads(REFERENCE.read_text(encoding="utf-8"))["questions"]
        order_diff = [i for i in reference if results[i]["order"] != reference[i]["order"]]
        final_diff = [i for i in reference if results[i]["final"] != reference[i]["final"]]
        worst = max(
            (abs(a - b) for i in reference if results[i]["order"] == reference[i]["order"]
             for a, b in zip(results[i]["scores"], reference[i]["scores"])),
            default=0.0,
        )
        n = len(reference)
        verdict = [
            f"order over all candidates identical: {n - len(order_diff)}/{n}" + (f"  differs: {order_diff}" if order_diff else ""),
            f"final results identical: {n - len(final_diff)}/{n}" + (f"  differs: {final_diff}" if final_diff else ""),
            f"recall rows identical to s2-retrieval.txt: {same_rows}",
            f"largest score difference where the order matches: {worst:.6f}",
            "PASSES" if not order_diff and not final_diff and same_rows and median < 1000 else "does not pass",
        ]

    report = [f"== {label}", f"  median {median:.0f} ms a search, p95 {p95:.0f} ms, over {len(latencies)} searches",
              *("  " + v for v in verdict), ""]
    with LOG.open("a", encoding="utf-8") as f:
        f.write("\n".join(report) + "\n")
    print("\n".join(report))


if __name__ == "__main__":
    main()
