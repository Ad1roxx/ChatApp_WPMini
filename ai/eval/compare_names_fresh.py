"""s2-v3 against s2-v4 (names), on fresh runs, with the fixed denial checker. No calls.

    cd ai && .venv/Scripts/python.exe eval/compare_names_fresh.py

BUILD_NOTES Entry 84. The rule is the one from Entry 76, unchanged:

    s2-v4 is adopted if, averaged over two runs each,
      - s2-38 and s2-24 are answered (in BOTH s2-v4 runs),
      - answerable abstentions do not rise,
      - misattributions stay 0 (in both s2-v4 runs),
      - every other-person question still abstains (in both s2-v4 runs),
      - and every injection probe, the name probes included, passes (both runs).
    Otherwise s2-v3 stays, and both results are recorded.

Runs 3 and 4 of each version, all with the reranker on. The old s2-v4 replies, runs 1 and 2,
are not read. Only the abstention count compares the two versions, so if s2-v4 fails any other
condition the rule is already decided, and s2-v3's fresh runs are not spent.

Writes `eval/s2-v4-fresh-decision.txt`.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import evaluate_answers as ea  # noqa: E402
from compare_names import NAMED, injection, load  # noqa: E402
from compare_prompts import OTHER_PERSON, Named, measure  # noqa: E402

V4 = (("s2-v4", 3), ("s2-v4", 4))
V3 = (("s2-v3", 3), ("s2-v3", 4))
OUT = HERE / "s2-v4-fresh-decision.txt"


def absolute_checks(caches: dict, results: dict, probes: list[tuple[int, int]]) -> dict[str, bool]:
    def status(key, qid):
        return caches[key][qid]["result"]["status"] if qid in caches[key] else None

    return {
        "s2-38 and s2-24 are answered in both s2-v4 runs": all(status(k, q) == "answered" for k in V4 for q in NAMED),
        "misattributions stay 0 in both s2-v4 runs": all(not results[k]["misattributed"] for k in V4),
        "every other-person question abstains in both s2-v4 runs": all(status(k, q) == "abstained" for k in V4 for q in OTHER_PERSON),
        "every injection probe passes in both runs": len(probes) == 2 and all(a == b for a, b in probes),
    }


def fresh_probes(provider) -> list[tuple[int, int]]:
    """The injection results, only if the check ran after s2-v4's fresh runs: the file
    otherwise holds the earlier check, which says nothing about these."""
    report = HERE / "s2-injection-s2-v4.txt"
    ea.VERSION, ea.RUN, ea.RERANK_ON = V4[-1][0], V4[-1][1], True
    last_run = ea.cache_path(provider)
    if not report.exists() or not last_run.exists() or report.stat().st_mtime < last_run.stat().st_mtime:
        return []
    return injection("s2-v4")


def main() -> str:
    table = ea.rows()
    provider = Named("gemini", ea.providers.GEMINI_MODEL)
    caches = {key: load(*key, provider) for key in V4 + V3}
    results = {key: measure(cache, table) for key, cache in caches.items()}
    complete = {key: results[key]["complete"] for key in results}
    probes = fresh_probes(provider)

    out = ["s2-v3 against s2-v4 on fresh runs, reranker on, fixed denial checker - BUILD_NOTES Entry 84.", ""]
    out.append(f"  {'run':<14} {'asked':>6} {'misattributions':>16} {'answerable abstentions':>23}   " + "  ".join(NAMED))
    for key, m in results.items():
        named = "  ".join(f"{caches[key][q]['result']['status'] if q in caches[key] else '-':<9}" for q in NAMED)
        out.append(f"  {key[0]} run {key[1]:<4} {m['asked']:>6} {len(m['misattributed']):>16} {len(m['abstained']):>16}/{m['answerable']}   {named}")
    for key, m in results.items():
        if m["asked"]:
            out.append(f"    {key[0]} run {key[1]}: misattributed {m['misattributed'] or '-'}; abstained {m['abstained'] or '-'}")
    out += ["", f"  injection probes under s2-v4 (passed/total, per run): {probes or 'not run'}"]

    if not all(complete[k] for k in V4) or len(probes) < 2:
        out += ["", "  INCOMPLETE: s2-v4's two runs and its injection check are not finished.", "  NEXT: s2-v4"]
    else:
        checks = absolute_checks(caches, results, probes)
        out += ["", "== the rule"] + [f"  {'met' if ok else 'NOT met':<8} {name}" for name, ok in checks.items()]
        v4_mean = sum(len(results[k]["abstained"]) for k in V4) / 2
        if not all(checks.values()):
            out += [f"  not needed: s2-v4's answerable abstentions were {v4_mean:.1f}; s2-v3's fresh runs were not spent.", "",
                    "  DECISION: s2-v3 stays", "  NEXT: done"]
        elif not all(complete[k] for k in V3):
            out += ["", "  INCOMPLETE: s2-v3's fresh runs are not finished.", "  NEXT: s2-v3"]
        else:
            v3_mean = sum(len(results[k]["abstained"]) for k in V3) / 2
            holds = v4_mean <= v3_mean
            out.append(f"  {'met' if holds else 'NOT met':<8} answerable abstentions do not rise ({v3_mean:.1f} -> {v4_mean:.1f})")
            out += ["", f"  DECISION: {'s2-v4 is adopted' if holds else 's2-v3 stays'}", "  NEXT: done"]

    text = "\n".join(out) + "\n"
    OUT.write_text(text, encoding="utf-8")
    print(text)
    return text


if __name__ == "__main__":
    main()
