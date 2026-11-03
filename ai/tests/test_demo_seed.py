"""The demo seed's guard, and that its documents extract the way a demo needs.

Nothing here connects to a database or a server: the seed itself is run by
`npm run demo` (BUILD_NOTES Entry 77).
"""

import importlib.util
from pathlib import Path

import pytest

from extract import extract_docx, extract_pdf

SCRIPT = Path(__file__).resolve().parent.parent.parent / "scripts" / "seed-demo.py"
spec = importlib.util.spec_from_file_location("seed_demo", SCRIPT)
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


@pytest.mark.parametrize("name", [
    "chatapp", "chatapp_test", "chatapp_eval", "chatapp_rag", "chatapp_freshness",
    "chatapp_asklive", "production", "chatapp_test_demo", "chatapp_eval_demo", "demo",
])
def test_it_refuses_any_database_but_a_demo_one(name):
    with pytest.raises(SystemExit, match="Refusing to seed"):
        seed.assert_demo_database(name)


def test_it_accepts_the_demo_database():
    seed.assert_demo_database("chatapp_demo")


def test_the_wipe_checks_the_name_before_it_connects(monkeypatch):
    monkeypatch.setattr(seed, "DEMO_DB", "chatapp")
    monkeypatch.setattr(seed, "MongoClient", lambda *a: pytest.fail("connected to a database"))
    with pytest.raises(SystemExit, match="Refusing to seed"):
        seed.wipe()


def test_the_pdfs_have_real_headings_on_more_than_one_page():
    report = extract_pdf(seed.RATE_LIMITER, filename="rate-limiter-design.pdf")
    headings = {s["heading"]: s for s in report["sections"]}
    assert {"The problem", "Why a token bucket", "When Redis is down", "What I tested"} <= set(headings)
    assert headings["The problem"]["start_page"] == 1
    assert headings["When Redis is down"]["start_page"] == 3


def test_the_word_files_have_real_headings():
    report = extract_docx(seed.POSTMORTEM, filename="lunch-rush-postmortem.docx")
    assert {"Summary", "Timeline", "Root cause", "Action items"} <= {s["heading"] for s in report["sections"]}


def test_every_demo_person_is_on_a_reserved_domain():
    assert all(email.endswith(".invalid") for _, _, email, _, _ in seed.USERS)
