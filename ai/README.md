# The retrieval service

Answers "what in this mentorship is relevant to this question?" — and nothing
about any other mentorship.

The rest of the application is Node. This part is Python because the embedding
and evaluation libraries live here, and because the retrieval logic is worth
keeping in one place rather than scattered through route handlers.

---

## What it is

```
Express  ──verifies the token, checks mentorship membership──┐
                                                             ▼
                                               FastAPI (127.0.0.1 only)
                                                             │
                                                   $vectorSearch with a
                                                   mentorship pre-filter
                                                             │
                                                    MongoDB Atlas Local
                                                     knowledge_chunks
```

`knowledge_chunks` is an index **derived** from application data. The
application's own collections stay the source of truth; nothing here writes to
them, and dropping the whole collection costs one re-ingest.

## The rule that matters

The mentorship filter is passed to `$vectorSearch` itself, not applied to its
results:

```python
"filter": {
    "mentorshipId": {"$eq": mentorship_id},
    "viewers": {"$in": [viewer_id]},
}
```

Filtering afterwards would let the index spend its candidate budget on
documents the caller may not see — so a query could come back empty *because*
the nearest neighbours belonged to someone else, and the fix would look like
"ask for more candidates" rather than "this is wrong".

This service trusts the `mentorshipId` it is given, which is why it binds to
localhost and requires a shared secret. Express does the membership check
first; this filter is the second lock.

## Running it

The Atlas Local container, because `$vectorSearch` needs it:

```bash
docker run -d --name mc-atlas -p 27018:27017 mongodb/mongodb-atlas-local:latest
```

Then, from `ai/`:

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
cp .env.example .env

.venv/Scripts/python.exe ingest.py --drop        # build the index
.venv/Scripts/python.exe check_retrieval.py      # prove the isolation
.venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

## The files

| File | In | Out |
| --- | --- | --- |
| `config.py` | Environment | Settings: database, model, chunk budget, secret |
| `sources.py` | Application data | Documents worth indexing, each with its `viewers` |
| `extract.py` | PDF and Word attachments | Text in sections, with page numbers where the format has them |
| `chunking.py` | Text | Chunks sized in the embedding model's own tokens, never crossing a section boundary |
| `store.py` | Chunks, queries | Embeddings, the vector index, and the filtered search: over-fetch, rerank, cap, cut to k |
| `ingest.py` | CLI | A built or rebuilt index |
| `check_retrieval.py` | CLI | End-to-end checks, including that another mentorship's material never appears |
| `app.py` | HTTP | FastAPI `/search`, behind the shared secret |

## What is indexed

First-party text only — things a person in the mentorship wrote: assignment
briefs, hand-in text, mentor review notes, goals with their milestones, and
resource titles with their notes.

Resources are links with a short note, so the page behind the link is **not**
fetched. Fetching arbitrary URLs from the server would be an SSRF hole for very
little retrieval value.

**Attached PDFs and Word files**, as one source each, identified by the GridFS
file id. A chunk from a file records the record it hangs off, which file, and
the page or section it came from, so a citation names something a person can
open. Every other attachable type is skipped with a logged reason: there is no
extractor for spreadsheets or slides, `.doc` is not `.docx`, and an image needs
the OCR of S7. A scan with no text layer produces **zero** chunks rather than a
filename pretending to be readable.

An attachment inherits the viewers of the record it is attached to, computed by
that record's own rule: a hand-in's file is the student's and their mentor's,
never another student's on the same brief. Today only hand-ins can carry files
— briefs and resources have no attachment field — but all three are walked, so
the day either gains uploads nothing here changes.

### Deletion

Re-indexing a source replaces its chunks, which only works for sources that
still exist. A run therefore ends by **reconciling**: anything in the index that
was not seen is deleted. A full run reconciles the whole index, so a deleted
hand-in, a removed attachment or an ended mentorship all disappear; a run
scoped with `--mentorship` reconciles only inside that mentorship, because it
only looked there. A source is identified by mentorship, type and id together,
since one brief set to two mentorships is one source in each.

What this does **not** do is notice a deletion as it happens: the index is
stale until the next run. That is S1.5's job, and it must land before
generation, because from then on a stale chunk can be quoted back to someone as
though it were current.
