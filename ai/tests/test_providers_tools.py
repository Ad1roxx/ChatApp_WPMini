"""Tool calling in the two adapters (`converse`), with no network.

The same `httpx.MockTransport` server as test_providers.py: real response
shapes in, every request kept. What is checked is what each provider is sent
and how its reply is read, plus that `converse` keeps `generate`'s rules for
retries, budgets and outcomes, because it is the same loop.
"""

from __future__ import annotations

import json

import httpx

from providers import FAILED, OK, RATE_LIMITED, TRUNCATED, CallBudget, GeminiProvider, GroqProvider
from test_providers import KEY, Clock, Server, gemini, gemini_429, groq, groq_headers

SYSTEM = "You are the Copilot."
TOOLS = [
    {"name": "list_goals", "description": "Goals.", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "search_mentorship_material", "description": "Search.",
     "parameters": {"type": "object", "properties": {"query": {"type": "string", "maxLength": 300}},
                    "required": ["query"], "additionalProperties": False}},
]
QUESTION = [{"role": "user", "text": "Which milestones are still to do?"}]


def body(server: Server, i: int = 0) -> dict:
    return json.loads(server.requests[i].content)


# ------------------------------------------------------------------ Gemini
def gemini_call(name="list_goals", args=None, signature="sig-abc") -> httpx.Response:
    part = {"functionCall": {"name": name, "args": args or {}}, "thoughtSignature": signature}
    return httpx.Response(200, json={
        "candidates": [{"content": {"role": "model", "parts": [part]}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 700, "candidatesTokenCount": 20},
    })


def gemini_text(text="Two remain [T1].") -> httpx.Response:
    return httpx.Response(200, json={
        "candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 800, "candidatesTokenCount": 30},
    })


def test_gemini_is_sent_the_tools_without_additional_properties():
    server, clock = Server(gemini_call()), Clock()
    gemini(server, clock).converse(SYSTEM, QUESTION, TOOLS)
    sent = body(server)
    declarations = sent["tools"][0]["functionDeclarations"]
    assert [d["name"] for d in declarations] == ["list_goals", "search_mentorship_material"]
    assert "additionalProperties" not in json.dumps(declarations)
    assert declarations[1]["parameters"]["required"] == ["query"]
    assert sent["toolConfig"] == {"functionCallingConfig": {"mode": "AUTO"}}
    assert sent["systemInstruction"]["parts"][0]["text"] == SYSTEM
    assert KEY not in str(server.requests[0].url)


def test_gemini_reads_a_tool_call_and_keeps_the_raw_parts_for_replay():
    server, clock = Server(gemini_call("search_mentorship_material", {"query": "rate limiter"})), Clock()
    g = gemini(server, clock).converse(SYSTEM, QUESTION, TOOLS)
    assert g.outcome == OK and g.text == ""
    assert g.calls == (("g0", "search_mentorship_material", {"query": "rate limiter"}),)
    assert g.raw[0]["thoughtSignature"] == "sig-abc"
    assert g.input_tokens == 700


def test_gemini_replays_the_model_turn_and_sends_the_result_as_a_function_response():
    server, clock = Server(gemini_call(), gemini_text()), Clock()
    provider = gemini(server, clock)
    first = provider.converse(SYSTEM, QUESTION, TOOLS)
    messages = QUESTION + [
        {"role": "model", "text": first.text, "calls": first.calls, "raw": first.raw},
        {"role": "tool", "call_id": "g0", "name": "list_goals", "content": "<<<RESULT T1 tag>>>goal<<<END RESULT T1 tag>>>"},
    ]
    second = provider.converse(SYSTEM, messages, TOOLS)
    contents = body(server, 1)["contents"]
    assert contents[1] == {"role": "model", "parts": first.raw}, "thought signature sent back as received"
    assert contents[2]["parts"][0]["functionResponse"]["name"] == "list_goals"
    assert second.text == "Two remain [T1]." and second.calls == ()


def test_gemini_answers_to_two_calls_go_in_one_turn():
    server, clock = Server(gemini_text()), Clock()
    messages = QUESTION + [
        {"role": "model", "text": "", "calls": (), "raw": [{"functionCall": {"name": "a"}}, {"functionCall": {"name": "b"}}]},
        {"role": "tool", "call_id": "g0", "name": "a", "content": "x"},
        {"role": "tool", "call_id": "g1", "name": "b", "content": "Not run"},
    ]
    gemini(server, clock).converse(SYSTEM, messages, TOOLS)
    contents = body(server)["contents"]
    assert len(contents) == 3 and len(contents[2]["parts"]) == 2


def test_gemini_with_no_tools_offered_sends_none():
    server, clock = Server(gemini_text()), Clock()
    gemini(server, clock).converse(SYSTEM, QUESTION, [])
    assert "tools" not in body(server) and "toolConfig" not in body(server)


def test_gemini_converse_is_counted_and_retried_like_generate(tmp_path):
    path = str(tmp_path / "usage.json")
    server, clock = Server(gemini_429("2s"), gemini_call()), Clock()
    g = gemini(server, clock, path=path).converse(SYSTEM, QUESTION, TOOLS, budget_s=20)
    assert g.outcome == OK and g.attempts == 2
    assert CallBudget(15, 500, path, clock=clock).used() == (2, 2)


def test_gemini_converse_cut_at_the_cap_is_truncated_not_a_call():
    server, clock = Server(httpx.Response(200, json={
        "candidates": [{"content": {"parts": [{"text": "partial"}]}, "finishReason": "MAX_TOKENS"}]})), Clock()
    assert gemini(server, clock).converse(SYSTEM, QUESTION, TOOLS).outcome == TRUNCATED


# ------------------------------------------------------------------ Groq
def groq_call(name="list_goals", arguments="{}", call_id="call_1", headers=None) -> httpx.Response:
    return httpx.Response(200, headers=headers or {}, json={
        "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
            "role": "assistant", "content": None, "reasoning": "private thoughts",
            "tool_calls": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}]}}],
        "usage": {"prompt_tokens": 668, "completion_tokens": 27},
    })


