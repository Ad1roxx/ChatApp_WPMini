"""A section's heading, read with its chunk by the embedder and the reranker only."""

import chunking
import store as store_module
from chunking import HEADING_MAX_TOKENS, PLACEHOLDER_HEADING, effective_budget, text_for_models, token_count
from config import EMBEDDING_MAX_TOKENS


def on(monkeypatch):
    # Entry 82's variant, not adopted: it only applies with contextual headers off.
    monkeypatch.setattr(chunking, "CONTEXT_HEADERS", False)
    monkeypatch.setattr(chunking, "EMBED_HEADINGS", True)


def test_off_the_text_is_left_alone(monkeypatch):
    monkeypatch.setattr(chunking, "EMBED_HEADINGS", False)
    assert text_for_models("Body.", "Action items") == "Body."


def test_on_the_heading_comes_first(monkeypatch):
    on(monkeypatch)
    assert text_for_models("Body.", "Action items") == "Action items\nBody."


def test_no_heading_and_the_placeholder_add_nothing(monkeypatch):
    on(monkeypatch)
    for heading in (None, "", "   ", PLACEHOLDER_HEADING):
        assert text_for_models("Body.", heading) == "Body."


def test_a_heading_cannot_start_a_second_line(monkeypatch):
    on(monkeypatch)
    assert text_for_models("Body.", "Action\n\n  items") == "Action items\nBody."


def test_a_long_heading_and_a_full_chunk_still_fit_the_model(monkeypatch):
    on(monkeypatch)
    heading = " ".join(["heading"] * 400)
    body = " ".join(["word"] * effective_budget(5000))
    assert token_count(body) == effective_budget(5000)
    combined = text_for_models(body, heading)
    assert token_count(combined.split("\n")[0]) <= HEADING_MAX_TOKENS
    # Two slots for the model's own start and end tokens.
    assert token_count(combined) + 2 <= EMBEDDING_MAX_TOKENS


def test_replace_source_embeds_the_heading_and_stores_only_the_text(monkeypatch):
    on(monkeypatch)
    embedded = []
    inserted = []

    class Chunks:
        def delete_many(self, _):
            pass

        def insert_many(self, rows):
            inserted.extend(rows)

    monkeypatch.setattr(store_module, "embed_passages", lambda texts: embedded.extend(texts) or [[0.0]] * len(texts))
    chunk_store = store_module.ChunkStore.__new__(store_module.ChunkStore)
    chunk_store.chunks = Chunks()
    doc = {"mentorship_id": "m", "source_type": "attachment", "source_id": "s", "title": "f.pdf", "viewers": [], "visibility": "both"}

    chunk_store.replace_source(doc, [{"text": "Release the connection.", "heading": "Action items"}])

    assert embedded == ["Action items\nRelease the connection."]
    assert inserted[0]["content"] == "Release the connection."
    assert inserted[0]["heading"] == "Action items"
