"""S5 Step 5, layer (a) of the role matrix: what the model is OFFERED (AGENT_PLAN §4.3).

This is the filtering half of §4.3.8. It is pure: no network, no database. The execution half, which
assumes this filter has failed and checks that Express still refuses, is server/test/agent-role-matrix.test.js.
"""

from __future__ import annotations

import httpx
import pytest
from langgraph.checkpoint.memory import InMemorySaver

import agent
from agent import NOT_RUN_UNKNOWN, Turn, run_turn, tools_for
from providers import ScriptedProvider

V4 = "agent-v4"
TOKEN = "header.payload.signature-of-this-turn"
MID = "0000000000000000000000b1"
THREAD = "a" * 32

ROLES = ["student", "mentor", "admin", "", "owner"]
# tool -> the roles it is offered to. Everything else is not.
OFFERED_TO = {
    "create_assignment": {"mentor"},
    "extend_assignment_deadline": {"mentor"},
    "set_goal": {"mentor"},
    "toggle_milestone": {"student", "mentor"},
    "propose_session": {"student", "mentor"},
    "confirm_session": {"student", "mentor"},
    "add_resource": {"student", "mentor"},
}
MENTOR_ONLY = ["create_assignment", "extend_assignment_deadline", "set_goal"]

FORBIDDEN = [
    "submit_assignment", "submit_hand_in", "edit_submission", "accept_submission", "request_changes", "review_submission",
    "delete_resource", "delete_assignment", "withdraw_assignment", "unsubmit", "request_optout", "answer_optout",
    "post_announcement", "create_announcement", "create_group", "add_student", "set_role", "change_role", "suspend_user",
    "list_users", "get_stats", "list_reports", "verify_user",
]
FORBIDDEN_PARTS = ["admin", "role", "suspend", "announce", "group", "delete", "withdraw", "optout", "opt_out"]


@pytest.fixture(autouse=True)
def clean_saver(monkeypatch):
    monkeypatch.setattr(agent, "SAVER", InMemorySaver())
    monkeypatch.setattr(agent, "_paused", {})


@pytest.mark.parametrize("role", ROLES)
@pytest.mark.parametrize("tool", list(OFFERED_TO))
def test_a_write_tool_is_offered_to_exactly_the_roles_the_plan_says(tool, role):
    offered = {t.name for t in tools_for(role, V4)}
    assert (tool in offered) is (role in OFFERED_TO[tool])


@pytest.mark.parametrize("role", ["admin", "", "owner"])
def test_a_role_that_is_not_a_party_is_offered_nothing_at_all(role):
    assert tools_for(role, V4) == ()


@pytest.mark.parametrize("role", ["student", "mentor"])
def test_no_forbidden_tool_is_offered(role):
    names = {t.name for t in tools_for(role, V4)}
    assert not names & set(FORBIDDEN)


@pytest.mark.parametrize("role", ["student", "mentor"])
def test_no_offered_tool_is_named_like_an_admin_or_destructive_one(role):
    for t in tools_for(role, V4):
        for part in FORBIDDEN_PARTS:
            assert part not in t.name, (t.name, part)


def _turn(*replies, role):
    model = ScriptedProvider(*replies)

    class Store:
        def search(self, *a, **k):
            return []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"records": []})

    express = httpx.Client(base_url="http://127.0.0.1:3001", headers={"X-AI-Secret": "s"}, transport=httpx.MockTransport(handler))
    return Turn(mentorship_id=MID, viewer_id="a" * 24, role=role, question="Please do it", token=TOKEN, provider=model, store=Store(),
                express=express, prompt_version=V4, thread_id=THREAD), model


@pytest.mark.parametrize("name,args", [
    ("create_assignment", {"title": "Essay", "instructions": "", "due_at": "2027-01-05T23:59"}),
    ("extend_assignment_deadline", {"assignment": "T1", "new_due_at": "2027-01-05T23:59"}),
    ("set_goal", {"title": "Ready", "description": "", "milestones": ["One"]}),
])
def test_a_student_naming_a_mentor_only_tool_gets_not_run_and_no_proposal(name, args):
    t, model = _turn([(name, args)], "NO_ANSWER", role="student")
    result = run_turn(t)
    assert result["status"] != "proposal"
    tool_reply = [m for m in model.calls[1][1] if m["role"] == "tool"][-1]["content"]
    assert tool_reply == NOT_RUN_UNKNOWN


def test_the_tools_a_student_is_shown_leave_out_the_mentor_only_ones():
    t, model = _turn("NO_ANSWER", role="student")
    run_turn(t)
    shown = set(model.calls[0][2])
    assert shown
    assert not shown & set(MENTOR_ONLY)
    # The same turn as a mentor does show them, so the assertion above can fail.
    t2, model2 = _turn("NO_ANSWER", role="mentor")
    run_turn(t2)
    assert set(MENTOR_ONLY) <= set(model2.calls[0][2])
