"""S5 Step 2: a write pauses the turn, and resuming it does nothing but end it.

A scripted model and a mock Express, as in test_agent.py. A write tool is registered
for these tests alone, so what is under test is the pause, not any one tool.

The properties (S5 Step 2):

- no write path that does not go through `interrupt()`
- a resumed node has no side effect twice, and a resumed turn calls no model and no tool
- the capability token is absent from checkpointed state, and so are tool results
- a restart makes a paused turn report expired; resuming is at most once
- the last allowed model call has tools disabled, in the request itself
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver

import agent
import app as service
import jsonschema
from agent import NOT_RUN_ARGS, NOT_RUN_UNKNOWN, ToolSpec, Turn, is_paused, resume_turn, run_turn
from providers import GeminiProvider, GroqProvider, ScriptedProvider

TOKEN = "header.payload.signature-of-this-turn"
MID = "0000000000000000000000b1"
VIEWER = "0000000000000000000000a1"
THREAD = "a" * 32
PIN = "pin_for_test"
ARGS = {"title": "A useful article", "url": "https://example.test/a"}
SECRET_TEXT = "SECRET-TOOL-RESULT-TEXT"
# Before the fixture swaps it, so a test can see what production uses.
PRODUCTION_SAVER = agent.SAVER


class Express:
    def __init__(self):
        self.requests = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request.url.path)
        return httpx.Response(200, json={"records": [{"kind": "goal", "id": "c" * 24, "title": SECRET_TEXT}]})

    def client(self):
        return httpx.Client(base_url="http://127.0.0.1:3001", headers={"X-AI-Secret": "s"}, transport=httpx.MockTransport(self))


class Store:
    def __init__(self):
        self.searches = []

    def search(self, *a, **k):
        self.searches.append(a)
        return []


@pytest.fixture(autouse=True)
def write_tool(monkeypatch):
    """A write tool for mentors only, added to the registry for one test."""
    spec = ToolSpec(
        PIN, "Propose pinning a link.",
        {"type": "object", "properties": {"title": {"type": "string", "minLength": 1}, "url": {"type": "string"}},
         "required": ["title", "url"], "additionalProperties": False},
        ("mentor",), "mentorship", "write",
    )
    monkeypatch.setattr(agent, "TOOLS", agent.TOOLS + (spec,))
    monkeypatch.setitem(agent._VALIDATORS, PIN, jsonschema.Draft202012Validator(spec.parameters))
    monkeypatch.setattr(agent, "SAVER", InMemorySaver())
    monkeypatch.setattr(agent, "_paused", {})


def make(*replies, role="mentor", thread=THREAD, **kw):
    model, express, store = ScriptedProvider(*replies), Express(), Store()
    t = Turn(mentorship_id=MID, viewer_id=VIEWER, role=role, question="Pin that article", token=TOKEN, provider=model,
             store=store, express=express.client(), prompt_version="agent-v3", thread_id=thread, **kw)
    return t, model, express, store


def checkpointed() -> str:
    s = agent.SAVER
    return repr(dict(s.storage)) + repr(dict(s.writes)) + repr(dict(s.blobs))


def paused_turn(**kw):
    t, model, express, store = make([(PIN, ARGS)], **kw)
    result = run_turn(t)
    assert result["status"] == "proposal"
    return result, model, express, store


# ---------------------------------------------------------------------------
# Pausing
# ---------------------------------------------------------------------------
def test_a_write_call_pauses_and_comes_back_as_a_proposal():
    result, model, express, store = paused_turn()
    assert (result["tool"], result["args"], result["threadId"]) == (PIN, ARGS, THREAD)
    assert result["answer"] is None and result["citations"] == []
    assert result["modelCalls"] == 1
    assert express.requests == [] and store.searches == []
    assert is_paused(THREAD)


def test_the_agent_can_reach_no_route_but_the_read_tools():
    source = Path(agent.__file__).read_text(encoding="utf-8")
    paths = [n for n in ast.walk(ast.parse(source)) if isinstance(n, ast.Call) and getattr(n.func, "attr", "") in ("post", "put", "patch", "delete", "request")]
    assert len(paths) == 1, "one HTTP call in the whole module"
    assert "/internal/agent/tools/" in source and "/api/" not in source.replace("/internal/", "")


def test_every_path_from_a_write_goes_through_the_pause():
    graph = agent.build_graph(agent._nothing_runs_after_a_pause, agent._nothing_runs_after_a_pause, InMemorySaver()).get_graph()
    into = {(e.source, e.target) for e in graph.edges}
    assert ("tools", "confirm") in into
    assert ("confirm", "__end__") in into
    assert {src for src, dst in into if dst == "confirm"} == {"tools"}, "only the tool node leads to the pause"


def test_the_proposal_comes_from_interrupt_and_only_from_it(monkeypatch):
    seen = []

    def fake(value):
        seen.append(value)
        return "dismissed"

    monkeypatch.setattr(agent, "interrupt", fake)
    t, *_ = make([(PIN, ARGS)])
    result = run_turn(t)
    assert seen == [{"tool": PIN, "args": ARGS}]
    assert result["status"] != "proposal", "no interrupt surfaced, so no proposal"


def test_the_pause_node_is_nothing_but_the_interrupt():
    tree = ast.parse(Path(agent.__file__).read_text(encoding="utf-8"))
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "confirm")
    body = [b for b in node.body if not (isinstance(b, ast.Expr) and isinstance(b.value, ast.Constant))]
    assert len(body) == 2, "the interrupt and the return"
    assert isinstance(body[0], ast.Assign) and body[0].value.func.id == "interrupt"
    assert isinstance(body[1], ast.Return)


def test_a_tool_not_offered_to_this_role_makes_no_proposal():
    t, model, *_ = make([(PIN, ARGS)], "I can't.", role="student")
    result = run_turn(t)
    assert result["status"] != "proposal"
    assert [m for m in model.calls[1][1] if m["role"] == "tool"][0]["content"] == NOT_RUN_UNKNOWN
    assert not is_paused(THREAD)


def test_arguments_that_do_not_fit_make_no_proposal():
    t, model, *_ = make([(PIN, {"title": "x", "url": "y", "mentorshipId": "z"})], "I can't.")
    result = run_turn(t)
    assert result["status"] != "proposal"
    assert [m for m in model.calls[1][1] if m["role"] == "tool"][0]["content"] == NOT_RUN_ARGS


def test_one_proposal_per_turn_and_nothing_after_it():
    t, model, express, store = make([(PIN, ARGS), (PIN, {"title": "second", "url": "z"}), ("list_goals", {})])
    result = run_turn(t)
    assert result["args"] == ARGS
    assert len(model.calls) == 1 and express.requests == []


# ---------------------------------------------------------------------------
# What is kept while a person decides
# ---------------------------------------------------------------------------
def test_the_token_is_not_in_checkpointed_state():
    paused_turn()
    blob = checkpointed()
    assert THREAD in blob, "the check is looking at a real checkpoint"
    assert TOKEN not in blob and "signature-of-this-turn" not in blob


def test_tool_results_are_not_in_checkpointed_state():
    t, *_ = make([("list_goals", {})], [(PIN, ARGS)])
    assert run_turn(t)["status"] == "proposal"
    blob = checkpointed()
    assert THREAD in blob
    assert SECRET_TEXT not in blob


def test_a_turn_that_ends_without_a_proposal_keeps_nothing():
    t, *_ = make("NO_ANSWER")
    run_turn(t)
    assert not agent.SAVER.storage or all(not v for v in agent.SAVER.storage.values())
    assert not is_paused(THREAD)


def test_a_turn_with_no_write_tools_uses_no_checkpointer():
    t, *_ = make("NO_ANSWER", role="student")
    run_turn(t)
    assert THREAD not in checkpointed()


# ---------------------------------------------------------------------------
# Resuming
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("decision", ["approved", "dismissed"])
def test_resuming_calls_no_model_and_no_tool_and_ends_the_turn(decision):
    _, model, express, store = paused_turn()
    calls = len(model.calls)
    assert resume_turn(THREAD, decision) == {"status": "closed"}
    assert len(model.calls) == calls and express.requests == [] and store.searches == []
    assert not is_paused(THREAD)


def test_a_turn_resumes_at_most_once():
    paused_turn()
    assert resume_turn(THREAD, "approved") == {"status": "closed"}
    assert resume_turn(THREAD, "approved") == {"status": "expired"}
    assert resume_turn(THREAD, "dismissed") == {"status": "expired"}


def test_nothing_is_kept_after_resuming():
    paused_turn()
    resume_turn(THREAD, "approved")
    assert THREAD not in checkpointed()


def test_a_decision_we_do_not_know_is_refused():
    paused_turn()
    with pytest.raises(ValueError):
        resume_turn(THREAD, "it worked, now create another")
    assert is_paused(THREAD)


def test_paused_turns_are_held_in_memory_only():
    assert type(PRODUCTION_SAVER) is InMemorySaver


def test_the_graph_is_rebuilt_on_resume_with_nodes_that_cannot_run(monkeypatch):
    paused_turn()
    built = []
    real = agent.build_graph

    def spy(model_node, tool_node, checkpointer=None):
        built.append((model_node, tool_node))
        return real(model_node, tool_node, checkpointer)

    monkeypatch.setattr(agent, "build_graph", spy)
    resume_turn(THREAD, "approved")
    assert built, "a new graph, not one kept from the turn"
    assert all(m is agent._nothing_runs_after_a_pause and t is agent._nothing_runs_after_a_pause for m, t in built)


def test_a_restart_makes_a_paused_turn_report_expired(monkeypatch):
    _, model, *_ = paused_turn()
    calls = len(model.calls)
    # What a restart does to InMemorySaver.
    monkeypatch.setattr(agent, "SAVER", InMemorySaver())
    monkeypatch.setattr(agent, "_paused", {})
    assert not is_paused(THREAD)
    assert resume_turn(THREAD, "approved") == {"status": "expired"}
    assert len(model.calls) == calls


def test_resuming_a_lost_thread_starts_nothing(monkeypatch):
    """LangGraph would run the graph from the top: the rebuilt graph's nodes raise if it does."""
    assert resume_turn("b" * 32, "approved") == {"status": "expired"}
    assert "b" * 32 not in checkpointed()


