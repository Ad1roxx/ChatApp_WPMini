# MentorConnect — handoff

**For planning a next step with a fresh pair of eyes.** Written 2026-10-16
against commit `9a0b6b9`, 61 commits in, working tree clean, **21 commits not
yet pushed**.

Every number below was measured the day this was written, with the command
beside it. Re-run them before quoting any of it — several change with the code.

- `docs/BUILD_NOTES.md` — 41 entries, the *why* behind every decision. The
  first place to look before changing something that seems odd.
- `docs/PROJECT_BRIEF.md` — the CV-facing version: facts with their sources,
  and a section of things that must **not** be claimed.

---

## What it is

A mentorship platform. Students and mentors hold a **mentorship**, and
everything hangs off that relationship: goals with milestones, scheduled
sessions, shared resources, and Classroom-style assignments with file
attachments. Around it sits a chat app — direct messages, group chat, mentor
announcements — with presence, unread counts and read receipts.

Three roles (student, mentor, admin), enforced on the server from the stored
user record, never from the request body.

Built as a college mini-project. Never deployed.

---

## Running it

Three runtimes. The first two are the app; the third is optional and only the
Copilot needs it.

```bash
# 1. API + sockets          http://localhost:3001
cd server && npm install && cp .env.example .env   # set MONGODB_URI, FIREBASE_PROJECT_ID
node index.js

# 2. Frontend               http://localhost:5173
npm install && npm run dev

# 3. Retrieval service      http://127.0.0.1:8000   (optional)
docker start mc-atlas     # or: docker run -d --name mc-atlas -p 27018:27017 mongodb/mongodb-atlas-local
cd ai && .venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

With the third absent, the app runs normally and the Copilot route answers
**503 by design** — which is also why CI stays a Node-only job.

---

## Architecture

```
React 18 + Vite  --authFetch (Firebase ID token)-->  Express 5 + Socket.IO
       |                                                   |
   CSS Modules over design tokens                      Mongoose 8 --> MongoDB
                                                           |
                                          POST /api/mentorships/:id/copilot/search
                                                           |   (localhost + shared secret)
                                                           v
                                                 FastAPI (Python 3.11)
                                                           |
                                             $vectorSearch with a filter
                                                           v
                                      MongoDB Atlas Local container :27018
                                             knowledge_chunks
