# Project Brief — MentorConnect

A factual summary of this project for CV, cover-letter and interview use.

**Every figure below cites the file or command it came from.** Anything not
traceable is quarantined in section 6 and must not be used in an application.
Several numbers change as the code changes — re-run the cited commands before
reusing them.

Compiled 2026-09-19 against commit `b40272b`. Figures counted before the
commit that records them.

| | |
| --- | --- |
| Commits | 59 |
| Active | 2025-08-23 → 2026-09-19 |
| Source | 21,025 lines JS/JSX |
| Automated tests | 490, all passing, in CI |
| Deployed | No |
| CI | GitHub Actions: lint, build, tests |

---

## 1. Name and positioning

**MentorConnect** — a web application in which students and mentors hold
mentorships with goals, scheduled sessions, shared resources and assignments
handed in with file attachments, alongside direct messages, group chat and
mentor announcements, with three roles whose permissions are enforced on the
server.

Built as a college mini-project. Identity is handled by Firebase
Authentication (Google Sign-In only); all application data is held in MongoDB
behind an Express and Socket.IO server written for this project.

---

## 2. Verified facts

### Codebase

| Fact | Source |
| --- | --- |
| **21,025** lines of JavaScript/JSX across **81** files, excluding lockfiles, `node_modules` and build output | `find . -name '*.js' -o -name '*.jsx' -o -name '*.mjs' \| grep -vE 'node_modules\|dist' \| xargs wc -l` |
| **57** commits, first 2025-08-23, most recent 2026-09-19 | `git rev-list --count HEAD` |
| ESLint across frontend, backend and tests: **81** files, **0** errors, **1** documented warning | `npx eslint . --format json` — the warning is `react-hooks/set-state-in-effect`, exempted in `eslint.config.js` with written reasoning |

### Backend surface

| Fact | Source |
| --- | --- |
| **58** REST endpoints, every one behind authentication; **9** additionally gated to the admin role | `grep -nE "^app\.(get\|post\|put\|patch\|delete)\(" server/index.js` |
| **12** Socket.IO event handlers; **27** distinct server-to-client events | `grep -oE "socket\.on\('[a-z-]+'" server/index.js` and the emit call sites in the same file |
| **14** Mongoose models — User, Message, Group, GroupMessage, Announcement, Report, Mentorship, Goal, Session, GroupRead, Feedback, Resource, Assignment, Submission — with **40** index-declaration lines, of which `User.firebaseUid` carries both `unique` and `index` and is one index, so **39** distinct | `server/models/*.js` · `grep -n "index: true\|unique: true\|\.index(" server/models/*.js` |
| `server/index.js` is **4,458** lines; `server/middleware/auth.js` is **306**; the test suite is **4,234** lines across 15 files plus the harness | `wc -l server/index.js server/middleware/auth.js server/test/**` |

### Retrieval service

