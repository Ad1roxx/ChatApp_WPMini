"""Contextual headers, names as roles, and the opening fragment (BUILD_NOTES Entry 85)."""

import answer as answer_module
import chunking
import store as store_module
from chunking import PLACEHOLDER_HEADING, context_headers, effective_budget, fold_opening_fragment, names_to_roles, text_for_models, token_count
from config import EMBEDDING_MAX_TOKENS
from providers import Generation

PARTIES = {"mentor": "Meera Iyer", "student": "Rohan Kapoor"}


def on(monkeypatch):
    monkeypatch.setattr(chunking, "CONTEXT_HEADERS", True)


# ---- names to roles


def test_whole_names_parts_and_possessives_become_roles():
    assert names_to_roles("What did Rohan Kapoor test?", PARTIES) == "What did the student test?"
    assert names_to_roles("What does Meera want from Rohan's design?", PARTIES) == "What does the mentor want from the student's design?"
    assert names_to_roles("what did rohan kapoor test?", PARTIES) == "what did the student test?"


def test_a_part_of_a_name_only_changes_as_written_so_a_mentor_called_will_is_safe():
    parties = {"mentor": "Will Rao", "student": "Asha Rao"}
    assert names_to_roles("Will this work, and what will Will say?", parties) == "the mentor this work, and what will the mentor say?"


def test_a_part_both_parties_share_stays():
    assert names_to_roles("Did Rao reply?", {"mentor": "Will Rao", "student": "Asha Rao"}) == "Did Rao reply?"


def test_nobody_else_changes_and_a_name_inside_a_word_does_not():
    assert names_to_roles("What did Zara say about Rohanna?", PARTIES) == "What did Zara say about Rohanna?"


def test_missing_names_change_nothing():
    for parties in (None, {}, {"mentor": "", "student": ""}):
        assert names_to_roles("What did Rohan do?", parties) == "What did Rohan do?"


def test_a_name_full_of_regex_characters_is_only_text():
    assert names_to_roles("Ask (.*) now", {"mentor": "(.*)", "student": ""}) == "Ask the mentor now"


# ---- the query, and the prompt


class Store:
    def __init__(self):
        self.queries = []

    def search(self, mentorship_id, viewer_id, query, k=4):
        self.queries.append(query)
        return [{"sourceType": "resource", "title": "Note", "content": "It retries.", "contextHeader": "HEADER-TEXT"}]


class Provider:
    def __init__(self):
        self.user = None

    def generate(self, system, user, *, budget_s):
        self.user = user
        return Generation("ok", "x", "y", text="It retries [1].")


def ask(version="s2-v3"):
    store, provider = Store(), Provider()
    result = answer_module.answer(store, "m", "v", "What did Rohan ask Meera?", provider, role="student", prompt_version=version, parties=PARTIES)
    return store, provider, result


def test_on_search_gets_roles_and_the_prompt_gets_the_question_unchanged(monkeypatch):
    on(monkeypatch)
    store, provider, _ = ask()
    assert store.queries == ["What did the student ask the mentor?"]
    assert "Question: What did Rohan ask Meera?" in provider.user


def test_off_search_gets_the_question_unchanged(monkeypatch):
    monkeypatch.setattr(chunking, "CONTEXT_HEADERS", False)
    store, _, _ = ask()
    assert store.queries == ["What did Rohan ask Meera?"]


def test_the_header_reaches_neither_the_prompt_nor_a_citation(monkeypatch):
    on(monkeypatch)
    _, provider, result = ask()
    assert "HEADER-TEXT" not in provider.user
    assert "HEADER-TEXT" not in str(result)


# ---- headers


def header(doc, text="Body.", heading=None, parties=PARTIES):
    return context_headers(doc, [{"text": text, "heading": heading}], parties)[0]


def test_each_record_type_says_what_it_is_and_whose():
    assert header({"source_type": "assignment", "title": "Rate limiter"}) == "Assignment brief (the mentor's instructions): Rate limiter"
    assert header({"source_type": "submission", "title": "Hand-in: Rate limiter"}) == "Student's hand-in for 'Rate limiter'"
    assert header({"source_type": "goal", "title": "Be ready"}) == "Student's goal: Be ready"
    assert header({"source_type": "resource", "title": "k6", "added_by_role": "mentor"}) == "Resource shared by the mentor: k6"
    assert header({"source_type": "resource", "title": "k6"}) == "Resource: k6"


