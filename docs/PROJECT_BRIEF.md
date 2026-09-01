# Project Brief — MentorConnect

A factual summary of this project for CV, cover-letter and interview use.

**Every figure below cites the file or command it came from.** Anything not
traceable is quarantined in section 6 and must not be used in an application.
Several numbers change as the code changes — re-run the cited commands before
reusing them.

Compiled 2026-09-02 against commit `f92b95f`.

| | |
| --- | --- |
| Commits | 26 |
| Active | 2025-08-23 → 2026-09-01 |
| Source | 5,936 lines JS/JSX |
| Automated tests | 0 |
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
| **5,936** lines of JavaScript/JSX across **36** source files, excluding lockfiles | `git ls-files '*.js' '*.jsx' '*.mjs' \| grep -v package-lock \| xargs wc -l` |
| **26** commits, first 2025-08-23, most recent 2026-09-01; **106** distinct files touched across history | `git rev-list --count HEAD` · `git log --format="" --name-only \| sort -u \| wc -l` — counted before the commit that adds this file, which makes it 27 |
| ESLint across frontend and backend: **36** files, **0** errors, **1** documented warning | `npx eslint . --format json` — the warning is `react-hooks/set-state-in-effect`, exempted in `eslint.config.js` with written reasoning |

### Backend surface

| Fact | Source |
| --- | --- |
| **16** REST endpoints, every one behind authentication; **3** additionally gated to the admin role | `grep -nE "^app\.(get\|post\|put\|patch\|delete)\(" server/index.js` |
| **11** Socket.IO event handlers; **15** distinct server-to-client events | `grep -oE "socket\.on\('[a-z-]+'" server/index.js` and the emit call sites in the same file |
| **5** Mongoose models — User, Message, Group, GroupMessage, Announcement — with **10** index declarations, **3** of them compound | `server/models/*.js` · `grep -n "index: true\|\.index(" server/models/*.js` |
| `server/index.js` is **1,189** lines; `server/middleware/auth.js` is **281** | `wc -l server/index.js server/middleware/auth.js` |

### Authentication

| Fact | Source |
| --- | --- |
| Firebase ID tokens verified with **RS256** against Google's public x509 certificates, with `audience` and `issuer` pinned to the project id | `server/middleware/auth.js:99–104`, `verifyIdToken()` |
| Signing-certificate cache honours the `Cache-Control: max-age` Google returns, falling back to 3600 s | `server/middleware/auth.js:64`, `getSigningCerts()` |
| The development auth bypass requires **two** independent flags and is absent from production builds — **0** occurrences of `X-Dev-User-Id` or `devUserId` in the built bundle | `auth.js:128` (`NODE_ENV` + `ALLOW_DEV_AUTH`) · `AuthContext.jsx:59` (`import.meta.env.DEV`) · grep over `dist/assets/*.js` after `npm run build` |

### Frontend

| Fact | Source |
| --- | --- |
| **10** page components and **11** reusable components, styled with CSS Modules over a single design-token file | `ls src/pages/*.jsx \| wc -l` · `ls src/components/*.jsx \| wc -l` · `src/styles/tokens.css` |
| Production bundle **415.19 kB** JS (**115.12 kB** gzipped) and **38.33 kB** CSS (**7.03 kB** gzipped); build completes in about **1.4 s** | `npm run build` (Vite 5.4 output) |
| Responsive at a **900 px** breakpoint: fixed sidebar above it, overlay drawer below | `src/components/AppShell.module.css`, `@media (max-width: 900px)` |

### Manual verification performed

These runs happened and are recorded in `BUILD_NOTES.md`, but the scripts were
ad hoc and **are not committed**, so a reader cannot reproduce them from the
repository. Describe them as manual testing, **never** as a test suite.

| Fact | Source |
| --- | --- |
| **15** HTTP and socket checks of authentication and ownership, including a spoofing check in which a message sent with a forged sender id was stored against the authenticated user instead | `BUILD_NOTES.md`, Entry 15 |
| **8** checks of the admin role: allowlist promotion, 403s for non-admins, and refusal to grant admin or self-demote | `BUILD_NOTES.md`, Entry 16 |
| A committed Playwright harness screenshots each route at two viewport widths and fails on an unexpected redirect or any console error | `scripts/screenshot.mjs` (108 lines) · `npm run screenshot` |

### Database

| Fact | Source |
| --- | --- |
| Local development database holds **2** user records, **0** messages, **0** groups, **0** announcements | `mongodb://127.0.0.1:27017/chatapp`, `countDocuments()` per collection |

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

**Three broadcast topologies for three message shapes.** Direct messages
unicast through an in-memory `Map` of user id to socket id; group messages go to
a Socket.IO room named `group:<id>`; announcements use a global `io.emit`,
because a public broadcast has no room meaning "everyone".

**Role checks and ownership checks kept distinct.** Announcement deletion checks
authorship rather than role — a role check alone would let any mentor delete
another mentor's posts. The self-service role endpoint refuses to touch anyone
but the caller; the admin endpoint refuses to touch the caller. Deliberately
opposite rules.

**Privilege escalation closed by making a role unassignable.** The `admin` role
is granted only from an environment allowlist at sign-in. The role picker, the
profile switcher, the self-service endpoint and the admin endpoint all reject
it, so a compromised admin account cannot create further admins.

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

- **No automated tests.** No test files, no test script in either
  `package.json`, no test-runner dependency. The 23 verification checks
  described above were run by hand and the scripts were not kept.
- **No CI.** No `.github/` directory or any other pipeline configuration.
- **Never deployed.** No Dockerfile, Procfile, or Vercel, Netlify, Render or Fly
  configuration. It runs on localhost only.
- **No rate limiting.** A signed-in client can flood messages or announcements
  unchecked.
- **Pagination exists server-side but is unused.** The group history endpoint
  accepts `?limit` and `?before`; no page calls either. The announcement feed is
  capped at 50 on the server.
- **Read receipts are one-to-one only.** Group messages have no read state.
- **Announcements cannot be edited** — only posted and deleted.
- **Presence is unreliable by construction.** "Online" means "holds a live
  socket", and `POST /api/auth/login` sets the flag before any socket connects,
  so a user who closes the tab immediately stays marked online.
- **Presence state is in-memory.** The user-to-socket `Map` does not survive a
  restart and does not work across more than one server process.
- **No mentorship relationships, goals, sessions, resources, matching or
  notifications.** These were scoped and deliberately deferred; nothing about
  them exists in code.

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
- **Test coverage percentage.** There are no tests to cover anything.
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
> with 16 authenticated REST endpoints and 11 Socket.IO handlers across three
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
> identity from client-supplied payloads to the verified handshake, and
> confirmed by hand that a forged sender id is attributed to the authenticated
> user instead.
