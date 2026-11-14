# Repository audit, 2026-11-14, and the hardening batch that followed

An independent, read-only audit of the whole repository, done at the human's request by a different
model from the one that built it. This file is the record: what was found, how each finding was
confirmed, and what was changed because of it. Each step's detail is in its BUILD_NOTES entry.

**Status column:** `open`, or the BUILD_NOTES entry that fixed it. Update it in the commit that changes it.

## What was covered

Read in full: `server/middleware/auth.js`; in `server/index.js` the setup, auth, chat, groups, admin,
moderation, mentorship, goals, sessions, resources, feedback, file upload and download, Copilot search,
agent, proposals, the internal tool endpoint and every socket handler; the security helpers in
`server/lib`; the User, Message and Mentorship models; CI and package configuration.

Sampled, not read in full, so **not vouched for**: the assignment and submission routes, criteria and
coverage routes, `/copilot/ask`, analytics, `agentWrites.js`, `agentTools.js`, most of `ai/` beyond
`app.py`'s routes and the retrieval filter in `store.py`, and most frontend components beyond
`AuthContext`, the chat pages and `AdminPage`.

Checks run at the audit (commit 80d37f0): lint 0 errors and 3 warnings; server tests 1176/1176;
frontend browser tests 230/230; AI service tests 1337 passed and 3 skipped; `npm audit --omit=dev`
10 advisories in `server/`, 20 in the root package. The production build was not run.

## Findings

| # | Finding | Severity | How confirmed | Status |
|---|---|---|---|---|
| F1 | Any signed-in user could stop the server with one socket event: `typing`, `stop-typing`, `group-typing`, `group-stop-typing` with no payload, or `join-group` with a non-id. Handlers had nothing around them and the process has no last-resort handler. | High | Run: the server exited with code 1 on each; a well-formed control event did not | Entry 148 |
| F2 | Chat history (1-to-1 and group) sorts oldest-first and then limits to 50, and the client asks for no more: past 50 messages a reload shows the oldest 50 and nothing newer. `limit` is unbounded and unvalidated. | High | Code | Entry 149 |
| F3 | `POST /api/reports` snapshots its target without checking the reporter can see it, and returns the snapshot: any message, group message or user's email, given its id. | Medium | Code | open |
| F4 | A mentor's verification `linkedinUrl` is stored without a scheme check and shown to the admin as a link, so it can be a `javascript:` URL. Any user can make themselves a mentor. | Medium | Code; not tried in a browser | open |
| F5 | Sign-in takes the email from the request body when the token has none, and never checks `email_verified`; the admin allowlist is matched on that email. Not reachable with Google sign-in only. | Medium, depends on Firebase settings | Code | open |
| F6 | Whole user documents (email, Firebase uid, verification details and review note, suspension reason) go to every signed-in user: `/api/users`, `/api/user/:id`, and the `user-added` and `user-updated` broadcasts. | Medium | Code | open |
| F7 | Known advisories in production dependencies, among them `mongoose` and `multer` directly, and `ws`, `socket.io-parser`, `body-parser`, `path-to-regexp` beneath. | Medium | `npm audit`; each advisory not verified | open |

## Hardening gaps, and the rest of the batch

| # | Item | Status |
|---|---|---|
| H1 | No rate limiting except Copilot asks: messages, reports, uploads and sign-in are unlimited | open |
| H2 | REST CORS reflects any origin (item 13: origins from config, local dev origins by default, an unlisted origin refused) | open |
| H3 | No security headers (item 14: one middleware, without breaking download headers or the Vite dev setup) | open |
| H4 | The signing-certificate fetch has no timeout, and an unknown key id does not refetch | open |
| H5 | `/search` on the AI service lacks the loopback check every other route has | open |
| H6 | CI does not run the Python suite; the real token verification path has no test (every test signs in through the dev header) | open |
| H7 | `server/index.js` is one 6,000-line file; every route repeats the same catch-and-500 | open |
| H8 | `/api/users`, `/api/groups` and history are unpaginated; the message indexes do not carry `timestamp` | history and the message indexes: Entry 149; users and groups: open |
| H9 | Group `memberIds` are not validated; stale comments (`index.js` "there is no token check" above one); `.gitignore` ignores `package-lock.json` though both lockfiles are tracked | open |

## Decided by the human, 2026-11-14

- **Hosting: local only.** No deployment files. Revisited if a public link is ever needed.
- **No shared store** for presence and limits: one instance.

## Left alone on purpose

The agent's token, proposal and re-check design; retrieval permissions inside the vector query; plain
HTTP calls to the providers with an explicit call budget; the pinned embedding stack; GridFS file
handling; the test harness that starts the real server on a throwaway database. Not worth doing now:
a TypeScript rewrite, a retrieval framework, Redis, or `firebase-admin` in place of the present
token check.
