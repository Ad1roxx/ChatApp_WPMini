"""S6 Step 1: structured logs carry metadata only, one line per model call and per tool call.

No provider is called and no network is used. Unique strings are planted in everything a person or a
record could put in front of the model, and none may appear in a log.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

import agent
import answer as answer_module
import log_summary
import obslog
from agent import Turn, run_turn
from providers import Generation, ScriptedProvider, log_call

PLANTS = {
    "question": "PLANTQUESTION7f3a",
    "answer": "PLANTANSWER91bc",
    "source": "PLANTSOURCE55de",
    "record": "PLANTRECORD20aa",
    "mentor": "PLANTMENTORNAME",
    "student": "PLANTSTUDENTNAME",
    "email": "plant.person@example.test",
    "token": "PLANTTOKENd00d.payload.signature",
    "key": "PLANTKEYAIzaSy0000000000000000000000",
    # Shaped like an entry in the private-terms file, which never leaves this machine and so can't be read here.
    "private": "PlantPrivateTermZx9",
}
MID, VIEWER = "0000000000000000000000b1", "0000000000000000000000a1"
RECORD_ID = "0000000000000000000000c7"


@pytest.fixture
def logs(tmp_path):
    path = obslog.configure(tmp_path, max_bytes=10_000_000, keep=2)
    yield tmp_path
    obslog.configure(None)


def read(folder: Path) -> list[dict]:
    return [json.loads(l) for p in sorted(folder.glob("copilot.jsonl*")) for l in p.read_text(encoding="utf-8").splitlines()]


def raw(folder: Path) -> str:
    return "".join(p.read_text(encoding="utf-8") for p in folder.glob("copilot.jsonl*"))


class Express:
    def __call__(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"records": [{"kind": "goal", "id": RECORD_ID, "title": PLANTS["record"],
                                                      "description": PLANTS["email"], "milestones": []}]})

    def client(self):
        return httpx.Client(base_url="http://127.0.0.1:3001", headers={"X-AI-Secret": PLANTS["key"]}, transport=httpx.MockTransport(self))


class Store:
    def search(self, *a, **k):
        return [{"mentorshipId": MID, "sourceType": "resource", "sourceId": RECORD_ID, "title": PLANTS["source"],
                 "content": f"{PLANTS['source']} {PLANTS['email']}", "chunkIndex": 0, "url": None, "score": 0.9}]


def agent_turn(*replies, role="student"):
    model = ScriptedProvider(*replies)
    t = Turn(mentorship_id=MID, viewer_id=VIEWER, role=role, question=f"{PLANTS['question']} {PLANTS['email']}", token=PLANTS["token"],
             provider=model, store=Store(), express=Express().client(), prompt_version="agent-v4",
             parties={"mentor": f'{PLANTS["mentor"]} {PLANTS["private"]}', "student": PLANTS["student"]})
    with obslog.turn("/agent"):
        result = run_turn(t)
    return result, model


# ---------------------------------------------------------------------------
# One line per call
# ---------------------------------------------------------------------------
def test_every_model_call_and_every_tool_call_is_one_line(logs):
    result, model = agent_turn([("list_goals", {})], [("search_mentorship_material", {"query": "x"})], f"{PLANTS['answer']} [T1].")
    lines = read(logs)
    assert len([l for l in lines if l["kind"] == "model_call"]) == len(model.calls) == 3
    assert [l["tool"] for l in lines if l["kind"] == "tool_call"] == ["list_goals", "search_mentorship_material"]
    assert len(lines) == 5


def test_a_tool_call_that_is_not_run_is_still_one_line(logs):
    agent_turn([("no_such_tool", {}), ("list_goals", {})], "NO_ANSWER")
    tools = [l for l in read(logs) if l["kind"] == "tool_call"]
    assert [(l["tool"], l["status"]) for l in tools] == [("-", "not_offered"), ("-", "one_at_a_time")]
    assert all(l["refusal_reason"] == l["status"] for l in tools)


def test_the_answer_route_writes_one_line_per_call(logs):
    with obslog.turn("/ask"):
        answer_module.answer(Store(), MID, VIEWER, PLANTS["question"], ScriptedProvider(f"{PLANTS['answer']} [1]."),
                             role="student", parties={"mentor": PLANTS["mentor"], "student": PLANTS["student"]})
    lines = read(logs)
    assert [(l["kind"], l["route"]) for l in lines] == [("model_call", "/ask")]


def test_a_file_summary_logs_each_of_its_model_calls(logs, monkeypatch):
    # summarize_attachment's own calls go through the provider too: each is one line.
    g = Generation("ok", "fake", "scripted", text="x", input_tokens=3, output_tokens=1, attempts=1)
    for _ in range(3):
        log_call(g, prompt_version="summary-v1")
    assert len(read(logs)) == 3


# ---------------------------------------------------------------------------
# No user content, no names, no ids, no keys
# ---------------------------------------------------------------------------
def test_no_line_holds_the_question_the_answer_a_source_a_name_an_id_or_a_key(logs):
    agent_turn([("list_goals", {})], [("search_mentorship_material", {"query": PLANTS["question"]})], f"{PLANTS['answer']} [T1][1].")
    with obslog.turn("/ask"):
        answer_module.answer(Store(), MID, VIEWER, PLANTS["question"], ScriptedProvider(f"{PLANTS['answer']} [1]."),
                             role="student", parties={"mentor": PLANTS["mentor"], "student": PLANTS["student"]})
    text = raw(logs)
    assert text, "there is something to look at"
    for name, value in PLANTS.items():
        assert value not in text, name
    for value in (MID, VIEWER, RECORD_ID, "@"):
        assert value not in text


def test_a_providers_error_detail_never_reaches_a_line(logs):
    g = Generation("failed", "gemini", "gemini-3.5-flash-lite", detail=f"HTTP 400: key {PLANTS['key']} rejected for {PLANTS['email']}")
    log_call(g, prompt_version="agent-v4")
    text = raw(logs)
    assert PLANTS["key"] not in text and PLANTS["email"] not in text and "rejected" not in text


@pytest.mark.parametrize("value", ["a sentence with spaces", "someone@example.test", "x" * 81, "line\nbreak", "{\"json\": 1}", ""])
def test_anything_that_is_not_a_name_is_written_as_invalid(logs, value):
    g = Generation(value, value, value, attempts=1)
    line = obslog.model_call(g, prompt_version=value)
    assert {line["provider"], line["model"], line["prompt_version"], line["outcome"]} == {"invalid"}
    assert value not in raw(logs) or value == ""


def test_a_line_has_exactly_these_fields(logs):
    agent_turn([("list_goals", {})], "NO_ANSWER")
    kinds = {l["kind"]: set(l) for l in read(logs)}
    base = {"ts", "kind", "turn", "route"}
    assert kinds["model_call"] == base | {"provider", "model", "prompt_version", "prompt_hash", "tokens_in", "tokens_out", "latency_ms", "outcome", "attempts"}
    assert kinds["tool_call"] == base | {"tool", "status", "latency_ms", "refusal_reason"}


def test_numbers_are_numbers(logs):
    g = Generation("ok", "fake", "m", input_tokens="12 tokens about PLANT", output_tokens=-3, latency_ms=12.6, attempts=True)
    line = obslog.model_call(g, prompt_version="agent-v4")
    assert (line["tokens_in"], line["tokens_out"], line["latency_ms"], line["attempts"]) == (None, None, 13, None)


def test_a_tool_name_this_code_does_not_define_is_invalid(logs):
    assert obslog.tool_call(tool="list_goals", status=200)["tool"] == "list_goals"
    for made_up in ("PlantPrivateTermZx9", "sk-abc123", "Meera_Iyer"):
        assert obslog.tool_call(tool=made_up, status=200)["tool"] == "invalid"
    assert "PlantPrivateTermZx9" not in raw(logs)


def test_a_tool_calls_latency_is_a_number(logs):
    assert obslog.tool_call(tool="list_goals", status=200, latency_ms=41.6)["latency_ms"] == 42
    assert obslog.tool_call(tool="list_goals", status=200, latency_ms="slow PLANT")["latency_ms"] is None


def test_the_timestamp_is_utc_iso_8601(logs):
    from datetime import datetime
    line = obslog.tool_call(tool="list_goals", status=200)
    assert datetime.fromisoformat(line["ts"]).utcoffset().total_seconds() == 0


def test_an_unknown_prompt_version_has_no_hash(logs):
    assert obslog.model_call(Generation("ok", "f", "m"), prompt_version="never-registered")["prompt_hash"] is None


# ---------------------------------------------------------------------------
# Turn, route and prompt hash
# ---------------------------------------------------------------------------
def test_lines_carry_the_route_and_a_random_turn_id(logs):
    agent_turn("NO_ANSWER")
    agent_turn("NO_ANSWER")
    lines = read(logs)
    assert [l["route"] for l in lines] == ["/agent", "/agent"]
    assert lines[0]["turn"] != lines[1]["turn"] and len(lines[0]["turn"]) == 16


def test_an_unknown_route_and_no_turn_are_written_as_a_dash(logs):
    with obslog.turn("/something-else"):
        log_call(Generation("ok", "fake", "m", attempts=1), prompt_version="agent-v4")
    log_call(Generation("ok", "fake", "m", attempts=1), prompt_version="agent-v4")
    assert [(l["route"], l["turn"] != "-") for l in read(logs)] == [("-", True), ("-", False)]


def test_the_prompt_hash_is_of_the_template_and_tells_versions_apart(logs):
    v3 = obslog.model_call(Generation("ok", "f", "m"), prompt_version="agent-v3")["prompt_hash"]
    v4 = obslog.model_call(Generation("ok", "f", "m"), prompt_version="agent-v4")["prompt_hash"]
    s2 = obslog.model_call(Generation("ok", "f", "m"), prompt_version="s2-v4")["prompt_hash"]
    assert v4 == obslog.prompt_hash(agent.PROMPTS["agent-v4"])
    assert s2 == obslog.prompt_hash(answer_module.PROMPTS["s2-v4"])
    assert len({v3, v4, s2}) == 3


# ---------------------------------------------------------------------------
# Where, and rotation
# ---------------------------------------------------------------------------
def test_rotation_keeps_the_newest_and_drops_the_oldest(tmp_path):
    obslog.configure(tmp_path, max_bytes=2_000, keep=2)
    try:
        for i in range(200):
            log_call(Generation("ok", "fake", f"m{i}", attempts=1), prompt_version="agent-v4")
        files = sorted(p.name for p in tmp_path.glob("copilot.jsonl*"))
        assert files == ["copilot.jsonl", "copilot.jsonl.1", "copilot.jsonl.2"]
        assert all(p.stat().st_size <= 2_400 for p in tmp_path.glob("copilot.jsonl*"))
        newest = [json.loads(l)["model"] for l in (tmp_path / "copilot.jsonl").read_text().splitlines()]
        assert newest[-1] == "m199" and "m0" not in {json.loads(l)["model"] for f in tmp_path.glob("copilot.jsonl*") for l in f.read_text().splitlines()}
    finally:
        obslog.configure(None)


def test_a_log_file_that_links_somewhere_is_refused(tmp_path):
    target = tmp_path / "elsewhere.txt"
    target.write_text("")
    try:
        (tmp_path / "copilot.jsonl").symlink_to(target)
    except OSError:
        pytest.skip("this machine does not allow symlinks")
    assert obslog.configure(tmp_path) is None


def test_a_folder_inside_the_repository_is_refused(tmp_path):
    inside = obslog.REPO_ROOT / "ai" / "logs-test-never-created"
    try:
        assert obslog.configure(inside) is None
        assert not inside.exists()
    finally:
        if inside.exists():  # only if the refusal failed: leave nothing behind in the repository
            import shutil
            shutil.rmtree(inside)
    assert obslog.log_directory({"AI_LOG_DIR": str(inside)}) is None
    assert obslog.log_directory({"AI_LOG_DIR": str(obslog.REPO_ROOT)}) is None


def test_the_default_folder_is_beside_the_secrets_file(tmp_path):
    assert obslog.log_directory({"AI_ENV_FILE": str(tmp_path / "ai.env")}) == (tmp_path / "logs").resolve()
    assert obslog.log_directory({}) is None


def test_with_no_folder_nothing_is_written_and_nothing_breaks(tmp_path):
    obslog.configure(None)
    line = log_call(Generation("ok", "fake", "m", attempts=1), prompt_version="agent-v4")
    assert "llm provider=fake" in line
    assert not list(tmp_path.iterdir())


# ---------------------------------------------------------------------------
# The summary
# ---------------------------------------------------------------------------
def test_the_summary_figures_are_right(tmp_path):
    lines = [
        {"kind": "model_call", "turn": "a", "route": "/agent", "provider": "gemini", "model": "m", "prompt_version": "agent-v4", "tokens_in": 100, "tokens_out": 10, "latency_ms": 100, "outcome": "ok"},
        {"kind": "model_call", "turn": "a", "route": "/agent", "provider": "gemini", "model": "m", "prompt_version": "agent-v4", "tokens_in": 200, "tokens_out": 20, "latency_ms": 300, "outcome": "ok"},
        {"kind": "model_call", "turn": "b", "route": "/ask", "provider": "gemini", "model": "m", "prompt_version": "s2-v4", "tokens_in": 50, "tokens_out": None, "latency_ms": 200, "outcome": "rate_limited"},
        {"kind": "tool_call", "turn": "a", "route": "/agent", "tool": "list_goals", "status": "200", "refusal_reason": None},
        {"kind": "tool_call", "turn": "a", "route": "/agent", "tool": "-", "status": "not_offered", "refusal_reason": "not_offered"},
    ]
    (tmp_path / "copilot.jsonl").write_text("\n".join(json.dumps(l) for l in lines[:3]) + "\nnot json\n", encoding="utf-8")
    (tmp_path / "copilot.jsonl.1").write_text("\n".join(json.dumps(l) for l in lines[3:]) + "\n", encoding="utf-8")
    s = log_summary.summarise(log_summary.lines_in(tmp_path))
    assert s["lines"] == 6 and s["unreadable"] == 1 and s["turns"] == 2
    assert s["model_calls"] == 3 and s["tool_calls"] == 2
    assert s["model_calls_by"] == {"/agent gemini/m agent-v4": 2, "/ask gemini/m s2-v4": 1}
    assert s["outcomes"] == {"ok": 2, "rate_limited": 1}
    assert (s["tokens_in"], s["tokens_out"]) == (350, 30)
    assert (s["latency_ms_median"], s["latency_ms_p95"]) == (200, 300)
    assert s["tool_calls_by"] == {"list_goals": 1, "-": 1} and s["refusals"] == {"not_offered": 1}