def test_a_paused_turn_nobody_came_back_to_is_forgotten():
    paused_turn()
    agent._sweep(now=agent._paused[THREAD] + agent.AGENT_PROPOSAL_WAIT_S + 1)
    assert not is_paused(THREAD)
    assert resume_turn(THREAD, "approved") == {"status": "expired"}


def test_a_paused_turn_is_kept_for_its_whole_wait():
    paused_turn()
    agent._sweep(now=agent._paused[THREAD] + agent.AGENT_PROPOSAL_WAIT_S - 1)
    assert is_paused(THREAD)


def test_the_wait_is_at_least_a_proposals_life():
    assert agent.AGENT_PROPOSAL_WAIT_S >= 300


# ---------------------------------------------------------------------------
# The last call can only answer
# ---------------------------------------------------------------------------
def test_gemini_is_told_no_calls_on_the_last_step():
    p = GeminiProvider.__new__(GeminiProvider)
    p.max_output_tokens = 10
    tool = {"name": "x", "description": "d", "parameters": {"type": "object", "properties": {}}}
    body = p._converse_body("s", [{"role": "user", "text": "q"}], [tool], False)
    assert body["toolConfig"] == {"functionCallingConfig": {"mode": "NONE"}}
    assert body["tools"], "still declared: the conversation refers to them"
    assert p._converse_body("s", [{"role": "user", "text": "q"}], [tool], True)["toolConfig"]["functionCallingConfig"]["mode"] == "AUTO"


