"""POST /agent: the service's half of the agent route.

The store is a stub that names the database it stands for, and the model is
`ScriptedProvider`, so nothing here reads a database or calls a provider. The
property that matters most: the agent runs on synthetic databases only, and
refuses before anything is searched, sent or read anywhere else (the user,
2026-11-07; BUILD_NOTES Entry 101).
"""

from __future__ import annotations

import logging
import types

import pytest
from fastapi.testclient import TestClient

import app as service
from config import AGENT_SYNTHETIC_DATABASES, agent_database_problem
from providers import PLAIN, RATE_LIMITED, Generation, ScriptedProvider

SECRET = "agent-test-secret"
M1 = "d00000000000000000000001"
ADITYA = "0000000000000000000000a1"
TOKEN = "header.payload.signature-of-this-turn"
BODY = {"mentorshipId": M1, "viewerId": ADITYA, "role": "student", "question": "Which milestones are left?",
        "token": TOKEN}
HIT = {
    "mentorshipId": M1, "sourceType": "resource", "sourceId": "e" * 24, "title": "Idempotency keys explained",
    "content": "Retry five times.", "chunkIndex": 0, "url": "https://example.com", "score": 0.8,
}


class Store:
    """Stands for the index `db_name`; records every search."""

    def __init__(self, db_name="chatapp_demo", hits=(HIT,)):
        self.db = types.SimpleNamespace(name=db_name)
        self.hits, self.searches = list(hits), []

    def search(self, mentorship_id, viewer_id, query, k=4):
        self.searches.append((mentorship_id, viewer_id, query, k))
        return [dict(h) for h in self.hits]


@pytest.fixture
def wire(monkeypatch):
    def _wire(*replies, app_db="chatapp_demo", index_db="chatapp_demo"):
        store, provider = Store(index_db), ScriptedProvider(*replies)
        monkeypatch.setattr(service, "store", store)
        monkeypatch.setattr(service, "provider", provider)
        monkeypatch.setattr(service, "SERVICE_SECRET", SECRET)
        monkeypatch.setattr(service, "AGENT_APP_DB", app_db)
        return TestClient(service.app, client=("127.0.0.1", 50000)), store, provider
    return _wire


def post(client, body=BODY, secret=SECRET):
    return client.post("/agent", json=body, headers={"X-AI-Secret": secret} if secret else {})


# ---------------------------------------------------------------------------
# Synthetic databases only
# ---------------------------------------------------------------------------
def test_the_agent_refuses_for_chatapp_before_anything_is_searched_or_sent(wire):
    client, store, provider = wire([("search_mentorship_material", {"query": "milestones"})], "Done [1].",
                                   app_db="chatapp")
    res = post(client)
    assert res.status_code == 503
    assert res.json() == {"status": "error", "message": "The agent is not configured on this server."}
    assert store.searches == [] and provider.calls == []


def test_the_agent_refuses_for_the_served_index_of_chatapp(wire):
    client, store, provider = wire("Done.", app_db="chatapp_demo", index_db="chatapp_rag")
    res = post(client)
    assert res.status_code == 503
    assert res.json()["message"] == "The agent is not configured on this server."
    assert store.searches == [] and provider.calls == []


@pytest.mark.parametrize("name", ["chatapp", "chatapp_rag", "Chatapp_demo", "chatapp_demo ", "", "mentorconnect"])
def test_only_the_listed_names_pass(name):
    assert agent_database_problem(name, "chatapp_demo")
    assert agent_database_problem("chatapp_demo", name)


def test_the_list_is_the_demo_the_evaluation_fixtures_and_the_tests_own_databases():
    assert AGENT_SYNTHETIC_DATABASES == {
        "chatapp_demo", "chatapp_eval", "chatapp_demo_eval", "chatapp_eval_ctx", "chatapp_agent_eval", "chatapp_asklive",
        "chatapp_test", "chatapp_rag_pytest", "chatapp_rag_pytest_app",
    }
    assert agent_database_problem("chatapp_demo", "chatapp_demo") is None


def test_the_list_is_not_read_from_the_environment(monkeypatch):
    import importlib

    import config

    monkeypatch.setenv("AI_AGENT_SYNTHETIC_DATABASES", "chatapp")
    monkeypatch.setenv("AGENT_SYNTHETIC_DATABASES", "chatapp")
    assert "chatapp" not in importlib.reload(config).AGENT_SYNTHETIC_DATABASES


def test_the_refusal_names_no_database_to_the_caller_but_the_log_does(wire, caplog):
    client, _, _ = wire("Done.", app_db="chatapp")
    with caplog.at_level(logging.WARNING, logger="copilot.agent"):
        res = post(client)
    assert "chatapp" not in res.text
    assert "'chatapp'" in caplog.text


# ---------------------------------------------------------------------------
# The same boundary as /ask
# ---------------------------------------------------------------------------
def test_the_secret_is_required(wire):
    client, store, provider = wire("Done.")
    assert post(client, secret=None).status_code == 401
    assert post(client, secret="wrong").status_code == 401
    assert store.searches == [] and provider.calls == []


def test_only_local_callers(wire, monkeypatch):
    wire("Done.")
    remote = TestClient(service.app, client=("10.0.0.7", 50000))
    assert remote.post("/agent", json=BODY, headers={"X-AI-Secret": SECRET}).status_code == 403


@pytest.mark.parametrize("extra", [{"prompt": "x"}, {"provider": "groq"}, {"tools": []}, {"viewers": [ADITYA]}])
def test_extra_fields_are_refused(wire, extra):
    client, _, provider = wire("Done.")
    assert post(client, {**BODY, **extra}).status_code == 422
    assert provider.calls == []


def test_a_turn_runs_and_answers_with_its_citation(wire):
    client, store, provider = wire([("search_mentorship_material", {"query": "retries"})], "Retry five times [1].")
    res = post(client)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "answered" and body["citations"][0]["handle"] == "1"
    assert store.searches[0][:2] == (M1, ADITYA)
    assert len(provider.calls) == 2


def test_an_abstention_is_200(wire):
    client, _, _ = wire("NO_ANSWER")
    res = post(client)
    assert res.status_code == 200 and res.json()["status"] == "abstained"


def test_a_provider_limit_is_429_with_the_plain_sentence(wire):
    limited = Generation(RATE_LIMITED, "fake", "scripted")
    client, _, _ = wire(limited)
    res = post(client)
    assert res.status_code == 429
    assert res.json()["message"] == PLAIN[RATE_LIMITED]


def test_the_token_is_never_in_the_response_or_the_log(wire, caplog):
    client, _, _ = wire([("search_mentorship_material", {"query": "retries"})], "Retry five times [1].")
    with caplog.at_level(logging.DEBUG):
        res = post(client)
    assert TOKEN not in res.text
    assert TOKEN not in caplog.text
