"""POST /criteria/extract: the service's half of S8's extraction.

A stub store and the scripted provider: nothing here reads a database or calls
a provider. What must hold: synthetic databases only, refused before anything
is read or sent; the file is read through the store's own gated read
(`file_chunks`), as the given viewer, in the given mentorship; nothing readable
is a 404; extra fields are refused; the route runs on Gemini, never Groq.
"""

from __future__ import annotations

import json
import types

import pytest
from fastapi.testclient import TestClient

import app as service
from providers import ScriptedProvider

SECRET = "criteria-test-secret"
M1, MENTOR, FILE = "d00000000000000000000001", "0000000000000000000000b1", "f" * 24
BODY = {"mentorshipId": M1, "viewerId": MENTOR, "fileId": FILE}
CHUNKS = [{"chunkIndex": 0, "sectionIndex": 0, "heading": "Marking scheme",
           "content": "States the invalidation rule as a comment (10 marks)."}]


class Records:
    """The app's records, as far as a rubric read needs them: whether the file is this viewer's rubric, and its bytes."""

    def __init__(self, allowed=True, data=b"", content_type="application/pdf"):
        from bson import ObjectId
        self.allowed, self.data, self.queries = allowed, data, []
        attachment = {"fileId": ObjectId(FILE), "contentType": content_type, "rubric": {"isRubric": True}}
        self.mentorships = types.SimpleNamespace(find_one=lambda q: self.queries.append(("mentorships", q)) or ({} if self.allowed else None))
        self.assignments = types.SimpleNamespace(find_one=lambda q: self.queries.append(("assignments", q)) or (
            {"attachments": [attachment]} if self.allowed else None))

    def open_download_stream(self, file_id):
        data = self.data

        class Stream:
            length = len(data)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return data
        return Stream()


class Store:
    def __init__(self, db_name="chatapp_demo", chunks=CHUNKS, records=None):
        self.db = types.SimpleNamespace(name=db_name)
        self.chunks, self.reads = list(chunks), []
        self.records = records or Records()

    def file_chunks(self, mentorship_id, viewer_id, file_id):
        self.reads.append((mentorship_id, viewer_id, file_id))
        return [dict(c) for c in self.chunks]


@pytest.fixture
def wire(monkeypatch):
    def _wire(*replies, app_db="chatapp_demo", index_db="chatapp_demo", chunks=CHUNKS, records=None):
        store, llm = Store(index_db, chunks, records), ScriptedProvider(*replies, name="gemini")
        monkeypatch.setattr(service, "store", store)
        monkeypatch.setattr(service, "coverage_llm", llm)
        monkeypatch.setattr(service, "SERVICE_SECRET", SECRET)
        monkeypatch.setattr(service, "AGENT_APP_DB", app_db)
        return TestClient(service.app, client=("127.0.0.1", 50000)), store, llm
    return _wire


def post(client, body=BODY, secret=SECRET):
    return client.post("/criteria/extract", json=body, headers={"X-AI-Secret": secret} if secret else {})


REPLY = json.dumps({"criteria": [{"source_text": "States the invalidation rule as a comment (10 marks).", "marks": 10}]})


def test_the_file_is_read_as_the_viewer_in_the_mentorship_through_the_gated_read(wire):
    client, store, llm = wire(REPLY)
    res = post(client)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok" and body["criteria"][0]["id"] == "c1" and body["criteria"][0]["marks"] == 10
    assert store.reads == [(M1, MENTOR, FILE)]
    assert len(llm.calls) == 1


@pytest.mark.parametrize("app_db, index_db", [("chatapp", "chatapp_demo"), ("chatapp_demo", "chatapp_rag")])
def test_refused_off_the_synthetic_databases_before_anything_is_read_or_sent(wire, app_db, index_db):
    client, store, llm = wire(REPLY, app_db=app_db, index_db=index_db)
    res = post(client)
    assert res.status_code == 503
    assert res.json() == {"status": "error", "message": "Rubric checks are not configured on this server."}
    assert store.reads == [] and llm.calls == []


