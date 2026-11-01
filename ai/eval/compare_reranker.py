"""s2-v3 with the reranker off against s2-v3 with it on: one variable.

    cd ai && .venv/Scripts/python.exe eval/compare_reranker.py

BUILD_NOTES Entry 74. The prompt is unchanged, so the only difference between
these four runs is what search hands to the model. The same counts as the s2-v2
against s2-v3 comparison (`compare_prompts.py`, whose definitions these reuse),
then the same rows. This reports; no rule decides anything here.

The injection probes bypass search and use the prompt alone, so the reranker
cannot change them and they are not re-run. The four injection questions do go
through search, so what they were shown is listed.

Writes `eval/s2-reranker-comparison.txt`.
"""

from __future__ import annotations

import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import evaluate_answers as ea  # noqa: E402
from answer import uncited_sentences  # noqa: E402
from compare_prompts import ANSWERABLE_ROWS, Named, injection, measure  # noqa: E402

RUNS = {"off run 1": (False, 1), "off run 2": (False, 2), "on run 1": (True, 1), "on run 2": (True, 2)}
# Where each injection question's plant lives (questions_s2.jsonl).
PLANT_SOURCE = {
    "s2-inj-01": ("queue-retries.pdf", "Appendix"),
    "s2-inj-02": ("learning-log.pdf", None),
    "s2-inj-03": ("Interview question bank", None),
    "s2-inj-04": ("Hand-in: Design cursor pagination for the bookings list", None),
}


def load(rerank: bool, run: int, provider) -> dict:
    ea.VERSION, ea.RUN, ea.RERANK_ON = "s2-v3", run, rerank
    return ea.load_cache(ea.cache_path(provider))


def row_counts(cache: dict, table: dict) -> dict[str, str]:
    out = {}
    for name, questions in table.items():
        statuses = [cache[q["id"]]["result"]["status"] for q in questions if q["id"] in cache]
        wanted = "abstained" if name in ("original: unanswerable", "new: unanswerable", "new: cross-tenant") else "answered"
        out[name] = f"{wanted} {statuses.count(wanted)}/{len(questions)}"
    return out


def labelled_in_sources(cache: dict, table: dict) -> tuple[int, int]:
    """Answerable questions whose four sources include a labelled one."""
    questions = [q for row in ANSWERABLE_ROWS for q in table[row]]
    found = sum(
        1 for q in questions
        if q["id"] in cache and any(s["title"] in q["expected"] for s in cache[q["id"]]["sources"])
    )
    return found, len(questions)


def main() -> None:
    table = ea.rows()
    provider = Named("gemini", ea.providers.GEMINI_MODEL)
    caches = {name: load(*key, provider) for name, key in RUNS.items()}
    measured = {name: measure(cache, table) for name, cache in caches.items()}

    out = ["s2-v3, reranker off against on - BUILD_NOTES Entry 74. Only search changed; the prompt did not.", ""]
    head = f"  {'':<34}" + "".join(f"{name:>13}" for name in RUNS)
    out.append(head)

    def line(label, values):
        out.append(f"  {label:<34}" + "".join(f"{v:>13}" for v in values))

    line("asked", [m["asked"] for m in measured.values()])
    line("uncited denial sentences", [m["denials"] for m in measured.values()])
    line("misattributions", [len(m["misattributed"]) for m in measured.values()])
    line("answerable abstentions, of 86", [len(m["abstained"]) for m in measured.values()])
    line("labelled source among the four", [f"{a}/{b}" for a, b in (labelled_in_sources(c, table) for c in caches.values())])
    out.append("")
    for row in table:
        counts = [row_counts(c, table)[row].split(" ", 1)[1] for c in caches.values()]
        verb = row_counts(next(iter(caches.values())), table)[row].split(" ", 1)[0]
        line(f"{row}, {verb}", counts)
    out.append("")

    def across(fn):
        return [fn(c) for c in caches.values()]

    def answered(c):
        return [e for e in c.values() if e["result"]["status"] == "answered"]

    line("citation handles kept", across(lambda c: sum(ea.handles_in(e["result"]["answer"]) for e in c.values())))
    line("handles stripped", across(lambda c: sum(e["result"]["stripped"] for e in c.values())))
    line("answers with an uncited sentence",
         [f"{sum(1 for e in answered(c) if uncited_sentences(e['result']['answer']))}/{len(answered(c))}" for c in caches.values()])
    line("cut off at the cap", across(lambda c: sum(1 for e in c.values() if e["result"]["outcome"] == "truncated")))
    line("provider errors", across(lambda c: sum(1 for e in c.values() if e["result"]["status"] == "error")))
    line("median turn, ms", [f"{statistics.median(e['turn_ms'] for e in c.values()):.0f}" if c else "-" for c in caches.values()])
    line("slowest turn, ms", [max((e["turn_ms"] for e in c.values()), default="-") for c in caches.values()])

    out += ["", "  injection probes (prompt only, not re-run): s2-v3 " + str(injection("s2-v3")), ""]
    for name, m in measured.items():
        out.append(f"  {name}: abstained {m['abstained'] or '-'}; misattributed {m['misattributed'] or '-'}")

    out += ["", "  was the injection question shown its planted source through search?"]
    for qid, (title, heading) in PLANT_SOURCE.items():
        shown = [
            any(s["title"] == title and (heading is None or s["heading"] == heading) for s in c[qid]["sources"]) if qid in c else None
            for c in caches.values()
        ]
        out.append(f"    {qid}: " + ", ".join(f"{n} {'yes' if s else 'no'}" for n, s in zip(RUNS, shown)))

    def status(c, i):
        return c[i]["result"]["status"] if i in c else None

    off, on = caches["off run 1"], caches["on run 1"]
    stable = [i for i in off if status(off, i) == status(caches["off run 2"], i) and status(on, i) == status(caches["on run 2"], i)]
    gained = [i for i in stable if status(off, i) != "answered" and status(on, i) == "answered"]
    lost = [i for i in stable if status(off, i) == "answered" and status(on, i) != "answered"]
    out += ["", "  stable within both settings, and changed by the reranker:",
            f"    abstained off, answered on: {gained or '-'}", f"    answered off, abstained on: {lost or '-'}"]
    out.append(f"    status flips between the two runs: off {sum(1 for i in off if status(off, i) != status(caches['off run 2'], i))}, "
               f"on {sum(1 for i in on if status(on, i) != status(caches['on run 2'], i))}")

    (HERE / "s2-reranker-comparison.txt").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    main()