| Fact | Source |
| --- | --- |
| **3,666** lines of Python across **12** files — extraction, chunking, embeddings, filtered vector search and a FastAPI endpoint | `wc -l ai/*.py` |
| The served index is built from the app's own database, read through a handle that has no write method; evaluation runs on a separate seeded database with its own index. **Until S1.5 the served index came from that seeded copy**, so the Copilot had never searched a real user's material | `ai/appdb.py` · `ai/tests/test_appdb.py` · BUILD_NOTES Entry 53 |
| PDF and Word attachments are extracted into sections with page numbers, chunked in the embedding model's own tokens, and indexed with the viewers of the record they hang off | `ai/extract.py`, `ai/chunking.py`, `ai/sources.py` |
| A scan with no text layer produces **zero** chunks and logs that it needs OCR, rather than indexing a filename that looks readable | `ai/check_retrieval.py`, check 8 |
| Ingestion **reconciles**: a source that was not seen in a run has its chunks deleted, so a removed attachment, a deleted hand-in or an ended mentorship cannot stay retrievable | `ai/ingest.py` · `ai/store.py`, `reconcile()` |
| Embeddings are **384**-dimensional, from `BAAI/bge-small-en-v1.5` running locally on CPU: no API key, no per-token cost, works offline. Chosen over `all-MiniLM-L6-v2` because it reads **512** tokens rather than 256 at the same width, and that limit is a hard ceiling on chunk size | `ai/config.py`, `ai/store.py` |
| The mentorship filter is passed **inside** `$vectorSearch`, not applied to its results, so the index cannot spend its candidate budget on chunks the caller may not see | `ai/store.py`, `search()` |
| Cross-mentorship isolation is checked against a corpus where both mentorships cover the same topics in similar words | `ai/check_retrieval.py` |
| `$vectorSearch` needs Atlas; local MongoDB 8.0.8 Community has no such operator, so development runs the `mongodb/mongodb-atlas-local` container | `docker run -d -p 27018:27017 mongodb/mongodb-atlas-local` |
| A **65**-question labelled set in two groups, reported separately and never averaged: **45** about text people typed into the application and **20** about attached documents. Seven of the unanswerable ones are answerable only inside a *different* mentorship, so they double as leak probes | `ai/eval/questions.jsonl` |
| Embedding model, measured like for like: bge-small scores **recall@1 0.71** on the 45 record questions (0.55 under the original, pre-document labels) and **0.93**, MRR 0.967 on the 20 document questions, dense. `all-MiniLM-L6-v2` on the same corpus and labels scores 0.55 and 0.93. Every figure here uses one label set; the eight post-hoc label changes and their effect (0.55 / 0.71 / 0.74) are disclosed in BUILD_NOTES Entry 51 | `ai/eval/s1-label-sets.txt` |
| The cross-encoder reranker, re-measured on this corpus, is **mixed**: +0.03 recall@1 on records (0.71 → 0.74), −0.06 on documents (0.93 → 0.87), ~370 ms added per search. The corpus is smaller than the 30-chunk candidate pool, so this compares the cross-encoder with the bi-encoder rather than measuring the two-stage pipeline; so it is **off by default** and revisited in S2 on a larger corpus. The served path is bge-small dense search with a soft per-record cap, `k=4`, at ~25 ms | same file · `AI_RERANK=1` · BUILD_NOTES Entry 52 |
| **Search is correct even when the index was never told**: every result is checked against its record at read time — deleted, changed, no longer visible, or unversioned chunks are dropped — so a missed update can only delay an addition. The check costs **3.5 ms** of a 30 ms search where it runs, and drops nothing on a fresh index | `ai/store.py`, `read_time_check()` · `python check_freshness.py` |
| **Freshness, end to end through the app's routes**: upload → searchable **0.94 s** median (p95 0.96 s, n=20) for a one-page PDF, **0.71 s** for a 9.28 MB mostly-image PDF (n=5), **3.78 s** for fifty pages of text (n=3); delete → gone at the **first** search after the delete, 28 of 28, even while the deleted file's chunks were still indexed | `python check_freshness.py` · `ai/eval/s15-freshness.txt` |
| Express sends **identifiers only** after a successful write, never awaited, 1.5 s timeout, no retry; the service refuses any body carrying content or viewers, so nothing reaching it can choose what is indexed or who sees it | `server/lib/indexSync.js` · `ai/app.py`, `/index/sync` · `server/test/indexsync.test.js` |
| The service **refuses to search an index embedded by a different model**: two 384-wide models are accepted by the index and mean nothing to each other, and a mismatch measured 0.16 recall@1 against 0.74 with no error | `ai/store.py`, `assert_model_matches()` |
| **Almost no configuration separates answerable from unanswerable questions**: the most confident unanswerable question outscores the least confident answerable one in every configuration but one. The exception is bge-small, dense, on the document questions, at **+0.014** — thin, on 20 questions, and the first positive separation measured in this project | same run — the gap is printed as `separation` |

### Authentication

