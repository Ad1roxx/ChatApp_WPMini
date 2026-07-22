# Build Notes

A running, plain-language log of the meaningful changes made to this project.
Each entry records **what** was built, **which files** changed, the **design
decisions and their tradeoffs**, and an **end-to-end walkthrough** of how the
feature actually works. Newest entries are appended at the bottom.

The app in one sentence: a real-time chat application where **Firebase
Authentication** handles identity (Google Sign-In only) and a custom
**Express + Socket.IO + MongoDB** server handles all the data (users,
messages, groups, presence).

The two-layer split is worth internalising because everything below leans on it:

- **Firebase = "who are you?"** It runs the Google login popup and hands back a
  stable `uid`, email, name, and photo. That's all it does now.
- **MongoDB (via our server) = "what is your data?"** The moment Firebase
  confirms a login, the frontend calls `POST /api/auth/login`, which creates or
  updates a matching user document in Mongo and returns its `_id`. That Mongo
  `_id` — not the Firebase `uid` — is the identity every other feature keys off
  (messages, group membership, online status).

---

## 2026-07-18 — Session 1

### Starting point (context)

Before this session the repo had drifted: it contained a **new, lean
Socket.IO + MongoDB chat** (the three live pages: Login, Users, Chat) sitting
next to a large pile of **dead code from a previous "MentorConnect"
architecture** (Firestore + Server-Sent Events + mentor/student roles) that was
no longer wired into any route. The first commit of the session
(`f1d6f7e`, "Rework chat app…") simply captured that working state as a clean
rollback point before we started changing anything.

Everything below builds forward from there.

---

### Entry 1 — Dead-code cleanup

**Commit:** `9af969d` "Remove orphaned dead code from old Firestore/SSE architecture"

**What I did.** Deleted 20 files (1,636 lines) that were unreachable — imported
by nothing in the live app — and belonged to the abandoned Firestore design.

**Files removed:**

- **9 unrouted pages** — `Home.jsx`, `RegisterPage.jsx`, `Dashboard.jsx`,
  `MentorDashboard.jsx`, `FindAMentor.jsx`, `ChatsListPage.jsx`, `ChatsPage.jsx`,
  `AnnouncementsPage.jsx`, `EditProfilePage.jsx` (all under `src/pages/`).
- **10 components** used only by those dead pages — `Avatar.jsx`, `Composer.jsx`,
  `DayDivider.jsx`, `Footer.jsx`, `Header.jsx`, `MessageBubble.jsx`,
  `NewChatModal.jsx`, `RecordsList.jsx`, `Toast.jsx`, `TopBar.jsx`
  (all under `src/components/`).
- **1 unused stylesheet** — `src/Pages.css` (never imported anywhere; only
  `App.css` is loaded, via `main.jsx`).

**Why this was safe — and how I proved it.** The danger with deleting code is
deleting something still in use. I traced the entire **live import graph**
starting from the two entry points (`main.jsx` and `App.jsx`) and followed every
`import` transitively. The complete set of files the running app depends on is
just: `main.jsx`, `App.jsx`, `firebase.js`, `context/AuthContext.jsx`, the three
pages `LoginPage/UsersPage/ChatPage`, and the two CSS files `index.css` +
`App.css`. None of them referenced any deleted file. I confirmed with a
project-wide search (only matches were inside code *comments*, e.g. `{/* Header */}`,
not real imports) and then with the ultimate proof: **`npm run build` succeeded**.
Vite resolves the whole import graph at build time, so a dangling reference to a
deleted file would have failed the build. It went from 80 modules to fewer with
zero errors.

**Design decision & tradeoff.** The alternative to deleting was to *keep* the old
pages and rewire them onto the new MongoDB backend. I chose deletion because
several of those files were not merely unused but actively **broken**: e.g.
`EditProfilePage.jsx` imported `db` and `storage` from `firebase.js`, but the
rewritten `firebase.js` only exports `auth` — so that page would have crashed the
instant it rendered. Keeping broken, unreachable code around is a liability (it
misleads readers and risks someone wiring it back in). The tradeoff: if we later
want those features (profile editing, file uploads, announcements), they'll be
rebuilt against MongoDB rather than salvaged — but they'd have needed a near-total
rewrite anyway.

