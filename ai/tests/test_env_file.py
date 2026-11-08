"""Secrets come from a file outside the repository, named by AI_ENV_FILE (BUILD_NOTES Entry 102).

Every value here is invented, in a temporary file. The real file is never read:
each subprocess is given its own AI_ENV_FILE.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest

import app as service
import config

AI_DIR = Path(__file__).resolve().parent.parent
SECRETS = ("GEMINI_API_KEY", "GROQ_API_KEY", "AI_SERVICE_SECRET")


def run_config(tmp_path, env_file, code="import config; print(config.GEMINI_API_KEY)"):
    """Import the real config in a process of its own, as the service would."""
    env = {k: v for k, v in os.environ.items() if k not in SECRETS and k != config.ENV_FILE_VAR}
    if env_file is not None:
        env[config.ENV_FILE_VAR] = str(env_file)
    return subprocess.run([sys.executable, "-c", code], cwd=AI_DIR, env=env, capture_output=True, text=True)


def test_the_keys_come_from_the_named_file(tmp_path):
    secrets = tmp_path / "ai.env"
    secrets.write_text("GEMINI_API_KEY=invented-value-from-the-file\n", encoding="utf-8")
    result = run_config(tmp_path, secrets)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "invented-value-from-the-file"


def test_a_named_file_that_is_not_there_stops_with_a_clear_sentence(tmp_path):
    result = run_config(tmp_path, tmp_path / "nowhere.env")
    assert result.returncode != 0
    assert "AI_ENV_FILE is set to" in result.stderr and "no file there" in result.stderr
    assert "Traceback" not in result.stderr


def test_the_environment_wins_over_the_file(tmp_path, monkeypatch):
    secrets = tmp_path / "ai.env"
    secrets.write_text("ZZ_ENV_FILE_TEST=from-the-file\n", encoding="utf-8")
    monkeypatch.setenv("ZZ_ENV_FILE_TEST", "from-the-environment")
    assert config.load_env_file({config.ENV_FILE_VAR: str(secrets)}) == secrets
    assert os.environ["ZZ_ENV_FILE_TEST"] == "from-the-environment"


def test_unset_is_none_when_importing(tmp_path):
    assert config.load_env_file({}) is None
    assert config.load_env_file({config.ENV_FILE_VAR: "   "}) is None
    result = run_config(tmp_path, None, "import config; print(config.ENV_FILE)")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "None"


def test_the_service_will_not_start_without_it(monkeypatch):
    monkeypatch.setattr(service.config, "ENV_FILE", None)
    touched = []
    monkeypatch.setattr(service.store, "ensure_vector_index", lambda: touched.append(1), raising=False)

    async def start():
        async with service.lifespan(service.app):
            pass

    with pytest.raises(RuntimeError, match="AI_ENV_FILE is not set"):
        asyncio.run(start())
    assert touched == [], "the service did something before refusing"


def test_the_refusal_says_what_to_do():
    with pytest.raises(RuntimeError) as caught:
        config.require_env_file(None)
    for word in ("AI_ENV_FILE", "GEMINI_API_KEY", "GROQ_API_KEY", "AI_SERVICE_SECRET", ".env.example"):
        assert word in str(caught.value)
    config.require_env_file(Path("anything"))  # a path is fine


def test_the_example_holds_no_secret_assignment():
    example = (AI_DIR / ".env.example").read_text(encoding="utf-8")
    for line in example.splitlines():
        assert not any(line.strip().startswith(f"{name}=") for name in SECRETS), line
    assert "AI_ENV_FILE" in example
