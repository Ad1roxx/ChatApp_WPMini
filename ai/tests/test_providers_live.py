"""One real call to the configured provider. Opt-in, because it spends quota.

    AI_LIVE_SMOKE=1 .venv/Scripts/python.exe -m pytest tests/test_providers_live.py

Skipped unless AI_LIVE_SMOKE=1. It draws on the same daily quota as the
service and every evaluation run (AGENT_PLAN 2.6), so it is exactly one call,
with a synthetic one-line prompt and nothing from any mentorship in it. To
check the fallback, run it once more with AI_LLM_PROVIDER=groq.
"""

import os

import pytest

import providers

pytestmark = pytest.mark.skipif(
    os.getenv("AI_LIVE_SMOKE") != "1", reason="live provider call: set AI_LIVE_SMOKE=1 to spend one request"
)


def test_one_live_call_answers():
    provider = providers.build_provider(os.getenv("AI_LLM_PROVIDER", providers.LLM_PROVIDER))
    result = provider.generate("Answer in one word.", "Reply with the single word OK.", budget_s=60)
    providers.log_call(result, prompt_version="smoke")

    assert result.ok, f"{result.provider} {result.model}: {result.outcome} {result.detail}"
    assert "ok" in result.text.lower()
    assert result.input_tokens and result.output_tokens