def test_groq_is_sent_one_tool_at_a_time():
    server, clock = Server(groq_call()), Clock()
    groq(server, clock).converse(SYSTEM, QUESTION, TOOLS)
    sent = body(server)
    assert sent["parallel_tool_calls"] is False and sent["tool_choice"] == "auto"
    assert [t["function"]["name"] for t in sent["tools"]] == ["list_goals", "search_mentorship_material"]
    assert sent["messages"][0] == {"role": "system", "content": SYSTEM}


def test_groq_reads_a_tool_call_and_replays_only_what_it_accepts_back():
    server, clock = Server(groq_call("search_mentorship_material", '{"query": "rate limiter"}')), Clock()
    g = groq(server, clock).converse(SYSTEM, QUESTION, TOOLS)
    assert g.outcome == OK
    assert g.calls == (("call_1", "search_mentorship_material", {"query": "rate limiter"}),)
    assert "reasoning" not in g.raw and g.raw["tool_calls"][0]["id"] == "call_1"


def test_groq_arguments_that_are_not_json_are_none_for_the_agent_to_refuse():
    server, clock = Server(groq_call(arguments="{not json")), Clock()
    g = groq(server, clock).converse(SYSTEM, QUESTION, TOOLS)
    assert g.outcome == OK and g.calls == (("call_1", "list_goals", None),)


def test_groq_sends_the_result_as_a_tool_message():
    server, clock = Server(groq_call(), httpx.Response(200, json={
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "Two remain [T1]."}}],
        "usage": {"prompt_tokens": 767, "completion_tokens": 64}})), Clock()
    provider = groq(server, clock)
    first = provider.converse(SYSTEM, QUESTION, TOOLS)
    messages = QUESTION + [{"role": "model", "text": "", "calls": first.calls, "raw": first.raw},
                           {"role": "tool", "call_id": "call_1", "name": "list_goals", "content": "result"}]
    second = provider.converse(SYSTEM, messages, TOOLS)
    sent = body(server, 1)["messages"]
    assert sent[2] == first.raw and sent[3] == {"role": "tool", "tool_call_id": "call_1", "content": "result"}
    assert second.text == "Two remain [T1]."


def test_groq_converse_waits_for_its_token_bucket_like_generate():
    # The first reply says almost no tokens are left; the next call cannot fit.
    server, clock = Server(groq_call(headers=groq_headers(300, reset_tokens="40s"))), Clock()
    provider = groq(server, clock)
    provider.converse(SYSTEM, QUESTION, TOOLS)
    g = provider.converse(SYSTEM, QUESTION, TOOLS, budget_s=8)
    assert g.outcome == RATE_LIMITED and g.detail == "budget"
    assert len(server.requests) == 1, "refused before sending"


def test_an_empty_reply_is_a_failure_not_an_answer():
    server, clock = Server(httpx.Response(200, json={
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": ""}}]})), Clock()
    assert groq(server, clock).converse(SYSTEM, QUESTION, TOOLS).outcome == FAILED


def test_calls_and_raw_are_kept_out_of_a_generations_repr():
    server, clock = Server(groq_call("search_mentorship_material", '{"query": "my secret question"}')), Clock()
    g = groq(server, clock).converse(SYSTEM, QUESTION, TOOLS)
    assert "my secret question" not in repr(g)
