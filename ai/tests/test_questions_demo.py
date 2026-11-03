"""The demo questions' labels, held to the demo's real files. Nothing here searches."""

import importlib.util
import json
import re
from pathlib import Path

from extract import extract_docx, extract_pdf

AI = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("seed_demo", AI.parent / "scripts" / "seed-demo.py")
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)

QUESTIONS = [json.loads(line) for line in (AI / "eval" / "questions_demo.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
HEADINGS = {
    "rate-limiter-design.pdf": extract_pdf(seed.RATE_LIMITER),
    "lunch-rush-postmortem.docx": extract_docx(seed.POSTMORTEM),
    "survey-cleaning-report.pdf": extract_pdf(seed.CLEANING_REPORT),
    "survey-star-schema.docx": extract_docx(seed.SCHEMA_NOTE),
}
HEADINGS = {name: {s["heading"] for s in result["sections"]} for name, result in HEADINGS.items()}
SEED_SOURCE = (AI.parent / "scripts" / "seed-demo.py").read_text(encoding="utf-8")


def test_counts_and_unique_ids():
    assert len(QUESTIONS) == 46
    assert len({q["id"] for q in QUESTIONS}) == 46
    assert sum(q["answerable"] for q in QUESTIONS) == 40


def test_every_named_section_is_a_real_section_of_that_file():
    for q in QUESTIONS:
        for label in q["expected"]:
            if label["heading"] is not None:
                assert label["heading"] in HEADINGS[label["title"]], q["id"]


def test_every_other_label_is_a_record_the_seed_writes():
    for q in QUESTIONS:
        for label in q["expected"]:
            if label["heading"] is None:
                assert label["title"].removeprefix("Hand-in: ") in SEED_SOURCE, q["id"]


def test_every_answerable_question_in_the_demo_log_is_here():
    log = (AI / "eval" / "s3-demo-log.txt").read_text(encoding="utf-8")
    demo = [q["question"] for q in QUESTIONS if q["group"] == "demo"]
    assert len(demo) == 9
    for question in demo:
        assert question in log, question
    assert "What is the canteen's refund policy?" in log
    assert not re.search("refund", " ".join(demo))
