"""S6 Step 5: s2-v5 and agent-v5 add one rule each, and change nothing else. Neither serves until its rule says so."""

import agent
import answer
import obslog
from agent import tools_for


def test_neither_serves_yet():
    assert answer.PROMPT_VERSION == "s2-v4" and agent.PROMPT_VERSION == "agent-v4"


def test_s2_v5_is_s2_v4_with_one_more_rule():
    v4, v5 = answer.PROMPTS["s2-v4"], answer.PROMPTS["s2-v5"]
    assert v5.startswith(v4.split("\n8. Be brief:")[0])
    assert "\n8. Work out each thing the question asks." in v5 and "\n9. Be brief:" in v5
    assert v5.replace(v5.split("\n8. ")[1].split("\n9. ")[0], "").replace("\n8. \n9. ", "\n8. ") == v4


def test_agent_v5_is_agent_v4_with_one_more_rule():
    v4, v5 = agent.PROMPTS["agent-v4"], agent.PROMPTS["agent-v5"]
    assert v5.startswith(v4) and v5[len(v4):].startswith("\n19. Work out each thing the question asks.")
    assert "results" in v5[len(v4):] and "sources" not in v5[len(v4):]


def test_v5_keeps_everything_v4_had():
    assert "s2-v5" in answer.NAMES_PARTIES and "s2-v5" in answer.DECLINE_DENIAL_ONLY
    for group in (agent.WITH_PARTIES, agent.WITH_ASKER, agent.WITH_WRITES):
        assert "agent-v5" in group
    for role in ("student", "mentor"):
        assert [t.name for t in tools_for(role, "agent-v5")] == [t.name for t in tools_for(role, "agent-v4")]


def test_the_rule_says_nothing_extra_when_everything_is_answered():
    assert "When the sources answer every part, say nothing about what they do not cover." in answer.PROMPTS["s2-v5"]


def test_both_are_in_the_structured_log():
    for template in (answer.PROMPTS["s2-v5"], agent.PROMPTS["agent-v5"]):
        assert obslog.prompt_hash(template) in obslog._prompts.values()
