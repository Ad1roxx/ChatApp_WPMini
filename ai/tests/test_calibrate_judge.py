"""The arithmetic of S6's judge calibration (eval/calibrate_judge.py), on hand-made labels. No provider."""

from __future__ import annotations

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