def test_nothing_readable_is_a_404_and_nothing_is_sent(wire):
    client, store, llm = wire(REPLY, chunks=[])
    res = post(client)
    assert res.status_code == 404 and res.json()["status"] == "unreadable"
    assert llm.calls == []


@pytest.mark.parametrize("body", [
    {**BODY, "role": "mentor"},
    {**BODY, "fileId": "not-an-id"},
    {k: v for k, v in BODY.items() if k != "viewerId"},
])
def test_a_malformed_request_is_refused(wire, body):
    client, store, _ = wire(REPLY)
    assert post(client, body).status_code == 422
    assert store.reads == []


def test_the_secret_is_required(wire):
    client, store, _ = wire(REPLY)
    assert post(client, secret=None).status_code in (401, 403, 422)
    assert post(client, secret="wrong").status_code in (401, 403)
    assert store.reads == []


def test_the_routes_provider_is_gemini_even_if_the_app_runs_on_groq():
    assert service.coverage_llm.name == "gemini"


# ---------------------------------------------------------------------------
# POST /coverage/assess (S8 Step 3)
# ---------------------------------------------------------------------------
SUB = "5" * 24
ASSESS = {"mentorshipId": M1, "viewerId": MENTOR, "submissionId": SUB, "text": "My rule clears one list.",
          "files": [{"fileId": FILE, "name": "report.pdf"}],
          "criteria": [{"id": "k1", "text": "States the rule", "marks": 10}]}
MIXED = [
    {"chunkIndex": 0, "content": "Own work.", "parentType": "submission", "parentId": SUB},
    {"chunkIndex": 1, "content": "Someone else's.", "parentType": "submission", "parentId": "6" * 24},
    {"chunkIndex": 2, "content": "A brief file.", "parentType": "assignment", "parentId": SUB},
]
VERDICT = json.dumps({"verdicts": [{"criterion_id": "k1", "verdict": "not_found"}]})


def assess_post(client, body=ASSESS, secret=SECRET):
    return client.post("/coverage/assess", json=body, headers={"X-AI-Secret": secret} if secret else {})


def test_assess_reads_each_file_as_the_viewer_and_keeps_only_this_hand_ins_chunks(wire):
    client, store, llm = wire(json.dumps({"evidence": []}), VERDICT, chunks=MIXED)
    res = assess_post(client)
    assert res.status_code == 200 and res.json()["verdicts"][0]["label"] == "Not found in submission"
    assert store.reads == [(M1, MENTOR, FILE)]
    shown = llm.calls[0][1]
    assert "Own work." in shown and "Someone else's." not in shown and "A brief file." not in shown


@pytest.mark.parametrize("app_db, index_db", [("chatapp", "chatapp_demo"), ("chatapp_demo", "chatapp_rag")])
def test_assess_is_refused_off_the_synthetic_databases_before_anything_is_read_or_sent(wire, app_db, index_db):
    client, store, llm = wire(VERDICT, app_db=app_db, index_db=index_db)
    assert assess_post(client).status_code == 503
    assert store.reads == [] and llm.calls == []


@pytest.mark.parametrize("change", [
    {"criteria": []},
    {"criteria": [{"id": "c1", "text": "x"}]},                      # not a confirmed id
    {"criteria": [{"id": "k1", "text": "x", "marks": -1}]},
    {"criteria": [{"id": "k1", "text": "x", "total": 10}]},
    {"files": [{"fileId": FILE, "name": "a"}] * 6},
    {"total": 30},
    {"text": "x" * 5001},
])
def test_assess_refuses_a_malformed_request(wire, change):
    client, store, llm = wire(VERDICT)
    assert assess_post(client, {**ASSESS, **change}).status_code == 422
    assert store.reads == [] and llm.calls == []


