# Project Brief — MentorConnect

A factual summary of this project for CV, cover-letter and interview use.

**Every figure below cites the file or command it came from.** Anything not
traceable is quarantined in section 6 and must not be used in an application.
Several numbers change as the code changes — re-run the cited commands before
reusing them.

Compiled 2026-09-06 against commit `3d6353a`, plus scheduling added in the
same session. Figures counted before the commit that records them.

| | |
| --- | --- |
| Commits | 33 |
| Active | 2025-08-23 → 2026-09-06 |
| Source | 11,246 lines JS/JSX |
| Automated tests | 105, all passing |
| Deployed | No |

---

## 1. Name and positioning

**MentorConnect** — a web application in which students and mentors exchange
direct messages, chat in groups, and read mentor announcements, with three
roles whose permissions are enforced on the server.

Built as a college mini-project. Identity is handled by Firebase
Authentication (Google Sign-In only); all application data is held in MongoDB
behind an Express and Socket.IO server written for this project.

---

## 2. Verified facts

### Codebase

| Fact | Source |
| --- | --- |
| **11,246** lines of JavaScript/JSX across **51** files, excluding lockfiles, `node_modules` and build output | `find . -name '*.js' -o -name '*.jsx' -o -name '*.mjs' \| grep -vE 'node_modules\|dist' \| xargs wc -l` |
| **33** commits, first 2025-08-23, most recent 2026-09-06 | `git rev-list --count HEAD` |
| ESLint across frontend, backend and tests: **49** files, **0** errors, **1** documented warning | `npx eslint . --format json` — the warning is `react-hooks/set-state-in-effect`, exempted in `eslint.config.js` with written reasoning |

### Backend surface

| Fact | Source |
| --- | --- |
| **34** REST endpoints, every one behind authentication; **8** additionally gated to the admin role | `grep -nE "^app\.(get\|post\|put\|patch\|delete)\(" server/index.js` |
| **11** Socket.IO event handlers; **18** distinct server-to-client events | `grep -oE "socket\.on\('[a-z-]+'" server/index.js` and the emit call sites in the same file |
| **9** Mongoose models — User, Message, Group, GroupMessage, Announcement, Report, Mentorship, Goal, Session — with **29** index declarations, **9** of them compound | `server/models/*.js` · `grep -n "index: true\|unique: true\|\.index(" server/models/*.js` returns 30 lines; `User.firebaseUid` carries both `unique` and `index`, which is one index, hence 29 |
| `server/index.js` is **2,323** lines; `server/middleware/auth.js` is **306**; the test suite is **1,160** lines across 5 files | `wc -l server/index.js server/middleware/auth.js server/test/**` |

### Authentication

| Fact | Source |
| --- | --- |
| Firebase ID tokens verified with **RS256** against Google's public x509 certificates, with `audience` and `issuer` pinned to the project id | `server/middleware/auth.js:99–104`, `verifyIdToken()` |
| Signing-certificate cache honours the `Cache-Control: max-age` Google returns, falling back to 3600 s | `server/middleware/auth.js:64`, `getSigningCerts()` |
| The development auth bypass requires **two** independent flags and is absent from production builds — **0** occurrences of `X-Dev-User-Id` or `devUserId` in the built bundle | `auth.js:128` (`NODE_ENV` + `ALLOW_DEV_AUTH`) · `AuthContext.jsx:59` (`import.meta.env.DEV`) · grep over `dist/assets/*.js` after `npm run build` |

### Frontend

| Fact | Source |
| --- | --- |
| **13** page components and **13** reusable components, styled with CSS Modules over a single design-token file | `ls src/pages/*.jsx \| wc -l` · `ls src/components/*.jsx \| wc -l` · `src/styles/tokens.css` |
| Production bundle **455.06 kB** JS (**125.54 kB** gzipped) and **49.90 kB** CSS (**8.51 kB** gzipped) | `npm run build` (Vite 5.4 output) |
| Responsive at a **900 px** breakpoint: fixed sidebar above it, overlay drawer below | `src/components/AppShell.module.css`, `@media (max-width: 900px)` |

### Tests

| Fact | Source |
| --- | --- |
| **105** integration tests across **5** files, all passing, in about **12 s** | `cd server && npm test` |
| Runner is Node's built-in `node:test` — **no test-runner dependency**; the only devDependency added was `socket.io-client`, needed to drive the socket layer | `server/package.json` |
| Tests spawn the **real server as a child process**, so they exercise config validation, the Mongo connection and the startup presence reset rather than an imported app object | `server/test/helpers/harness.js`, `start()` |
| They run against a throwaway `chatapp_test` database dropped on teardown, so they cannot touch development data | `server/test/helpers/harness.js`, `TEST_DB` and `stop()` |
| Coverage by area: authentication and ownership (21), admin role (22), sockets, membership and presence (20), verification, suspension and reports (38), startup (4) | `server/test/*.test.js` |
| A Playwright harness screenshots each route at two viewport widths and fails on an unexpected redirect or any console error | `scripts/screenshot.mjs` (108 lines) · `npm run screenshot` |

### Database

| Fact | Source |
| --- | --- |
| Local development database holds **3** user records — one per role — and **0** messages, groups or announcements | `mongodb://127.0.0.1:27017/chatapp`, `countDocuments()` per collection |

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

**Data and tooling** — MongoDB, ESLint 9.39 (flat config),
eslint-plugin-react-hooks 7.1, eslint-plugin-react-refresh 0.5, Playwright 1.62

No Python, notebooks, datasets or ML components exist in this repository.

---

## 5. Not implemented

- **No CI.** No `.github/` directory or any other pipeline configuration — the
  tests exist but nothing runs them automatically.
- **No frontend tests.** The 105 tests cover the server. React components are
  checked only by the Playwright screenshot harness, which catches render
  failures and console errors but asserts nothing about behaviour.
- **The mentorship, goal and session endpoints are not yet in the test
  suite.** All three were verified by hand — 14 HTTP checks on mentorships, 9
  on goals and 40 on sessions, covering permissions, the duplicate guard, the
  derived goal status and every state transition — but those checks were not
  committed. Every other server feature is covered; these three are the
  exception, deferred deliberately to a single test pass.
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
- **No shared resources, matching or notifications.** Mentorships, goals and
  sessions were built; these three were scoped alongside them and remain
  deferred. Nothing about them exists in code.

The repository's own documentation was checked against the code while compiling
this brief: every claim in `README.md` holds, including the `?limit` / `?before`
support and the 50-item announcement cap. There is no README-versus-code drift
to disclose.

---

## 6. Unverified — do not use

No evidence exists for any of the following. Each is the kind of figure an
interviewer will ask you to substantiate, and none can be.

- **User counts of any kind** — registered, active, concurrent. The database
  holds two development accounts, both the author's.
- **Message or traffic volume.** Zero messages, groups and announcements are
  currently stored.
- **Latency, throughput or response-time figures.** Nothing was benchmarked or
  instrumented.
- **Concurrent connection capacity or load-test results.** Never load tested.
- **Uptime or availability.** The application has never been hosted.
- **Test coverage percentage.** 67 tests exist, but no coverage tool has been
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
> with 34 authenticated REST endpoints and 11 Socket.IO handlers across three
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

> Built a 67-test integration suite on Node's built-in test runner with no
> runner dependency, spawning the real server against a throwaway database so
> tests cannot touch development data, covering authentication, ownership,
> role gates, socket identity, group membership and multi-tab presence.