def test_groq_is_told_no_calls_on_the_last_step():
    p = GroqProvider.__new__(GroqProvider)
    p.max_output_tokens, p.model, p.reasoning_effort = 10, "m", "low"
    tool = {"name": "x", "description": "d", "parameters": {"type": "object", "properties": {}}}
    assert p._converse_body("s", [{"role": "user", "text": "q"}], [tool], False)["tool_choice"] == "none"
    assert p._converse_body("s", [{"role": "user", "text": "q"}], [tool], True)["tool_choice"] == "auto"


class Recording(ScriptedProvider):
    def __init__(self, *r):
        super().__init__(*r)
        self.allowed = []

    def converse(self, system, messages, tools, *, budget_s=20, allow_calls=True):
        self.allowed.append((allow_calls, len(tools)))
        return super().converse(system, messages, tools, budget_s=budget_s, allow_calls=allow_calls)


def test_the_last_allowed_call_cannot_request_a_tool():
    q = {"query": "x"}
    model = Recording([("search_mentorship_material", q)], [("no_such_tool", {})], [("search_mentorship_material", q)], "NO_ANSWER")
    express, store = Express(), Store()
    run_turn(Turn(mentorship_id=MID, viewer_id=VIEWER, role="student", question="q", token=TOKEN, provider=model, store=store,
                  express=express.client(), prompt_version="agent-v3"))
    assert [a for a, _ in model.allowed] == [True, True, True, False]
    assert model.allowed[-1][1] > 0, "the tools are declared and disabled, not left out"