**End-to-end effect.** Nothing changed for the user; this was pure subtraction.
The value is for *us*: `src/` now contains only files that actually run, so
reading the codebase no longer means guessing which half is real.

---

### Entry 2 — Group chat backend

**Commit:** `92c3471` "Add group chat backend: models, REST API, and Socket.IO events"

**What I built.** The complete server side of group chat — data models, REST
endpoints, and real-time socket events — added **without touching the existing
1-to-1 flow at all**.

**Files added:**

- `server/models/Group.js` — a group: `name`, `members[]` (array of User
  ObjectIds), `createdBy`, `createdAt`. Indexed on `members` so "find all groups
  for user X" is fast.
- `server/models/GroupMessage.js` — a message posted to a group: `group`,
  `sender`, `text`, `timestamp`. A compound index on `{ group, timestamp }` makes
  loading one group's history in time-order efficient.

**File changed:**

- `server/index.js` — added the two model imports, four REST endpoints, and five
  socket events. All additive.

**The central design decision: a separate `GroupMessage` model vs. extending the
existing `Message` model.** The 1-to-1 `Message` model has a required `sender`
*and* `receiver`. I could have bolted groups onto it by adding an optional
`group` field and making `receiver` optional. I deliberately **did not**, and
created a parallel `GroupMessage` collection instead.

- *Why separate wins here:* it guarantees the live, working 1-to-1 path is
  byte-for-byte untouched — no weakening of its "receiver is required" integrity,
  no risk of a group bug leaking into direct messages. The two concerns stay
  clean.
- *The tradeoff:* a little duplication (two message schemas that look similar),
  and if we ever build a unified "all my conversations" inbox we'd have to query
  two collections and merge. For a project at this stage, isolation and safety
  beat that future convenience.

**The second key decision: Socket.IO *rooms* for group broadcast.** 1-to-1 chat
delivers a message by looking up the single recipient's socket in an
`onlineUsers` map and emitting to that one socket id. That doesn't scale to N
group members. Groups instead use **Socket.IO rooms** — a room is just a named
channel (`group:<groupId>`); any socket that "joins" the room receives anything
broadcast to it. This is the idiomatic tool and it's why the group code looks
different from the 1-to-1 code.

**REST endpoints added:**

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/groups` | Create a group. Body: `name`, `createdBy`, `memberIds[]`. The creator is always folded into `members` and the list is de-duplicated, so you can't create a group you're locked out of. |
| POST | `/api/groups/:groupId/join` | Join a group. Uses Mongo's `$addToSet`, so joining twice never creates a duplicate membership. |
| GET | `/api/groups?userId=` | List groups a user belongs to (or all groups if no `userId`). |
| GET | `/api/groups/:groupId/messages` | Group message history, oldest-first, `sender` populated. Mirrors the 1-to-1 history endpoint. |

**Socket.IO events added (all inside the existing `io.on('connection')` block):**

| Event received | What the server does | Event emitted |
|---|---|---|
| `join-group` | `socket.join('group:'+id)` | — |
| `leave-group` | `socket.leave('group:'+id)` | — |
| `send-group-message` | save a `GroupMessage`, then broadcast | `new-group-message` |
| `group-typing` / `group-stop-typing` | relay to the room (sender excluded) | `group-user-typing` / `group-user-stop-typing` |

**End-to-end walkthrough (the important part).** Follow a single group message
from keypress to everyone's screen:

1. When a client opens a group, it emits **`join-group`** with the group id. The
   server runs `socket.join('group:<id>')` — that browser tab is now subscribed
   to the room's channel.
2. The sender emits **`send-group-message`** `{ groupId, senderId, text }`. The
   server first **saves it to MongoDB** (a `GroupMessage` document) — persistence
   happens *before* delivery, so nothing is lost even if delivery fails.
3. The server then does `io.to('group:<id>').emit('new-group-message', msg)` —
   this fans the saved message out to **every socket in the room, the sender
   included**.
4. That last point is a deliberate simplification versus 1-to-1 chat. Direct
   messages use *two* events — `new-message` to the receiver and a separate
   `message-sent` confirmation back to the sender. Groups collapse that into one:
   because the sender is in the room too, they receive their own message back
   through the same `new-group-message` broadcast. One code path, so "my message"
   and "their message" can never render differently.
5. Typing indicators use **`socket.to(room)`** (note: `socket.to`, not `io.to`) —
   that variant sends to everyone in the room *except* the sender, so you never
   see your own "typing…" bubble. These are relay-only; nothing is persisted.
6. **Durability guarantee:** because every message is written to Mongo before
   broadcast, a member who isn't currently in the room (app closed, or just hasn't
   opened the group) simply misses the *live* push but gets the message on their
   next `GET /api/groups/:id/messages`. Same model as 1-to-1.

**What was intentionally left out (backend scope):** per-member read receipts for
groups (the single `read` boolean doesn't map cleanly to N members — that needs a
`readBy[]` array), and membership enforcement on the socket events (a client could
technically emit to a group it isn't in; the 1-to-1 handlers have the same trust
model, so I kept it consistent rather than hardening only half the app). Both are
noted as future work.

---

### Entry 3 — Group chat frontend

**Commit:** `ab42f03` "Add group chat frontend: create/browse page and group chat view"

**What I built.** The UI that consumes the group backend, reusing the existing
page patterns, the `useAuth()` hook, and the `#3b82f6` blue styling so it feels
native to the app.