| Fact | Source |
| --- | --- |
| Firebase ID tokens verified with **RS256** against Google's public x509 certificates, with `audience` and `issuer` pinned to the project id | `server/middleware/auth.js:99–104`, `verifyIdToken()` |
| Signing-certificate cache honours the `Cache-Control: max-age` Google returns, falling back to 3600 s | `server/middleware/auth.js:64`, `getSigningCerts()` |
| The development auth bypass requires **two** independent flags and is absent from production builds — **0** occurrences of `X-Dev-User-Id` or `devUserId` in the built bundle | `auth.js:128` (`NODE_ENV` + `ALLOW_DEV_AUTH`) · `AuthContext.jsx:59` (`import.meta.env.DEV`) · grep over `dist/assets/*.js` after `npm run build` |

### Frontend

| Fact | Source |
| --- | --- |
| **15** page components and **20** reusable components, styled with CSS Modules over a single design-token file | `ls src/pages/*.jsx \| wc -l` · `ls src/components/*.jsx \| wc -l` · `src/styles/tokens.css` |
| Production bundle **501.25 kB** JS (**138.75 kB** gzipped) and **63.88 kB** CSS (**10.30 kB** gzipped) — past Vite's 500 kB warning, which is an open item | `npm run build` (Vite 5.4 output) |
| Responsive at a **900 px** breakpoint: fixed sidebar above it, overlay drawer below | `src/components/AppShell.module.css`, `@media (max-width: 900px)` |

### Tests

| Fact | Source |
| --- | --- |
| **490** integration tests across **16** files, all passing, in about **35 s**, run on every push by GitHub Actions | `cd server && npm test` · `.github/workflows/ci.yml` |
| Runner is Node's built-in `node:test` — **no test-runner dependency**; the only devDependency added was `socket.io-client`, needed to drive the socket layer | `server/package.json` |
| Tests spawn the **real server as a child process**, so they exercise config validation, the Mongo connection and the startup presence reset rather than an imported app object | `server/test/helpers/harness.js`, `start()` |
| They run against a throwaway `chatapp_test` database dropped on teardown, so they cannot touch development data | `server/test/helpers/harness.js`, `TEST_DB` and `stop()` |
| Areas covered, one file each: authentication and ownership, admin, realtime, moderation, mentorship, goals, sessions, analytics (including assignment streaks), conversations, group reads, feedback, resources, assignments, attachments, the Copilot trust boundary, startup | `server/test/*.test.js` |
| A Playwright harness screenshots each route at two viewport widths and fails on an unexpected redirect or any console error | `scripts/screenshot.mjs` (108 lines) · `npm run screenshot` |

### Database

| Fact | Source |
| --- | --- |
| Local development database holds **3** user records — one per role — 3 messages, 1 group, 1 mentorship, 1 assignment with 1 hand-in and 1 stored file, and 0 goals, sessions, resources, announcements or reports | `mongodb://127.0.0.1:27017/chatapp`, `countDocuments()` per collection |

---

## 3. Technical decisions

**Two-layer identity with one translation point.** Firebase Auth answers
authentication; the MongoDB `_id` is the application identity every feature
keys off. The two are joined only in `POST /api/auth/login`, so no other module
knows Firebase exists.

**JWT verification without the Firebase Admin SDK.** Fetch Google's public x509
certificates, select by the `kid` in the JWT header, verify the RS256
signature, and pin audience and issuer. Removes the need for a service-account
secret, so the server runs from a clone with one public environment variable.

**Socket authentication at the handshake.** `io.use()` verifies the token once
on connect and pins the user to `socket.data.user` for the connection's
lifetime. Event payloads carry no sender id, so a client cannot act as another
user by editing a field.

**Three broadcast topologies for three message shapes.** Direct messages fan
out through an in-memory `Map` of user id to the **set** of that user's open
sockets, so every tab stays in step; group messages go to a Socket.IO room
named `group:<id>`; announcements use a global `io.emit`, because a public
broadcast has no room meaning "everyone".

**Presence derived from connection transitions, not from events.** Online
status is written only when a user's socket set becomes non-empty and cleared
only when it empties, so extra tabs neither re-announce nor prematurely mark
someone offline. Stale flags left by a crash are cleared once at startup, since
no socket can survive a restart.

