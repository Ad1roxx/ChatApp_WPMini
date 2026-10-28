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
| `store.py` | Chunks, queries | Embeddings, the vector index, and the filtered search |
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
