"""The suite's own safety rails.

These assert the property — that tests cannot reach real data — rather than a
proxy for it. BUILD_NOTES Entries 38, 41 and 42 each record a check that passed
while the thing it stood for had not happened, so the guard gets its own tests
before anything depends on it.
"""

from __future__ import annotations

import pytest

import config
from tests.conftest import (
    FORBIDDEN_DB_NAMES,
    TEST_DB_NAME,
    forbid_real_databases,
)


def test_the_test_database_is_neither_real_one():
    assert TEST_DB_NAME not in FORBIDDEN_DB_NAMES
    assert TEST_DB_NAME != config.DB_NAME


@pytest.mark.parametrize("name", sorted(FORBIDDEN_DB_NAMES))
def test_the_guard_refuses_real_databases(name):
    with pytest.raises(RuntimeError, match="refusing to run tests"):
        forbid_real_databases(name)


def test_the_guard_allows_the_test_database():
    assert forbid_real_databases(TEST_DB_NAME) == TEST_DB_NAME


def test_the_live_corpus_is_one_of_the_forbidden_names():
    # If the service is ever reconfigured to a different corpus database, this
    # fails and says so, rather than letting the guard protect a name nothing
    # uses any more.
    assert config.DB_NAME in FORBIDDEN_DB_NAMES


@pytest.mark.needs_mongo
def test_each_test_gets_an_empty_database(test_db):
    assert test_db.name == TEST_DB_NAME
    assert test_db.list_collection_names() == []

    test_db.scratch.insert_one({"written_by": "test_each_test_gets_an_empty_database"})
    assert test_db.scratch.count_documents({}) == 1


@pytest.mark.needs_mongo
def test_the_previous_test_left_nothing_behind(test_db):
    # Runs after the test above, which wrote a document. An empty database here
    # is the teardown actually working, not an assumption that it did.
    assert test_db.list_collection_names() == []