**Role checks and ownership checks kept distinct.** Announcement deletion checks
authorship rather than role — a role check alone would let any mentor delete
another mentor's posts. The self-service role endpoint refuses to touch anyone
but the caller; the admin endpoint refuses to touch the caller. Deliberately
opposite rules.

**Privilege escalation closed by making a role unassignable.** The `admin` role
is granted only from an environment allowlist at sign-in. The role picker, the
profile switcher, the self-service endpoint and the admin endpoint all reject
it, so a compromised admin account cannot create further admins.

**Suspension enforced at the authentication layer, not per route.** One check
in `requireAuth` and one in the socket handshake lock a suspended account out
of everything, because a per-route check is only as good as the route somebody
forgets to add it to. Login is the deliberate exception, so the person can be
shown why instead of failing blankly.

**Moderation records that survive their subject.** A report stores the target
as a type plus an id rather than a Mongoose `ref`, since it can point at four
different collections and `refPath` would break exactly when a moderator
deletes the reported content. A `targetSnapshot` copies the text at report
time so the queue stays readable afterwards.

**A relationship with a one-way lifecycle.** `Mentorship` moves
pending → active → ended, or pending → declined, and never backwards. Starting
again creates a new record rather than reviving the old one, so the history of
who asked whom and what was answered stays intact. Who may make each move
differs: only the mentor can accept or decline, but *either* party can end an
active mentorship without the other's agreement.

**Goals belong to a mentorship, not to a person.** "Priya's goals" is
ambiguous the moment she has two mentors; "the goals of this mentorship" never
is. Milestones are embedded subdocuments rather than their own collection —
they are only read as part of their goal and have no independent life — and
Mongoose still gives each an `_id`, so the toggle route can address one
directly.

**Goal status is derived, never stored independently.** `active` and
`completed` are recomputed from the milestones on every change, so the summary
can never disagree with the data underneath it. `archived` is the one status a
person sets, because "we are not doing this any more" is not something the
milestones can imply. A goal with no milestones is never complete — 0 of 0
reading as 100% would be a lie.

**The goal permissions are asymmetric on purpose.** Only the mentor may set or
edit a goal; *either* party may tick a milestone. The student does the work
and reports it, the mentor can correct a mistake without asking, and `doneBy`
records which of them it was — so "the student says it's done" stays
distinguishable from "the mentor confirmed it".

**Scheduling is a two-party handshake, and the goal permissions are inverted
for it.** Either party may propose a session; the *other* one confirms it, and
the proposer is refused if they try to confirm their own. A goal is a directive
so it belongs to the mentor, but asking for time is not — the student asking
"can we meet Thursday?" is the common case. Rescheduling returns the session to
`proposed` and makes the mover the proposer, because a confirmed time that
changed silently would leave both people certain they had agreed on different
things. `completed` and `cancelled` are terminal, and a session cannot be
marked done before its start time has passed.

**Analytics is built around a question, not a scoreboard.** The per-mentorship
rows are sorted by how long it has been since a session actually happened, so
the relationship that has gone quiet is at the top rather than buried in a
list of totals. Counting runs as a MongoDB aggregation — `$group` with
`$size`/`$filter` over the embedded milestones — rather than pulling every goal
document across the wire to read a boolean. Archived goals contribute no
milestones, because a goal that was abandoned would otherwise drag the
completion figure down permanently, and a number that never recovers is one
people learn to ignore.

**Insert-versus-update detection on an upsert.** The login upsert passes
`includeResultMetadata` and reads `lastErrorObject.upserted` to tell a
first-ever sign-in from a returning one, which drives a "new user" broadcast
without announcing every login.

**Server-echoed messages instead of optimistic rendering.** The server
broadcasts the saved record back to the sender as well as the recipient, so
every client renders the same database-confirmed message and no local copy needs
reconciling.

**Design tokens with CSS Modules.** Every colour, space and type size resolves
to a custom property; component styles are scoped by CSS Modules. Replaced eight
duplicated inline style objects and 34 hardcoded colour literals, and added the
app's first responsive layout.

