# Architecture Blueprint

Why this application is shaped the way it is.

`README.md` covers what exists and how to run it. `FEATURES_DOCUMENTATION.md`
maps course outcomes to code. `docs/BUILD_NOTES.md` logs each change as it was
made. **This document explains the structural decisions** — the ones that would
be expensive to reverse.

> **Historical note.** An earlier version of this file planned a
> Firestore + Server-Sent Events design under the name "MentorConnect". That
> architecture was built, then removed (see BUILD_NOTES Entry 1, which deleted
> 20 orphaned files). This document describes what the project actually is.

---

## 1. The two-layer split

```
   Browser                    Our server                   Data
  ┌──────────────┐          ┌──────────────────┐        ┌──────────┐
  │  React SPA   │  REST    │  Express         │        │          │
  │  (Vite)      │─────────▶│  routes          │───────▶│ MongoDB  │
  │              │          │                  │        │          │
  │              │ Socket   │  Socket.IO       │        │          │
  │              │◀════════▶│  handlers        │───────▶│          │
  └──────┬───────┘          └──────────────────┘        └──────────┘
         │
         │ Google sign-in popup
         ▼
  ┌──────────────┐
  │ Firebase Auth│   identity only — no application data
  └──────────────┘
```

**Firebase answers "who are you?". MongoDB answers "what is your data?".**

Firebase Auth runs the Google sign-in popup and returns a stable `uid`, email,
name and photo. That is *all* it does. It was kept for exactly one reason:
OAuth done correctly is a lot of work and getting it wrong is a security
problem, whereas everything else in this app is ordinary CRUD we can own.

**The consequence that matters:** on every sign-in the frontend calls
`POST /api/auth/login`, which upserts a MongoDB user and returns its document.
From then on the **Mongo `_id` — not the Firebase `uid` — is the identity every
feature keys off.** Messages, group membership, announcements and presence all
reference it. A single translation point at login means the rest of the system
never has to know Firebase exists.

*The tradeoff:* two sources of truth about a person. Display name and photo
belong to Google and are re-synced on each login; bio, role, expertise and
availability belong to us. The profile UI states this explicitly rather than
pretending the Google fields are editable.

## 2. REST for state, sockets for change

Both transports run on one HTTP server (`http.createServer(app)` shared by
Express and Socket.IO), and the split is deliberate:

| | Used for | Why |
| --- | --- | --- |
| **REST** | history, user lists, profiles, creating things | Request/response, cacheable, easy to reason about and to test with `curl` |
| **Socket.IO** | new messages, typing, read receipts, presence, announcements | Server-initiated; polling for these would be wasteful and laggy |

A page typically does both: fetch the current state once over REST, then
subscribe over the socket for everything that happens next. `UsersPage` is the
clearest example — one `/api/users` fetch, then live `user-status-change`
events maintain the online set.

**Three broadcast shapes**, which is the part worth understanding:

- **Direct message** → one socket. The server keeps an in-memory
  `userId → socket.id` map and emits to that id.
- **Group message** → a room. Sockets `join('group:<id>')`, and the server
  emits to the room.
- **Announcement** → everyone. `io.emit`, because a public broadcast has no
  room that means "all users".

*Known gap:* the in-memory socket map does not survive a server restart or
scale to multiple server processes. For a single-instance project this is the
right amount of machinery; a second instance would need a Redis adapter.

## 3. Authorization: the database is the authority

The student/mentor role gates two capabilities — creating groups and posting
announcements. The rule that makes this real:

> **The client's copy of who you are is a hint. The database's copy is the
> fact.**

Every gated endpoint does a `findById` on the caller and checks the **stored**
role before writing anything. None of them trust a role sent in the request
body, and none cache it. So a student who edits the payload still gets a `403`,
and a user who switches role is governed by the new one immediately.

The UI hides what you cannot do — no create form, no compose box, with a note
explaining why — but **UI hiding is convenience; the server check is
enforcement.** Both exist on purpose, and they are not redundant: one is for
usability, the other for correctness.

**Role checks and ownership checks are different.** Deleting an announcement
checks *authorship*, not role. A role check alone would let any mentor delete
another mentor's notices.

## 4. Data model

```
User ──────┬──< Message (sender, receiver)
           │
           ├──< GroupMessage (sender)
           │
           ├──< Announcement (author)
           │
           └──< Group (createdBy, members[])
```

Design choices worth naming:

- **One `User` document, not a separate mentor profile collection.**
  Mentor-only fields (`expertise`, `availability`) live on every user document
  and stay empty for students. With three small fields a second collection
  would mean a join for no benefit. If mentor profiles later grow —
  credentials, session history, rates — splitting them becomes the better call.
- **`role` has no default; profile fields default to `''`.** Deliberately
  inconsistent. "Hasn't picked a role yet" is a state the app must detect, so
  `role` being absent is meaningful. An empty bio and an absent bio mean the
  same thing, so defaulting to `''` costs nothing and keeps React inputs
  controlled.
- **No role snapshot on `Announcement`.** Storing `authorRole` alongside each
  announcement would go stale the moment someone switches role. The author is a
  reference and the role is read through `.populate()`.
- **Populates stay lean.** Message and group populates select only
  `displayName photoURL role` — enough to render a bubble or a member row.
  Attaching a 500-character bio to every message would bloat payloads for no
  benefit; the full profile is fetched on demand from `GET /api/user/:id`.

## 5. What this design does not do

Honest limits, so they are decisions rather than oversights:

- **No server-side token verification.** No route proves a caller is who they
  claim to be. This is the single largest gap, and it is uniform rather than
  patchy — which is why the fix is one piece of work (verify the Firebase ID
  token in middleware on every mutating route) rather than a scatter of
  patches. Section 3 still holds under it: a client cannot *promote* itself,
  but it could *impersonate* another user by sending their id.
- **Socket handlers are not gated.** `join-group` places any socket in any
  room, and `send-group-message` trusts the `senderId` it is given. The REST
  layer is authorized; the socket layer is not yet.
- **No pagination in the UI.** The group history endpoint supports `?limit` and
  `?before`, but no page uses them; the announcement feed is capped at 50
  server-side. Fine at project scale, the first thing to revisit at real scale.
- **Presence is connection-based.** "Online" means "has a live socket". A
  half-closed connection can leave a stale green dot until the socket times
  out.
