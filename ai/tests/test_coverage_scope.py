"""S8 Step 3: evidence comes only from that student's hand-in for that assignment.

Against the real index (the same world as test_sync.py): the files a request
names are read through the store's gated read as the mentor, and a chunk is
used only if it belongs to the named hand-in. Another student's file, a file in
another mentorship, and the same student's other hand-in all yield nothing,
whatever the request names. Then a whole assessment, scripted, is shown to have
put none of their text in front of the model.
"""

from __future__ import annotations

import json

import pytest

import app as service
import coverage
from ingest import run
from providers import ScriptedProvider
from test_attachments import PDF_TYPE, Corpus, pdf_bytes
from test_sync import settle, world  # noqa: F401  (the fixture)

pytestmark = pytest.mark.needs_mongo

MINE = "Aditya's own invalidation rule clears one user's list."
THEIRS = "Zara's zebra notes on cache stampedes."
OTHER = "Aditya's earlier draft about write-through caching."


def file_of(app_db, sid):
    return app_db.submissions.find_one({"_id": sid})["attachments"][0]


@pytest.fixture
def three(world, monkeypatch):  # noqa: F811
    store, records, corpus, app_db = world
    mine = corpus.submission(Corpus.M1, Corpus.ADITYA, text="See my file.", files=[(pdf_bytes([MINE]), "mine.pdf", PDF_TYPE)])
    other = corpus.submission(Corpus.M1, Corpus.ADITYA, text="Earlier.", files=[(pdf_bytes([OTHER]), "other.pdf", PDF_TYPE)])
    theirs = corpus.submission(Corpus.M2, Corpus.ZARA, text="Zara's text.", files=[(pdf_bytes([THEIRS]), "theirs.pdf", PDF_TYPE)])
    run(store, records)
    settle(store)
    monkeypatch.setattr(service, "store", store)
    return {k: (sid, file_of(app_db, sid)) for k, sid in (("mine", mine), ("other", other), ("theirs", theirs))}


def named(sid, *files):
    return [service.FileIn(fileId=str(f["fileId"]), name=f["name"]) for f in files], str(sid)


def test_the_hand_ins_own_file_is_read(three):
    sid, f = three["mine"]
    files, s = named(sid, f)
    [got] = service.submission_files(Corpus.M1, Corpus.PRIYA, s, files)
    assert got["chunks"] and all(c["parentId"] == s for c in got["chunks"])
    assert MINE in " ".join(c["content"] for c in got["chunks"])


@pytest.mark.parametrize("who, why", [
    ("theirs", "another student's file, in another mentorship"),
    ("other", "the same student's other hand-in"),
])
def test_a_file_named_from_anywhere_else_yields_nothing(three, who, why):
    sid, _ = three["mine"]
    _, f = three[who]
    files, s = named(sid, f)
    [got] = service.submission_files(Corpus.M1, Corpus.PRIYA, s, files)
    assert got["chunks"] == [], why


def test_another_mentorships_hand_in_cannot_be_read_by_naming_its_mentorship_either(three):
    sid, f = three["theirs"]
    files, s = named(sid, f)
    # PRIYA is not a party to M2: the viewer filter returns nothing even with M2 named.
    [got] = service.submission_files(Corpus.M2, Corpus.PRIYA, s, files)
    assert got["chunks"] == []


def test_a_whole_assessment_never_shows_the_model_anyone_elses_text(three):
    sid, f = three["mine"]
    _, theirs = three["theirs"]
    _, other = three["other"]
    files, s = named(sid, f, theirs, other)
    read = service.submission_files(Corpus.M1, Corpus.PRIYA, s, files)
    model = ScriptedProvider(json.dumps({"evidence": []}),
                             json.dumps({"verdicts": [{"criterion_id": "k1", "verdict": "not_found"}]}), name="gemini")
    out = coverage.assess([{"id": "k1", "text": "States an invalidation rule", "marks": None}], "See my file.", read, model)
    shown = " ".join(u for _, u in model.calls)
    assert MINE in shown and THEIRS not in shown and OTHER not in shown
    # The two foreign files are reported as unreadable, never read.
    assert {x["where"] for x in out["notRead"]} >= {"theirs.pdf", "other.pdf"}
