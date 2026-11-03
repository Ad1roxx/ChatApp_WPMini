"""The mechanism questions' labels. Nothing here searches or opens a database."""

import json
from pathlib import Path

EVAL = Path(__file__).resolve().parent.parent / "eval"


def load(name):
    return [json.loads(line) for line in (EVAL / name).read_text(encoding="utf-8").splitlines() if line.strip()]


QUESTIONS = load("questions_mechanism.jsonl")
SEED = (EVAL / "seed_documents.py").read_text(encoding="utf-8") + (EVAL / "s2_documents.py").read_text(encoding="utf-8")


def test_counts_and_about_half_name_someone():
    assert len(QUESTIONS) == 19
    assert len({q["id"] for q in QUESTIONS}) == 19
    assert 8 <= sum(q["names_someone"] for q in QUESTIONS) <= 11


def test_no_question_repeats_an_earlier_set_or_any_demo_trace():
    earlier = {q["question"] for name in ("questions.jsonl", "questions_s2.jsonl", "questions_demo.jsonl", "questions_demo_fresh.jsonl") for q in load(name)}
    assert not {q["question"] for q in QUESTIONS} & earlier


def test_every_answer_is_in_a_hand_in_or_its_file_and_never_only_in_a_brief():
    briefs = {"Database indexing exercise", "Load test the bookings API", "Find and fix the double-booking race"}
    for q in QUESTIONS:
        assert q["expected"], q["id"]
        for label in q["expected"]:
            assert label["title"] not in briefs, q["id"]
            assert label["title"].startswith("Hand-in: ") or label["title"].rsplit(".", 1)[-1] in ("pdf", "docx"), q["id"]


def test_every_label_names_something_the_fixture_seeds():
    for q in QUESTIONS:
        for label in q["expected"]:
            assert label["title"].removeprefix("Hand-in: ") in SEED, q["id"]
