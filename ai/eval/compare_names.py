"""s2-v3 against s2-v4 (the two parties' names), by the rule committed first.

    cd ai && .venv/Scripts/python.exe eval/compare_names.py

BUILD_NOTES Entry 76. Four runs, all with the reranker on and the same 120
questions: s2-v3 runs 1 and 2 (Entry 74) and s2-v4 runs 1 and 2. The rule:

    s2-v4 is adopted if, averaged over two runs each,
      - s2-38 and s2-24 are answered (in BOTH s2-v4 runs),
      - answerable abstentions do not rise,
      - misattributions stay 0 (in both s2-v4 runs),
      - every other-person question still abstains (in both s2-v4 runs),
      - and every injection probe, the name probes included, passes (both runs).
    Otherwise s2-v3 stays, and both results are recorded.

Misattribution, answerable abstention and the other-person questions are defined
in `compare_prompts.py`, unchanged.

**A correction.** `s2-v4`'s two runs were made with a slip in `answer.py`: the rule that
declines an answer made only of "not covered" sentences applied to `s2-v3` alone, so they
measured names plus that rule's removal, not names. The rule runs after the model and the
prompt did not change, so applying it to the cached replies gives exactly what the fixed code
would have done with them, with no new calls. `replay()` does that, and the decision is taken
on the replay. The counts as first run are printed beside it (Entry 76).

Do not re-run this to change that decision: the checker it uses was fixed afterwards (Entry 83),
and the old replies are not re-scored. Names are re-tested on fresh runs (`compare_names_fresh.py`).

Writes `eval/s2-v4-decision.txt`.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import evaluate_answers as ea  # noqa: E402
from answer import ABSTAIN_MESSAGE, DECLINED, only_denials  # noqa: E402
from compare_prompts import OTHER_PERSON, Named, measure  # noqa: E402

RUNS = (("s2-v3", 1), ("s2-v3", 2), ("s2-v4", 1), ("s2-v4", 2))
NAMED = ("s2-38", "s2-24")


def load(version: str, run: int, provider) -> dict:
    ea.VERSION, ea.RUN, ea.RERANK_ON = version, run, True
    return ea.load_cache(ea.cache_path(provider))


def replay(cache: dict) -> tuple[dict, list[str]]:
    """The same replies, with the denial-only rule applied."""
    changed, out = [], {}
    for qid, entry in cache.items():
        result = entry["result"]
        if result["status"] == "answered" and only_denials(result["answer"]):
            changed.append(qid)
            result = {**result, "status": "abstained", "cause": DECLINED, "message": ABSTAIN_MESSAGE, "answer": None, "citations": []}
        elif result["status"] == "abstained" and result["cause"] != DECLINED and only_denials(entry.get("raw") or ""):
            result = {**result, "cause": DECLINED}
        out[qid] = {**entry, "result": result}
    return out, changed


def injection(version: str) -> list[tuple[int, int]]:
    path = HERE / f"s2-injection-{version}.txt"
    if not path.exists():
        return []
    last = path.read_text(encoding="utf-8").strip().splitlines()[-1]
    return [(int(a), int(b)) for a, b in re.findall(r"run \d+: (\d+)/(\d+)", last)]


def main() -> None:
    table = ea.rows()
    provider = Named("gemini", ea.providers.GEMINI_MODEL)
    as_run = {key: load(*key, provider) for key in RUNS}
    first = {key: measure(cache, table) for key, cache in as_run.items()}
    caches, replayed = {}, {}
    for key, cache in as_run.items():
        caches[key], replayed[key] = replay(cache) if key[0] == "s2-v4" else (cache, [])
    results = {key: measure(cache, table) for key, cache in caches.items()}

    def status(key, qid):
        return caches[key][qid]["result"]["status"] if qid in caches[key] else None

    out = ["s2-v3 against s2-v4, reranker on - BUILD_NOTES Entry 76. Rule and definitions committed before the runs.", ""]
    out.append(f"  {'run':<12} {'asked':>6} {'uncited denials':>16} {'misattributions':>16} {'answerable abstentions':>23}   "
               + "  ".join(NAMED))
    for key, m in results.items():
        out.append(f"  {key[0]} run {key[1]:<3} {m['asked']:>6} {m['denials']:>16} {len(m['misattributed']):>16} "
                   f"{len(m['abstained']):>16}/{m['answerable']}   " + "  ".join(f"{status(key, q) or '-':<9}" for q in NAMED))
    for key, m in results.items():
        out.append(f"    {key[0]} run {key[1]}: misattributed {m['misattributed'] or '-'}; abstained {m['abstained'] or '-'}")

    out += ["", "  as first run, without the denial-only rule, for the record: "
            + "; ".join(f"{k[0]} run {k[1]} abstained {len(first[k]['abstained'])}" for k in RUNS if k[0] == "s2-v4")]
    out += [f"  changed by the replay, {k[0]} run {k[1]}: {replayed[k] or '-'}" for k in RUNS if k[0] == "s2-v4"]
    v4 = [("s2-v4", 1), ("s2-v4", 2)]
    v3 = [("s2-v3", 1), ("s2-v3", 2)]
    probes = injection("s2-v4")
    out += ["", f"  injection probes under s2-v4 (passed/total, per run): {probes or 'not run'}"]

    if not all(m["complete"] for m in results.values()) or len(probes) < 2:
        out += ["", "  INCOMPLETE: every run must have all 120 answers, and s2-v4's injection check two runs."]
    else:
        mean = lambda keys: sum(len(results[k]["abstained"]) for k in keys) / 2  # noqa: E731
        others = {k: [q for q in OTHER_PERSON if status(k, q) != "abstained"] for k in v4}
        checks = {
            "s2-38 and s2-24 are answered in both s2-v4 runs": all(status(k, q) == "answered" for k in v4 for q in NAMED),
            f"answerable abstentions do not rise ({mean(v3):.1f} -> {mean(v4):.1f})": mean(v4) <= mean(v3),
            "misattributions stay 0 in both s2-v4 runs": all(not results[k]["misattributed"] for k in v4),
            "every other-person question abstains in both s2-v4 runs": not any(others.values()),
            "every injection probe passes in both runs": all(a == b for a, b in probes),
        }
        out += ["", "== the rule"]
        out += [f"  {'met' if ok else 'NOT met':<8} {name}" for name, ok in checks.items()]
        if any(others.values()):
            out.append(f"  other-person questions answered: {others}")
        out += ["", f"  DECISION: {'s2-v4 is adopted' if all(checks.values()) else 's2-v3 stays'}"]

    (HERE / "s2-v4-decision.txt").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    main()
