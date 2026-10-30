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

Three databases, three jobs:

| Database | Server | Holds | Written by |
| --- | --- | --- | --- |
| `chatapp` | 27017 | the app's records and attachments | Express only — this service **reads** it, through `appdb.py` |
| `chatapp_rag` | 27018 | the served index, `knowledge_chunks` | this service only |
| `chatapp_eval` | 27018 | a seeded corpus **and** its own index | the seeders, `evaluate.py`, `check_retrieval.py` |

`knowledge_chunks` is an index **derived** from the app's records. Those stay
the source of truth; `appdb.py` offers no way to write to them, and dropping the
whole index costs one re-ingest.

**Until S1.5 this was not true.** The service read its records from a seeded
copy beside the chunks, so the Copilot had never searched anything a real user
wrote (BUILD_NOTES Entry 53). Every evaluation figure was, and still is,
measured on that seeded corpus — which is what an evaluation corpus is for.

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

# The served index, from the app's own database (read-only):
.venv/Scripts/python.exe ingest.py --drop
.venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000

# The evaluation, on its own fixture database - never the served index:
node ../scripts/seed-rag-corpus.cjs             # the corpus, from the repo root
.venv/Scripts/python.exe eval/seed_documents.py  # its PDFs and Word files
.venv/Scripts/python.exe check_retrieval.py      # prove the isolation
.venv/Scripts/python.exe check_freshness.py      # the app and this service, end to end
.venv/Scripts/python.exe evaluate.py --ablation  # measure it, stage by stage
```

`eval/seed_documents.py` is a **separate step**, run after the Node seeder; the
seeder does not call it. It builds the synthetic PDFs and Word files and
attaches them to the seeded hand-ins, and writing a PDF needs PyMuPDF, which
only the Python side has. Run the seeder alone and the index has no documents
in it, and every document question in the evaluation fails.

Both seeding commands are idempotent, and `ingest.py` deletes the chunks of any
source it did not see, so running the lot twice leaves one index rather than
two.

### What the served search does

bge-small dense search over 30 candidates, then a soft per-record cap, cut to
`k=4`. The cross-encoder reranker is **off by default**: on the S1 corpus it
gained 0.03 recall@1 on record questions, lost 0.06 on document questions and
added about 370 ms a search, and the corpus was too small to test the two-stage
design it is for (BUILD_NOTES Entry 52). `AI_RERANK=1` turns it on;
`evaluate.py --ablation` measures every stage, including the served one.

`evaluate.py` rebuilds the index with whatever model it is run with. Every chunk
records the model that embedded it, and the first search in a process refuses
an index from a different one — two 384-wide models are accepted by the vector
index and mean nothing to each other. After an evaluation run with a model
override, run `ingest.py --drop` before serving.

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

### Keeping the index in step: `POST /index/sync`

Express calls this after a write succeeds, with an identifier and nothing else:

```json
{"sourceType": "submission", "sourceId": "<24 hex>"}     // assignment, submission, goal, resource
{"mentorshipId": "<24 hex>"}                             // the mentorship itself changed
```

The service reads that record from the app's database and makes the index match
it as it is now — re-extracting, re-chunking and re-embedding it, or removing it
if it is gone or no longer indexed. It answers `202` at once and does the work on
one background thread. A body carrying text, viewers, or a mentorship beside a
record is refused (`422`), so a caller can say *which* record changed but never
*what* it says or *who* may see it. Shared secret, as for `/search`, and local
callers only.

Because a sync reads current state rather than applying a change, it is
idempotent and the order events arrive in does not matter. On start-up the
service re-indexes everything and reconciles (`AI_CATCHUP=full`, or `off`), which
catches up on anything missed while it was down.

**What a full re-index (`ingest.py --drop`) still does:** everything a lost event
or a restart would otherwise leave late, in one pass — and it is the only thing
that stamps versions onto chunks written before S1.5, which search otherwise
drops.

### How fresh, measured

`check_freshness.py` starts Express and this service on fixture databases of
their own and uses only the app's HTTP routes. From an upload's response until
the Copilot finds it: under a second for a short PDF or a 9 MB mostly-image
one, about four seconds for fifty pages of text — the cost is text to embed,
not bytes. From a delete's response until it is gone: immediate, at the very
next search, even with the deleted file's chunks still in the index
(`ai/eval/s15-freshness.txt`).

The worker shares this process with search, so a long upload slows everyone's
searches while it embeds: from 36 ms to 84 ms median for another user, during a
fifty-page PDF's 3.5 seconds (`check_freshness.py --contention`). One worker
means at most one embedding at a time.

### The read-time check

Every search checks its candidates against the records as they are now, after
`$vectorSearch` and before reranking. A chunk is dropped if its source is gone,
its file has left the record, the record would no longer be indexed, the caller
is no longer a viewer, or the record has changed since the chunk was built. The
rules are the indexer's own (`sources.py`); each drop is logged with its reason.

This is what keeps search correct when an update was never delivered: a missed
event can only delay something *new* becoming findable, never let something
removed be seen. If the app's database is unreachable, search fails (the
Copilot route's 502) rather than returning chunks nothing has checked. Cost:
about 6 ms a search (`ai/eval/s15-read-check.txt`).

### Versions

Every chunk records `sourceVersion`, the version of the record it was built
from — the record's `updatedAt`, which Mongoose moves on every save. A hand-in
takes the later of its own and its assignment's, because its title comes from
the assignment. A file takes its upload time: GridFS files are never rewritten.
Chunks written before S1.5 have no version, and from S1.5 step 2 search drops
them. **A re-index fixes that** (`ingest.py --drop`).

Goals had no `updatedAt` before S1.5. Run `node scripts/backfill-goal-timestamps.cjs`
once against each database that has goals (it is safe to run twice), or every
goal written before then is dropped from search until it is next edited.

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