# ---------------------------------------------------------------------------
# POST /criteria/extract-brief and /coverage/summary (S8 Step 4)
# ---------------------------------------------------------------------------
def test_brief_extraction_reads_only_the_text_express_sent(wire):
    client, store, llm = wire(json.dumps({"criteria": [{"source_text": "Write the rule.", "marks": None}]}))
    res = client.post("/criteria/extract-brief", json={"text": "Caching\n\nWrite the rule. Explain staleness."},
                      headers={"X-AI-Secret": SECRET})
    assert res.status_code == 200 and [c["sourceText"] for c in res.json()["criteria"]] == ["Write the rule."]
    assert store.reads == [] and "Write the rule. Explain staleness." in llm.calls[0][1]


@pytest.mark.parametrize("path, body", [("/criteria/extract-brief", {"text": "x"}),
                                        ("/coverage/summary", {k: v for k, v in ASSESS.items() if k != "criteria"})])
def test_the_step_4_routes_are_refused_off_the_synthetic_databases(wire, path, body):
    client, store, llm = wire("{}", app_db="chatapp")
    assert client.post(path, json=body, headers={"X-AI-Secret": SECRET}).status_code == 503
    assert store.reads == [] and llm.calls == []


def test_a_summary_request_cannot_carry_criteria_and_reads_only_this_hand_in(wire):
    client, store, llm = wire(json.dumps({"points": []}), chunks=MIXED)
    body = {k: v for k, v in ASSESS.items() if k != "criteria"}
    assert client.post("/coverage/summary", json=ASSESS, headers={"X-AI-Secret": SECRET}).status_code == 422
    res = client.post("/coverage/summary", json=body, headers={"X-AI-Secret": SECRET})
    assert res.status_code == 200 and res.json()["points"] == []
    assert "Own work." in llm.calls[0][1] and "Someone else's." not in llm.calls[0][1]


# ---------------------------------------------------------------------------
# A table rubric (S8 Step 6, the human's decision A)
# ---------------------------------------------------------------------------
from pathlib import Path  # noqa: E402

R8_RUBRIC = (Path(__file__).resolve().parents[1] / "eval" / "s8-set" / "files" / "R8" / "rubric.pdf").read_bytes()


def test_a_table_rubrics_criteria_reach_the_model(wire):
    reply = json.dumps({"criteria": [{"source_text": "Implementation and Presentation", "marks": 10}]})
    client, store, llm = wire(*[reply] * 6, records=Records(data=R8_RUBRIC))
    res = post(client)
    assert res.status_code == 200
    shown = " ".join(u for _, u in llm.calls)
    assert "Impleme ntation and Pres entation" in shown, "the table's rows are read, word breaks and all"
    assert "Impleme ntation and Pres entation" in [c["sourceText"] for c in res.json()["criteria"]], (
        "a word a narrow cell broke still counts as quoted, and is kept as the document spaces it")


def test_the_bytes_are_read_only_for_this_viewers_rubric_in_this_mentorship(wire):
    client, store, llm = wire(REPLY, records=Records(allowed=False, data=R8_RUBRIC))
    res = post(client)
    assert res.status_code == 404 and llm.calls == [] and store.reads == []
    (kind1, q1), = store.records.queries[:1]
    assert kind1 == "mentorships" and q1["status"] == "active" and str(q1["mentor"]) == MENTOR and str(q1["_id"]) == M1


def test_the_rubric_query_names_the_setter_the_mentorship_and_the_rubric_flag(wire):
    client, store, _ = wire(REPLY, records=Records(data=b""))
    post(client)
    q = dict(store.records.queries)["assignments"]
    assert str(q["mentor"]) == MENTOR and str(q["mentorships"]) == M1
    assert q["attachments"]["$elemMatch"]["rubric.isRubric"] is True and str(q["attachments"]["$elemMatch"]["fileId"]) == FILE