**Compile-time removal of the development auth bypass.** The frontend bypass is
guarded by `import.meta.env.DEV`, which Vite replaces with a literal `false`, so
dead-code elimination removes the branch from production output rather than
leaving it disabled at runtime.

---

## 4. Tech stack

Taken only from `package.json`, `server/package.json` and `eslint.config.js`.

**Frontend** — React 18.2, React Router 6.23, Vite 5.4, socket.io-client 4.8,
firebase 10.12 (Auth only), CSS Modules

**Backend** — Node.js, Express 5.1, Socket.IO 4.8, Mongoose 8.19, jsonwebtoken
9.0, cors 2.8, dotenv 17.2

**Retrieval service** — Python 3.11, FastAPI, uvicorn, pymongo,
sentence-transformers 6.1 (`BAAI/bge-small-en-v1.5`), MongoDB Atlas Vector Search via
the `mongodb-atlas-local` container

**Data and tooling** — MongoDB, ESLint 9.39 (flat config),
eslint-plugin-react-hooks 7.1, eslint-plugin-react-refresh 0.5, Playwright 1.62

**No model is trained here.** The embedding model is pre-trained and used as
is; the engineering is in what gets indexed, how it is filtered, and how that
is measured. There are no notebooks and no datasets in this repository.

---

## 5. Not implemented

- **No deployment pipeline.** CI runs the linter, a build and the tests on
  every push, but nothing deploys; there is no environment to deploy to.
- **No frontend tests.** The 478 tests cover the server. React components are
  checked only by the Playwright screenshot harness, which catches render
  failures and console errors but asserts nothing about behaviour — and that
  harness is not in CI, because it needs both servers and a browser.
- ~~The mentorship, goal, session and analytics endpoints are not yet in the
  test suite.~~ **Resolved.** Every server feature is covered; the suite has
  gone from 105 to 478 as features were added.
- **Never deployed.** No Dockerfile, Procfile, or Vercel, Netlify, Render or Fly
  configuration. It runs on localhost only.
- **No rate limiting.** A signed-in client can flood messages or announcements
  unchecked.
- **Pagination exists server-side but is unused.** The group history endpoint
  accepts `?limit` and `?before`; no page calls either. The announcement feed is
  capped at 50 on the server.
- **Read receipts are one-to-one only.** Group messages have no read state.
- **Sessions never leave the app.** No calendar export, no invitations, no
  reminder before one starts. Times are stored as UTC and rendered in each
  viewer's own timezone, so two people in different places agree on the
  moment — but nothing tells either of them it is coming.
- **Announcements cannot be edited** — only posted and deleted.
- **Presence is unreliable by construction.** "Online" means "holds a live
  socket", and `POST /api/auth/login` sets the flag before any socket connects,
  so a user who closes the tab immediately stays marked online.
- **Presence state is in-memory.** The user-to-socket `Map` does not survive a
  restart and does not work across more than one server process.
- **The Copilot has no interface yet.** The route and the retrieval service
  work end to end, but nothing in React calls them; it is exercised by tests
  and by a scripted request.
- **The Copilot does not write prose.** It returns ranked chunks with scores
  and their sources. Generation is deliberately still absent, and the
  evaluation gave a concrete reason to keep it that way until there is a
  grounding check: a confident retrieval score does not mean the answer is in
  the retrieved text.
- **Retrieval is measured on a corpus of eleven sources.** recall@5 is nearly
  free at that size; only recall@1 and MRR discriminate, and the corpus is
  synthetic. The defensible claim is that the pipeline was measured and
  improved, not that it scores well in general.
- **The Python service is not in CI.** It needs Docker, a container image and a
  model download; the Node suite proves the access rules without any of them,
  and that is what runs on every push.
- **No mentor matching.** A student finds a mentor by opening their profile
  from the Messages list; nothing suggests one.
- **Feedback ratings are built but switched off.** The `Feedback` model, three
  endpoints and their tests are live; the UI is hidden behind
  `FEATURES.sessionRatings` in `src/lib/features.js`, so the code cannot rot
  while dormant.
- **Achievements were built and then removed.** Badges derived from goals and
  sessions existed for six commits; they set challenges the platform is not
  about, and assignment streaks replaced them.
