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


class Store:
    def __init__(self, db_name="chatapp_demo", chunks=CHUNKS):
        self.db = types.SimpleNamespace(name=db_name)
        self.chunks, self.reads = list(chunks), []

    def file_chunks(self, mentorship_id, viewer_id, file_id):
        self.reads.append((mentorship_id, viewer_id, file_id))
        return [dict(c) for c in self.chunks]


@pytest.fixture
def wire(monkeypatch):
    def _wire(*replies, app_db="chatapp_demo", index_db="chatapp_demo", chunks=CHUNKS):
        store, llm = Store(index_db, chunks), ScriptedProvider(*replies, name="gemini")
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