**Files added:**

- `src/pages/GroupsPage.jsx` (route `/groups`) — a hub with two sections: a form
  to **create** a group (name + a checklist of users to add), and a list to
  **browse/join** every group (each row shows **Open** if you're a member, or
  **Join** if not).
- `src/pages/GroupChatPage.jsx` (route `/group/:groupId`) — the group
  conversation view, a near-mirror of `ChatPage.jsx`.

**Files changed:**

- `src/App.jsx` — added two imports and two protected routes (`/groups`,
  `/group/:groupId`), guarded by the same `user ? <Page/> : <Navigate to="/login"/>`
  pattern as every other route.
- `src/pages/UsersPage.jsx` — added a single **"Groups"** button in the header so
  the feature is reachable. Purely additive (a button that calls
  `navigate('/groups')`). This was the *only* change to a pre-existing live page.

**Design decisions & tradeoffs.**

- **Reuse over reinvention.** `GroupChatPage` copies `ChatPage`'s structure
  deliberately: load history via REST, then wire live updates via socket, then
  clean up on unmount. Learning one page teaches you the other. The tradeoff is
  some duplicated styling/logic between the two chat pages; acceptable for
  clarity at this size.
- **Fetching group info without a dedicated endpoint.** `GroupChatPage` needs the
  group's name and member list for its header. Rather than add a
  `GET /api/groups/:id` endpoint, it reuses `GET /api/groups?userId=<me>` and
  finds the group in that list. Tradeoff: it fetches your whole group list to read
  one group — wasteful at large scale, fine here, and it avoided reopening the
  just-committed backend. Flagged for later if group counts grow.
- **No optimistic send.** When you send a group message, the code does **not**
  immediately add it to the screen. It emits `send-group-message` and waits for
  the `new-group-message` broadcast to paint it — because, per the backend design,
  the server echoes your own message back to you. This keeps every message on one
  render path.