- **Notifications are in-app only.** A sidebar count of work waiting on you and
  a transient line under the header when work is set, handed in or answered.
  Nothing is stored, so a notice that arrives while you are signed out is gone;
  there is no email and no push.

The repository's own documentation was checked against the code while compiling
this brief: every claim in `README.md` holds, including the `?limit` / `?before`
support and the 50-item announcement cap. There is no README-versus-code drift
to disclose.

---

## 6. Unverified — do not use

No evidence exists for any of the following. Each is the kind of figure an
interviewer will ask you to substantiate, and none can be.

- **User counts of any kind** — registered, active, concurrent. The database
  holds three development accounts, one per role, all the author's.
- **Message or traffic volume.** The development database holds three messages
  and one group; nothing that could be called traffic.
- **Latency, throughput or response-time figures.** Nothing was benchmarked or
  instrumented.
- **Concurrent connection capacity or load-test results.** Never load tested.
- **Uptime or availability.** The application has never been hosted.
- **Test coverage percentage.** 478 tests exist, but no coverage tool has been
  run, so any percentage would be invented. Cite the test count, not coverage.
- **Lighthouse, Core Web Vitals or accessibility audit scores.** Accessibility
  work was done — keyboard-operable rows, `useId`-associated labels,
  `aria-live` announcements, `:focus-visible` rings — but never scored by a
  tool, so describe the work, not a number.
- **Security assessment or penetration testing.** The authentication was checked
  by hand against the cases listed above; that is not an audit.

---

## Lines you can actually use

Drawn only from section 2. Each is defensible if questioned.

> Built a real-time mentorship platform (React, Express, Socket.IO, MongoDB)
> with 57 authenticated REST endpoints and 12 Socket.IO handlers across three
> broadcast topologies: unicast for direct messages, rooms for groups, global
> emit for announcements.

> Implemented Firebase ID token verification from first principles — RS256
> signature checking against Google's rotating public certificates with audience
> and issuer pinning — removing the service-account dependency of the Firebase
> Admin SDK.

> Designed a three-role permission model enforced server-side, separating role
> checks from ownership checks, and made the admin role unassignable through any
> endpoint so a compromised admin account cannot create more.

> Replaced eight duplicated inline style objects and 34 hardcoded colour
> literals with a CSS-Modules design system over custom-property tokens, adding
> the application's first responsive layout.

> Retrofitted authentication onto an existing socket layer, moving sender
> identity from client-supplied payloads to the verified handshake, covered by
> a test asserting that a forged sender id is attributed to the authenticated
> user instead.

> Built a 478-test integration suite on Node's built-in test runner with no
> runner dependency, spawning the real server against a throwaway database so
> tests cannot touch development data, covering authentication, ownership,
> role gates, socket identity, group membership, multi-tab presence, and the
> mentorship, goal, session, assignment and file-attachment rules.

> Built a mentorship-scoped retrieval service (FastAPI, sentence-transformers,
> MongoDB Atlas Vector Search) in which the permission filter runs inside the
> vector query rather than over its results, with tests proving that a user
> outside a mentorship retrieves nothing from it and that the access check
> happens in Express, before the service is reachable.

> Evaluated that pipeline against a 65-question labelled set over a seeded
> corpus, in two groups, raising recall@1 on typed-in text from 0.55 to 0.71 by moving
> to an embedding model with twice the context window, and reaching 0.93 on
> questions about attached documents. Found that a cross-encoder reranker
> adopted on an earlier corpus was a mixed result on this one (+0.03 on
> records, −0.06 on documents, 370 ms per search) — and that its apparent
> "no gain" depended on which labels were used, so labelling now precedes
> measurement. Established that almost no configuration separates answerable
> from unanswerable questions by score, so abstention has to come from a
> grounding check rather than a threshold.

> Designed a Classroom-style assignment model: one brief shared across several
> students, each with an independent hand-in, draft and unsubmit states, an
> append-only history of every move, and file attachments stored in MongoDB
> GridFS and served only to the student and the mentor who set the work.
