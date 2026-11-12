"""S8 needs no capability token because nothing in a check calls Express back (BUILD_NOTES Entry 133).

These tests make that stay true. If any fails, a callback has been added, and
the check then needs a capability token (lib/agentToken.js) like the agent's
tools: the scope is no longer fixed by Express up front.

- Static: coverage.py and criteria.py import no HTTP client and name no
  Express route; the S8 route functions in app.py make no request.
- Runtime: a whole check through the /coverage/assess handler, with every
  httpx request made to fail, and a model that may not use tools.
"""

from __future__ import annotations

import ast
import inspect
import json
from pathlib import Path

import httpx
import pytest

import app as service
import coverage
import criteria
from providers import ScriptedProvider

HERE = Path(__file__).resolve().parents[1]
HTTP_CLIENTS = {"httpx", "requests", "urllib", "urllib3", "aiohttp", "http", "socket", "websockets", "grpc"}
EXPRESS_HINTS = ("internal/", "/api/", "EXPRESS", "AGENT_TOKEN", "x-ai-secret", "Authorization")


def imported(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module.split(".")[0])
    return names


@pytest.mark.parametrize("module", ["coverage.py", "criteria.py"])
def test_the_s8_modules_import_no_http_client_and_name_no_express_route(module):
    path = HERE / module
    assert not imported(path) & HTTP_CLIENTS, f"{module} imports an HTTP client: a callback needs a capability token"
    text = path.read_text(encoding="utf-8")
    assert not [h for h in EXPRESS_HINTS if h in text], f"{module} names an Express route or credential"


@pytest.mark.parametrize("fn", ["assess_submission", "submission_files", "extract_criteria"])
def test_the_s8_route_functions_make_no_request(fn):
    source = inspect.getsource(getattr(service, fn))
    for word in ("httpx", "requests", "urlopen", "fetch(", "express", "internal/", "token"):
        assert word not in source.lower(), (fn, word)


class NoTools(ScriptedProvider):
    """A model with no tools: `converse` (the agent's tool-calling step) is refused."""

    def converse(self, *a, **kw):
        raise AssertionError("S8 offered the model tools")


class Store:
    db = type("DB", (), {"name": "chatapp_demo"})()

    def file_chunks(self, mentorship_id, viewer_id, file_id):
        return [{"chunkIndex": 0, "content": "My rule clears one user's list.", "parentType": "submission", "parentId": "5" * 24}]


def test_a_whole_check_makes_no_network_request_and_offers_the_model_no_tools(monkeypatch):
    def refuse(*a, **kw):
        raise AssertionError("a check made an HTTP request: it now needs a capability token")

    monkeypatch.setattr(httpx.Client, "send", refuse)
    monkeypatch.setattr(httpx.AsyncClient, "send", refuse)
    monkeypatch.setattr(service, "store", Store())
    monkeypatch.setattr(service, "AGENT_APP_DB", "chatapp_demo")
    model = NoTools(json.dumps({"evidence": [{"criterion_id": "k1", "passage": "P2", "quote": "My rule clears one user's list."}]}),
                    json.dumps({"verdicts": [{"criterion_id": "k1", "verdict": "met", "evidence": ["E1"]}]}), name="gemini")
    monkeypatch.setattr(service, "coverage_llm", model)
    body = service.AssessRequest(mentorshipId="d" * 24, viewerId="b" * 24, submissionId="5" * 24, text="See my file.",
                                 files=[{"fileId": "f" * 24, "name": "mine.pdf"}],
                                 criteria=[{"id": "k1", "text": "States the rule", "marks": None}])
    res = service.assess_submission(body)
    assert res.status_code == 200
    assert json.loads(res.body)["verdicts"][0]["label"] == "Met"
    assert len(model.calls) == 2, "two model calls, no tool step"


def test_the_s8_code_uses_only_plain_generation():
    for module in (coverage, criteria):
        source = inspect.getsource(module)
        assert ".converse(" not in source and "tools" not in source.lower(), module.__name__