```

**Identity in two layers, joined once.** Firebase Auth answers "who are you";
the MongoDB `_id` is the identity every feature keys off. They meet only in
`POST /api/auth/login`. Tokens are verified in-process against Google's public
certificates (RS256, audience and issuer pinned) — no Firebase Admin SDK, so
there is no service-account secret to distribute.

---

## The permission spine

Read this before touching any route.

- **`requireAuth`** verifies the token and attaches `req.authUser` — the whole
  Mongo document. Handlers use `req.authUser._id`, never an id from the body.
- **Socket identity is pinned at the handshake** (`io.use(socketAuth)`), so an
  event payload cannot claim to be someone else.
- **`resolveMentorshipAccess(id, user)`** is the one helper that answers "is
  this your mentorship" — 404 when it does not exist, 403 when it is not
  yours. Goals, sessions, resources, assignments and the Copilot all use it.
  Do not write a second one.
- **Admin is unassignable.** It comes only from the `ADMIN_EMAILS` allowlist at
  sign-in; every role endpoint refuses it.
- **Suspension is checked in `requireAuth` and the socket handshake**, not per
  route, so there is no route to forget.
- **Ownership is not the same as role.** Deleting an announcement checks
  authorship, not role — otherwise any mentor could delete another's posts.

---

## Data model — 14 Mongoose models

| Model | Holds | Worth knowing |
| --- | --- | --- |
| `User` | identity, role, presence, profile | `firebaseUid` unique; presence derives from live sockets |
| `Message` / `GroupMessage` | chat | the server echoes the saved record back to the sender too |
| `Group` / `GroupRead` | groups, per-member read marks | read receipts are per member |
| `Announcement` | mentor broadcasts | post and delete only — no edit |
| `Report` | moderation | type + id + a text snapshot, so it survives deletion of its subject |
| `Mentorship` | the relationship | one-way lifecycle: pending → active → ended/declined, never backwards |
| `Goal` | goals with embedded milestones | status is **derived** from milestones; `archived` is the only one a person sets |
| `Session` | scheduled meetings | two-party handshake: one proposes, the *other* confirms |
| `Feedback` | session ratings | **built, tested, switched off** via `src/lib/features.js` |
| `Resource` | a shared link | title + URL + 500-char note. A bookmark, **not** a document |
| `Assignment` | one brief, several students | recipients are mentorships, not users |
| `Submission` | one student's hand-in | status, files, append-only history, derived lateness |

Derived-not-stored is a theme: goal status, assignment lateness and streaks are
all computed on read, so a summary cannot drift from the data under it.

---

## What exists

Chat, groups, announcements, presence, unread counts and previews, group read
receipts, admin dashboard, mentor verification, suspension, reports,
mentorships (mentor adds outright; student requests; either may end; student
may ask to opt out), goals and milestones, sessions, resources, assignments
(shared brief, per-student drafts, hand-ins, unsubmit, mentor review, full
history), file attachments in GridFS with in-place preview of images, text and
PDFs, assignment streaks, a sidebar badge for work waiting on you, and a quiet
in-app notice when work is set, handed in or answered.

**Deliberately not present:**

- **Achievements** — built, then removed (Entry 37). Do not re-add by accident.
- **Session ratings** — built and tested, UI switched off behind a flag.
- **Mentor matching**, calendar export, announcement editing, rate limiting.

---

## The retrieval layer (`ai/`)

955 lines of Python across 8 modules. It answers "what in *this* mentorship is
relevant to this question" and nothing about any other.

**Built and proven**

- Indexes first-party text only: assignment briefs, hand-in text, mentor review
  notes, goals with milestones, resource titles and notes. Linked pages are
  **not** fetched — that would be SSRF in a server that makes no outbound
  requests.
- Embeddings are local (`all-MiniLM-L6-v2`, 384-dim, CPU, free, offline).
- The permission filter runs **inside** `$vectorSearch`, not over its results,
  so the index cannot spend its candidate budget on chunks the caller may not
  see.
- `ai/check_retrieval.py` proves cross-mentorship isolation against a corpus
  where both mentorships cover the same topics in similar words.
- `server/test/copilot.test.js` — 12 tests for the trust boundary, none of
  which need Python running.

**Measured** (`ai/evaluate.py --compare --rerank`, 45 labelled questions)

| Configuration | recall@1 | recall@3 | MRR |
| --- | --- | --- | --- |
| fixed 800 (baseline) | 0.68 | 1.00 | 0.828 |
| fixed 400 + cross-encoder | **0.81** | 0.90 | **0.855** |

Two findings that shape what comes next:

1. **No score threshold separates answerable from unanswerable questions** in
   any configuration. "What does the caching exercise say about stale reads?"
   outranks genuinely answerable questions because it is phrased in the
   corpus's own vocabulary, and the cross-encoder agrees. **Abstention cannot
   be a threshold** — it needs a grounding check that reads the retrieved text.
2. **Heading-aware chunking scored identically to fixed** because this corpus
   has no headings. That is "not applicable", not "no difference".

**Not built:** generation (there is no LLM anywhere in the project), and any UI.

---

## Conventions — follow these when changing things

- **Verify, then claim.** Two logged cases where an assertion passed while the
  thing it stood for had not happened: an empty PDF frame (Entry 38) and
  isolation checks that passed because retrieval returned nothing at all
  (Entry 41). Assert the property, not a proxy for it.
- **One feature, one commit**, with a `docs/BUILD_NOTES.md` entry explaining
  the decisions and what was rejected. Commits are authored as Ad1roxx with
  **no attribution trailers**.
- **Tests never touch the development database.** `server/test/helpers/harness.js`
  spawns the real server against `chatapp_test` and drops it afterwards. The
  RAG corpus is separate again: `chatapp_rag`, inside the container.
- **`docs/PROJECT_BRIEF.md` must stay true** — it exists for job applications,
  and a stale claim there is worse than no claim. It has already drifted once.
- Node's built-in `node:test`; no test-runner dependency.
- Comments explain *why*, not what. Match the surrounding voice.

---

## Current numbers (measured 2026-10-16)

| | | Command |
| --- | --- | --- |
| Commits | 61 (21 unpushed) | `git rev-list --count HEAD` |
| JS/JSX | 21,543 lines | `find . -name '*.js*' \| xargs wc -l` |
| Python | 955 lines, 8 modules | `wc -l ai/*.py` |
| REST endpoints | 58 | `grep -cE "^app\.(get\|post\|put\|patch\|delete)\(" server/index.js` |
| Socket handlers / events | 12 / 27 | `grep` in `server/index.js` |
| Models | 14 | `ls server/models` |
| Pages / components | 15 / 20 | `ls src/pages src/components` |
| Tests | **490 passing**, 16 files, ~53 s | `cd server && npm test` |
| Lint | 0 errors, 1 documented warning | `npx eslint .` |
| Bundle | 506.60 kB JS (140.33 gzip), 65.73 kB CSS | `npm run build` |

---

## Known gaps, honestly

**Blocking a demo**

- The Copilot has **no interface**. The route and service work end to end;
  nothing in React calls them.
- The container must be started by hand, or the Copilot answers 503. A demo
  that opens with a 503 is worse than no demo.

**Quality and security**

- **8 npm advisories** in `server/` (body-parser, qs, path-to-regexp through
  Express; socket.io, engine.io, ws; mongoose). All fixable within current
  version ranges by `npm audit fix`. Untouched so far.
- **No frontend tests.** The 490 cover the server only. React is checked by a
  Playwright screenshot harness that catches render failures and console
  errors but asserts no behaviour — and it is not in CI.
- **No rate limiting.** A signed-in client can flood messages or announcements.
- The bundle is past Vite's 500 kB warning. Route-level `import()` is the fix.

**Design limits worth knowing**

- Presence is in-memory: one process only, lost on restart.
- Notices are live-only; one that arrives while signed out is gone. The sidebar
  count is the part that persists.
- Pagination exists on the group history endpoint and nothing calls it.
- `viewers` on a chunk currently adds nothing beyond `mentorshipId`, because a
  mentorship has exactly one student. It earns its place only when a mentor
  searches across all their students.
- The evaluation corpus is 11 sources written in an afternoon. recall@5 is
  nearly free at that size; only recall@1 and MRR discriminate.

---

## What I would do next, in order

1. **Copilot UI** — a panel on `MentorshipDetailPage` calling the existing
   route, rendering chunks as citations, and degrading honestly on 503. The
   retrieval is measured but invisible; this is what makes it demonstrable.
2. **Grounding check, then generation.** The evaluation gave a concrete reason:
   abstention must read the retrieved text rather than threshold a score.
   Needs an API key; everything else is already in place.
3. **One-command demo** — container, service and app together. Otherwise every
   demo starts with a 503 and an apology.
4. **Second embedding model A/B** (768-dim). Note: the vector index is
   dimension-specific, so this needs its own collection and index, not a flag.
5. **Housekeeping** — `npm audit fix`, then split the bundle.
6. **Push.** 21 commits are sitting local.

---

## Where things are

```
server/index.js              start-up only since 2026-11-14 (BUILD_NOTES Entry 155)
server/app.js                the Express app, Socket.IO server, middleware, shared state
server/routes/*.js           the REST routes, one file per area, in the order index.js loads them
server/realtime.js           the socket handlers
server/middleware/auth.js    token verification, dev bypass, role gates
server/models/*.js           schemas; the header comment explains the modelling choice
server/test/*.test.js        16 files; helpers/harness.js spawns a real server
src/pages/ src/components/   screens and shared UI (CSS Modules + design tokens)
src/context/                 AuthContext (identity, socket, authFetch), Conversations, Work
ai/                          retrieval service — see ai/README.md
ai/eval/                     45 labelled questions + a dated results snapshot
scripts/seed-rag-corpus.cjs   the corpus the evaluation runs against
docs/BUILD_NOTES.md          41 entries: why everything is the way it is
```