- **Sender names in bubbles.** The one visible departure from 1-to-1 chat: each
  *incoming* bubble shows the sender's name in small blue text above it, because a
  group has many speakers. Your own messages omit it (they're obviously yours).

**End-to-end walkthrough.**

1. From the Users page you tap **Groups** → land on `/groups`.
2. **Creating:** type a name, tick members, submit → `POST /api/groups` → on
   success the page navigates you straight into `/group/<newId>`. The backend
   auto-adds you as a member, so you're never locked out of your own group.
3. **Joining:** for a group you're not in, tapping **Join** → `POST
   /api/groups/:id/join` → then into the chat. `$addToSet` on the server makes a
   double-tap harmless.
4. **Opening the chat (`GroupChatPage`):** on mount it (a) loads group info +
   history via REST, then (b) emits **`join-group`**, subscribing this tab to the
   room. From then on any message anyone posts arrives live.
5. **Live messages:** the `new-group-message` handler appends the message
   (de-duplicating by `_id`), and clears that sender's typing indicator.
6. **Typing:** as you type it pings `group-typing`; everyone else sees "Alice is
   typing…". Two typers → "Alice, Bob are typing…". It auto-clears after 2 seconds
   of stillness or when the message lands.
7. **Leaving:** unmounting the page emits **`leave-group`** and unhooks all
   listeners, so a group you're not looking at stops pushing you updates.

**Reachability note.** Without the Users-page button the feature would exist but
be unreachable — that button is the doorway.

---

### Entry 4 — Read receipts for 1-to-1 chat

**Commit:** `552e120` "Add read receipts to 1-to-1 chat"

**What I fixed.** The `read` boolean on messages never became `true` — you could
watch a message arrive and the field stayed `false` forever. This entry explains
the bug clearly because the *shape* of the bug is a good lesson.

**The root cause.** The server *already had* the logic to flip the field — a
`mark-read` socket handler in `server/index.js` that runs
`Message.updateMany({ sender: peerId, receiver: visitorId, read: false }, { read: true })`
and then notifies the sender via a `messages-read` event. But that handler is an
**event listener**: it only runs when a `mark-read` event arrives. Searching the
entire frontend showed **nothing ever emitted `mark-read`**. So the handler
simply never fired. Analogy: a working light switch wired to a working bulb, but
nobody ever flips the switch. Delivering a message and marking it read are two
different jobs — delivery was built; the "mark it read" trigger was missing on the
client.

**File changed:** `src/pages/ChatPage.jsx` only (42 insertions). Four edits:

1. **Emit `mark-read` when a message arrives from the peer while the chat is
   open** — so live-received messages flip to read immediately (this is the
   side-by-side case).
2. **Emit `mark-read` when the chat opens** — so any already-unread history from
   the peer flips to read.
3. **Listen for `messages-read`** — when the peer reads *our* messages, flip our
   own sent messages in local state to `read: true`.
4. **Render a `✓ Sent` / `✓✓ Seen` indicator** on our own message bubbles, driven
   by each message's `read` flag.

**Design decision & tradeoff.** I chose the *full* version (visible receipts)
over the minimal one (just fix the DB field silently). The extra work was small
and it makes the `read` field actually *mean* something on screen — otherwise
you'd have a correct database column that no user ever sees.

**End-to-end walkthrough.**

1. You open a chat → frontend emits `mark-read` → server sets any unread messages
   *from that peer* to `read: true` in MongoDB.
2. A message arrives from the peer while you're looking → frontend emits
   `mark-read` again → that message flips to `read: true`.
3. Whenever the server marks messages read, it emits `messages-read` to the
   **original sender**.
4. The sender's `ChatPage` catches it and flips their own bubbles from
   "✓ Sent" to "✓✓ Seen" live.

**Important caveat.** The live "Seen" flip requires **both** users to have the
chat open (the server only pushes `messages-read` to a currently-connected
socket). The **database field always updates correctly** regardless — only the
live on-screen flip needs the sender to be viewing the chat. This matches the
two-window test setup, which is why it appears to work instantly there.

---

### Entry 5 — GroupsPage UI polish

**Commit:** `b01abbb` "Polish GroupsPage: reorder, collapsible create form, member avatars"

**What I changed.** Three focused UI refinements to `src/pages/GroupsPage.jsx`
(the only file touched), based on usage feedback.

1. **Reordered the two cards** — the "All groups" browse/join list now sits
   *above* the "Create a group" card, so the default focus is finding and joining
   existing groups rather than making new ones.
2. **Made the create form collapsible** — it now starts **collapsed** behind a
   header row with a chevron (▼). Clicking expands it (▲) to reveal the name
   field, member checklist, and button; clicking again collapses it. Implemented
   with a `createOpen` boolean state and conditional rendering of the `<form>`.
   The page opens uncluttered; creating is opt-in.
3. **Added profile pictures to the member checklist** — each selectable user now
   shows their Google avatar (a 28px circle) beside their name, with a blue
   initial-circle fallback for anyone without a photo — the same avatar pattern
   used on the users list and chat header.

**Design note.** All three are presentational; no data flow changed. The
collapsible pattern is worth remembering: a piece of state (`createOpen`) gates
whether a chunk of JSX renders — the simplest way to build show/hide UI in React,
no library needed.

---

### Entry 6 — Server lockfile sync (housekeeping)

**Commit:** `40cbf49` "Sync server lockfile with package.json (drop firebase-admin)"

**What & why.** Running `npm install` in `server/` regenerated
`server/package-lock.json` to match the current `package.json`. This removed
~1,700 lines of stale `firebase-admin` dependency tree left over from the old
architecture and corrected the package name. No runtime dependency actually
changed — the lockfile just caught up with reality.

**Design lesson — why this was its own commit.** When it appeared alongside the
read-receipts and GroupsPage changes in the working tree, I committed it
**separately** rather than folding it into a feature commit. A reviewer opening
the "read receipts" commit should see read receipts — not a giant unrelated
dependency diff. One commit = one concern. This is why I staged files
individually (`git add <one file>`) instead of `git add .`: staging is the tool
that lets you split a messy working tree into clean, atomic commits.

---

### Local environment fixes (not committed — machine/config only)

These were needed to run the app locally but don't belong in the repo.

- **MongoDB IPv4 fix.** The server failed with `ECONNREFUSED ::1:27017`. Cause:
  on Windows, `localhost` resolves to IPv6 (`::1`) first, but the local MongoDB
  service listens only on IPv4 (`127.0.0.1`). Fix: created a **gitignored**
  `server/.env` setting `MONGODB_URI=mongodb://127.0.0.1:27017/chatapp` (note the
  literal `127.0.0.1`, not `localhost`). *Follow-up worth doing:* change the
  hardcoded default in `server/index.js` from `localhost` to `127.0.0.1` so a
  fresh clone doesn't hit the same wall — that one *would* be a committed change.
