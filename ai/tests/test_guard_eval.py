"""The Prompt Guard measurement's arithmetic (eval/guard_eval.py), on hand-written scores. No provider and no database."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "eval"))

import guard_eval as g  # noqa: E402


def test_text_is_split_into_consecutive_windows_of_at_most_the_limit():
    text = "a" * (g.WINDOW * 2 + 5)
    windows = g.windows(text)
    assert [len(w) for w in windows] == [g.WINDOW, g.WINDOW, 5]
    assert "".join(windows) == text


def test_empty_text_still_gets_one_window():
    assert g.windows("") == [""]


def test_a_score_of_exactly_the_threshold_is_flagged():
    assert g.flagged([0.5])
    assert not g.flagged([0.4999])


def test_a_text_is_flagged_when_any_of_its_windows_is():
    assert g.flagged([0.01, 0.9, 0.01])
    assert not g.flagged([0.01, 0.2])


def test_a_passage_with_a_failed_call_is_left_out_and_counted():
    s = g.summarise({"a": {"scores": [0.9]}, "b": {"scores": [0.1]}, "c": {"scores": [0.9, None]}})
    assert (s["n"], s["failed"], s["flagged"]) == (2, 1, ["a"])


def results(ordinary_flagged: int, injections: int, n: int = 100) -> dict:
    return {"ordinary": {"n": n, "failed": 0, "flagged": ["x"] * ordinary_flagged},
            "hard_negatives": {"n": 30, "failed": 0, "flagged": []},
            "injections": {"n": 12, "failed": 0, "flagged": ["y"] * injections}}


def test_above_one_percent_is_off_for_both():
    _, final = g.recommendation({"86m": results(2, 12), "22m": results(2, 12)})
    assert "keep it off" in final


def test_exactly_one_percent_may_be_recommended():
    _, final = g.recommendation({"86m": results(1, 3), "22m": results(5, 12)})
    assert final.startswith("RECOMMENDATION: 86m meets")


def test_the_higher_detection_is_named():
    _, final = g.recommendation({"86m": results(0, 9), "22m": results(0, 4)})
    assert final.startswith("RECOMMENDATION: 86m meets")


def test_a_tie_goes_to_the_smaller_model():
    _, final = g.recommendation({"86m": results(0, 5), "22m": results(0, 5)})
    assert final.startswith("RECOMMENDATION: 22m meets")


def test_nothing_measured_is_never_recommended():
    _, final = g.recommendation({"86m": results(0, 5, n=0), "22m": results(0, 5, n=0)})
    assert "keep it off" in final


def test_the_recommendation_never_turns_it_on():
    _, final = g.recommendation({"86m": results(0, 12), "22m": results(0, 4)})
    assert "human's decision" in final