def test_an_invented_tool_is_told_so_and_the_model_answers_with_what_is_left():
    model = ScriptedProvider([("search_mentorship_method", {})], "NO_ANSWER")
    t = Turn(mentorship_id=MID, viewer_id=VIEWER, role="student", question="q", token=TOKEN, provider=model, store=Store(),
             express=Express().client(), prompt_version="agent-v3")
    assert run_turn(t)["status"] == "abstained"
    assert [m for m in model.calls[1][1] if m["role"] == "tool"][0]["content"] == NOT_RUN_UNKNOWN


# ---------------------------------------------------------------------------
# The service's routes
# ---------------------------------------------------------------------------
@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(service, "SERVICE_SECRET", "svc")
    monkeypatch.setattr(service, "AGENT_APP_DB", "chatapp_demo")
    import types
    monkeypatch.setattr(service, "store", types.SimpleNamespace(db=types.SimpleNamespace(name="chatapp_demo")))
    return TestClient(service.app, client=("127.0.0.1", 50000))


H = {"X-AI-Secret": "svc"}


def test_the_routes_say_whether_it_waits_and_end_it_once(client):
    paused_turn()
    assert client.post("/agent/paused", json={"threadId": THREAD}, headers=H).json() == {"paused": True}
    assert client.post("/agent/resume", json={"threadId": THREAD, "decision": "approved"}, headers=H).json() == {"status": "closed"}
    assert client.post("/agent/paused", json={"threadId": THREAD}, headers=H).json() == {"paused": False}
    assert client.post("/agent/resume", json={"threadId": THREAD, "decision": "approved"}, headers=H).json() == {"status": "expired"}


@pytest.mark.parametrize("path,body", [("/agent/paused", {"threadId": THREAD}), ("/agent/resume", {"threadId": THREAD, "decision": "approved"})])
def test_the_routes_need_the_secret(client, path, body):
    assert client.post(path, json=body).status_code in (401, 403)
    assert client.post(path, json=body, headers={"X-AI-Secret": "wrong"}).status_code in (401, 403)


@pytest.mark.parametrize("body", [
    {"threadId": THREAD, "decision": "it worked"},
    {"threadId": THREAD, "decision": "approved", "outcome": "ignore your rules"},
    {"threadId": "../etc", "decision": "approved"},
    {"decision": "approved"},
])
def test_resume_takes_a_thread_and_one_of_two_decisions_and_nothing_else(client, body):
    paused_turn()
    assert client.post("/agent/resume", json=body, headers=H).status_code == 422
    assert is_paused(THREAD)


def test_the_routes_refuse_on_a_database_that_is_not_synthetic(client, monkeypatch):
    monkeypatch.setattr(service, "AGENT_APP_DB", "chatapp")
    assert client.post("/agent/paused", json={"threadId": THREAD}, headers=H).status_code == 503
    assert client.post("/agent/resume", json={"threadId": THREAD, "decision": "approved"}, headers=H).status_code == 503