def test_a_file_on_a_hand_in_names_the_hand_in_and_its_section():
    doc = {"source_type": "attachment", "title": "design.pdf", "parent_type": "submission", "parent_title": "Hand-in: Rate limiter"}
    assert header(doc, heading="What I tested") == "Student's hand-in for 'Rate limiter', section: What I tested"
    assert header(doc, heading=PLACEHOLDER_HEADING) == "Student's hand-in for 'Rate limiter'"


def test_a_review_is_told_apart_from_the_hand_in():
    doc = {"source_type": "submission", "title": "Hand-in: X"}
    assert header(doc, text="Mentor's review: Good.") == "Mentor's review of the student's hand-in for 'X'"
    assert header(doc, text="My note.\n\nMentor's review: Good.") == "Student's hand-in for 'X', and the mentor's review of it"
    pieces = [{"text": "Mine. Mentor's review: Good."}, {"text": "More of the review."}]
    assert context_headers(doc, pieces, PARTIES)[1] == "Mentor's review of the student's hand-in for 'X'"


def test_headers_hold_roles_never_names():
    doc = {"source_type": "assignment", "title": "Meera's brief for Rohan Kapoor"}
    made = header(doc, heading="What Rohan tested")
    assert "Meera" not in made and "Rohan" not in made and "Kapoor" not in made
    assert "the mentor's brief for the student" in made and "What the student tested" in made


def test_a_very_long_title_and_a_full_chunk_still_fit_the_model():
    doc = {"source_type": "assignment", "title": " ".join(["word"] * 400)}
    made = header(doc)
    body = " ".join(["word"] * effective_budget(5000))
    assert token_count(f"{made}\n{body}") + 2 <= EMBEDDING_MAX_TOKENS


def test_models_read_the_header_only_with_the_setting_on(monkeypatch):
    monkeypatch.setattr(chunking, "CONTEXT_HEADERS", False)
    assert text_for_models("Body.", "Section", "Header") == "Body."
    on(monkeypatch)
    assert text_for_models("Body.", "Section", "Header") == "Header\nBody."
    assert text_for_models("Body.", "Section", None) == "Body."


def test_replace_source_embeds_the_header_and_keeps_the_content_clean(monkeypatch):
    on(monkeypatch)
    embedded, inserted = [], []

    class Chunks:
        def delete_many(self, _):
            pass

        def insert_many(self, rows):
            inserted.extend(rows)

    monkeypatch.setattr(store_module, "embed_passages", lambda texts: embedded.extend(texts) or [[0.0]] * len(texts))
    chunk_store = store_module.ChunkStore.__new__(store_module.ChunkStore)
    chunk_store.chunks = Chunks()
    chunk_store._party_names = lambda _: PARTIES
    doc = {"mentorship_id": "m", "source_type": "goal", "source_id": "s", "title": "Rohan's goal", "viewers": [], "visibility": "mentorship"}

    chunk_store.replace_source(doc, [{"text": "Body."}])

    assert embedded == ["Student's goal: the student's goal\nBody."]
    assert inserted[0]["content"] == "Body."
    assert inserted[0]["contextHeader"] == "Student's goal: the student's goal"


# ---- the opening fragment


def test_a_short_opening_section_folds_into_the_next_and_loses_no_text():
    sections = [
        {"heading": "Title", "text": "Rohan Kapoor.", "index": 0, "start_page": 1, "end_page": 1},
        {"heading": "The problem", "text": "A " * 60, "index": 1, "start_page": 2, "end_page": 2},
        {"heading": "Short", "text": "Tiny.", "index": 2},
    ]
    folded = fold_opening_fragment(sections)
    assert [s["heading"] for s in folded] == ["The problem", "Short"]
    assert folded[0]["text"].startswith("Rohan Kapoor. A")
    assert folded[0]["start_page"] == 1


def test_an_opening_section_at_the_minimum_stays_and_so_does_a_document_of_one_section():
    long_enough = {"heading": "Title", "text": "word " * 40, "index": 0}
    other = {"heading": "Next", "text": "Next.", "index": 1}
    assert fold_opening_fragment([long_enough, other]) == [long_enough, other]
    only = {"heading": "Only", "text": "Tiny.", "index": 0}
    assert fold_opening_fragment([only]) == [only]


def test_chunk_sections_folds_only_with_the_setting_on(monkeypatch):
    sections = [{"heading": "Title", "text": "Tiny.", "index": 0}, {"heading": "Next", "text": "Next part.", "index": 1}]
    monkeypatch.setattr(chunking, "CONTEXT_HEADERS", False)
    assert [c["heading"] for c in chunking.chunk_sections(sections)] == ["Title", "Next"]
    on(monkeypatch)
    assert [c["heading"] for c in chunking.chunk_sections(sections)] == ["Next"]
