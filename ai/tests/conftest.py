"""Test fixtures, and the rule that keeps tests away from real data.

The Node suite settled this question already: `server/test/helpers/harness.js`
points the server at a throwaway `chatapp_test` and drops it on teardown,
because earlier verification runs against the development database twice meant
repairing real records afterwards. The Python side inherits the same rule.

Two databases are off limits here:

- `chatapp` — the development database the app itself uses
- `chatapp_rag` — the corpus the retrieval service and its evaluation use

Tests use `chatapp_rag_pytest`, which is created on demand and dropped at the
end of the session. `forbid_real_databases` is not decoration: it is a guard
that fails loudly if a future edit points a fixture at either real database,
because that mistake is silent and expensive, and the test that catches it
should not be the one that notices missing records a week later.
"""

from __future__ import annotations

import os

import pytest

# Imported for its configured values only — never to write through.
import config

TEST_DB_NAME = "chatapp_rag_pytest"

# Both the development database and the live corpus. Neither may be opened by
# anything in this suite.
FORBIDDEN_DB_NAMES = frozenset({"chatapp", "chatapp_rag"})


def forbid_real_databases(name: str) -> str:
    """Return `name`, or raise if it is a database tests must never touch."""
    if name in FORBIDDEN_DB_NAMES:
        raise RuntimeError(
            f"refusing to run tests against {name!r}: tests use {TEST_DB_NAME!r}"
        )
    return name


@pytest.fixture(scope="session")
def mongo_uri() -> str:
    return os.getenv("AI_MONGODB_URI", config.MONGODB_URI)


@pytest.fixture(scope="session")
def mongo_client(mongo_uri: str):
    """A client, or a skip when the container is not running.

    Skipping rather than failing is deliberate: the extraction and chunking
    tests are pure functions and must stay runnable with Docker closed. Only
    the tests marked `needs_mongo` depend on it.
    """
    from pymongo import MongoClient
    from pymongo.errors import PyMongoError

    client = MongoClient(mongo_uri, serverSelectionTimeoutMS=3000)
    try:
        client.admin.command("ping")
    except PyMongoError as err:
        pytest.skip(f"Atlas Local not reachable at {mongo_uri}: {err}")

    yield client
    client.close()


@pytest.fixture
def test_db(mongo_client):
    """An empty database per test, dropped afterwards.

    Dropped on the way *in* as well as out: a previous run killed partway
    through leaves state behind, and a test that silently inherits it is a test
    that passes for the wrong reason.
    """
    name = forbid_real_databases(TEST_DB_NAME)
    mongo_client.drop_database(name)
    db = mongo_client[name]
    yield db
    mongo_client.drop_database(name)
