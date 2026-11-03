"""The fresh demo questions' labels, held to the demo's real files. Nothing here searches."""

import importlib.util
import json
from pathlib import Path

from extract import extract_docx, extract_pdf

AI = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("seed_demo", AI.parent / "scripts" / "seed-demo.py")
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)

QUESTIONS = [json.loads(line) for line in (AI / "eval" / "questions_demo_fresh.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
EARLIER = [json.loads(line) for line in (AI / "eval" / "questions_demo.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
HEADINGS = {
    "rate-limiter-design.pdf": extract_pdf(seed.RATE_LIMITER),
    "lunch-rush-postmortem.docx": extract_docx(seed.POSTMORTEM),
    "survey-cleaning-report.pdf": extract_pdf(seed.CLEANING_REPORT),
    "survey-star-schema.docx": extract_docx(seed.SCHEMA_NOTE),
}
HEADINGS = {name: {s["heading"] for s in result["sections"]} for name, result in HEADINGS.items()}
SEED_SOURCE = (AI.parent / "scripts" / "seed-demo.py").read_text(encoding="utf-8")


def test_counts_ids_and_no_repeats_of_the_earlier_questions():
    assert len(QUESTIONS) == 16
    assert len({q["id"] for q in QUESTIONS}) == 16
    assert not {q["question"] for q in QUESTIONS} & {q["question"] for q in EARLIER}


def test_every_label_is_real():
    for q in QUESTIONS:
        for label in q["expected"]:
            if label["heading"] is None:
                assert label["title"].removeprefix("Hand-in: ") in SEED_SOURCE, q["id"]
            else:
                assert label["heading"] in HEADINGS[label["title"]], q["id"]