- **Firebase Google provider.** Login initially failed with
  `auth/operation-not-allowed`. Cause: the Google sign-in method wasn't enabled in
  the Firebase Console for project `chatcsp-52686610-61cb3`. Fix is console-only
  (Authentication → Sign-in method → enable Google + set support email); no code
  change. Also noted: the `Cross-Origin-Opener-Policy … window.closed` console
  warnings during sign-in are **harmless** — Firebase's popup polls `window.closed`
  to detect a manual cancel, the browser blocks that cross-origin peek, but the
  actual login result travels a different (allowed) channel, so sign-in succeeds.

---

### Git history rewrite — removing AI attribution (process note)

**What happened.** On request, all commit messages this session had their
`Co-Authored-By: Claude …` trailers removed, so every commit is authored solely
by the user. The commits were *already* authored by the user; only the trailer in
the message body carried the attribution.

**How.** `git filter-branch --msg-filter` stripped the trailer from the range
`b266d8b..HEAD` (all 7 session commits). Because rewriting a message changes a
commit's hash, every hash changed (e.g. `b266d8b → f1d6f7e`, `5a7ee0b →
9af969d`, … `950de93 → 40cbf49`). Two of those commits had already been pushed,
so origin had diverged; reconciling it required a **force-push**
(`git push --force-with-lease origin main`, the safe variant that refuses to
clobber someone else's work). Origin is now clean and in sync.

**Going forward:** no AI/Anthropic attribution will be added to commits in this
project (also saved to persistent memory).

---

### Entry 7 — User roles (student / mentor)

**What I built.** The first piece of turning this into a mentor-student
platform: a `role` field on every user (`'student'` or `'mentor'`), a way for
users to choose it, and exposure of that role everywhere user data is returned.
This entry stores and surfaces role — it does **not** yet enforce any
permissions (see the design flag below).

**Files added:**

- `src/pages/RoleSelectPage.jsx` — the first-login role picker (a full-screen
  "Student or Mentor?" card with two big buttons).

**Files changed:**

- `server/models/User.js` — added `role: { type: String, enum: ['student','mentor'] }`
  with **no default**.
- `server/index.js` — added `POST /api/users/:id/role`; added role to all nine
  user `populate()` selects (message sender/receiver, group members, group-message
  sender), i.e. `'displayName photoURL'` → `'displayName photoURL role'`; added a
  clarifying comment on `/api/auth/login`.
- `src/context/AuthContext.jsx` — added a `chooseRole()` helper and exposed it on
  the context; `dbUser` already carries `role`.
- `src/App.jsx` — added a gate that shows the picker when a signed-in user has no
  role yet, plus the import.

**Design decision 1 — where the user chooses their role.** With Google-only
sign-in there is nowhere to ask during login (you can't customise Google's
consent screen) and there's no registration form (we deleted it). So the only
natural moment is **immediately after the first sign-in.** I show a one-time,
full-screen picker, gated in `App.jsx`: if `user && dbUser && !dbUser.role`,
render `RoleSelectPage` instead of the routes. Pick once → stored → never asked
again. The gate deliberately waits for `dbUser` to load (it's null for a beat
after login) so it never flashes prematurely.

**Design decision 2 — role is set separately from the upsert, on purpose.** The
instinct is to store role "wherever users are created/upserted" — which is
`POST /api/auth/login`. But that endpoint runs on **every** login and re-writes
the user document, so putting `role` there would **overwrite the user's choice
every time they signed in.** Instead, `/api/auth/login` never touches `role`
(preserving whatever is stored), and role is written once through the dedicated
`POST /api/users/:id/role` endpoint. This is the key subtlety of the feature.

**Design decision 3 — nothing enforces the role (yet).** This is important to be
explicit about: role is **stored and displayed only.** No endpoint or UI checks
it; a mentor and a student can currently do exactly the same things. Real
authorization (mentor-only actions, gating group creation, etc.) is separate,
deferred work. What's done here is the *foundation* it will build on.

**Why no default on the schema.** If `role` defaulted to `'student'`, every new
user would silently be a student and the picker would be meaningless. Leaving it
unset means "hasn't chosen yet" is a real, detectable state (`!dbUser.role`),
which is exactly what the first-login gate keys on. Existing accounts created
before this change also have no role, so they'll simply be prompted once on their
next login — no migration needed.

**End-to-end walkthrough.**

1. A user signs in with Google. `AuthContext` calls `POST /api/auth/login`, which
   upserts their user doc. For a brand-new (or pre-existing role-less) user, the
   returned `dbUser` has **no `role`**.
2. `App.jsx` sees `user && dbUser && !dbUser.role` and renders `RoleSelectPage`
   instead of any route — the app is effectively blocked on this choice.
3. The user clicks **Student** or **Mentor**. That calls `chooseRole(role)` from
   the context, which `POST`s to `/api/users/:id/role`.
4. The server validates the value is one of the two allowed roles, writes it with
   `findByIdAndUpdate`, and returns the updated user.
5. `chooseRole` puts that updated user into `dbUser` state. Now `dbUser.role` is
   set, so `App.jsx` re-renders — the gate condition is false — and the user lands
   in the normal app (the Users page).
6. On every later login, `/api/auth/login` returns the stored role untouched, so
   the picker never appears again.
7. **Exposure:** because role is now in the schema and in every user `populate`,
   any user object the API returns — the logged-in user, the users list, a chat
   peer, a group member, a message's sender — carries its `role`. Nothing in the
   UI reads it yet, but it's available the moment we want to (badges, mentor-only
   buttons, filtered lists, etc.).

**Note on scope.** An earlier framing of this task said "don't touch chat or
group functionality," which would have kept role out of the message/group
populates. That constraint was lifted once the project scope was settled, so role
is now threaded through **all** user-data returns, chat and group included.

---

### Open items / "later" list

- **Role enforcement** — the `role` field now exists and is exposed everywhere
  (Entry 7), but nothing acts on it yet. Next steps: decide what mentors can do
  that students can't (e.g. only mentors create groups, or post announcements),
  then enforce it in the relevant REST/socket handlers **and** reflect it in the
  UI (badges, hidden buttons). Also: there's currently no way to *change* a role
  after the first pick — a settings toggle or admin action would be needed.
- **New-user live refresh** — the Users list only updates online/offline status
  live; a brand-new signup doesn't appear until a manual refresh (no "new user"
  broadcast yet).
- **Final cleanup pass** — stale docs (`README.md` is still the Vite boilerplate;
  `FEATURES_DOCUMENTATION.md` and `blueprint.md` describe the deleted
  architecture) and the unused Firebase config files (`firestore.rules`,
  `firestore.indexes.json`, `firebase.json`, `.firebaserc`); plus the
  `localhost → 127.0.0.1` server default noted above.
- **Group read receipts & socket membership enforcement** — deferred from the
  group backend (see Entry 2).
