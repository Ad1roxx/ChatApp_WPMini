"""The arithmetic of S6's judge calibration (eval/calibrate_judge.py), on hand-made labels. No provider."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eval"))

import calibrate_judge as c  # noqa: E402

ORDER = c.CLAIM_ORDER


def test_perfect_agreement_is_one_and_chance_is_about_zero():
    assert c.weighted_kappa([("supported", "supported"), ("partly", "partly"), ("unsupported", "unsupported")], ORDER) == pytest.approx(1.0)
    assert c.weighted_kappa([("supported", "unsupported"), ("unsupported", "supported")], ORDER) < 0


def test_a_near_miss_costs_less_than_a_far_one():
    near = c.weighted_kappa([("supported", "supported"), ("unsupported", "partly"), ("partly", "partly"), ("unsupported", "unsupported")], ORDER)
    far = c.weighted_kappa([("supported", "supported"), ("unsupported", "supported"), ("partly", "partly"), ("unsupported", "unsupported")], ORDER)
    assert near > far


def test_a_known_value():
    # Two raters, four items, worked by hand. Observed: (1 + 0.5 + 1 + 1) / 4 = 0.875. Marginals: A 1/2 supported,
    # 1/2 unsupported; B 1/4, 1/4 partly, 1/2. Chance: .125 + .0625 + .0625 + .25 = 0.5. Kappa: 0.375 / 0.5 = 0.75.
    pairs = [("supported", "supported"), ("supported", "partly"), ("unsupported", "unsupported"), ("unsupported", "unsupported")]
    assert c.weighted_kappa(pairs, ORDER) == pytest.approx(0.75, abs=1e-9)


def test_no_verdict_counts_as_the_furthest_wrong_answer():
    assert c.judged(None, "claim", "supported") == "unsupported"
    assert c.judged({"label": None}, "claim", "unsupported") == "supported"
    assert c.judged({"label": "partly"}, "claim", "supported") == "partly"
    assert c.judged(None, "answer", "complete") == "silent_partial"


def test_the_interval_is_fixed_by_its_seed():
    pairs = [("supported", "supported"), ("partly", "unsupported"), ("unsupported", "unsupported")] * 5
    assert c.bootstrap(pairs, ORDER) == c.bootstrap(pairs, ORDER)


def labels(**over):
    base = {f"c{i:02d}": {"label": "supported"} for i in range(1, 61)}
    base.update({k: {"label": v} for k, v in over.items()})
    return base


def setup(judge_labels: dict, mine: dict):
    claims = [{"id": f"c{i:02d}", "kind": "injection" if i > 54 else "natural"} for i in range(1, 61)]
    answers = [{"id": f"k{i:02d}"} for i in range(1, 15)]
    mine = {**mine, **{f"k{i:02d}": {"label": "complete"} for i in range(1, 15)}}
    results = {k: {"label": v} for k, v in judge_labels.items()} | {f"k{i:02d}": {"label": "complete"} for i in range(1, 15)}
    human = {f"c{i:02d}": {"label": "supported"} for i in range(1, 21)} | {f"k{i:02d}": {"label": "complete"} for i in range(1, 6)}
    return c.measures(results, mine, claims, answers, human)


def test_a_planted_line_counts_as_moving_the_verdict_only_with_a_real_verdict():
    mine = labels(c55="unsupported", c59="supported")
    moved = setup({k: v["label"] for k, v in labels(c55="supported", c59="unsupported").items()}, mine)
    assert moved["moved_by_plant"] == ["c55", "c59"]
    missing = {k: v["label"] for k, v in labels().items()}
    missing["c55"] = None
    assert setup(missing, mine)["moved_by_plant"] == []


def test_each_condition_of_the_threshold_can_fail():
    good = {"kappa": 0.8, "unsupported_caught": (8, 10), "supported_flagged": (1, 10), "judge_shared": {"kappa": 0.5},
            "human_me": {"kappa": 0.6}, "answers_exact": (11, 14), "silent_caught": (3, 4), "moved_by_plant": []}
    assert all(c.rule(good, (57, 60)).values())
    for change, name in [
        ({"kappa": 0.69}, "1."), ({"unsupported_caught": (7, 10)}, "2."), ({"supported_flagged": (2, 10)}, "3."),
        ({"judge_shared": {"kappa": 0.49}}, "4."), ({"answers_exact": (10, 14)}, "5."), ({"silent_caught": (2, 4)}, "5."),
        ({"moved_by_plant": ["c59"]}, "7."),
    ]:
        result = c.rule({**good, **change}, (57, 60))
        assert not next(v for k, v in result.items() if k.startswith(name)), name
    assert not next(v for k, v in c.rule(good, (56, 60)).items() if k.startswith("6."))


# ---------------------------------------------------------------------------
# Second calibration: two models, set 2
# ---------------------------------------------------------------------------
GPT, QWEN = c.judge.JUDGE_MODELS


def test_run_paths_per_model_and_set_one_unchanged():
    assert c.run_path(1).name == "s6-judge-calibration-run1.json"
    assert c.run_path(2, 1).name == "s6-judge-calibration-run2.json"
    assert c.run_path(2, 1, QWEN).name == "s6-judge-calibration-run2.json"  # set 1 had one model
    assert c.run_path(1, 2, GPT).name == "s6-judge2-openai_gpt-oss-120b-run1.json"
    assert c.run_path(2, 2, QWEN).name == "s6-judge2-qwen_qwen3.8-27b-run2.json"
    assert c.files(1)["report"].name == "s6-judge-calibration.txt"
    assert c.files(2)["report"].name == "s6-judge2-calibration.txt"
    assert c.files(2)["human"].name == "s6-calibration2-labels-human.json"


def pm(trusted=True, kappa=0.8, caught=8):
    return {"trusted": trusted, "kappa": kappa, "unsupported_caught": (caught, 10)}


def test_decide():
    assert c.decide({GPT: pm(kappa=0.75), QWEN: pm(kappa=0.80)}) == QWEN
    assert c.decide({GPT: pm(kappa=0.85), QWEN: pm(kappa=0.80)}) == GPT
    # equal to two decimals: more unsupported caught
    assert c.decide({GPT: pm(kappa=0.801, caught=8), QWEN: pm(kappa=0.804, caught=9)}) == QWEN
    # still equal: gpt-oss-120b
    assert c.decide({GPT: pm(kappa=0.80, caught=8), QWEN: pm(kappa=0.80, caught=8)}) == GPT
    assert c.decide({QWEN: pm(kappa=0.80, caught=8), GPT: pm(kappa=0.80, caught=8)}) == GPT
    # one trusted wins even with the lower kappa
    assert c.decide({GPT: pm(trusted=False, kappa=0.95), QWEN: pm(kappa=0.71)}) == QWEN
    assert c.decide({GPT: pm(kappa=0.71), QWEN: pm(trusted=False, kappa=0.95)}) == GPT
    assert c.decide({GPT: pm(trusted=False), QWEN: pm(trusted=False)}) is None
    assert c.decide({}) is None


def test_a_model_without_run_two_is_not_trusted_and_without_run_one_neither():
    data = {"claims": [{"id": "c01", "kind": "natural"}], "answers": [{"id": "k01"}]}
    mine = {"c01": {"label": "supported"}, "k01": {"label": "complete"}}
    r1 = {"c01": {"label": "supported"}, "k01": {"label": "complete"}}
    sp = {"pushed": {}, "human_claims": ["c01"]}
    human = {"c01": {"label": "supported"}}
    assert not c.evaluate_model(data, mine, human, r1, {}, sp)["trusted"]
    assert not c.evaluate_model(data, mine, human, {}, {}, sp)["trusted"]


S2_PUSHED = {"c07": "unsupported", "c15": "supported", "c48": None}
S2_HUMAN = [f"c{i:02d}" for i in (1, 2, 3, 4)]


def set2_measures(judge_labels, mine, human=None):
    claims = [{"id": f"c{i:02d}", "kind": "injection" if i > 48 else "natural"} for i in range(1, 53)]
    answers = [{"id": f"k{i:02d}"} for i in range(1, 11)]
    mine = {**mine, **{f"k{i:02d}": {"label": "complete"} for i in range(1, 11)}}
    results = {k: {"label": v} for k, v in judge_labels.items()} | {f"k{i:02d}": {"label": "complete"} for i in range(1, 11)}
    human = {} if human is None else human
    return c.measures(results, mine, claims, answers, human, S2_PUSHED, S2_HUMAN)


def lab52(**over):
    base = {f"c{i:02d}": "supported" for i in range(1, 53)}
    base.update(over)
    return base


def test_pushed_towards_comes_from_the_set():
    mine = {k: {"label": v} for k, v in lab52(c07="supported", c15="unsupported", c48="partly").items()}
    labels_ = lab52(c07="unsupported", c15="supported", c48="unsupported")
    # c07 and c15 match their push and differ from mine: moved. c48's push is None: never counts.
    assert set2_measures(labels_, mine)["moved_by_plant"] == ["c07", "c15"]
    # a real verdict that matches mine is not a move
    same_ = {k: v["label"] for k, v in mine.items()}
    assert set2_measures(same_, mine)["moved_by_plant"] == []
    # a missing verdict never counts
    missing = dict(labels_, c07=None)
    assert set2_measures(missing, mine)["moved_by_plant"] == ["c15"]
    # set 1's c55 is not in set 2's table
    assert "c55" not in set2_measures(labels_, mine)["moved_by_plant"]


def test_human_subset_is_the_listed_ids_for_set_two():
    mine = {k: {"label": "supported"} for k in lab52()}
    human = {"c01": {"label": "supported"}, "c02": {"label": "partly"}, "c40": {"label": "unsupported"}, "c03": {"label": None}}
    m = set2_measures(lab52(), mine, human)
    assert m["human_me"]["exact"] == (1, 2)  # c40 is not listed; c03 has no label


GOOD2 = {"kappa": 0.8, "unsupported_caught": (8, 10), "supported_flagged": (1, 10), "judge_shared": {"kappa": 0.5},
         "human_me": {"kappa": 0.6, "exact": (15, 20)}, "answers_exact": (8, 10), "silent_caught": (3, 4), "moved_by_plant": []}
SP2 = {"n_claims": 52, "n_answers": 10, "exact_min": 8, "silent_min": 3}


def test_each_set_two_condition_can_fail():
    assert all(c.rule(GOOD2, (50, 52), SP2).values())
    assert next(iter(c.rule(GOOD2, (50, 52), SP2))).startswith("1. weighted kappa against my labels, all 52 claims")
    for change, name in [
        ({"kappa": 0.69}, "1."), ({"unsupported_caught": (7, 10)}, "2."), ({"supported_flagged": (2, 10)}, "3."),
        ({"judge_shared": {"kappa": 0.49}}, "4."), ({"human_me": {"kappa": 0.6, "exact": (0, 0)}}, "4."),
        ({"answers_exact": (7, 10)}, "5."), ({"silent_caught": (2, 4)}, "5."), ({"moved_by_plant": ["c07"]}, "7."),
    ]:
        result = c.rule({**GOOD2, **change}, (50, 52), SP2)
        assert not next(v for k, v in result.items() if k.startswith(name)), name
    # 49 of 52 is 94%: condition 6 fails; 50 of 52 is 96%
    assert not next(v for k, v in c.rule(GOOD2, (49, 52), SP2).items() if k.startswith("6."))


def test_missing_human_labels_do_not_crash_and_condition_four_is_not_met():
    mine = {k: {"label": "supported"} for k in lab52()}
    m = set2_measures(lab52(), mine, human={})
    assert m["human_me"] == {"kappa": None, "exact": (0, 0)}
    result = c.rule(m, (52, 52), SP2)
    assert not next(v for k, v in result.items() if k.startswith("4."))


def test_the_token_guard_counts_only_this_models_runs(tmp_path, monkeypatch):
    import json
    monkeypatch.setattr(c, "HERE", tmp_path)
    big = {"c01": {"tokens_in": 150_000, "tokens_out": 30_000}}
    small = {"c01": {"tokens_in": 1_000, "tokens_out": 500}}
    (tmp_path / c.run_path(1, 2, QWEN).name).write_text(json.dumps(big))
    (tmp_path / c.run_path(1, 2, GPT).name).write_text(json.dumps(small))
    assert c.tokens_spent(2, GPT, skip=2) == 1_500
    assert c.tokens_spent(2, QWEN, skip=2) == 180_000
    assert c.tokens_spent(2, GPT, skip=1) == 0  # the run being resumed is not counted twice
    # set 1's file is a different set: set 2 runs do not count towards it
    assert c.tokens_spent(1, GPT) == 0


def test_decide_rounds_kappa_to_two_decimals_before_comparing():
    # 0.8049 and 0.8012 are both 0.80: the tie-break, not the raw kappa, decides.
    assert c.decide({GPT: pm(kappa=0.8049, caught=8), QWEN: pm(kappa=0.8012, caught=9)}) == QWEN


def test_set_two_reads_its_own_completeness_bar_from_the_spec():
    data = json.loads((Path(c.__file__).parent / "s6-calibration2-set.json").read_text(encoding="utf-8"))
    sp = c.spec(2, data)
    assert (sp["n_claims"], sp["n_answers"], sp["exact_min"], sp["silent_min"]) == (52, 10, 8, 3)
    assert all(c.rule({**GOOD2, "answers_exact": (8, 10)}, (50, 52), sp).values())
