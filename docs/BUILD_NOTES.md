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

### Entry 8 — User profiles (role-aware)

**What I built.** Profiles layered on top of the role field from Entry 7. Every
user gets a **bio**; mentors additionally get an **area of expertise** and an
**availability note**. Plus a `/profile` page where you view and edit your own.

**Files added:**

- `src/pages/ProfilePage.jsx` — the profile screen: a read-only identity card
  (Google name/photo/email + a role badge) above an editable form.

**Files changed:**

- `server/models/User.js` — added `bio` (max 500), `expertise` (max 200),
  `availability` (max 200), all defaulting to `''`.
- `server/index.js` — added `PUT /api/users/:id/profile`.
- `src/context/AuthContext.jsx` — added `updateProfile()` and exposed it.
- `src/App.jsx` — added the protected `/profile` route + import.
- `src/pages/UsersPage.jsx` — added a "Profile" button to the header.

**Design decision 1 — one User document, not a separate MentorProfile
collection.** Mentor-only fields live on the same user document as everyone
else's, just left empty for students. With three small fields, a second
collection would mean a join for no real benefit. *Tradeoff:* every student
document carries two unused empty strings. If mentor profiles later grow
(credentials, hourly rates, session history), splitting them into their own
collection becomes the better call — worth revisiting then, not now.

**Design decision 2 — the server decides what a role may store, not the
client.** `PUT /api/users/:id/profile` reads the user's **stored** role from
MongoDB and only writes `expertise`/`availability` if that role is `'mentor'`.
So even if a student's browser sent those fields, they'd be silently dropped.
The frontend also hides those inputs for students — but the frontend check is
*convenience*, the server check is the one that actually holds. That's the
general principle: **UI hiding is not enforcement; the server must re-check.**

**Design decision 3 — defaults of `''` rather than leaving fields unset.** This
differs deliberately from `role`, which has *no* default so that "hasn't chosen
yet" is detectable. For profile text there's no such state to detect — an empty
bio and an absent bio mean the same thing — and defaulting to `''` means the
React form inputs always have a defined value, avoiding the "controlled input
changed to uncontrolled" warning.

**Design decision 4 — populates stay lean.** I did *not* add bio/expertise to
the message and group `populate()` selects (unlike `role` in Entry 7). Those
populates exist to render message bubbles and member lists; attaching a 500-char
bio to every message in a conversation would bloat payloads for no benefit. The
full profile is fetched on demand from `GET /api/user/:id`, which returns the
whole document anyway.

**Known gap (deliberately not fixed).** There is no check that the caller *is*
the user whose profile they're editing — anyone who knows a user id could `PUT`
their profile. This is consistent with every other endpoint in the app (no token
verification anywhere, including the role endpoint), so I kept it consistent
rather than half-securing one route. Fixing it properly means verifying the
Firebase ID token server-side on all mutating endpoints — a single, separate
piece of work.

**End-to-end walkthrough.**

1. From the Users page you tap **Profile** → `/profile`.
2. `ProfilePage` reads `dbUser` straight from context — no fetch needed, because
   the logged-in user's full document (now including bio/expertise/availability)
   is already in memory from `/api/auth/login`.
3. A `useEffect` seeds the form fields from `dbUser`. The identity card shows the
   Google-sourced name, photo and email (read-only — those belong to Google) plus
   a 🎓 Student / 🧑‍🏫 Mentor badge.
4. **The role-specific part:** `isMentor = dbUser.role === 'mentor'`. The bio
   textarea always renders; the expertise and availability inputs render only
   when `isMentor` is true. A student simply never sees them.
5. On save, the page sends `{ bio }` for a student or
   `{ bio, expertise, availability }` for a mentor to `updateProfile()`.
6. `updateProfile()` PUTs to `/api/users/:id/profile`. The server re-checks the
   role, builds an update containing only permitted fields, saves with
   `runValidators: true` (so the maxlengths are enforced), and returns the
   updated user.
7. The context replaces `dbUser` with that response, so the whole app
   immediately has the fresh profile. The page shows "✓ Profile saved".
8. Because `dbUser` changed, the seeding `useEffect` re-runs and re-fills the
   form from the server's authoritative copy — a free confirmation that what's on
   screen is what's actually stored.

**Not built yet:** viewing *other* people's profiles (e.g. tapping a mentor in
the users list to see their expertise before starting a chat). The data is all
there and `GET /api/user/:id` already returns it — it just needs a read-only
view. That's the natural next step for making mentor discovery useful.

---

### Entry 9 — Public profile view

**What I built.** The read-only counterpart to Entry 8. You can now look at
*someone else's* profile — their bio, and for mentors their expertise and
availability. Until now those fields were **write-only**: a mentor could fill
them in and nobody could ever read them, which made the whole profile feature
decorative.

**Files added:**

- `src/pages/UserProfilePage.jsx` — read-only profile at `/users/:userId`.

**Files changed:**

- `src/App.jsx` — added the protected `/users/:userId` route + import.
- `src/pages/UsersPage.jsx` — role badge on each card + a "Profile" button.
- `src/pages/ChatPage.jsx` — the peer's name/photo in the header now opens
  their profile.

**Design decision 1 — no new endpoint.** `GET /api/user/:id` already returned
the entire user document (it uses `.select('-__v')`, so bio/expertise/
availability came along for free the moment Entry 8 added them to the schema).
The whole feature is frontend. *Tradeoff:* that endpoint returns everything,
including the email, to any caller. That's already true of `GET /api/users`,
which the users list calls on every load — so this exposes nothing new. If
field-level privacy ever matters, both endpoints need a `.select()`, not just
this one.

**Design decision 2 — the card still opens the chat; a separate button opens
the profile.** The obvious alternative was making a tap on the user card open
the profile instead. I kept the tap on chat: this is a chat app, opening the
conversation is the action people want 95% of the time, and it was already
working. The profile gets its own explicit button. *The catch:* that button
lives **inside** a card that has its own `onClick`, so it calls
`e.stopPropagation()` — without it, tapping "Profile" would fire the card
handler too and dump you into the chat instead. That's the standard
nested-clickable trap.

**Design decision 3 — role badges in the list.** A profile view for mentors is
only useful if you can tell who the mentors *are* before tapping. `GET
/api/users` already returns `role`, so the badge costs one conditional. It's
guarded on `user.role` being present, because accounts created before Entry 7
have no role until their owner next logs in and hits the picker.

**Design decision 4 — the online dot listens to the socket.** The profile page
fetches `isOnline` once, which would then be frozen — leave the page open and
it would claim someone is offline long after they came back. It subscribes to
the same `user-status-change` broadcast the users list uses, filtered to the
one id being viewed.

**Empty states matter here.** A brand-new mentor has an empty bio, expertise
and availability. Rather than render three blank cards, each field falls back
to a muted "Not specified yet." and the bio to "This user hasn't written a bio
yet." The mentoring card doesn't render at all for students, mirroring how
ProfilePage hides those inputs for them.

**End-to-end walkthrough.**

1. On the users list each card now shows a 🎓/🧑‍🏫 badge next to the name, so
   mentors are identifiable without opening anything.
2. Tap **Profile** on a card (or the person's name in a chat header) →
   `/users/:userId`.
3. `UserProfilePage` reads `userId` from the URL and fetches
   `GET /api/user/:id`. A 404 and a malformed-id 500 are shown identically —
   "This user could not be found" — because the distinction means nothing to
   the reader.
4. The identity card renders name, photo, email, a role badge and a live
   status dot, then a primary button: **Message <first name>** → `/chat/:id`.
   If you somehow land on your own id by typing the URL, it offers **Edit my
   profile** → `/profile` instead, since messaging yourself isn't a thing.
5. **About** shows the bio, with `whiteSpace: 'pre-wrap'` so paragraph breaks
   someone typed into the textarea survive.
6. **Mentoring** renders only when `profile.role === 'mentor'`, showing
   expertise and availability.

**Verified:** production build clean.

---

### Entry 10 — Role enforcement (groups + announcements)

**What I built.** The role field finally *does* something. Since Entry 7 it had
been stored, badged and populated everywhere while changing nothing — a label,
not a permission. Two mentor-only capabilities now hang off it, plus a way to
change your role, which mattered much more once the role started gating things.

**Files added:**

- `server/models/Announcement.js` — the broadcast model.
- `src/pages/AnnouncementsPage.jsx` — the feed, with a mentor-only compose box.

**Files changed:**

- `server/index.js` — mentor gate on `POST /api/groups`; three new
  announcement routes (`GET`, `POST`, `DELETE /api/announcements`).
- `src/pages/GroupsPage.jsx` — create form hidden for students; "Notices" nav.
- `src/pages/ProfilePage.jsx` — role switcher.
- `src/context/AuthContext.jsx` — `chooseRole()` now returns a boolean.
- `src/App.jsx` — `/announcements` route.
- `src/pages/UsersPage.jsx` — "Notices" nav button.

**The rule, stated once:** mentors can create groups and post announcements.
Students can join groups, chat in them, and read announcements. Nothing else
differs.

**Design decision 1 — the gate reads the role from the database, every time.**
Both `POST /api/groups` and `POST /api/announcements` do a `findById` on the
caller and check `role !== 'mentor'` before writing anything. They deliberately
do *not* trust a role sent in the request body, and they do not cache it. This
is the same principle Entry 8 established for the profile endpoint, now applied
consistently: **the client's copy of who you are is a hint; the database's copy
is the fact.**

**Design decision 2 — a role check and an ownership check are different
things.** `DELETE /api/announcements/:id` needs both ideas but uses only the
second: it compares `announcement.author` against the caller's id. A role check
alone would have been wrong in an interesting way — every mentor would be able
to delete every *other* mentor's notices. Being a mentor earns you the ability
to delete **your own** announcements. This is the app's first ownership check,
as opposed to a role check, and the distinction is worth keeping straight.

**Design decision 3 — announcements broadcast with `io.emit`, not to a room.**
Group messages go to `io.to('group:<id>')` because a group has a membership.
Announcements are public, so there is no room that means "everyone" — a plain
`io.emit` to every connected socket is the correct shape, not laziness. The
poster receives their own announcement back through the same broadcast, so
`AnnouncementsPage` never has to merge a local copy with the server's.

**Design decision 4 — no `role` snapshot on the Announcement.** It would have
been easy to store `authorRole: 'mentor'` alongside each announcement. I didn't:
that copy goes stale the instant someone switches role, and then the record
disagrees with the user document. The author is a `ref` and the role is read
through the populate.

**Design decision 5 — roles are now changeable, and that is a consequence of
enforcement, not a separate feature.** When role was decorative, a permanent
first-login pick was fine. Now that it gates two features, a mis-tap would lock
someone out with no recovery short of a new Google account. The switcher on
ProfilePage reuses `POST /api/users/:id/role` unchanged — the first-login picker
and the switcher are the same operation, so a second endpoint would have been
duplication. It confirms first, because the consequences are real.
*Deliberate non-consequence:* demoting a mentor leaves the groups and
announcements they already created intact. The gate is on **creating**, not on
owning.

**Design decision 6 — students are told, not just denied.** Where the create
form and compose box used to be, students see a short note explaining that the
feature is mentor-only and how to change that. A silently missing button reads
as a bug; an explained absence reads as a rule.

**A frontend detail worth recording.** The create/post failure paths now surface
`body.error` from the server rather than a generic "Failed to…". That turns the
403 into an explanation. It also means the gate is demonstrable without opening
devtools: post as a student via any HTTP client and the server tells you why it
refused.

**End-to-end walkthrough (announcements).**

1. **Notices** from the Messages or Groups header → `/announcements`.
2. The page fetches `GET /api/announcements` once — newest first, capped at 50
   so the feed can't grow into an unbounded payload over a term.
3. A mentor sees a compose box; a student sees the explanatory note instead.
4. Posting sends `{ authorId, text }`. The server looks up the author, confirms
   `role === 'mentor'`, saves, populates the author, and `io.emit`s
   `new-announcement`.
5. **Every** open feed — the poster's included — prepends it via the socket
   listener. Nobody refreshes.
6. On your own announcements a Delete button appears. It calls
   `DELETE /api/announcements/:id` with your id; the server re-checks
   authorship, deletes, and emits `announcement-deleted`, which every feed
   filters out of its list.
7. Tapping an author's name opens their profile (Entry 9), so a student can
   read a mentor's expertise straight from a notice.

**Verified.** Production build, server syntax check, and ten live HTTP checks
against the running server and real MongoDB: public read; 400 on missing text;
404 on unknown author; **403 for a student posting an announcement**; **403 for
a student creating a group**; confirmed nothing was written by any rejected
call; mentor posts successfully; **403 when a student tries to delete a
mentor's announcement**; author deletes their own successfully; feed empty
again afterwards. The test announcement was removed by the delete it was
testing, so no test data was left behind.

---

### Entry 11 — Getting ESLint to actually run

**What I did.** Made linting work for the first time. Before this, **not a
single file in the repo had ever been linted** — and the reason was a stack of
three separate problems that each hid the next.

**Files changed:**

- `eslint.config.js` — rewritten to cover frontend *and* backend.
- `package.json` — added the missing devDependencies and a `lint` script.
- `.eslintrc.json`, `server/.eslintrc.json` — **deleted**.
- `src/context/AuthContext.jsx` — one real bug fixed (below).
- `src/pages/GroupChatPage.jsx` — `memberName` moved above its caller.

**The three problems.**

1. `eslint.config.js` was written in flat-config style and imports
   `eslint/config`, a subpath that only exists in **ESLint 9**. The installed
   ESLint was **8.57**, which doesn't export it, so every run died with
   `ERR_PACKAGE_PATH_NOT_EXPORTED` before linting anything.
2. ESLint 8.57 was only present *transitively* — neither `eslint` nor
   `@eslint/js`, `globals`, `eslint-plugin-react-hooks` or
   `eslint-plugin-react-refresh` was declared in `package.json`. A clean
   `npm install` on another machine wouldn't have had them at all.
3. Two legacy `.eslintrc.json` files (root and `server/`) sat alongside the
   flat config. ESLint 9 ignores `.eslintrc` entirely, so they were dead
   weight that *looked* like working configuration.

There was also no `lint` script, so nothing invoked it in the normal course of
work.

**Why this was worth fixing rather than deleting.** `vite build` compiles
undefined variables perfectly happily — Entry 7 shipped a missing `dbUser`
destructure that built green and crashed in the browser. I re-ran that
experiment deliberately: a file referencing an undeclared `dbUser` **builds
successfully** and ESLint reports `'dbUser' is not defined  no-undef`. That is
the entire justification for the config declaring per-environment globals
instead of turning `no-undef` off.

**Design decision 1 — one config, two environments.** The old setup had a
separate `.eslintrc.json` per environment. The new flat config does it in one
file with `files:` blocks: `src/**` gets browser globals, ES modules and JSX;
`server/**` gets Node globals and `sourceType: 'commonjs'`; root `*.config.js`
gets Node plus ES modules. Splitting them matters — `require` and `process` are
undefined in a browser and `window` is undefined in Node, so a single shared
set of globals would either miss real typos or invent fake ones. The server had
never been linted at all before this; it is now.

**Design decision 2 — a plugin API trap worth recording.** In
`eslint-plugin-react-hooks` **v7**, `configs.recommended` and
`configs['recommended-latest']` are still the **legacy eslintrc shape** (with
`plugins` as an array of strings), which flat config rejects outright with a
confusing error about converting your config. The flat versions live under
`configs.flat.recommended`. The old config referenced
`configs['recommended-latest']` — correct for the v5 it was written against,
wrong now.

**Two real findings, fixed.**

- **`AuthContext` never disconnected the socket on logout.** The mount effect's
  Firebase callback checked `if (socket)` — but that variable is captured from
  the render the effect ran in, and since the effect runs once on mount it is
  captured as `null` **forever**. The branch could never fire. Fixed by reading
  through the state updater (`setSocket(current => …)`), which always sees the
  latest value and needs no dependency, so the run-once-on-mount contract
  survives. The explicit `logout()` was never affected — it's recreated each
  render and sees the current socket — which is exactly why the bug stayed
  invisible: the normal logout path worked.
- **`GroupChatPage` used `memberName` before declaring it.** The typing handler
  inside an effect called a `const` arrow function declared *after* that
  effect. It worked at runtime (the handler only fires on socket events, long
  after render) but reads as a use-before-declare. Moved above its caller.

**Design decision 3 — one rule downgraded to a warning, with reasons.** v7 of
the hooks plugin ships the React Compiler rule set, stricter than the code was
written against. `react-hooks/set-state-in-effect` fires twice, and neither is
a defect: `ProfilePage` seeds its form from `dbUser` in an effect (the standard
"reset the form when the record changes" pattern; React's suggested
alternative is remounting via `key`, which means extracting the form into a
child component for no behavioural gain), and `GroupsPage` calls an `async`
fetch whose `setState` runs in a promise callback — not synchronously — which
the rule can't see through. Set to `'warn'` rather than `'off'`, so new
occurrences still surface. I deliberately did **not** restructure working,
manually-tested code to satisfy a rule that arrived with a plugin upgrade.

**Result.** `npm run lint` covers **21 files** — all of `src/` and all of
`server/` — and reports **0 errors, 2 documented warnings**, exiting 0.

---

### Entry 12 — Documentation cleanup

**What I did.** Made every document in the repo describe the application that
actually exists. All three were describing a system that had been deleted
months of commits ago, which is worse than having no documentation: a reader
trusts them and is misled.

**Files changed:**

- `README.md` — was the **stock Vite template**. Never touched since
  `npm create vite`.
- `FEATURES_DOCUMENTATION.md` — rewritten against the real code.
- `blueprint.md` — rewritten as an architecture document.
- `server/index.js`, `server/.env.example` — `localhost` → `127.0.0.1`.

**Files deleted:** `firebase.json`, `.firebaserc`, `firestore.rules`,
`firestore.indexes.json`.

**How stale they were.** `FEATURES_DOCUMENTATION.md` is the graded artifact —
it maps course outcomes to implementations — and it referenced
`src/components/Avatar.jsx`, `ChatsListPage.jsx`, `EditProfilePage.jsx`,
`RegisterPage.jsx`, `RecordsList.jsx` and a `src/components/` directory,
**none of which exist**. It described Firestore as the database, Server-Sent
Events as the transport, `firebase-admin` on the server, and a file-upload
feature built on Firebase Storage. Every one of those was removed in Entry 1.
`blueprint.md` described the project as a "front-end only prototype" and laid
out a plan to build a backend that has since been built twice.

**Design decision 1 — rewrite, don't delete.** The obvious alternative was to
delete `blueprint.md` and `FEATURES_DOCUMENTATION.md` outright, since
`README.md` and these build notes now cover the ground. I rewrote them instead:
they're submission artifacts, and a missing course-outcome mapping is a real
loss where a stale one is merely a fixable problem. They now have distinct
jobs — README says *what exists and how to run it*, FEATURES_DOCUMENTATION maps
*course outcomes to code*, blueprint explains *why the architecture is shaped
this way*, and BUILD_NOTES logs *what changed and when*.

**Design decision 2 — document the limitations in all three.** README,
FEATURES_DOCUMENTATION and blueprint each end with the same three honest gaps:
no server-side token verification, ungated group sockets, and no live refresh
for new signups. Stating them turns them into acknowledged decisions rather
than things a reader discovers and assumes nobody noticed.

**On the deleted Firebase files.** `firebase.json` configured Firestore rules
and indexes; `firestore.rules` held a full rule set for collections that no
longer exist; `firestore.indexes.json` was an untouched commented-out template;
`.firebaserc` pinned a CLI project alias. Firestore has not been used since
Entry 1 — I verified with a repo-wide grep that nothing imports it, and
`src/firebase.js` initialises **Auth only**. Firebase Auth needs no local
config files (its config is inline in `src/firebase.js`), so all four were
dead. `src/firebase.js` obviously stays. They remain in git history if ever
needed.

**The `localhost` → `127.0.0.1` follow-up, finally done.** Noted back in the
local-environment section as the one machine-specific fix that *should* be
committed. On Windows `localhost` resolves to IPv6 (`::1`) first while a
default MongoDB install listens only on IPv4, so a fresh clone hits
`ECONNREFUSED ::1:27017` — which reads as "MongoDB isn't running" when it is.
Changed the fallback in `server/index.js` and the commented example in
`.env.example`, both with the reason written next to them so nobody
"simplifies" it back.

**Verified:** server syntax check, `npm run lint` (0 errors), production build.

---

### Entry 13 — New users appear without a refresh

**What I built.** The users list was fetched once on mount and then only ever
updated online/offline dots. A brand-new signup stayed invisible to everyone
already using the app until they manually reloaded — which, in a demo where two
people sign in one after the other, is exactly when it's most visible.

**Files changed:**

- `server/index.js` — `POST /api/auth/login` now distinguishes insert from
  update and emits `user-added`; `POST /api/users/:id/role` emits
  `user-updated`.
- `src/pages/UsersPage.jsx` — listens to both.
- `src/pages/GroupsPage.jsx` — listens to `user-added` for its member picker.

**Design decision 1 — telling an insert from an update.** The login endpoint is
an *upsert*: it runs on every login and either creates or updates. Broadcasting
unconditionally would announce a "new user" every single time anyone signed in.
Mongoose 8's `includeResultMetadata: true` returns the raw driver result, whose
`lastErrorObject.upserted` is set only on insert. That's one query and an exact
answer; the alternative (a `findOne` first, then the upsert) costs a round trip
to learn the same thing.

**Design decision 2 — why a second event was necessary.** This is the part I'd
have got wrong without thinking it through. `POST /api/auth/login` fires
**before** the first-login role picker — a user must exist in Mongo before they
can be given a role. So the `user-added` broadcast necessarily carries
`role: undefined`, and everyone else would see the new person listed with **no
badge**, permanently, until a refresh. Hence `user-updated` from the role
endpoint. The verification below shows exactly this sequence.

**Design decision 3 — two guards on the client.** `handleUserAdded` skips the
event if it's about *us* (the server broadcasts to everyone, including the
person who just registered) and skips anyone already in the list. Neither
should normally trigger; both mean a stray or repeated broadcast can never
produce a duplicate row.

**Design decision 4 — re-sort rather than append.** `GET /api/users` returns
users sorted by display name. Appending would drop the newcomer at the bottom,
out of order, until the next reload — a small inconsistency that would look
like a bug. The handler re-sorts.

**Scope note.** `GroupsPage` fetches the same user list for its "add members"
picker and had the identical staleness — a new account couldn't be added to a
group without a reload. Same listener, so I fixed it there too rather than
leave one half of the same bug.

**Verified live.** A Socket.IO client connected to the server while REST calls
drove the flow:

1. First-ever login for a new account → received **`user-added`**, with
   `role = (none)` — the situation that makes decision 2 necessary.
2. That account picks a role → received **`user-updated`**, `role = mentor`.
3. The same account logs in again → **silent**, no duplicate broadcast.

Plus a separate check that an existing user logging in produces only
"User logged in" and never "New user registered". The test account was deleted
afterwards; the database was left with the same three users it started with.

---

### Entry 14 — UI foundation: design system, app shell, responsive layout

**What I built.** The app's first shared UI layer. This is the largest single
change in the log, and it was sequenced *before* the next round of features on
purpose — see the reasoning below.

**Files added:** `src/styles/tokens.css`, `src/styles/base.css`, ten components
in `src/components/` (AppShell, Button, Card, Avatar, Badge, Field,
EmptyState, Loading, Toast, ConfirmDialog, Icons) and a `.module.css` for each
page.

**Files deleted:** `src/App.css` (1006 lines), `src/index.css` (empty).

**The starting state, measured.** Worth recording because it's the
justification:

| | Before | After |
| --- | --- | --- |
| Shared components | **0** (no `src/components/` at all) | 11 |
| Per-page `const styles = {}` objects | 8 | 0 |
| Hardcoded `#3b82f6` | 34 | 0 (2 mentions in comments) |
| `alert()` calls | 9 | 0 |
| `@media` queries | **0** | responsive throughout |
| Dead CSS shipping in the bundle | 1006 lines | 0 |

`App.css` deserves its own note: 1006 lines defining `.topbar`, `.login-page`,
`.pwd-wrapper` and `.toggle-btn` — the **password-login UI deleted back in
Entry 1**. Only `LoginPage` used `className` at all. It was still imported in
`main.jsx` and still shipping to every visitor.

**Why this came before the next features.** The plan after this is a
mentorship relationship model, goals, and mentor discovery — several new
screens. Adding them on top of eight copy-pasted style objects would have
meant eight more, and a design pass afterwards would have had to touch every
one. Doing the foundation first makes each new screen cheaper instead of
adding to the debt. The rule of thumb: fix the thing that multiplies before
you multiply.

**Design decision 1 — the accent colour is for state, not for buttons.**
Primary actions are charcoal; the accent (a deeper, desaturated blue than the
`#3b82f6` it replaces) marks the active nav item, links and progress. This is
what Linear, Vercel and GitHub do. Accent-coloured buttons on every screen,
soft glows, big pill radii and gradients are the specific tells that make an
interface read as generated — which was the stated problem. The neutrals are
warm (a slight brown cast) rather than default cool grey for the same reason.

**Design decision 2 — CSS Modules over a framework.** Vite supports them
natively, so this adds **no dependency**, and the scoping means the
duplication that caused the problem can't come back: a class in
`ChatPage.module.css` cannot leak into `GroupsPage`. Tailwind would have been
faster for this particular look but changes how every component is written.

**Design decision 3 — a sidebar instead of the per-page header bar.** Every
page previously had its own blue bar with "Profile / Notices / Groups /
Logout" buttons. That tells a visitor some pages exist. A sidebar that names
the sections tells them what the product *is*. The nav is a role-filtered
array, so the mentor-only entries this app will grow are one key
(`roles: ['mentor']`) rather than another branch in the JSX.

**Design decision 4 — `alert()` and `confirm()` both had to go.** They block
the page, cannot be styled, and on some browsers announce
"localhost:5173 says", which instantly reads as unfinished. Toasts replace
`alert()` with an `aria-live` region so messages are still announced to screen
readers — something `alert()` got for free and a custom toast has to ask for.
`ConfirmDialog` is built on the native `<dialog>` element, which provides
focus trapping, Escape-to-close and an inert background; a hand-rolled overlay
usually gets at least one of those wrong.

**Accessibility fixed along the way, not as a separate pass.** The user rows
were `<div onClick>` — invisible to the keyboard. They're now real `<button>`s
with the Profile button as a **sibling** rather than a child, which also
removed the `stopPropagation` the nested version needed. Form fields get
generated ids via `useId` so labels are properly associated. Loading states
carry `role="status"`. Focus rings use `:focus-visible`, so they appear for
keyboard users and not on mouse clicks — the reason people used to wrongly set
`outline: none`.

**A linter gap this surfaced.** Core ESLint has no JSX awareness, so a
component used *only* as a JSX element name (`<NavIcon />`) is reported as
unused. `varsIgnorePattern` already worked around this for imports;
`argsIgnorePattern` now does the same for destructured ones. The alternative
was adding `eslint-plugin-react` for a single rule.

**Verified.** Production build; `npm run lint` (0 errors, 1 documented
warning — and the GroupsPage `set-state-in-effect` warning disappeared, since
moving the fetch inside its effect removed the cause rather than suppressing
it); a script confirming all **208** `styles.*` references across 19 files
resolve to a class that actually exists (a typo there fails silently and just
renders unstyled); and all **23** source modules fetched through the Vite dev
server, which returns a 500 with the error for anything it can't transform.

**Not verified:** the rendered result. There's no browser driver in this
environment and installing one would mean downloading a browser onto the
machine, so the visual check is a manual one.

---

### Entry 15 — Server-side authentication

**What I built.** Identity. Until now every endpoint trusted a MongoDB `_id`
sent in the request body, and every socket event trusted a `senderId` in its
payload. The role gates were real — they read the stored role from the
database, so a client could not *promote* itself — but identity was not: anyone
who knew your id could **be** you. Edit your profile, read your conversations,
send messages as you.

This was the largest open item in this log, carried since Entry 8. It is
closed, and it took the group-socket gap (open since Entry 2) with it.

**Files added:** `server/middleware/auth.js`.

**Files changed:** `server/index.js` (25 edits), `server/.env.example`,
`server/package.json`, `src/context/AuthContext.jsx`, and the six pages that
call the server (33 edits).

**Design decision 1 — no service-account key.** The standard way to verify a
Firebase ID token is `firebase-admin`, which wants a **service account JSON**
downloaded from the Firebase Console and kept secret. I deliberately did not
use it. Verifying an ID token only needs Google's **public** signing
certificates: fetch them, match the token's `kid`, check the signature. So
there is no secret to distribute, nothing to leak, and no console step before
a fresh clone will run — you set `FIREBASE_PROJECT_ID` (which is already
public, it ships in the frontend bundle) and the server works. The cost is
about sixty lines we own instead of a dependency.

**What is actually checked**, and why each one matters:

- **signature** against Google's current cert for the token's `kid` — proves
  Google issued it and it has not been altered.
- **audience** equals our project id — without this, a valid token from
  *somebody else's* Firebase project would be accepted here. This is the check
  people most often forget.
- **issuer** is `https://securetoken.google.com/<projectId>` — same reason.
- **expiry**, enforced by `jsonwebtoken`. Tokens last an hour and the client
  SDK refreshes them, which is why `authFetch` calls `getIdToken()` before
  every request rather than caching one.
- **`sub` is non-empty** — that field *is* the Firebase uid, and everything
  downstream keys off it.

The certs are cached for exactly as long as Google's `Cache-Control: max-age`
says. Ignoring that header would mean either refetching on every request or
serving a stale set after a rotation.

**Design decision 2 — the token replaces the id, it does not sit beside it.**
The tempting half-measure is to verify the token and *also* keep reading
`req.body.visitorId`. That fixes nothing: the body is still what decides who
you are. So the ids were **removed from the requests entirely**. `POST
/api/announcements` no longer takes an `authorId`; `POST /api/groups` no
longer takes a `createdBy`; `join` takes no body at all; the socket events
carry no `senderId`. There is no longer a field to lie in.

**Design decision 3 — `/api/auth/login` needed a different middleware.** That
endpoint is what *creates* the Mongo user, so on a genuinely first-ever
sign-in there is nothing for `requireAuth` to find and it would 401 every new
user forever. `requireToken` verifies the token but tolerates a missing
account. Its uid and email now come from the token; only the display name and
photo still come from the body, because those are cosmetic and the token's
copies can lag behind a Google profile change.

**Design decision 4 — the socket is authenticated once, at the handshake.**
`io.use(socketAuth)` runs before any handler, and pins the user to
`socket.data.user` for the connection's whole life. Every handler reads the
sender from there. This is what makes the spoofing test below fail to spoof.

**The group-membership gap, finally closable.** Entry 2 deferred it and Entry
10 still listed it, because it *could not* be done: refusing to let you join a
group you don't belong to requires knowing who you are. With identity in
place, `join-group`, `send-group-message` and the REST history endpoint all
check membership. `send-group-message` re-checks rather than relying on
`join-group`, because a client can emit it without ever joining the room.

**Design decision 5 — a dev escape hatch, behind two locks.** An automated
browser cannot complete a Google sign-in popup, so without something the app
could never be driven end-to-end by a test. `ALLOW_DEV_AUTH=true` lets an
`X-Dev-User-Id` header stand in for a token. It is ignored when
`NODE_ENV=production`, unset by default, and the server prints a loud warning
at startup whenever it is on. It bypasses authentication completely, so it is
worth being suspicious of — that is exactly why it announces itself.

**Verified: 15 checks against the running server and real MongoDB.**

*Identity is required (4):* unauthenticated request → **401**; garbage bearer
token → **401**; dev identity → **200**; socket connection with no credentials
and with a garbage token → **both refused**.

*You cannot act as someone else (4):* reading another user's conversation →
**403**; editing another user's profile → **403**; changing another user's
role → **403**; reading your own conversation → **200**.

*Role gates still hold on top of identity (2):* student posting an
announcement → **403**; student creating a group → **403**.

*Group membership (3):* `join-group` on a group you are not in → **refused**;
`send-group-message` to it → **refused**; REST history for it → **403**.

*Spoofing (1), the important one:* a student emitted `send-message` with
`senderId` set to the **mentor's** id. The stored message came back attributed
to the **student** — the server ignored the claim entirely.

*Cleanup (1):* the test group and messages were deleted; the database was left
with the three users and zero groups it started with.

Plus: production build, `npm run lint` (0 errors), server syntax check.

**Docs corrected in the same commit.** README, FEATURES_DOCUMENTATION and
blueprint each listed "no server-side token verification" and "group sockets
don't check membership" under known limitations. Both are now false. Leaving
them would have recreated exactly the staleness Entry 12 existed to fix. The
README gained a **Security** section stating what is enforced, and the
remaining honest gaps are now rate limiting, pagination and connection-based
presence.

---

### Entry 16 — Visual verification, and the admin role

Two things in one session: a browser that can actually look at the app, and a
third role.

#### Part 1 — Playwright

The whole UI foundation (Entry 14) shipped **unverified**, because there was
no browser in the environment. There is now, and looking at the result found
two bugs that reading the CSS had not.

`scripts/screenshot.mjs` drives the running app and captures every route at a
desktop and a mobile width. It also fails on an unexpected redirect or any
console error — a screenshot can look perfect while the console is full of
failures, and only checking the picture would miss that.

**The obstacle worth recording:** Google sign-in cannot be automated. The
popup needs a real person, which makes every signed-in screen unreachable to a
test browser. Two dev switches solve it — `ALLOW_DEV_AUTH` on the server
(accepts an `X-Dev-User-Id` header) and `VITE_DEV_USER_ID` on the frontend
(skips Google and sends it). Both are off by default and must be set in two
different places, and the frontend half is guarded by `import.meta.env.DEV`,
which Vite replaces with a literal `false` in a production build. **Verified:
zero occurrences of `X-Dev-User-Id`, `devUserId` or the dev sign-in path in
the built bundle.** It cannot be enabled in production because it is not there.

**What looking found:**

- **The page title was 24px out of line with the cards beneath it.** The
  topbar's inner box centred inside the bar's *own padding*, while the content
  column centred inside the full width — so the two columns never agreed. The
  inner box now mirrors `.content` exactly: same max-width, same centring, same
  inline padding, with the padding moved off the bar itself. Measured
  afterwards rather than eyeballed: title and card share a left edge on all
  four default routes.
- **The login page's white panel floated mid-column on wide screens**, because
  the max-width sat on the panel rather than on an inner wrapper. The surface
  now fills its grid column with the copy held to a readable measure inside it.

Neither was visible in the code. Both were obvious in a picture.

#### Part 2 — The admin role

**Design decision 1 — admin is granted, never chosen.** Student and mentor are
self-service. Admin is not in that set: it comes from the server's
`ADMIN_EMAILS` allowlist, applied at every login. The first-login picker and
the profile switcher offer only two options, `POST /api/users/:id/role` already
validated against exactly `['student','mentor']` so it rejected admin without
any change, and **the admin endpoint cannot grant admin either** — otherwise
one compromised admin account would be enough to mint more. The principle:
**a role a user can assign to themselves is not an access control.**

*Deliberate asymmetry:* adding an address promotes on next sign-in; removing
one does **not** automatically demote. Demoting would need a read of the
current role before the upsert, and silently stripping someone's access on a
config edit is worse than doing it explicitly from the dashboard.

**Design decision 2 — admin is a superset of mentor, not a sibling.** The
mentor gates now accept `['mentor','admin']`. Without that an admin could not
use the very features they oversee, which would be a strange product and an
irritating one to test. On the frontend this became `canMentor(role)` in
`src/lib/roles.js`, because `role === 'mentor'` had been written in four
separate pages and four places is exactly where an inconsistency hides.

**Design decision 3 — every number on the dashboard is counted live.** No
placeholder figures. With a three-user database the dashboard reads "3 users,
0 groups, 0 messages", and that is the honest answer. A dashboard showing
"1,284 students" screenshots well and collapses the first time somebody asks
what it means.

**Design decision 4 — two guards on the admin role endpoint.** It refuses to
set `admin` (above), refuses to touch another admin, and refuses to change
**your own** role — which would otherwise let an admin demote themselves out of
the page they are standing in. Self-service role changes stay on the other
endpoint, which refuses to touch anyone *but* you. The two endpoints have
exactly opposite ownership rules, which is the point.

**Verified — 8 checks against the running server:** the allowlist promoted an
account to admin on login; `/api/admin/stats` and `/api/admin/users` returned
**403** to a student and **200** to the admin; `PATCH … role` → `admin` was
refused **400**; changing one's own role was refused **400**; changing someone
else's succeeded **200**; and the same PATCH from a student was refused
**403**. Then the dashboard was screenshotted as an admin: real counts, the
role split, the user table with per-row controls, "You" on your own row, and
the Administration section appearing in the sidebar.

**Test data restored.** These checks changed two roles in the real database
(one promotion to admin, one student→mentor). Both were set back afterwards
and the three users are as they were.

**One thing that was NOT restored, and should be recorded.** An earlier
auth check in Entry 15 called `POST /api/auth/login` with a made-up
`email`/`displayName` against an existing `firebaseUid`. Because that endpoint
is an upsert, it **overwrote that user's real name and email** with
"Existing User" / "existing@example.com". The originals were not captured and
cannot be restored from here — but they self-heal: display name and email are
re-synced from the Google token on that account's next sign-in. The lesson for
future testing against a live database is to use a **throwaway `firebaseUid`**
so the upsert inserts rather than updates.

---

### Entry 17 — Presence, and the multi-tab bugs hiding behind it

**What I fixed.** The known presence bug turned out to be one of four, all
sharing a root cause. Chasing it properly was worth more than patching the
symptom.

**Files changed:** `server/index.js`.

**The reported bug.** `POST /api/auth/login` set `isOnline: true`. But signing
in is not the same as being connected: the socket may never open — the tab is
closed straight away, the connection is refused, the network drops — and
nothing would ever set the flag back. A green dot next to someone who left.

Fixed by making presence owned **entirely** by the socket lifecycle:
`user-online` sets it, `disconnect` clears it, and login does not touch it.

**The second bug, found while fixing the first.** Sockets do not survive a
restart, so at boot nobody is connected *by definition* — yet any
`isOnline: true` left in the database from a crash or a kill would sit there
forever. The server now clears stale presence once, on connect. Worth doing
because it is the failure mode you actually hit in development, where the
server gets killed constantly.

**The third and fourth bugs, from one line.** `onlineUsers` was a
`Map<userId, socketId>` — **one** socket per person. A second tab silently
replaced the first, which broke two separate things:

- **Closing either tab marked the user offline** while they were still sitting
  in the other one.
- **Only the most recent tab received anything** — messages, typing
  indicators, read receipts. Worse, `message-sent` went only to the sending
  socket, so your own message would not even appear in your other window.

The map is now `Map<userId, Set<socketId>>`, with three small helpers:
`addUserSocket` returns whether this was the user's *first* socket,
`removeUserSocket` returns whether it was their *last*, and `emitToUser` fans
an event out to every tab. The database write and the status broadcast now
happen only on the first connect and the last disconnect, so opening a second
tab no longer makes every other client redraw for nothing.

**Design note — why a Set rather than Socket.IO rooms.** Joining a
`user:<id>` room per socket would also fan out correctly, and the group code
already uses rooms. I kept an explicit Set because presence needs two things
rooms do not give cheaply: the *list* of online user ids (sent to each client
on connect) and a reliable first/last transition. Reading those back out of
the adapter means depending on Socket.IO internals; a Set states the intent
directly.

**Verified — and I checked the bugs were real, not theoretical.** A 9-check
suite covering all four fixes, run twice: once against the fix, and once
against the previous commit with the fix stashed.

| | before | after |
| --- | --- | --- |
| Stale flag cleared at boot | ✗ | ✓ |
| REST login alone leaves you offline | ✗ | ✓ |
| First socket brings you online | ✓ | ✓ |
| Second tab emits no status change | ✗ | ✓ |
| Still online with two tabs | ✓ | ✓ |
| Both tabs receive a message | ✗ | ✓ |
| Closing one tab keeps you online | ✗ | ✓ |
| Closing the last tab takes you offline | ✓ | ✓ |

**4/9 before, 9/9 after.** The test created one message and set one flag; both
were removed afterwards and the database was left as found. The suite itself
was ad hoc and is *not* committed — same caveat as Entries 15 and 16, and
another argument for the test-suite item still on the open list.

**Confirmed live afterwards:** with the fix in place and the server restarted,
the browser session reconnected and set `isOnline: true` on its own, with no
stale-clear needed at boot.

---

### Entry 18 — An actual test suite

**What I built.** 67 integration tests covering the server. This closes the
item that had been growing through Entries 15, 16 and 17, each of which ended
with the same admission: *verified by hand, scripts not kept*. Three suites
written and thrown away is a habit, not an accident.

**Files added:** `server/test/helpers/harness.js`, `auth.test.js`,
`admin.test.js`, `realtime.test.js`, `startup.test.js` — 788 lines.

**Files changed:** `server/package.json` (a `test` script and one
devDependency), `README.md`, `docs/PROJECT_BRIEF.md`.

**Design decision 1 — Node's built-in runner, no test framework.** `node:test`
ships with Node, so the suite adds **no runner dependency**: no Jest, no Vitest,
no Mocha, no config file, no transform step. The only devDependency added was
`socket.io-client`, which is needed to actually drive the socket layer and
can't be avoided. For a project whose whole backend is six dependencies,
bringing in a framework with fifty would have been out of proportion.

**Design decision 2 — a throwaway database, and this one matters.** Tests point
`MONGODB_URI` at `chatapp_test` and drop it on teardown. This is a direct
response to how badly the earlier manual runs behaved: they hit the real
`chatapp` database, which twice meant repairing roles afterwards and once
**overwrote a real user's name and email** (recorded in Entry 16). That class
of mistake is now impossible rather than merely discouraged. The development
database is untouched by a test run — verified after the fact.

**Design decision 3 — spawn the real server, don't import an app object.** The
harness runs `node index.js` as a child process with test environment
variables. Importing an Express app would have been tidier and would have
tested less: spawning exercises the config validation that `process.exit(1)`s
on a missing `FIREBASE_PROJECT_ID`, the Mongo connection, and the startup
presence reset — the last of which is a *boot-time* behaviour that an imported
app cannot express at all. `startup.test.js` exists precisely to assert on it,
which is why it manages its own server lifecycle rather than sharing the
others'.

**Design decision 4 — tests authenticate through the dev escape hatch.** A
Google sign-in popup cannot be automated, which is the reason `ALLOW_DEV_AUTH`
was built in Entry 15. It now earns its keep: the harness sets it, and every
test acts as a fixture user via `X-Dev-User-Id`. Worth noting the shape of
this — the feature that makes the app testable is the same one that must never
be enabled in production, and both facts are enforced in code.

**Two things that bit, worth recording.**

- `node --test test/` fails: a trailing-slash directory argument is treated as
  a *module path* and Node tries to `require` it. The working form is a quoted
  glob, `"test/**/*.test.js"`, so Node expands it rather than the shell —
  which also avoids the difference between `cmd` and bash globbing.
- The suite runs with `--test-concurrency=1`. Every file spawns a server on the
  same port and shares one database, so parallel files would fight over both.
  Serial costs about ten seconds total, which is not worth engineering around.

**What the 67 cover.**

| File | Tests | Area |
| --- | --- | --- |
| `auth.test.js` | 21 | Identity required; ownership (own vs others' conversations, profiles, roles); role gates; mentor-only fields dropped for students; announcement delete as an *ownership* check, using an admin — who can post — to prove it is not a role check |
| `admin.test.js` | 22 | Admin-only endpoints refused to students *and* mentors; stats counted from the database; admin unassignable by either endpoint; no self-demotion; allowlist promotion at sign-in |
| `realtime.test.js` | 20 | Handshake rejection; **sender identity taken from the socket, not the payload**; group membership over socket and REST; presence not set by login; multi-tab behaviour end to end |
| `startup.test.js` | 4 | Stale presence cleared at boot, asserted in the database *and* in the server log |

Several assert on absence, which is the more useful half: a refused request
must also **write nothing**, and opening a second tab must emit **no** status
change. A check that only confirms the happy path would have missed all four
bugs from Entry 17.

**Verified:** `cd server && npm test` — 67 passing in about 10 s. ESLint now
covers 41 files (the tests included) with 0 errors. Production build clean.
The development database was inspected afterwards and holds the same three
users, unchanged.

**Docs corrected in the same commit.** `docs/PROJECT_BRIEF.md` led with
"Automated tests: 0" and listed "No automated tests" under what is not
implemented — both now false. Its stale figures were re-derived at the same
time (commits, line count, `index.js` length, the user count, and the
description of the presence map, which Entry 17 changed from one socket per
user to a set).

---

### Entry 19 — Verification, suspension and reports (UI)

**What I built.** The screens for the three admin powers whose server side
landed in Entry 18's commit. Split deliberately: endpoints and tests first,
then a UI rendering an interface that was already verified.

**Files added:** `src/pages/SuspendedPage.jsx` + module.

**Files changed:** `AdminPage.jsx` (rewritten), `ProfilePage.jsx`,
`UserProfilePage.jsx`, `UsersPage.jsx`, `App.jsx`, `AuthContext.jsx`,
`Badge.jsx`, `ConfirmDialog.jsx`, `lib/roles.js`, four stylesheets.

**Design decision 1 — the badge says what was actually checked.** `VerifiedBadge`
renders for `approved` and nothing else, and its tooltip reads "an
administrator reviewed this mentor's stated credentials". The queue itself
carries a line in warning colour: *nothing here has been checked
automatically; approve only what you have looked at yourself*. This is the
same feature the earlier scoping rejected — a ✓ that certifies nothing is
worse than no ✓ — made honest by putting a person behind it and saying so.

**Design decision 2 — queues above the table.** The admin page now leads with
mentor verification and reports, then stats, then users. A pending request is
work waiting on you; the table is reference. The subtitle counts the two
queues, so the page says "2 items waiting on you" or "Nothing waiting on you"
before you read anything else.

**Design decision 3 — a rejection sits above the form, not instead of it.** A
mentor whose request was rejected sees the reviewer's note *and* the form,
pre-filled with what they last submitted. Replacing the form with an error
would mean retyping four fields to fix one; showing them together makes
"update the details below" literally true.

**Design decision 4 — moderation actions require a reason.** `ConfirmDialog`
gained `children` and `confirmDisabled`, so suspending and rejecting can
demand a written reason before the button enables. The suspension reason is
shown to the person on the screen that replaces the app for them — a lockout
with no explanation is the worst version of this feature. Report resolutions
take an optional note, since "nothing to answer" is a legitimate outcome that
needs no essay.

**Design decision 5 — suspension is gated before the role picker.** In
`App.jsx` the suspended check runs *first*. A suspended account with no role
would otherwise be shown the first-login picker, which is both useless and
misleading, since every request it made would be refused anyway.

**A small one worth keeping:** the report control is a `ghost` button next to
the primary Message action. Reporting should be available without being the
second thing you notice about a person.

**Verified in a browser, against a throwaway database.** Rather than seed
demo data into the development database — the mistake recorded in Entry 16 —
the whole app was pointed at `chatapp_test`, seeded with four users, one
pending verification and one open report, screenshotted, and the database
dropped afterwards. The development database was confirmed unchanged: same
three accounts, no suspensions, no reports.

What the screenshots confirmed:

- The admin page renders both queues with the evidence grid, the LinkedIn
  link, the caution line, and the snapshot quoted as somebody else's text.
- Approving through the API made the green **✓ Verified** badge appear beside
  the mentor's role badge in the users list.
- The rejected branch on a mentor's own profile shows the reviewer's note in a
  red-bordered block above a form pre-filled with the previous submission.
- Both at desktop and mobile widths, with no console errors and no unexpected
  redirects.

**Still not covered by tests:** all of the above is frontend, and there are no
frontend tests. The 105 server tests cover the endpoints these screens call,
but nothing asserts that the screens call them correctly. That gap is on the
open list.

---

### Entry 20 — The mentorship relationship

**What I built.** The entity the app has been missing. Until now "mentor" was
an adjective on a user; there was no way to say *this person mentors that
person*. Goals, sessions, scheduling and every progress figure need an owner,
and this is it — which is why it came before all of them.

**Files added:** `server/models/Mentorship.js`, `src/pages/MentorshipsPage.jsx`
+ module.

**Files changed:** `server/index.js` (three endpoints), `App.jsx`,
`AppShell.jsx`, `Icons.jsx`, `UserProfilePage.jsx`.

**The lifecycle.**

```
pending ──accept──▶ active ──end──▶ ended
   │
   └──decline──▶ declined
```

One-way, deliberately. A declined or ended relationship is never revived —
asking again creates a *new* record, so who asked whom and what was answered
survives as history instead of being overwritten by the next attempt.

**Design decision 1 — `student` means "whoever asked", not "whoever has the
student role".** A mentor wanting mentoring in a different subject is an
ordinary case, and requiring `role === 'student'` on the asking side would
forbid it for no reason. The only requirement enforced is that the person
being *asked* can actually mentor. This is why the page shows both sides at
once rather than splitting by role: one person can be a student in one
relationship and a mentor in another, and a role-split view would hide half
of what they have.

**Design decision 2 — three moves, three different rules about who may make
them.** Accept and decline are the **mentor's alone**; the student cannot
answer their own request. Ending is available to **either party**, without
the other's agreement — a person who wants out of a mentorship should not
need permission. Getting this wrong in either direction would be a real
product bug, so the checks are explicit rather than a single "is this yours".

**Design decision 3 — the duplicate guard is in the route, and here is why
not an index.** The natural expression is a partial unique index on
`{ student, mentor }` filtered to `status: { $in: ['pending', 'active'] }` —
but `partialFilterExpression` **does not support `$in`**, only equality and
range operators. Two separate partial indexes would not compose into the rule
either: they would permit one pending *and* one active for the same pair. So
the check lives in `POST /api/mentorships`, and the tradeoff is stated in the
model: genuinely concurrent duplicate requests could slip two rows through. At
this scale that is a nuisance, not a defect, and the alternative is a
transaction for something a person clicks once.

**Design decision 4 — `topic` is required.** A request with no stated purpose
gives the mentor nothing to decide on. It is also the field goals will later
be grouped under, so making it optional now would mean a migration later.

**Verified by hand — 14 HTTP checks against a throwaway database.**

*Happy path:* two students request the same mentor; both succeed.

*Creation guards:* a duplicate request → **409**; asking a student → **400
"That person is not a mentor"**; asking yourself → **400**; omitting the topic
→ **400**. A suspended mentor is refused too, since the request would be one
nobody can answer.

*Who may answer:* the student trying to accept their own request → **403
"Only the mentor can answer a request"**; an unrelated third party → **403
"This is not your mentorship"**; the mentor → **200**; accepting a second time
→ **400 "already been answered"**.

*Ending:* the **student** ending an active mentorship → **200** (either party
may); ending it again → **400**; re-requesting the same mentor after it ended
→ **200**, confirming the duplicate guard covers only live relationships.

Then screenshotted as the mentor: the request queue with the student's topic
and quoted note, the active student with their topic where a status line would
be, and the ended one under Past. Sections render only when they have content,
so this mentor sees no empty "Your mentors".

**Not in the test suite yet.** Those 14 checks were run by hand and not
committed — the same gap Entries 15–17 had, reopened deliberately because
tests were deferred to the end of this batch of work. Every other server
feature is covered; this one is the exception, and it is on the open list.

**The database was never touched.** Everything above ran against
`chatapp_test`, dropped afterwards. The development database still holds three
users and zero mentorships.

---

### Entry 21 — Goals and milestones

**What I built.** The first thing in the app that produces *progress* — a
number that means something. A mentor sets what the student is working
towards, breaks it into milestones, and either party ticks them off.

**Files added:** `server/models/Goal.js`, `src/components/Progress.jsx` +
module, `src/pages/MentorshipDetailPage.jsx` + module.

**Files changed:** `server/index.js` (four endpoints), `App.jsx`,
`MentorshipsPage.jsx`.

**Design decision 1 — a goal belongs to a mentorship, not to a person.** This
is the whole reason the relationship had to exist first. *"Priya's goals"* is
ambiguous the moment she has two mentors; *"the goals of this mentorship"*
never is. It also gives every later feature — sessions, analytics, a health
score — an unambiguous thing to aggregate over.

**Design decision 2 — status is derived, and deliberately so.** `active` and
`completed` are recomputed from the milestones every time one is toggled, by
an explicit `refreshStatus()` call rather than a Mongoose hook. A hook doing
it invisibly is exactly how a status ends up disagreeing with the data it
summarises; a method makes it visible at the call site that the value is being
derived rather than set.

`archived` is the one status a person sets, because "we are not doing this any
more" is not something the milestones can imply. Un-archiving hands the status
back to the milestones rather than guessing at `active` — the goal may well be
finished.

**The 0-of-0 case is handled explicitly:** a goal with no milestones is never
complete. `done === total` would be true for `0 === 0`, and 100% on an empty
goal is a lie.

**Design decision 3 — asymmetric permissions, which is the point of the
feature.** Only the **mentor** may create or edit a goal; **either** party may
tick a milestone. The student does the work and reports it; the mentor can
correct a mistake without having to ask. `doneBy` records which of them it
was, so "the student says it's done" stays distinguishable from "the mentor
confirmed it". Letting the student set their own goals would make the mentor's
part decorative.

**Design decision 4 — milestones are embedded.** They are only ever read as
part of their goal, they are few, and a milestone without its goal is
meaningless. Mongoose still gives each subdocument an `_id`, so the toggle
route addresses one directly rather than by array index — which would break
the moment a milestone was inserted or removed. *Tradeoff, recorded in the
model:* you cannot query across all milestones ("everything due this week")
without unwinding. If scheduling later needs that, this becomes its own
collection.

**A small shared piece.** `Progress` takes `done` and `total` rather than a
percentage, because only the raw counts let it tell 0-of-0 from 0-of-4. It is
a real `progressbar` to assistive technology with a label naming what is being
measured — a bare percentage announced alone tells a screen-reader user
nothing. The fill is the accent while in progress and green only once
finished, so the colour change carries information rather than decorating.

**The screen this produced.** `/mentorships/:id` is the closest thing the app
has to a signature view: the other person, overall progress across every live
goal, then each goal with its own meter and checkable milestones. Overall
progress counts *milestones*, not goals, so one finished goal out of four does
not read as "done".

**Verified by hand — 9 checks.** The student trying to set a goal → **403
"Only the mentor can set goals"**; a goal with no title → **400**; the mentor
setting one → **200**. Then the derived status, which is the part worth
proving: the **student** ticking two milestones → allowed, status stays
`active`; an unrelated third party ticking one → **403**; the **mentor**
ticking the third → `active` at 3/4; the fourth → status flips itself to
**`completed`** with `completedAt` set; un-ticking one → back to **`active`**
with `completedAt` cleared again.

Then screenshotted as the mentor with two goals at 3/4 and 0/4, showing
overall progress at 3 of 8.

**Not in the test suite.** Same as Entry 20 — these 9 checks were run by hand
and not committed, because tests were deferred to one pass at the end of this
batch. Mentorships and goals are now the only two server features without
coverage.

**The development database was never touched.** Everything ran against
`chatapp_test`, dropped afterwards.

---

### Entry 22 — Scheduling

**What I built.** The other half of a mentorship. Goals say what someone is
working towards; sessions are when the work gets talked about. Either party
proposes a time, the other confirms it, and it can be moved, called off, or
marked done with notes afterwards.

**Files added:** `server/models/Session.js`, `src/components/Sessions.jsx` +
module.

**Files changed:** `server/index.js` (four endpoints, 34 total),
`MentorshipDetailPage.jsx`, `MentorshipsPage.jsx` + module, `Field.jsx` +
module (a shared `Select`), `Icons.jsx` (a calendar glyph).

**Design decision 1 — the permissions are the inverse of goals, on purpose.**
Only the mentor may set a goal, because a goal is a directive. *Anyone* may
propose a session, because asking for time is not — a student asking "can we
meet Thursday?" is probably the most common case there is. What keeps that
from being unilateral is that the *other* person confirms it: the proposer is
refused with a 403 if they try to confirm their own. Two rules, opposite
directions, each one following from what the thing actually is.

**Design decision 2 — rescheduling un-confirms.** Moving a session sends it
back to `proposed` and makes the mover the new proposer, so the other side has
to agree again. The alternative — silently changing the time on a confirmed
session — is the worst outcome available: both people would believe they had
agreed on something, and only one of them would be right. `confirmedAt` is
cleared at the same time so the record cannot claim an agreement that no
longer exists.

**Design decision 3 — the transitions live in the model, not at the call
sites.** `ALLOWED_TRANSITIONS` is a table, and `canBecome()` reads it. Four
actions share one PATCH route, so without the table each of them would have
carried its own hand-written list of what it was allowed to follow, and the
fifth one added later would have got one of them wrong. `completed` and
`cancelled` are terminal: there is no un-cancel, because the record that a
meeting was called off is worth keeping and proposing a new time is both
easier and more honest than editing history.

**Design decision 4 — a session cannot be marked done before it starts.**
`hasStarted()` gates `complete`, so the history cannot claim things that have
not happened. The mirror of it is that creation refuses a past date — mostly a
typo guard, since the wrong year is the easiest thing to get wrong in a date
field. A meeting that already happened gets recorded by completing it, not by
scheduling it. Notes are gated the same way: they are a record of what
happened, so they are refused until something has, and the agenda is the field
for intent before that.

**Design decision 5 — `GET /api/sessions/upcoming` is not scoped to one
mentorship.** Every other session route is. This one exists because *"when am
I next meeting anyone?"* is a question about your week, not about one
relationship, and answering it should not mean opening three pages and
comparing dates. It reads only `active` mentorships — a session left over from
a relationship that has since ended is not something either person still owes
— and only `proposed`/`confirmed`: it is a list of commitments, not history.

**Design decision 6 — one compound index, not two.** `{ mentorship: 1,
scheduledFor: -1 }` serves both reads: the per-mentorship list, by equality on
the prefix, and the upcoming query, which is an `$in` over my mentorship ids
plus a date range on the same prefix. A separate index on `scheduledFor` alone
would only earn its keep for a cross-user sweep, and nothing does that.

**Design decision 7 — the clock is state, not a render-time read.** ESLint's
React-compiler rule rejected `Date.now()` during render, which was the right
call for a reason beyond purity: the labels are relative ("in 3 days"), so a
value read once at mount goes wrong the longer the page stays open. A `useNow`
hook ticking once a minute fixed the lint *and* made the UI honest — "in 2
minutes" becomes "2 minutes ago" on its own, and a session moves from Upcoming
to Past without anyone refreshing.

**UI notes.** Each session gets a date rail — weekday, day, month, in a boxed
column to the left — because the date is what you scan a list of meetings for,
and prose does not scan. The first version printed the full date *again* in the
line beside it; the mobile screenshot showed that line wrapping onto three
rows to say what the rail already said. The rail is now the only visible date,
and the full one lives in an `sr-only` span inside the `<time>` element, since
the rail is `aria-hidden` and screen readers would otherwise get nothing.

Status labels say what is true rather than naming the field: "Awaiting
confirmation", not "Proposed". One tells you something is owed; the other only
names a state.

Cancelling goes through a `ConfirmDialog` with an optional reason, the same
shape as declining a mentorship request — the other person has that time set
aside, so it should not be one click away.

Sessions sit *below* the goals on the detail page, deliberately: goals are what
the page is for. The time-sensitive question — what is coming up — is answered
instead by a "Coming up" card on the mentorships list, which is where it
belongs, because it spans every relationship rather than one.

**A shared `Select`.** The duration picker needed a `<select>` styled like the
existing inputs, so it went into `Field.jsx` next to `Input` and `Textarea`
rather than being styled locally. Suppressing `appearance` also removes the
native arrow, so it is redrawn from two CSS gradients — which inherit
`currentColor`, and therefore follow the theme without a second asset.

**Verified with 40 checks** against a throwaway `chatapp_test` database, using
the harness the committed tests already use: the student proposing (201, and
`proposedBy` is them), the proposer confirming their own (403), the other
party confirming (`confirmedAt` set), an outsider on every route (403), a past
date, a bad duration, a blank title, an unparseable date and a non-active
mentorship (400 each), completing before the start time (400), rescheduling
(back to `proposed`, proposer flipped, `confirmedAt` cleared), completing after
the clock was moved back in the database (`completedAt` set), notes before and
after completion (400 then saved), confirming and cancelling a completed
session (400 each), cancelling with a reason (`cancelledBy` and the reason
stored), rescheduling a cancelled one (400), and `upcoming` returning only open
future sessions, soonest first, with names populated, empty for someone whose
only mentorship is still pending. The existing 105 tests still pass.

Screenshotted at both viewport widths against a seeded throwaway database —
never the development one — with the preview stack torn down and
`chatapp_test` dropped afterwards.

**Not in the test suite.** Same as Entries 20 and 21: these 40 checks were run
by hand and not committed, because tests were deferred to one pass at the end
of this batch. Mentorships, goals and sessions are now the three server
features without coverage.

**What this unblocks.** Analytics now has two things to aggregate rather than
one — goal completion *and* session history — which is the difference between
a progress bar and something worth calling a dashboard.

---

### Entry 23 — One header per chat, not two

**The bug, as reported:** *"why are there two group bars on the right? it
appears on opening a group."* Opening a group showed the name and member
count in the top bar, and then again in a second bar directly beneath it.

**Why it happened.** `AppShell`'s top bar already renders `title` and
`subtitle`, and `GroupChatPage` passed the group name and `3 members` into
them. It *also* rendered its own strip below, which printed the same two
strings — because the strip was where the group avatar and the member avatars
lived, and there was nowhere else to put them. The duplication was not the
point of the strip; it was the price of it.

The same fault was in `ChatPage` and had gone unnoticed because it only
repeats one string rather than two: the top bar says the peer's name, and the
peer strip underneath said it again. Its strip existed to hold the avatar with
its presence dot and the role badge — and it linked to the profile, which the
"View profile" button in the top bar already did.

**The fix — give the top bar somewhere to put an avatar.** `AppShell` gained a
`leading` slot, rendered between the back button and the title. Both chat
pages now pass their avatar there, put the extras in `actions`, and delete the
strip entirely:

- **Group:** `leading` is the group initial; `actions` is the overlapping
  member avatars — the one thing the bar could not already say.
- **1-to-1:** `leading` is the peer's avatar with its presence dot; `actions`
  is the role badge next to the existing profile button.

Deleting the strips also removed `.strip`, `.stripText`, `.groupName`,
`.groupMeta`, `.peerStrip` and `.peerName`, plus two responsive rules that
only existed to pad them.

**The lesson, written into `AppShell`'s doc comment** so the next page does not
repeat it: `title`, `subtitle`, `leading` and `actions` are meant to be the
*whole* header. A page that adds a second bar of its own underneath will end
up printing its title twice.

**`VITE_SERVER_URL`.** Verifying this needed a browser, and the dev stack was
already running on 3001 against the real `chatapp` database — which is exactly
what must never be screenshotted against, after the incident in Entry 18.
`SERVER_URL` in `AuthContext` was a hardcoded `http://localhost:3001`, so
there was no way to stand a second copy up beside it. It now reads
`import.meta.env.VITE_SERVER_URL` and falls back to the same literal, so the
default path is unchanged and nothing needs configuring to run it normally.

That let the preview run on 3002/5174 against a seeded `chatapp_test` while
the real stack stayed up and untouched on 3001/5173. It also removes a
hardcoded localhost that would have blocked deployment later — the change was
needed for the verification, but it was worth making anyway.

**Verified** by screenshotting both chat screens at desktop and mobile widths:
one bar each, no console errors, no redirects, and the member avatars still
fit beside the title at 390px. `chatapp_test` was dropped afterwards and the
development database confirmed untouched. Lint 0 errors, build clean, 105
tests still passing.

---

### Entry 24 — Analytics, and the question it answers

**What I built.** Goals and sessions had been accumulating real data for two
entries with nothing reading it back. This is the page that reads it — plus
the fix to the admin dashboard that was the reason to start here.

**Files added:** `src/pages/ProgressPage.jsx` + module,
`src/components/Stat.jsx` + module, `src/lib/useNow.js`.

**Files changed:** `server/index.js` (one endpoint, 35 total; admin stats
extended), `AdminPage.jsx` + module, `AppShell.jsx`, `App.jsx`, `Icons.jsx`,
`Sessions.jsx`.

**The bug that set the direction.** `GET /api/admin/stats` was counting users,
groups, messages and announcements — and nothing else. Mentorships, goals and
sessions did not appear anywhere on it. The dashboard's own subtitle says
*"Counted live — no placeholder figures"*, and it was true as far as it went;
an overview that silently omits the three largest features in the product is
its own kind of invented number. Six `countDocuments` calls fixed it.

**Design decision 1 — the page is built around a question, not a scoreboard.**
The obvious analytics page is a wall of totals. The useful one answers the
question a mentor with four students actually has: *which of them has gone
quiet?* So the rows are sorted by how long it has been since a session
actually happened, quietest first, and the row that needs acting on is the one
at the top rather than the one you scroll to find. The totals are above it for
context — they are not the point of the page.

**Design decision 2 — aggregation, not a loop.** Counting in JavaScript would
have meant pulling every goal document, milestone arrays and all, across the
wire to read a boolean on each. `$group` with `$size`/`$filter` over the
embedded milestones does the counting where the data already is and returns
one small row per mentorship. At this project's scale either is instant; the
pipeline is the one that stays instant.

`$min` and `$max` over a `$cond` that yields `null` for non-qualifying rows
turned out to be exactly the right tool for "the latest session that happened"
and "the soonest one still to come" — both accumulators ignore nulls, so no
second query was needed for either.

**Design decision 3 — archived goals contribute no milestones.** A goal you
gave up on would otherwise drag the completion figure down forever. "We
decided not to do this" is not the same as "this is unfinished", and a
progress number that never recovers from an abandoned goal is a number people
learn to ignore. Archived goals still count in the *goal* total, because they
did exist; only their milestones are excluded. Verified explicitly rather than
assumed — a 2-milestone archived goal is in the fixture precisely to prove it
does not appear in the 14.

**Design decision 4 — the attention flag is a label first, a colour second.**
"Quiet for 34 days", "Not met yet", "Nothing booked". A badge that means
something only if you can see red means nothing to some readers, so the text
carries it and the colour reinforces it. A mentorship with a session already
booked is not flagged at all — the booking is the answer to the question.

**Design decision 5 — "sessions kept" is hidden rather than shown as 0%.** The
rate is completed over arranged, which is meaningless before anything has been
arranged. Showing 0% to someone who has never cancelled anything would be a
lie told by a denominator.

**Two extractions rather than two copies.** The stat tile existed only inside
`AdminPage.module.css`; the new page needed the same one, and copying thirty
lines of CSS into a second module is how a design system starts to drift. It
is now `Stat` / `StatGrid`, and AdminPage renders through it — the tiles look
identical, they just have one definition. Likewise `useNow` and `relative`
moved out of `Sessions.jsx` into `src/lib/useNow.js` when this page needed the
same ticking clock for its "most recently" labels.

**A wording bug the screenshot caught.** The facts line read *"1 session met,
last last month"* — `relative()` returns "last month" for anything that old,
and the template was prepending its own "last". It says "most recently" now,
which reads correctly against both "last month" and "3 days ago". Worth
recording because it is the second time in three entries that rendering the
page has caught something no test would have: the first was a date printed
twice, this one is a word.

**Verified with 39 checks** against a throwaway `chatapp_test`: the totals and
their per-row breakdown agreeing, archived milestones excluded while archived
goals still count, minutes summed from completed sessions only, the ordering
putting a never-met mentorship ahead of a 34-day-quiet one, `isMentor` and
`other` resolving per viewer, a student seeing only their own row, someone
with no mentorships getting a zeroed shape rather than a 404 or an error, an
ended mentorship leaving the rows but staying in the totals, 401 without a
token, and the six new admin figures with a non-admin still refused. The
existing 105 tests still pass.

Screenshotted at both widths against a seeded fixture built to contain all
three states at once — healthy, quiet, never-met — so the sorting and the
flags could be checked rather than assumed. `chatapp_test` dropped afterwards.

**Not in the test suite.** Same standing gap: mentorships, goals, sessions and
now analytics are the four server features whose checks were run by hand and
not committed.

---

### Entry 25 — Unread counts and message previews

**The report.** *"There is absolutely no message notification system... if
someone sends a message it isn't visible on the users page alongside their
name with a number or something."* Correct, and worse than it sounds: every
row said "Online" or "Offline" underneath the name, so a list of people you
had been talking to all day looked identical to a list of strangers. The only
way to find out whether anyone had said anything was to open each conversation
in turn.

**Files added:** `src/context/ConversationsContext.jsx`,
`src/components/UnreadBadge.jsx` + module.

**Files changed:** `server/index.js` (one endpoint, 36 total; `mark-read` now
emits twice), `UsersPage.jsx` + module, `AppShell.jsx` + module, `App.jsx`.

**Design decision 1 — one aggregation, not 2N queries.** The obvious version
loops the user list and runs two queries each: last message, unread count.
`GET /api/conversations` is one pass instead — sort every message the caller
is party to newest-first, then `$group` on "the other person", taking `$first`
for the preview and summing unread on the way through. *Stated tradeoff:* it
grows with the caller's history rather than their contact count, and a real
deployment with long histories would keep a denormalised conversation document
updated on write. At this scale the two existing compound indexes serve it.

**Design decision 2 — the state lives above both screens.** Two things need
these numbers and they have to agree: the per-person rows and the one total
beside "Messages" in the sidebar. Separate copies would drift the moment a
socket event arrived while only one of them was mounted, so
`ConversationsContext` owns the fetch and the socket wiring, and both read it.

**A real bug this exposed.** `mark-read` told the *peer* their message had
been seen, and told nobody else. Your own other tabs never learned you had
read anything — so a conversation opened in one window left the count sitting
there in another until a reload. The handler now emits twice, and the comment
in the code says why: `messages-read` to the peer is a receipt, and
`conversation-read` to yourself is what clears the badge. Two different facts,
two different audiences; one of them had simply been missing.

**Design decision 3 — a people list that behaves like a messages list.**
Anyone you have spoken to sorts to the top by recency and shows a preview;
everyone else keeps their alphabetical place underneath. That way a new
contact is still findable rather than buried under whoever messaged most
recently, which is what a pure conversation list would have done.

The presence line was not lost when the preview took its place — it moved to
the dot on the avatar, which is where every other messaging app puts it. Rows
with no history still read "Online"/"Offline", because for those people that
is the only thing there is to say.

**Design decision 4 — unread is three signals, not one.** The count pill, a
darker preview, and a heavier weight. A row that says "unread" only by the
colour of a small circle says nothing to a reader who cannot distinguish it,
and nothing at all once the pill has scrolled out of view.

**`UnreadBadge` is not `Badge`.** The existing one is a label that happens to
be small; this is a number that must stay circular at one digit and become a
pill at three, and it caps at 99+ because past a point the exact figure stops
being information and starts being a layout problem. The real number still
goes in the `aria-label`, since a screen reader has no layout to protect.

**A test bug worth recording.** Two socket checks failed at first —
`conversation-read` and the pre-existing `messages-read` both arrived as null,
while the database showed the read had been processed. The cause was in the
check, not the server: unicast fans out from the `onlineUsers` map, which is
populated by the `user-online` event, and the test sockets had connected
without emitting it. The real client emits it on connect. Worth writing down
because a socket that is connected but not *registered* looks identical from
the outside, and the same trap is waiting for the next unicast test.

**Verified with 23 checks** against a throwaway `chatapp_test`: an empty list
before anything is said, a preview and count appearing after one message, the
sender seeing the same row with nothing unread and `lastFromMe` true, counts
accumulating, a reply flipping the preview without marking their messages
read, `mark-read` clearing the count *and* notifying the reader's own tabs,
ordering by recency, counts staying per-peer, a third party seeing none of it,
401 without a token, reading one thread leaving the other alone, and the
original read receipt still reaching the peer. The 105 existing tests pass.

Screenshotted at both widths against a fixture with four deliberate states —
three unread, one unread, read-with-your-own-reply-last, and never messaged.

**Not in the test suite.** The five server features whose checks were run by
hand and not committed are now mentorships, goals, sessions, analytics and
conversations.

---

### Entry 26 — Mentorship goes two-way, and opt-outs

**The report.** *"Is mentorship not implemented yet? The mentorship page says
find someone on the messages page and ask them to mentor you — somehow this is
the same for both mentor and student — there is no actual option to add someone
as a mentor."*

**It was implemented** (Entry 20), and the answer was worth writing down: a
student opens a mentor's profile and gets a **Request mentorship** button,
which creates a `pending` mentorship the mentor accepts or declines. But two
of the three complaints were fair:

1. **The only entry point was a button on someone else's profile page** — you
   had to already know it was there. Nothing on the Mentorship page pointed at
   it beyond one line of prose.
2. **The empty state said the same thing to everybody.** "Ask them to mentor
   you" is nonsense addressed to a mentor: they take students on, they do not
   apply for one.
3. There genuinely was **no way for a mentor to start anything** — the model
   only ran student → mentor.

**What changed.** Mentorship is now asymmetric in both directions:

| | Who | Effect |
| --- | --- | --- |
| Add a student | Mentor | **Immediate** — `active`, no acceptance |
| Ask a mentor | Student | `pending` — the mentor answers |
| Remove a student | Mentor | Immediate |
| Opt out | Student | **Request with a reason** — the mentor answers |
| Withdraw a request | Student | Immediate, on their own unanswered request |

**Design decision 1 — why the two directions are not symmetric.** A student
asking costs the mentor time they have not agreed to spend, so it is a request
and it waits. A mentor adding a student costs the mentor their *own* time,
which they have just volunteered — there is nobody left to ask, and making them
wait for an acceptance would be ceremony.

**Design decision 2 — `initiatedBy` is stored, not inferred.** Once a
mentorship is active, who started it is the only thing that explains why one
party never had to say yes. It is also exactly what a student needs to point at
when opting out of something they never asked for, and it is what lets the
rows read "you added them" or "they asked you" instead of both looking alike.

**Design decision 3 — the opt-out is not a status.** A mentorship with an
opt-out pending is *still active*: goals are still tracked, sessions still
happen, and the mentor may yet talk them out of it. Folding it into `status`
would have meant every query meaning "currently mentoring" growing a second
value to check, and one of them eventually forgetting. It is an embedded
`optOut` block instead. `declined` is kept rather than reset to `none`, so a
student can see they were answered rather than ignored.

**Design decision 4 — withdrawing a request is not opting out.** A student may
`end` their own *pending* request outright, with no reason and no permission,
because nobody has agreed to anything yet. Walking out of a live relationship
is a different act and goes through the opt-out.

**The tradeoff, named rather than hidden.** A mentor who ignores an opt-out
leaves the student stuck in a mentorship they never asked for — the exact
situation the opt-out exists to fix. Nothing expires or escalates yet. The
seam is `optOut.requestedAt`: a sweep, an admin action, or auto-approval after
N days all hang off it. Left deliberately rather than guessed at, and flagged
to the user rather than quietly shipped.

**A migration detail.** `initiatedBy` is `required`, and rows written before it
existed have none — they would have failed validation on their next save. It
carries `default: 'student'`, which is not a guess: the only direction the app
offered until now *was* a student asking, so every pre-existing mentorship
genuinely was student-initiated.

**Two things the screenshot caught.** The mentor saw Priya in the opt-out queue
*and* again in "You mentor" with a plain Remove button and nothing connecting
them — she now carries a "Wants out" badge in the second list. And the
subtitle read "1 request waiting on you" while an opt-out also sat unanswered;
it counts both queues now, because a number that disagrees with the page under
it is worse than no number.

**Also fixed: the profile button row.** `.actions` was `display: flex` with no
`gap`, so Message / Request mentorship / Report sat flush against each other
and read as one striped block. It has a gap, wraps, and centres now. The
primary button also said `Message {firstName}`, which for "The One Above All"
rendered as **"Message The"** — it is plain "Message", which is what every
other page in the app already says.

**Verified with 44 checks** against a throwaway `chatapp_test`: both creation
directions and their statuses, a student refused when adding a student, a
mentor refused when "adding" another mentor, exactly-one-direction validation,
duplicates from both sides, a student refused when ending an active mentorship
but allowed to withdraw a pending request, opt-out requiring a reason and
belonging to the student, double requests refused, withdrawal, the mentor
declining (still active, answer recorded) and approving (ended, with `endedBy`
the *student* who asked, not the mentor who agreed), opt-out on an ended
mentorship, outsiders, unknown actions, 401, and a suspended target. The 105
existing tests still pass.

---

### Entry 27 — Group previews, unread counts and read receipts

**The ask.** *"The groups should have the message preview system and
notification system exactly like DMs do."* Plus read receipts, which groups
had never had in any form.

**Files added:** `server/models/GroupRead.js`.

**Files changed:** `server/index.js` (two endpoints, 38 total; one new socket
handler; `send-group-message` now fans out twice), `ConversationsContext.jsx`,
`GroupsPage.jsx` + module, `GroupChatPage.jsx` + module, `AppShell.jsx`.

**Design decision 1 — a high-water mark, not a `read` flag.** A direct message
has exactly one reader, so `read: true` on the message is the whole truth. A
group message has as many readers as the group has members, and the equivalent
would be a `readBy` array on every message: it grows with members × messages,
is rewritten on every read by every member, and has to be scanned to answer
"how many have I not read".

`GroupRead` is one row per (group, member) holding the timestamp of the last
message they have seen. One row, written once per open, and it answers both
questions the app actually asks — unread count is "messages newer than my
mark", and a read receipt is "whose mark is at or past this message". *It
cannot express "read message 5 but not message 3", which nothing needs:* chat
is read in order, and a per-message record is a large price for a distinction
nobody makes. A member with no row has never opened the group, which reads
correctly as "everything is unread" without a row to say so.

**Design decision 2 — the room is not the audience for a badge.** Group
messages broadcast to `group:<id>`, which contains only the people who
currently have that group *open*. Everyone else is precisely who an unread
badge is for. So `send-group-message` now emits twice: `new-group-message` to
the room, which is a message to render, and `group-activity` unicast to every
member, which is "something happened in this group". Two events because they
answer different questions, and the second one has a different audience by
definition.

**Design decision 3 — one context, two shapes.** Groups ride in
`ConversationsContext` beside direct messages rather than getting a provider
of their own. The Groups list and the sidebar badge beside it need the same
numbers, and a second provider would have meant a second socket subscription
racing the first. `byPeer` and `byGroup` are separate maps because the two are
keyed differently and merging them would only have been undone on the client.

**Design decision 4 — a group preview needs a name, a direct one does not.**
"Priya Nair: ah that explains the cold starts". In a one-to-one list the row
you are on already says who; in a group it does not, so the sender is part of
the preview — quieter than the message, because the message is what you are
scanning for and the name is the qualifier.

Non-members see the member count instead. They have no conversation to preview
and a stranger's messages are not theirs to read.

**Design decision 5 — receipts only on your own last message.** The same rule
WhatsApp follows, for the same reason: "who has seen this" is a question you
ask about something *you* sent. Rendering it on every message would be a wall
of names restating the same set. It reads "Seen by everyone" when the whole
group has caught up, names up to two, and falls back to "and N more" past
that.

**Two aggregations rather than one.** The preview is a `$group` with `$first`
over a time sort. The unread count cannot join it, because every group has its
*own* cutoff — the caller's mark — and one pipeline would need a `$switch` over
every group to say so. An `$or` of `{ group, timestamp: { $gt } }` clauses is
both clearer and a better fit for the existing `{ group: 1, timestamp: 1 }`
index.

**What the screenshot caught.** The list was rendering in whatever order
`/api/groups` returned, so a group with three unread messages sat *below* one
the viewer had never joined. It sorts by recency now, same as the messages
list — the rule was already written down one page over and had simply not been
applied here.

**Verified with 32 checks** against a throwaway `chatapp_test`: an empty list
before anything is said, previews carrying the sender's name, unread counting
for a member who has never opened the group, own messages never counting as
unread while still moving the preview, counts accumulating and clearing per
member independently, `mark-group-read` notifying the reader's own tabs *and*
broadcasting a receipt to the room, re-reading upserting rather than
duplicating, `group-activity` reaching a member who is not in the room at all,
non-members getting nothing and 403 on the receipts, 401 without a token, and
404 for a group that does not exist. The 105 existing tests still pass.

**Not in the test suite.** Six server features now: mentorships, goals,
sessions, analytics, conversations and group conversations.

---

### Entry 28 — The deferred test pass, and CI

**The ask.** *"Instead of hand checks maybe we can implement those tests in
GitHub Actions so they get tested automatically?"* Which retires the two
oldest items on this list at once: six features verified only by hand, and no
CI at all.

**Files added:** `server/test/mentorship.test.js`, `goals.test.js`,
`sessions.test.js`, `analytics.test.js`, `conversations.test.js`,
`groupreads.test.js`, `.github/workflows/ci.yml`.

**The suite went from 105 tests across 5 files to 273 across 11**, in about
23 seconds. Every server feature is now covered; nothing is left on the
"verified by hand, not committed" list.

**These are not transcriptions of the hand checks.** The scratch scripts were
flat lists of `check(name, boolean)` written to answer "does this work right
now". Converting them meant deciding, for each one, what it is actually
guarding — which is a different question, and it changed the shape. The
files are grouped by the rule being protected rather than by endpoint, and
several checks that were really the same assertion twice collapsed into one.
A few gaps showed up in the process and got tests they never had: goals had
no committed coverage of the derived-status *round trip* (tick to complete,
un-tick back to active with `completedAt` cleared), and nothing anywhere
asserted that a goal with no milestones is never complete.

**The comments say why, not what.** `assert.equal(row.unread, 3)` is already
readable; what is worth writing down is that answering someone is not the same
as having read what they sent, which is why replying leaves the count alone.
The test names carry the rule — *"the proposer cannot confirm their own"*,
*"an archived goal contributes NO milestones"*, *"activity reaches members who
are NOT in the room"* — so a failure names the broken promise rather than a
line number.

**A hook bug, caught immediately.** The first version of `goals.test.js` used
two root `test.before` hooks — one to start the server, one to seed a
mentorship — and the seeding ran against a server that was not listening yet.
Node's runner does not guarantee the second waits for the first to resolve.
One hook that does both, with a comment saying why, rather than a sleep.

**Design decision — three CI jobs, not one.** Lint, build and test run
separately so a lint failure and a test failure are told apart at a glance
instead of the first one masking the second. `concurrency` cancels superseded
runs, because a second push makes the first irrelevant.

**Design decision — a real MongoDB, not a mock.** The harness spawns the
actual server and talks to it over HTTP and Socket.IO; that is the whole
reason these tests are worth having, and mocking the database would have
thrown it away. A `mongo:7` service container provides one. It carries a
health check, because without one the suite can start before Mongo accepts
connections and fails as a confusing `ECONNREFUSED` inside the harness rather
than as "the database was not ready".

**Node 22 is pinned deliberately.** `node --test` only accepts glob patterns
from Node 21 onwards, and the test script passes `"test/**/*.test.js"`.

**One thing I wrote and then deleted.** The test job originally set
`MONGODB_URI` as an env var, with a comment claiming it pinned where Mongo
lives. It does nothing — the harness hardcodes the test database and passes it
to the server it spawns, ignoring the environment. That hardcoding is a safety
feature dating from Entry 18, when a hand-run check overwrote a real user's
name and email: the harness calls `dropDatabase()` on the way out, and an env
var able to redirect it is an env var able to point a drop-database at
somebody's real data. The workflow now carries that as a comment explaining
the *absence*, which is the kind of thing a future reader would otherwise
"fix".

**What is still not covered.** The frontend. The 273 are all server-side;
React components are checked only by the Playwright screenshot harness, which
catches render failures and console errors but asserts nothing about
behaviour. That harness is also not in CI, because it needs both servers and a
browser — a materially bigger job than the one that now exists, and worth
doing on its own rather than bolted onto this.

**Verified** by running each new file alone, then the whole suite together to
prove no cross-file interference: 273 passing, 0 failing. `npm ci` was
dry-run against both lockfiles to confirm CI will install cleanly, and the
workflow was checked structurally — three jobs, no tabs, Node pinned in all
three, the service block intact. The workflow itself cannot be executed
locally; the first push is its real test.

---

### Entry 29 — Feedback ratings

**What I built.** The missing end of the session lifecycle. A session was
proposed, confirmed and met — and then nothing came of it. Students now rate a
completed session out of five with an optional note, and the average appears
on the mentor's profile.

**Files added:** `server/models/Feedback.js`, `src/components/Stars.jsx` +
module, `server/test/feedback.test.js`.

**Files changed:** `server/index.js` (three endpoints, 41 total),
`Sessions.jsx` + module, `UserProfilePage.jsx` + module,
`MentorshipDetailPage.jsx`.

**Design decision 1 — per session, not per mentorship.** One rating at the end
of a mentorship arrives months after the thing it describes, when the details
are gone and only the last impression is left. A session that just finished is
the one moment the person actually remembers how it went, and rating each one
gives the mentor a trend rather than a verdict.

**Design decision 2 — only the student rates.** The mentor does not rate back,
and the asymmetry is the point. A rating that follows a mentor around is a
record of a service they offered; a score attached to a *student* is a record
of a person being judged while they are trying to learn, which is a different
and worse thing. A mentor who wants to record how someone is doing already has
session notes and goal progress — both of which describe work rather than
worth.

**Design decision 3 — it cannot be anonymous, so it does not pretend to be.**
A mentorship has exactly two people in it. Whatever the UI said, the mentor
would know who left the rating, so `from` is stored plainly and the hint under
the stars reads *"Your mentor sees this with your name on it."* A promise of
anonymity that the arithmetic breaks is worse than no promise at all.

**Design decision 4 — PUT, and a unique index.** Rating again replaces rather
than adds. The route upserts on `(session, from)` and the index enforces it,
because a double submit from a slow connection would otherwise double-count —
a failure that inflates a mentor's average with nothing visibly wrong on the
page. There is a test asserting the row count stays at one.

**Design decision 5 — five whole points.** A wider scale invites false
precision: nobody can tell a 73 from a 76, and the average of a hundred of
them looks authoritative while meaning nothing. The average *is* shown to one
decimal, because 4.1 and 4.9 are genuinely different, and always beside the
count — "5.0 from one session" and "4.6 from forty" are not the same claim.

**Design decision 6 — comments only in the quotes.** The profile lists recent
*comments*, not recent ratings. A list of bare numbers tells a reader nothing
the average has not already said, and a blank quote is a row of whitespace
pretending to be a review. Tested explicitly: two ratings, one comment, one
quote.

**`Stars` is one component for reading and writing.** Pass `onChange` and it
becomes an input; leave it off and it is a label. They are the same scale, and
letting them drift apart is how a 4 comes to look like a different thing on
two pages.

The input is a **real radio group** — five visually-hidden radios with the
star as their label — so it is arrow-key operable and announced as "3 of 5
stars, radio button" without any `role`/`tabIndex` reconstruction. Halves are
*displayed* (a 4.7 average fills the fifth star 70% of the way, by clipping a
second glyph) but never *entered*: a person pressing stars does not mean 3.5,
and offering it would be false precision at the point of collection.

**Written with its tests, not before them.** Six features in a row were
verified by hand and converted later (Entry 28). This one shipped with
`feedback.test.js` in the same commit, so it goes straight into CI. 27 tests:
both role refusals, rating an unfinished session, the five-point bounds
including 3.5 and `"five"`, replacement not duplication, both parties reading
the mentorship's feedback while an outsider cannot, the average moving from
5 to 4.5 and rounding, commentless ratings staying out of the quotes, and an
unrated account returning zeroes rather than an error.

The suite is now **300 tests across 12 files**.

**A layout fix from the screenshot.** The rating comment sat inside the same
flex row as the stars, so a long one wrapped around them and left its second
line hanging under nothing. It claims the full row now.

---

### Entry 30 — Shared resources

**What I built.** A place to pin the links worth coming back to. *"That
article you sent me"* is the single most common thing to lose in a
conversation, and a chat transcript is a bad place to keep anything you intend
to return to.

**Files added:** `server/models/Resource.js`, `src/components/Resources.jsx` +
module, `server/test/resources.test.js`.

**Files changed:** `server/index.js` (three endpoints, 44 total),
`MentorshipDetailPage.jsx`, `Icons.jsx`.

**Design decision 1 — links, not uploads.** File uploads mean storage, size
limits, virus scanning and a bill, none of which this project has. Almost
everything a mentor actually shares already lives at a URL, so a link is the
whole feature at a fraction of the cost — and it degrades honestly: a dead
link is visibly dead, whereas a missing upload just looks like a bug.

**Design decision 2 — either party may add.** Like sessions, unlike goals. A
student finding something useful and pinning it for their mentor is the same
act as the reverse, and there is nothing here to approve.

**Design decision 3 — removing is not symmetric.** Whoever shared it may take
it down, and so may the mentor; a student cannot remove their mentor's links.
Deleting what someone else shared is the one action in this feature with a
loser, and the mentor is the party with standing to decide. The button is
hidden where it would be refused, and the server refuses it regardless.

**The security bit, and why it is in two places.** The client renders `url`
straight into an `href`, so a stored `javascript:` URL is stored XSS with a
one-click path to the other party. The route parses with `new URL()` and
allow-lists `http:` and `https:` — an allow-list rather than a blocklist,
because that is the version that stays correct as new schemes are invented.
The *model* validates it again, which is not redundancy for its own sake: the
route's check is what returns a useful 400, and the schema's is what stops
anything else in the codebase — a seed script, a migration, some future
endpoint — from writing a dangerous URL into that field without going through
the route at all.

`javascript:`, `JavaScript:` (case), `data:`, `file:` and `ftp:` all have
tests, plus one asserting that after all of them, nothing non-http survived in
the collection. Those assertions exist as much to explain the allow-list to
whoever loosens it later as to catch a regression.

The rendered anchor carries `rel="noopener noreferrer"`: `noopener` because a
`target="_blank"` link otherwise hands the new page a reference back to this
one, and `noreferrer` so a shared link does not leak the mentorship URL it was
shared from.

**A small UI decision.** The line under each title is the **hostname**, not a
truncated URL. A bare domain tells you more about where a link goes than the
first forty characters of its path do, and it is what a reader is actually
checking before they click.

**A comment that was lying, caught before commit.** The Remove button carried
a note saying it "only avoids offering a button that would be refused" — while
rendering unconditionally. Either the comment or the code had to change; the
code did, since the claim was the correct design. Worth recording because a
comment describing an intention the code does not implement is worse than no
comment: the next reader trusts it.

**29 tests, written alongside** — both parties sharing, the outsider and the
ended-mentorship refusals, every dangerous scheme, the required fields,
ordering, and the four-way removal matrix (own link, someone else's, mentor
over everything, outsider over nothing).

The suite is now **329 tests across 13 files**.

---

### Entry 31 — Achievements, derived rather than stored

**What I built.** The last of the originally-scoped features, and the one I
argued against back when the list was drawn up: badges on a college project
read as filler unless they are earned from real data. Goals, sessions,
minutes and ratings now exist, so they can be — and that is the only version
worth shipping.

**Files added:** `src/components/Achievements.jsx` + module,
`server/test/achievements.test.js`.

**Files changed:** `server/index.js` (one endpoint, 45 total),
`ProgressPage.jsx`, `Icons.jsx`.

**Design decision 1 — nothing is stored.** There is no Achievement collection
and no "awarded" row. Each badge is a predicate over figures the app already
keeps, recomputed on every read.

That is not laziness, it is the only version that cannot lie. A stored award
drifts the moment the thing underneath it changes: un-tick the last milestone
of a goal and a persisted "first goal completed" is still sitting there,
describing something no longer true. Derived badges cannot disagree with the
data because they *are* the data. **The test that matters most in this entry
is the un-earning one** — earning a badge is easy to get right, and losing it
correctly is the thing the whole design exists for.

*The tradeoff, plainly:* there is no "earned on" date, and nothing can be
awarded that history no longer supports.

**Design decision 2 — locked badges show their progress.** A badge that
appeared and silently vanished would be worse than one never granted, so
every locked badge returns `progress` and `target`. "7 of 10" is an
invitation; a grey square with no number is a locked door, and a wall of them
is just a list of things you have not done.

**Design decision 3 — the other role's badges are absent, not locked.**
Showing a student how far they are from "First student" is nonsense rather
than encouragement, so they are filtered by audience rather than greyed out.

**Design decision 4 — thresholds are deliberately modest.** One goal, three
sessions, five hours. This is a project used by a handful of people, and a
badge nobody can reach is decoration. The names are honest about it too:
"First goal done", not "Goal Master".

**Design decision 5 — two figures needed care.**

*The kept streak* counts the longest run of completed sessions with no
cancellation between them, and **skips sessions still to come** rather than
breaking on them. A meeting in the diary is neither a keep nor a miss yet;
treating it as a break would drop the streak every time someone scheduled
ahead. It is a run rather than a ratio because a percentage is unreadable at
small counts — one cancellation out of two looks like a catastrophe.

*"Well rated"* requires **three ratings before the average counts at all**. A
single five-star rating is not a reputation, and a badge that can be minted by
one click from one person is a badge worth nothing.

**A duplicate the screenshot caught.** `Progress` defaults `showCount` to
true, so passing my formatted label rendered *both* — "4h of 5h" on the left
and a raw "270 of 300" on the right, two units for one fact. `showCount` is
off here; the label is the one in units a person can hold.

**Rendered on the Progress page, including its empty state.** A mentorship
that has *ended* leaves no active row to report on, but the sessions met and
goals finished inside it still happened — an empty page would read as though
they had been taken away.

**25 tests**, covering both directions of every badge: nothing earned at the
start with real progress attached, role filtering, a goal completing and then
*un*-completing, minutes formatting, the streak surviving a future session and
breaking on a cancellation, the ratings floor, an empty account, and 401.

The suite is now **354 tests across 14 files**, and every server feature has
committed coverage.

**That closes the content list.** Scheduling, analytics, feedback ratings,
resources and achievements were the five features scoped back in Entry 19 and
deferred; all five exist. What remains is infrastructure: deployment, and
frontend tests.

---

### Entry 32 — Ratings switched off, and kept

**The call.** *"A mentorship rating system doesn't seem like it fits in our
project — could you keep it in the codebase as redundant code in case we need
it later?"*

Fair, and I think correct. A five-star score sits oddly in a relationship with
exactly two people in it: the number adds very little that the session notes
do not already say, and rating the person who is helping you nudges the thing
towards a marketplace rather than a mentorship. That is a product judgement,
not a defect — so the code stays and only the product changes.

**How it is off.** One object, `src/lib/features.js`, with one boolean. Three
render sites in `Sessions.jsx` and one card in `UserProfilePage.jsx` check it,
and the two `fetch` calls that fed them are skipped rather than made and
ignored — an endpoint nothing is rendering should not be being called either.

**Why the server half stays switched ON.** This is the part worth writing
down. Only the UI is hidden. The model, the three endpoints and all 27 tests
stay exactly as they were, and they still run in CI.

The reason is that **dead code nothing exercises rots.** If the routes were
commented out and the tests skipped, turning this back on in six months would
not be flipping a switch — it would be debugging three endpoints that had
silently drifted out of step with the models around them while nothing was
watching. Kept live and tested, the switch really is the whole job.

Nothing is exposed by leaving them reachable: they are authenticated and
permission-checked like every other endpoint. There is simply no button in the
product that calls them.

**Verified by rendering it, not by reasoning about it.** The fixture still
holds a five-star rating on one session and three ratings on the mentor, and
both screens were screenshotted with the switch off: no "Rate this session",
no stars on the rated session, and no "What students say" card on a profile
whose average is 4.7 in the database. The data is there; the product does not
show it. 354 tests still pass.

**A note on the shape of this.** A feature flag for one boolean is normally
over-engineering. It earns its place here because the alternative was deleting
tested work on a judgement that may reverse, and a commented-out block with a
"re-enable later" note is the version that never gets re-enabled. The file
says which feature, why it is off, and what to do — which is the part a
`git revert` would not have carried.

---

### Entry 33 — Assignments

**The question.** *"Can we include a task or assignment system, something like
Google Classroom scheduled for submission by the mentor — or does the goals
feature already do that?"*

It does not, and the difference is worth stating because they look adjacent. A
goal has **no date field at all**, nothing is handed in, and *either* party
ticks a milestone. An assignment has a deadline, the student produces
something, and the mentor answers it.

| | Goals | Assignments |
| --- | --- | --- |
| Deadline | none | required |
| Marked done by | either party | student submits, mentor reviews |
| The work | nothing stored | text and/or a link |
| Outcome | ticked | accepted, or changes requested |
| Late | no such concept | derived from the dates |

Goals is the long game — *"Be ready for backend interviews"* with four topics.
An assignment is *"solve five array problems by Friday"*.

**Files added:** `server/models/Assignment.js`,
`src/components/Assignments.jsx` + module, `server/test/assignments.test.js`.

**Files changed:** `server/index.js` (four endpoints, 50 total),
`MentorshipDetailPage.jsx`, `Icons.jsx`.

**Design decision 1 — a separate model, not extra fields on Goal.** Bolting
deadlines and submissions onto milestones would have made both worse: a
milestone is a *topic*, not a task, and most goals have no sensible deadline.
Two models, each doing one thing.

**Design decision 2 — the permissions mirror goals exactly.** Mentor sets,
student submits, and neither can do the other's half. That is the same
asymmetry goals uses and for the same reason: setting work is a directive, and
a student setting their own would make the mentor's part decorative.

**Design decision 3 — `changes-requested` returns to `submitted`, not to
`assigned`.** The student has already handed something in; sending it back to
"not started" would lose that and misrepresent what happened.

Resubmitting also **clears the previous review note**. A fresh answer deserves
a fresh reading, and leaving "question three is wrong" hanging over new work
would read as a second rejection that never happened.

**Design decision 4 — lateness is derived, never stored.** It means two
things — handed in after the deadline, *or* not handed in with the deadline
past — and both live in one `isLate()` method rather than in whichever route
needed it first. A stored flag would be a second source of truth that drifts
the moment a mentor extends a deadline, which is exactly what the test asserts:
extending the date un-lates it with nothing to keep in step.

An accepted assignment submitted on time is never late even if the mentor
reviewed it a week afterwards. The student's part was done.

**Design decision 5 — accepted work cannot be withdrawn.** A mentor can pull
an assignment they should not have set, but once accepted it is a record of
something the student did, and deleting it would erase their work rather than
the mentor's mistake.

**The same URL allow-list as resources.** A submitted link is rendered into an
`href` the *mentor* clicks, so a `javascript:` URL there is stored XSS aimed
at them. It reuses `parseSharedUrl` rather than a second copy of the rule.

**Every label is written twice, deliberately.** A mentor and a student want
opposite things from the same state: "submitted" means *waiting on you* to one
and *waiting on them* to the other. So the badge reads "To review" or "Handed
in", the subtitle reads "1 waiting on you to review" or "2 still to hand in",
and the quote reads "You said" or "Your mentor said" — same data, opposite
side of the desk.

**46 tests**, covering both halves of every permission, the due-date
validation, the allow-list, the full loop (submit → changes → resubmit →
accept), that nothing can be reviewed before it is handed in, that accepted is
terminal for both sides, and lateness in all four directions.

The suite is now **400 tests across 15 files**.

---

### A verification bug worth recording

The first screenshot of this feature showed **no Assignments card at all** —
and the section was mounted, the endpoint was returning data, and the build
was clean.

The cause was not in the app. Eleven preview runs over this session each
started Vite on port 5174, and `TaskStop` kills the shell without reliably
killing the `npx vite` child underneath it on Windows. So the orphans piled
up: Vite silently walked to 5175, 5176, and so on — while the screenshot
script kept requesting **5174**, an instance from hours earlier whose file
watcher had stopped invalidating.

Eight orphaned node processes were still listening.

Two changes came out of it:

- **`--strictPort`** on every preview from now on. Vite drifting to the next
  free port is a convenience that turns a dead process into a silently wrong
  screenshot; failing to start is the better outcome, and it caught the very
  next run — where the "mentor view" screenshot was actually the student's
  because the mentor instance had refused to start.
- **Tear down by port, not by task.** Killing whatever is listening on the
  preview ports is the only reliable version on this machine.

The reassuring half: a stale server can only produce a **false negative**. Every
earlier screenshot in this session was verifying that a feature *appeared*, and
code without the feature cannot render it — so those remain trustworthy. This
one was checking for the absence of a card, which is precisely the case where
staleness lies.

---

### Entry 34 — Assignments go Classroom-style: shared, drafted, and logged

**Three asks, arriving one after another.**

1. *"I need the relationship to be one mentor can have multiple students."* It
   already was — each mentor–student pair is its own mentorship, the duplicate
   guard is keyed on the *pair*, and the analytics suite runs one mentor with two
   students. The confusion was my wording: *"exactly one student per
   mentorship"* meant per mentorship **record**, and read as "a mentor has one
   student". The real gap underneath was different: an assignment belonged to
   one mentorship, so giving five students the same work meant creating it five
   times. The user chose the Classroom model — one brief, several students.
2. *"The mentor should also be able to see when the assignment is just attached
   and not turned in… and see the logs of changes made — submitted, unsubmitted
   and submitted again — with when it was done."*
3. *"Make assignments a group feature."*

**The sentence that stopped being true.** Entry 33 embedded the submission
inside the assignment on the grounds of *"one assignment, one student, one
submission"*. That was right for the per-pair model and wrong the moment an
assignment had several recipients. It is quoted here because the user quoted it
back, and a design note that has been overtaken should say so rather than
quietly disappear.

**Files added:** `server/models/Submission.js`, `src/pages/AssignmentsPage.jsx`
+ module, `src/components/SubmissionRow.jsx` + module.

**Files changed:** `server/models/Assignment.js` (rewritten), `server/index.js`
(the whole assignments block replaced — 9 routes where there were 5; 54 total),
`Assignments.jsx` + module, `AppShell.jsx`, `App.jsx`,
`server/test/assignments.test.js` (rewritten).

**No migration was needed, and that was checked rather than assumed.** The old
shape was committed but never pushed or deployed, and a read-only count of the
development database found 0 assignments.

**Design decision 1 — the brief and the hand-ins are separate documents.**
`Assignment` holds what is shared: the title, the instructions, the deadline,
and the list of recipients. `Submission` holds each student's side. Editing the
brief once changes it for everybody; one student's hand-in never touches
another's row.

**Design decision 2 — a submission exists before anything is submitted.** One
row per recipient is created in the same request as the assignment, with status
`assigned`. That is how Google Classroom models it too, and for the same
reason: "Rahul has not handed this in" is a fact about Rahul and this
assignment, and it needs somewhere to live. Without the row, "4 of 6 handed in"
would be a comparison of two lists, and "overdue" would have nothing to attach
to.

**Design decision 3 — recipients are mentorships, and only your own.** Every
other feature is anchored to the relationship, so assignments are too. The
server refuses the *whole* list if any one entry is someone else's student or an
ended mentorship, rather than sending to the valid ones — a mentor who ticked
six students and reached five would not know which one was missed.

**Design decision 4 — students never see each other's work.** The per-assignment
view lists every hand-in and every piece of feedback, so it is refused to
anyone but the mentor who set it — including another mentor who happens to
mentor one of the same students. Tested from all three directions.

**Design decision 5 — "4 of 6 handed in" means currently in.** `handedIn` counts
`submitted` and `accepted`. Work sent back for changes is *not* counted: the
student owes something again, and counting it would make the headline number
flatter than the truth.

**Design decision 6 — drafts are a real state, and visible.** A student can
attach work without turning it in. The mentor sees it — "Attached, not handed
in", on a dashed panel so "not final" reads before a single word does — and the
student is told so on screen, in so many words, because they should never be
surprised that a draft was visible. A draft past the deadline counts as overdue:
attached is not handed in.

**Design decision 7 — Unsubmit is explicit, and cannot be skipped.** Taking work
back moves it to `draft`, keeps the content, and clears `submittedAt` — lateness
derives from it, and leaving it set would make taken-back work look on time
forever. Handed-in work **cannot** be edited as a draft without unsubmitting
first: an edit the history never saw would defeat the history. Accepted work
cannot be unsubmitted at all.

**Design decision 8 — the history is embedded, append-only, and read in
context.** Every move — assigned, draft saved, handed in, unsubmitted, changes
asked for, accepted — appends `{ type, at, by }`. Embedded because it is only
ever read with its submission and is bounded by how many times two people can
click a button. Nothing edits or removes an entry.

The user offered two places to show it: per student inside the assignment, or a
separate logs page with search and filtering. **Per student in context**, because
the context *is* the filter — opening "Solve five array problems → Rahul" shows
exactly Rahul's timeline for that assignment, with nothing to search and nothing
to mix up. A global log would need search to be usable at all and would still be
worse at the one question a mentor actually has. It reads oldest first, as a
story, with absolute timestamps rather than "3 days ago" — a history is the
thing you screenshot and send to someone else — and marks a hand-in made after
the deadline as late. `by` is stored even though the type usually implies it: an
audit trail that relies on inference is one refactor away from lying.

**Design decision 9 — groups pick recipients; they never receive work.** Groups
here are open: anyone can join, and other mentors are members too. If a group
itself received assignments, a student could opt into another mentor's work
just by joining, and a mentor could set work for people who never agreed to be
mentored by them. So "Tick your students from a group" ticks only the members
who **are** your students, adds to rather than replaces the current selection,
and says who it left out — *"Ticked 3 from 'Backend crew'. 1 other member is not
your student, so they will not get it."* It is entirely client-side; the server
validates the final list exactly as it would a hand-ticked one.

**Two pages, two axes.** The mentorship page is one student, many assignments.
`AssignmentsPage` is one assignment, many students — the only place "4 of 6"
can live. It is role-aware rather than two pages, because one person can be on
both sides of the desk. There is deliberately no Withdraw on the mentorship
page: pulling a six-student assignment from inside one student's page would take
it away from the other five without the mentor seeing them.

**A bug the redesign fixed.** In Entry 33's version, a student whose work was
`submitted` saw "Hand in again" — and the server refused `submitted → submitted`
with the message *"That assignment has already been accepted"*, which was false.
The tests covered resubmitting after changes were requested, never from
`submitted`. The new model makes that path Unsubmit, and a test asserts
handed-in work cannot be edited without it.

**Two safety checks that failed closed.** The script that spliced the new routes
into `index.js` asserted that no helper was declared twice; its regex matched
`function name(` but not `async function name(`, counted three helpers as
missing, and aborted before writing anything. A second script asserted the word
`useCallback` no longer appeared in a file — and tripped on the comment
explaining why it was gone. Both were wrong checks, and both stopped the write
rather than let it through, which is the direction a check should fail in.

**Lint, and the pattern that satisfies it.** Both new data-loading components
first used a shared `load` callback called from an effect, which React's
compiler rules reject. The loader now lives inside the effect, where its
setStates are visibly after an `await`, and every reload goes through a
`version` bump from an event handler instead. Lint is back to 0 errors and the
one long-standing warning.

**82 tests in `assignments.test.js`**, rewritten for the new model: shared
recipients and de-duplication, the whole-list refusals, the deadline rules,
independent hand-ins, the URL allow-list, privacy from three directions, the
per-student review loop, lateness per student and extended deadlines un-lating
everyone, editing the brief once, adding a student later (whose history starts
when *they* were added), withdrawal, drafts, Unsubmit, and a full seven-move
history asserted event by event, in order, with who did each one.

The suite is now **436 tests across 15 files**.

---

### Entry 35 — Files on hand-ins, kept in MongoDB

**The ask.** *"Add in a button to select all students for convenience — also,
are files attachable now? We need that to work for this to be complete."*

Select all already existed, as a text link beside "Send to". The user did not
find it, which is a finding in itself: the common case — most work goes to
everyone — was dressed as the least important control on the form. It is now a
real button, "Select all 4" / "Clear all".

Files did not exist. A hand-in was text and a link, and the link's hint told
students to put their file on Drive and paste the share link. That was the
last thing standing between this and Classroom.

**Files added:** `server/lib/fileStore.js`, `server/test/attachments.test.js`,
`src/lib/attachments.js`.

**Files changed:** `server/index.js` (3 routes; 57 total),
`server/models/Submission.js`, `SubmissionRow.jsx` + module,
`AssignmentsPage.jsx` + module, `AuthContext.jsx`, `Icons.jsx`,
`server/package.json` (multer).

**Design decision 1 — the bytes go in MongoDB (GridFS), not a bucket.** The
user had already asked whether files would mean paying for a storage plan.
A bucket (S3, R2, Firebase Storage) is the textbook answer, and every one needs
an account, credentials in the server's environment and, usually, a card on
file. GridFS needs nothing new: the same code runs on a laptop, in CI's `mongo`
service and on a hosted MongoDB. The cost is database space, bounded by 10 MB a
file and 5 files a hand-in — and the file says, in so many words, that a free
Atlas cluster is 512 MB for everything. The routes call only the functions
`fileStore.js` exports, so moving to a bucket later rewrites that one file.

**Design decision 2 — a file is reached through its hand-in.** The record of
each file lives on the `Submission`; the download route is
`/api/submissions/:id/files/:fileId` and looks the file up in *that*
submission's list. So the people who can read a file are exactly the people who
can read the hand-in — the student and the mentor who set the work — with no
second permission model to drift. A real file id asked for through the wrong
hand-in is a 404, and the test for it deliberately uses the mentor, who may
read both hand-ins: it proves the *pairing* is checked, not just the person.

**Design decision 3 — served so a file can never run as this app.** An upload
feature's classic hole is stored XSS: upload `page.html`, send someone the
link, and it runs on your origin with their session. Four layers, each
tested:

- `Content-Disposition: attachment` — the browser saves it, never renders it
- a Content-Type the **server** chose from the extension at upload time; the
  type the browser claimed is thrown away. The test uploads a `<script>` named
  `report.pdf` claiming `text/html`, and it comes back `application/pdf`
- `X-Content-Type-Options: nosniff`, so the browser does not second-guess it
- `Content-Security-Policy: sandbox`, for anyone who opens the URL directly

HTML and all source code are served as `text/plain`. SVG is not allowed at all:
it is an image format that can carry script.

**Design decision 4 — an allow-list of extensions.** Documents, images, zip,
and source code — most of what a coding mentorship hands in. Nothing that
launches on a double-click, so a hand-in cannot carry a program from one
account to another. One check is subtler than it looks: `TYPES[ext]` for a file
named `x.constructor` finds `Object.prototype.constructor`, which is truthy,
and would wave it through. The lookup is `Object.hasOwn`, and a test uploads
exactly that name.

**Design decision 5 — names are cleaned, never trusted.** Only the last path
segment is kept, in both slash directions. Control characters are stripped, and
so are bidirectional overrides, which can make `invoice<U+202E>fdp.exe` display
as `invoiceexe.pdf`. Names are capped at 200 characters, keeping the extension.
Non-English names survive the round trip: multer is told to decode them as
UTF-8, and downloads send the RFC 6266 `filename*` form. `résumé.pdf` is a
test.

**Design decision 6 — refused before it is read.** Who is asking, whether the
work can still change, and the five-file cap are all checked in a middleware
that runs *before* multer parses the body. Someone who may not attach here is
turned away without the server buffering their 10 MB first. The size cap
itself is multer's, and answers 413.

**Design decision 7 — files obey the hand-in's rules, not their own.**

- Attaching *is* saving a draft. That is how Classroom behaves, and
  "attached, not handed in" is precisely the state the mentor asked to see in
  Entry 34.
- Handed-in work is frozen: no file added or removed until Unsubmit, exactly
  like its text. Accepted work is a record.
- A file on its own is enough to hand in.
- Every attach and remove goes in the history *with the file's name* — a new
  optional `detail` on history events — so the timeline reads "Attached
  design.pdf · Rahul".

**Design decision 8 — deleting means deleting.** Removing a file deletes the
bytes, not just the listing, and withdrawing an assignment deletes every file
handed in against it; tests check GridFS's own collections afterwards. The
order is record first, bytes second, so a failure halfway leaves an orphan
nobody can reach — never a hand-in pointing at nothing. And if the bytes are
stored but the record then fails to save, the bytes are taken back out.

**Downloading without leaking the token.** The route needs the sign-in token.
An `<a href>` cannot send one, and a token in the URL would end up in browser
history and server logs. So the client fetches with `authFetch`, makes a blob
URL, and clicks a temporary link. `authFetch` had to learn one thing for
uploads: not to stamp `Content-Type: application/json` on a `FormData` body,
because the browser has to set `multipart/form-data` itself, boundary included.

**Two things that went wrong on the way.**

1. The splice script refused to run. After the last commit, git's `autocrlf`
   had rewritten `index.js` in the working copy with CRLF endings, and the
   script asserted LF. It failed closed, wrote nothing, and now matches on LF
   and writes back whatever it found.
2. The bidi-stripping regex was first written with the literal invisible
   characters inside it, and the comment's example contained a real
   right-to-left override. In source code that is the very trick the function
   exists to defend against, so both became `\u` escapes and a visible
   `<U+202E>`.

**A flaky test that was a real bug.** The full run failed the startup test,
which had never failed before; run alone, it failed one time in three. The
server called `listen()` as soon as its routes were registered and connected
to Mongo in parallel, so "the server answers HTTP" — the harness's signal that
it is ready — did not mean the stale-presence reset had run, and the test read
the database in the gap. This change had only shifted the timing. And the gap
was not just a test's problem: after a restart, Socket.IO clients reconnect
within moments, and one that reconnected inside it would be marked online and
then wiped by the reset still in flight — shown offline while connected. The
server now connects, clears stale presence, and only then listens; if Mongo
cannot be reached it exits with the error rather than serve requests it has no
database to answer. The test was not changed. It was right.

**Also found, and left for their own commits.** `npm install` reported 8
vulnerabilities, none of them from multer: body-parser, qs and path-to-regexp
(through Express), socket.io, engine.io and ws, and mongoose — all fixable
within their current version ranges. And the frontend bundle has crossed
Vite's 500 kB warning line, which is the prompt to split routes with dynamic
`import()`.

**46 tests in `attachments.test.js`**: who can attach and download, from five
directions; what can be attached, including both boundaries of the size cap;
how files are served; the hand-in rules; and clean-up, checked against GridFS
itself. The suite is now **482 tests across 16 files**.

---

### Entry 36 — Three things that were in the way

**The asks.** (1) On the Groups page, make the whole bar open the group rather
than having a separate Open button on it. (2) The note on each mentorship row —
*"they asked you"* — is too casual; say it the way a record would. (3) Back
from a chat opened from the mentorship page lands on the Messages list, so
getting back to the mentorship means going through the sidebar again.

**Files changed:** `GroupsPage.jsx` + module, `MentorshipsPage.jsx`,
`ChatPage.jsx`, `MentorshipDetailPage.jsx`, `UserProfilePage.jsx`.

**1 — The row is the button, but only for members.** The Messages list already
works this way, so the group list borrows its shape: one `<button>` filling the
row, the avatar, name and preview inside it. A row for a group you have *not*
joined stays inert and keeps its Join button, because joining is a decision
rather than navigation and should not happen because somebody tapped a row on
the way past. That is also why the hover and the pointer live on the button
rather than on the row: a non-member row must not look like a way in.

**2 — How a mentorship started, said the same way on both sides.** One helper
now writes all four sentences: *You admitted Zara Khan* / *Accepted Rahul
Mehta's request* for the mentor, *Priya Nair admitted you* / *Priya Nair
accepted your request* for the student. The student side previously said
nothing at all when the student had been the one to ask — the very case where
"they accepted" is worth seeing. Both sides now always say how it began.

**3 — Back goes where you came from.** A chat is opened from the Messages list,
a profile and two mentorship screens, and `backTo` was the fixed string
`/users`, so three of those four sent you somewhere you had not been. Each
caller now passes its own path in the navigation state and the chat reads it,
falling back to the Messages list for a link opened cold.

`navigate(-1)` would have been less code and wrong: the history entry behind a
chat is not always the page that opened it — a reload, a redirect through the
role gate, or arriving from a notification all leave something else there.
Saying where you came from is explicit, survives a refresh, and cannot walk
backwards into a page the user never saw.

**Checked in a browser, asserting rather than photographing:** no Open button
on the row, clicking the bar lands on `/group/:id`, all four wordings present
and the old ones gone, Message opens the chat and Back returns to
`/mentorships`, and a chat opened cold still falls back to Messages.

---

### Entry 37 — Achievements out, streaks in, and the app learns to tell you

**The asks.** *"Assignment task or other goal notification system for the
student (did you remove tasks and goals, I can't find them)"* — and *"I was
thinking of completely removing the achievement system… just keep an assignment
streak instead."*

**Nothing had been removed, and that was the finding.** Goals live inside a
mentorship — Mentorship → Open → Goals — which is the only place they can live,
since a goal belongs to a relationship rather than to a person. Assignments
arrived later and got their own sidebar entry; goals never did. So the newer
feature looked like a replacement for the older one, purely because one of them
is named in the navigation and the other is two clicks inside a page. Worth
remembering the next time something "disappears": the sidebar is the map, and
anything not on it is, to a user, somewhere between hidden and gone.

**1 — Achievements are gone, not dormant.** The user's call, and the right one:
the badges set challenges about hours and streaks of meetings, which is not
what a mentorship is for. Deleted rather than switched off behind a flag the
way session ratings were, because that one was paused and this one was decided
against — a flag would only leave a second, colder copy of the same
disagreement in the tree. Out went the card and its styles, the
`/api/achievements/me` route and its badge definitions, 25 tests, the Trophy
icon nothing else used, and four README rows.

**2 — Two streaks, and the user asked for both of the rules offered.**

- **On time, in a row.** Assignments in deadline order; a hand-in that beats
  its deadline extends the run, a late one or a deadline that passed with
  nothing handed in resets it. Work *not yet due* is skipped rather than
  counted as a break — an assignment due next week is not yet either a success
  or a failure, and treating it as one would drop the streak to zero every time
  a mentor set something. The best run is kept alongside the current one, so a
  reset takes the streak but not the history.
- **Weeks running.** Consecutive weeks holding at least one hand-in, late or
  not: the "did you keep showing up" figure rather than the punctuality one.
  This week being empty so far does not break it; a whole empty week does.
  Weeks run Monday to Sunday **in UTC**, so the number does not change when the
  reader travels.

Both are derived on read inside `/api/analytics/me` — the one idea worth
keeping from the achievements, and the reason neither can drift out of step
with the work. They render where the badges used to be, and only for someone
who has handed something in: a mentor who has never been a student would
otherwise get a card of zeroes about work nobody set them.

**3 — The sidebar badge.** Work set for a student was silent until they thought
to go and look. The count beside Assignments is two figures in one pill,
because one person can be on both sides of the desk: what you owe as a student
(drafts and work sent back for changes included — attached is not handed in)
and what has been handed in to you as a mentor.

It is served by a small `/api/assignments/counts` rather than the existing
list: the shell draws this on every page, and a badge is not worth shipping
every assignment and hand-in to render. That route is declared **before**
`/api/assignments/:id`, or Express reads "counts" as an id and hands it to the
wrong route — the kind of bug that appears months later when someone adds a
static path under a dynamic one.

**4 — The notice, deliberately not a toast.** The user asked for something like
Classroom's "stream was updated": *"not too flashy… something subtle like
that."* A toast is the result of something **you** just did, and it sits over
the page demanding to be read. This is someone else's action arriving while you
were busy with your own, so it takes one muted line under the header, says what
happened, offers *View*, and leaves after twelve seconds. `role="status"`, so a
screen reader mentions it once rather than interrupting.

Four moments deserve one: work set, students added to work that already
existed, a hand-in arriving (the mentor), and an answer to one (the student).
Saving a draft does not — the mentor can see it, but nothing is waiting on
them.

**Nothing about a notice is stored.** A notice missed while signed out is not a
debt the app owes you later; the badge is what survives a reload, and it is
counted from the work itself rather than from a list of events. That is the
same reasoning as the streaks, one layer up.

A test asserts that a student the work was *not* set for hears nothing: a
notice about someone else's assignment is noise, and a small leak of what they
were set.

**The suite went 482 → 457 → 478**: 25 gone with the achievements, 9 for the
streaks, 7 for the badge counts and 5 for the notice.

---

### Entry 38 — Previewing a hand-in's files

**The ask.** *"Do we not have a file preview system like Classroom does? What
would it take to implement that?"* — and then, once it was three kinds rather
than all of them: build those three.

**Files added:** `src/components/FilePreview.jsx` + module.
**Files changed:** `SubmissionRow.jsx` + module, `src/lib/attachments.js`,
`Icons.jsx`.

**Three kinds, and that is a fact about browsers rather than a decision.** An
image, anything textual (source code included), and a PDF. Word, Excel,
PowerPoint and the OpenDocument equivalents cannot be rendered without
converting them first, which needs a service — Classroom previews them because
Drive does that conversion on Google's servers. Those stay download-only, and
the row never offers a preview it cannot give: the name **downloads** them
instead, so a click never does nothing and never surprises.

**Nothing about how files are served changed, and that is the point.** The
server still sends every file with `Content-Disposition: attachment`, a
Content-Type it chose from the extension, `nosniff`, and a CSP sandbox. The
preview renders the copy the browser already holds in memory — the same copy
the download path fetches with the sign-in token, for the same reason an `<a
href>` was never pointed at the route. So "does previewing weaken the upload
hardening" has a short answer: there is no inline-serving path to weaken. An
uploaded `page.html` is still text, still downloaded, and still cannot run on
this origin.

**One fetch per open.** The blob is kept while the dialog is up, so *Download*
inside the preview saves the copy already in memory rather than asking the
server a second time. The object URL is revoked when the dialog closes.

**Text is clipped at 256 KB.** Past that it is not reading, it is scrolling —
and 10 MB of source laid out as one very long line of DOM is a frozen tab. The
dialog says it is showing the first 256 KB and points at the download.

**Built on `<dialog>`, like ConfirmDialog**, for the three things hand-rolled
modals usually get wrong: focus is trapped inside, Escape closes it, and the
page behind is inert. `::backdrop` is the scrim.

**A React rule shaped the loading state.** The obvious version sets
`status: 'loading'` at the top of the effect, which is exactly what
`react-hooks/set-state-in-effect` refuses. So the state records *which file* it
was fetched for, and the render treats a mismatch as loading. It is the same
move as the `version` counter in the assignment lists, one size smaller: say
what is true and derive the rest, rather than writing state on the way in.

**The row grew a second button.** The name opens; download is its own icon
beside it. A file you can preview is still a file you may want to keep, and
making preview the only thing a click does would have cost every mentor an
extra step to save anything.

**No server code changed**, so there are no new tests: the suite is 478 either
way. It was checked in a browser instead — a generated PNG renders, the `.py`
shows its text, `project.zip` downloads rather than opening, and *Download*
inside a preview saves the copy already fetched. The standing open item about
the frontend having no automated tests is the reason that sentence is a list of
screenshots rather than a test file.

**The PDF needed a second look, and that is the useful part.** The scripted
check asserted the dialog contained an `<iframe>`, and it did — but the
screenshot showed the frame **empty**. An assertion about the DOM had passed
while the thing it stood for had not happened, which is the failure mode every
screenshot in this log exists to catch.

Two explanations fitted: headless Chromium ships without the PDF viewer, or the
PDF generated for the fixture was malformed — it had no cross-reference table.
Separating them took one throwaway script: a properly structured PDF, opened in
a **headed** browser, first as a file and then exactly the way the app does it,
as a blob URL inside an iframe. Both rendered. So the app's path is sound and
the empty frame was the harness, not the feature.

The lesson for the harness: a headless screenshot can prove an image or text
preview, and cannot prove a PDF one. A check that cannot fail for the right
reason is worth no more than the claim it was meant to support.

---

### Entry 39 — Retrieval, and three things proven before any of it was written

**The ask.** A proposal to add RAG to the project — a "Mentorship Copilot" that
answers questions from the material inside one mentorship — plus a review of
that proposal, and the question *"how do we go about implementing this?"*

The review asked one thing that decided the order of everything: *have
resources and assignments actually been built?* They have, since Entries 30–38.
The brief said otherwise because it was compiled on 10 September, which is why
Entry 39 begins with a documentation fix rather than with code.

**Files added:** `ai/` — `config.py`, `sources.py`, `chunking.py`, `store.py`,
`ingest.py`, `check_retrieval.py`, `app.py`, `requirements.txt`, `.env.example`,
`README.md` — and `scripts/seed-rag-corpus.cjs`.

---

**Nothing was built until three unknowns were settled.** Each could have
changed the design, and two of them did.

1. **Does `$vectorSearch` exist here?** The development MongoDB is 8.0.8
   Community with no modules, so: no. The `mongodb/mongodb-atlas-local` image
   bundles the search node, runs offline, needs no account and no card, and
   speaks the same query syntax as Atlas. A smoke test — three documents, two
   mentorships, one filtered query — proved it before a line of the service
   existed.
2. **Can embeddings run locally?** `all-MiniLM-L6-v2` loads on CPU and returns
   384 dimensions. Ingestion therefore costs nothing and works offline, which
   matters more than the quality difference at this corpus size.
3. **What text is actually there to retrieve?** This one falsified part of the
   plan. The proposal assumed shared resources were documents to chunk. They
   are **links** — a title, a URL, and a 500-character note. So "RAG over
   resources" would have retrieved a sentence each. The substantial
   first-party text is assignment briefs, hand-in text and mentor review notes.
   Fetching the linked pages would fix that and open an SSRF hole in a server
   that currently makes no outbound requests at all; it was refused.

**What is indexed, then.** Assignment briefs, hand-in text, mentor reviews,
goals with their milestones, and resource titles with their notes. All of it
written by someone in the mentorship.

**The rule the whole thing rests on: filter inside the search, not after it.**

```python
"filter": {
    "mentorshipId": {"$eq": mentorship_id},
    "viewers": {"$in": [viewer_id]},
}
```

Filtering the results afterwards would let the index spend its candidate budget
on documents the caller may not see. A query could then come back empty
*because* the nearest neighbours belonged to someone else — and the obvious fix
would look like "raise numCandidates" rather than "this is wrong". The corpus
is built to catch that: both mentorships cover indexing and caching in similar
words, so a leak is likely rather than hypothetical.

**An honest note about `viewers`.** A mentorship has exactly one student, so a
hand-in's viewers are the same two people as the mentorship — meaning
`mentorshipId` alone already isolates it today. The field is kept because it
states the rule in the data and costs nothing, and it starts doing real work
the moment a mentor searches across all their students. It is not claimed to be
doing more than that now.

**Two findings from actually running it, both about tests rather than code.**

The first run reported: *"no chunk from the other mentorship appears — ok"* and
*"a student outside this mentorship retrieves nothing — ok"*, while the two
relevance checks failed with nothing returned at all. Both isolation checks had
passed **because nothing was returned to anybody**. An assertion that cannot
fail for the right reason is worth nothing, which is the same lesson the empty
PDF frame taught in Entry 38, two days earlier and in a different language.

The cause was the second finding: **Atlas indexes asynchronously.**
`insert_many` returns once Mongo has the documents; the search node sees them a
moment later. Queries issued in that window read an index that has not caught
up, and an empty result is indistinguishable from "nothing matched". Ingestion
now ends with `wait_until_searchable`, which polls until the index returns as
many chunks as were written, and the isolation assertions now require results
to exist before concluding that nothing leaked.

After that, on 15 sources and 15 chunks: *"how do compound indexes work?"*
returns the mentor's compound-index note at 0.805, then the indexing exercise,
then the book she shared — and the same query run as the other mentorship's
student returns nothing.

**What is deliberately not here yet.** No LLM. Retrieval with citations is the
part worth engineering and the part an evaluation can measure; generation is a
prompt away and adds nothing to prove until the retrieval is good. The Express
trust boundary — membership checked before this service is called, a shared
secret, localhost-only binding — and a labelled evaluation set are the next two
commits.

---

### Entry 40 — The trust boundary in front of retrieval

Entry 39 ended with the retrieval service proven and deliberately unreachable:
nothing in the application called it. This is the route that does, and the
reason it exists is that **the service cannot check who is asking.**

`POST /api/mentorships/:id/copilot/search`. Fifty-eight endpoints now.

**Why the check cannot live in the retrieval service.** It never sees a
Firebase token and could not verify one if it did — that machinery is in
`middleware/auth.js`, in Node, and duplicating it in Python would mean two
implementations of the same security check drifting apart. So the service
trusts the mentorship id it is handed, and the chain is:

```
token → requireAuth → resolveMentorshipAccess → retrieval
```

The same `resolveMentorshipAccess` the goals, sessions and resources routes
use. Reusing it matters more than it looks: a new permission helper written
for one route is a second definition of "is this your mentorship", and the two
would answer differently the first time either changed.

**The viewer id comes from the verified identity, never from the body.** A
caller cannot ask what somebody else would be allowed to see; the field is
filled in from `req.authUser._id` after the token has been checked.

**Two locks behind that, neither of which is the access check.** The service
binds to `127.0.0.1`, so nothing off the machine can open a socket to it, and
every route requires a shared secret Express holds. Those stop *other things on
the same machine* from skipping Express. They do not decide who may read what —
that decision is made before the service is called at all.

**Unconfigured answers 503, and that is a feature.** With `AI_SERVICE_URL`
unset the route says the Copilot is not configured. A clone with no Python, no
Docker and no model download still runs, and its tests still pass — which is
why CI stays a Node-only job rather than growing a 1.2 GB virtualenv and a
container to lint a JavaScript repository.

**Twelve tests, and the interesting ones are the refusals.** Another mentor's
student, another student's mentor, and the mirror case of the same person
asking about a mentorship that is not theirs — all 403, from the same helper.
An unknown mentorship is 404 rather than 403, because "not yours" and "not a
thing" are different answers and neither says anything about anyone else's
data. Signed out is 401 before any of it. The empty and over-long question are
refused here rather than at the service, so a bad request never crosses the
boundary.

None of those twelve need Python running. That is deliberate: everything they
assert happens *before* the service would be called, so the security of the
boundary is proven by the suite that runs on every push, not by a demo.

**End to end, with the service up:** the student asks *"how do compound indexes
work?"* and gets his mentor's compound-index note at 0.805, the indexing
exercise at 0.704, the book she shared at 0.668, and the goal that ties them
together at 0.595. The other mentorship's student, asking the same question
against the same mentorship id, gets 403 — and the signed-out request gets 401.

**One small thing worth keeping.** The upstream call has a fifteen-second
abort. A slow model must not hold an Express connection open indefinitely, and
a timeout and a service that is not running look the same to the person asking:
the question was not answered, and it was not their fault. Both become 502.

---

### Entry 41 — Measuring the retrieval, and what the measurement refused to show

Entry 40 left retrieval working and unmeasured. This is the number, and the
two findings that matter are both negative.

**The set.** 45 questions in `ai/eval/questions.jsonl`, each labelled with the
source that should answer it: 31 answerable from this mentorship's material,
14 not. Five of those 14 are answerable **only inside the other mentorship** —
*"what did Karan say about low-cardinality fields?"*, *"what was Zara's index
that made no difference?"* — so they are security probes wearing an
evaluation's clothes. The answer exists in the corpus; the right behaviour is
silence.

**Six configurations, on the same corpus:**

| Configuration | chunks | recall@1 | @3 | @5 | MRR |
| --- | --- | --- | --- | --- | --- |
| fixed 800 (baseline) | 15 | 0.68 | 1.00 | 1.00 | 0.828 |
| fixed 800 + reranker | 15 | 0.77 | 0.90 | 0.90 | 0.839 |
| fixed 400 | 18 | 0.71 | 0.97 | 1.00 | 0.841 |
| **fixed 400 + reranker** | 18 | **0.81** | 0.90 | 0.90 | **0.855** |
| heading 800 | 15 | 0.68 | 1.00 | 1.00 | 0.828 |
| heading 800 + reranker | 15 | 0.77 | 0.90 | 0.90 | 0.839 |

**Finding 1: the heading-aware chunker is not "no better", it is not
applicable.** It scored *identically* to the fixed splitter — same recall, same
MRR, same chunk count — because the corpus has no headings in it. Assignment
briefs are plain paragraphs, so every section fell through to the fixed path
and produced the same splits. A tie between two strategies is a result; a tie
because one of them never ran is a mislabelled result, and writing "heading
chunking made no difference" would have been a lie of exactly the kind this log
exists to prevent.

**Finding 2: the reranker buys recall@1 with recall@3.** Halving the chunks and
adding a cross-encoder moves the first-hit rate from 0.68 to 0.81, and moves
recall@3 from 1.00 down to 0.90. It demotes one chunk consistently: the goal,
which is a list of milestone bullets, for vague questions like *"what should I
focus on next?"*. A cross-encoder trained on passage relevance does not think a
bullet list answers a vague question; for that question it is the only thing
that does.

Which configuration is better therefore depends on what reads the output. A
panel showing four citations wants recall@3. A generation step reading the top
chunk wants recall@1. That is a product decision wearing a metric's clothes,
and it is worth stating rather than picking the bigger number.

**Finding 3, the one that changes the plan: no threshold separates answerable
from unanswerable.** In every configuration the most confident unanswerable
question outranks the least confident answerable one. The same question wins
every time:

```
0.815  leak-04: What does the caching exercise say about stale reads?
       -> Add caching to the reading list endpoint
```

The caching brief is genuinely the nearest text — the question is phrased in
the corpus's own vocabulary — and it does not mention stale reads at all. The
cross-encoder agrees with it (+2.56, its highest unanswerable score), so this
is not a weakness of cosine similarity. **Similarity is not answerability.**

The consequence is concrete: *"I do not have enough information"* cannot be
implemented as a score threshold, which is what a naive RAG tutorial does. It
has to come from reading the retrieved text and asking whether the answer is in
it — a grounding check at generation time, or an answerability classifier. That
is now a measured reason to build one, rather than a guess, and it is the best
argument yet for having deferred generation until retrieval could be measured.

**What these numbers are not.** Eleven sources, fifteen to eighteen chunks.
recall@5 is nearly free at that size and should be ignored; recall@1 and MRR
are the only figures here that discriminate, and even they are measured on a
corpus one person wrote in an afternoon. The honest claim is "this pipeline was
measured and improved against a labelled set", not "this system achieves 0.81".

**Still to try:** a second embedding model. The vector index is
dimension-specific, so a 768-dimension model needs its own collection and
index rather than a flag — which is itself worth knowing before promising an
A/B.

---

### Entry 42 — A seeder that had never been run from where it lives

Found while starting S1, before a line of it was written: the committed
`scripts/seed-rag-corpus.js` could not execute at all.

The repository's `package.json` declares `"type": "module"`, so Node loads a
`.js` file as an ES module, and the script opens with `require(...)`. It threw
*"require is not defined in ES module scope"* on the first line that mattered.

It had worked perfectly in the scratch directory it was written in — no
`package.json` there, so Node treated it as CommonJS — and was then copied into
`scripts/`, committed, documented in three files, and referenced by the S1 plan
without once being run from its committed location.

Renamed to `.cjs`, which states its module system explicitly, the way
`scripts/screenshot.mjs` already does.

The lesson is the one Entries 38 and 41 keep teaching in different clothes. An
empty PDF frame passed its assertion; isolation checks passed while returning
nothing; and a seeder passed review while being unrunnable. Each time the proof
was a proxy for the property rather than the property itself. **Running it
somewhere is not running it where it lives.**

---

### Entry 43 — S1 step 1: a test suite for the Python side

The retrieval service has had no tests since it was written. Four sprints of
planning now depend on it, and S1 is about to rewrite its chunker and swap its
embedding model, so the regression protection comes first.

**pytest, and nothing else.** The Node side runs on `node:test` with no runner
dependency; the Python side gets `pytest` and no plugins. `requirements-dev.txt`
is separate from `requirements.txt` for the reason Node keeps devDependencies
separate: what runs the service and what proves it works are different lists.

**The isolation rule is inherited, not invented.** `server/test/helpers/harness.js`
already settled it — spawn against a throwaway database, drop it afterwards,
because verification runs against the development database twice meant
repairing real records. Python inherits the rule and adds a second forbidden
name, because this service has two databases worth protecting:

- `chatapp` — what the app uses
- `chatapp_rag` — the corpus the retrieval evaluation runs on

Tests use `chatapp_rag_pytest`, dropped on the way in as well as out. Dropping
on entry matters: a run killed halfway leaves state behind, and a test that
silently inherits it passes for the wrong reason.

**The guard has its own tests.** `forbid_real_databases` raises on either real
name, and four tests assert that it does — including one asserting that
`config.DB_NAME` is still *in* the forbidden set, so pointing the service at a
new corpus fails loudly rather than leaving the guard protecting a name nothing
uses.

**Mongo-dependent tests skip rather than fail.** Extraction and chunking are
pure functions and must stay runnable with Docker closed; only `needs_mongo`
tests need the container. Skipping keeps the fast tests honest on a laptop
without making the slow ones optional on a machine that has it.

Seven tests. The two that matter most are the pair proving teardown works: one
writes a document, the next asserts the database is empty — the property
itself, not an assumption that the fixture did its job.

---

### Entry 44 — S1 step 2: porting PDF extraction

From RAG-Project at commit `695795a`, `ingestion/extract.py` becomes
`ai/extract.py`. Papers in, coursework out.

**What was taken.** Every rule below exists because of a defect observed in a
real PDF, and none of them is specific to research papers:

- **Words-per-line block filtering.** Body text comes back from PyMuPDF with
  eight to twelve words a line; a diagram's labels come back with one or two,
  because every label is its own line.
- **A composition filter for flattened tables.** A table row passes every
  shape test — it is long and dense — and is useless once its column headers
  are gone. Prose is overwhelmingly alphabetic; a table row is mostly numeric.
- **The hyphenation vocabulary trick.** `representa-
tion` and
  `task-
specific` are identical on the page. The document itself decides:
  if `representation` appears elsewhere unbroken the hyphen was soft, if
  `task-specific` appears intact it was real.
- **NFKC folding**, so `ﬁne-tuned` and `fine-tuned` stop being different
  strings to a tokenizer.
- **Page tracking**, so a citation can name somewhere a person can turn to.

**What was deliberately NOT taken: the references cut.** RAG-Project drops
everything from the `References` heading onward, and is right to — in a paper
that section is lexically dense with query terms and informationally empty.
Here it would silently delete the end of somebody's hand-in, and an appendix
after it. Conflict C10. A test asserts extraction does *not* stop there, because
the absence of a behaviour needs a test as much as its presence does.

**What else was left behind.** The arXiv margin-stamp regex, the metadata
contract, the on-disk paths, and the paper-shaped heading vocabulary —
"abstract", "related work", "broader impact" — replaced with one for briefs,
rubrics and coursework: requirements, deliverables, marking scheme, testing,
reflection.

The asymmetric-risk reasoning behind that list was kept exactly as they wrote
it. Single generic words that are also table column headers — "Model",
"Results", "Marks" — are deliberately *absent*. A missed heading merges one
section into its neighbour and costs a little citation precision; a false
heading corrupts the document's structure from that point on, and in their
corpus produced a 50,000-character phantom section. Documents that section on
those words almost always number them, which the numbered pattern catches.

**Two deliberate differences.** Extraction takes **bytes, not a path**, because
attachments live in GridFS and never touch the disk. And **text before the
first heading is kept**: the original discarded a paper's title block as
already-known metadata, but a brief routinely opens with a paragraph of
instruction before any heading, and dropping it would lose the actual task.

**A scan is noticed rather than crashed on.** Under twenty characters of
extractable text across the whole document means there is no text layer; the
result says `needs_ocr` and logs *"no extractable text - needs OCR (S7)"*. OCR
itself is S7. This module only has to notice, and to not pretend an empty
string is a document.

**PyMuPDF is AGPL** (conflict C9). Acceptable for a public portfolio
repository, where the source is published anyway; `pdfplumber` (MIT) is the
named alternative if this ever ships inside something closed. Pinned exactly at
1.28.2, for the same reason the embedding stack will be: a change in how text
comes out of a PDF changes every chunk derived from it, and the index would
still look valid afterwards.

**Twenty-four tests**, almost all on pure functions. A PDF round trip would
test PyMuPDF's layout engine as much as our rules and fail for unrelated
reasons; the two tests that do build real PDFs test the two things that are
genuinely document properties — page tracking, and having no text layer.

---

### Entry 45 — S1 step 3: reading Word documents

RAG-Project had no .docx path — arXiv ships PDFs. Coursework does not: a brief
is often a Word file, and a rubric almost always is. This is new code written
against the same output contract, so chunking never has to ask which format it
is holding.

**Headings come from styles, not from shape.** A .docx states that a paragraph
is Heading 2; there is nothing to infer. The PDF heuristics stay as a fallback
for the case that is extremely common in student work — a heading typed as
ordinary text and bolded by hand. Both routes end at the same place.

**Tables are kept, which is the exact opposite of the PDF rule.** That looks
inconsistent until you look at what arrives. A PDF table comes back
flattened — `T5-Small 2.08E+00 60 1,000` — with its column headers lost
somewhere above it, so the numbers mean nothing and the composition filter
drops the row. A .docx table still *has* cells, so a row renders as
`Criterion | Marks | Evidence` and stays readable. The rule is not "tables are
bad"; it is "text whose structure was destroyed is bad". Rubrics are written as
tables, and S8 has to read them, so dropping them here would quietly make that
sprint impossible.

**Document order needed the hard way.** `document.paragraphs` silently omits
tables; `document.tables` loses where they sat. Neither alone preserves the
order a reader depends on, so the extractor walks the body element and yields
paragraphs and tables as they actually appear. A test asserts the order
survives, because "silently omits" is the kind of API behaviour that produces a
plausible-looking result.

**No pages.** A Word file has no pages until something renders it, so
`start_page` and `end_page` are None and a citation names the section instead.
The keys exist in both formats anyway — a chunker that has to branch on format
is a chunker that will eventually branch wrongly.

**De-hyphenation is not applied.** Line-break hyphens are an artefact of PDF
layout. Word text has no such breaks, so running the repair would be solving a
problem that cannot occur.

**An empty document is not an OCR problem.** It returns no sections with the
reason *"no text found"* and `needs_ocr` false. Nothing to read and unreadable
are different states, and S7 only cares about the second.

Nineteen tests, built in memory rather than as checked-in binaries. A .docx
fixture is unreadable in a diff; a builder states the structure being tested.

---

### Entry 46 — S1 step 4: chunking in tokens instead of characters

The splitter cut at 800 characters. Characters are a proxy for the thing that
decides whether a chunk survives, and a loose one. The embedding model's limit
is measured in **its own tokens**, and text over that limit is not rejected —
it is silently truncated and the tail is embedded as though it had never been
written. Nothing downstream looks wrong. Retrieval just quietly gets worse.

800 characters is roughly 200 tokens, so the old chunks happened to fit under
all-MiniLM-L6-v2's 256-token ceiling. That was luck, not design, and it stops
being true the moment a dense PDF arrives — which steps 2 and 3 just made
possible.

**The budget is clamped to the model, not merely configured beside it.**
`CHUNK_BUDGET_TOKENS` is a request: `effective_budget()` returns
`min(requested, EMBEDDING_MAX_TOKENS - 16)`. The configured default is 400 and
today's model reads 256, so the real budget is 240 — and a test asserts that
the default is currently *not* reachable, so step 5's switch to
bge-small-en-v1.5 (512 tokens, same 384 dimensions) is what widens it. Chunk
size and model limit are one decision, so they are made in one place; a model
with a smaller window narrows the budget instead of overflowing it.

**The tokenizer had to come from the loaded model.** The first version called
`AutoTokenizer.from_pretrained(EMBEDDING_MODEL)` and it does not work:
`all-MiniLM-L6-v2` is the name sentence-transformers accepts, not a Hub
identifier, so `AutoTokenizer` raises. Writing the test is what found it —
nothing in the pipeline had called `token_count` yet. It now reads
`store.embedder().tokenizer`: the tokenizer that counts is the tokenizer that
truncates, and the process that chunks is already the process that embeds, so
there is no second copy of the vocabulary and no name to guess.

**Three properties, each asserted directly rather than through a proxy.**

1. *No chunk exceeds the model's limit*, counted with the real tokenizer. A
   character assertion would pass while the model truncated.
2. *No chunk crosses a section boundary.* A passage half Requirements and half
   Marking Scheme describes no single thing, so its vector lands between two
   topics and answers neither question well. The test gives each section a
   nonsense marker word and asserts no chunk contains two of them — detected
   from the text, not from bookkeeping the chunker produced itself.
3. *Consecutive chunks of one section overlap.* The sentence that answers a
   question and the sentence that names its subject are often neighbours; split
   between them with no overlap and neither chunk is retrievable alone.

**Boundaries land on sentences, which means splitting sentences properly.**
Prose is full of periods that end nothing — `et al.`, `e.g.`, `fig. 4`,
`J. Dean`. A sentence longer than the whole budget is real rather than
hypothetical (a list of forty requirements with no full stop, a table row on
one line) and is hard-split on words, because the alternative is the invisible
truncation this module exists to prevent. A remainder under
`MIN_CHUNK_TOKENS` is folded into the previous chunk rather than indexed as a
weak competitor for queries its own neighbour should win — but a whole piece of
text that is short, like a one-line resource note, is kept: it is all there is.

**Measured, not assumed: no change on the seeded corpus.** 15 sources, 15
chunks, recall@1/@3/@5 0.68 / 1.00 / 1.00, MRR 0.828, separation −0.208 —
identical to `fixed 800` in `ai/eval/s1-before.txt`, because every seeded
source is short enough to be one chunk under either rule. `check_retrieval.py`
passes unchanged. The baseline's `fixed 400` row still scores better
(recall@1 0.71, MRR 0.841) for the same reason smaller chunks always flatter a
corpus of tiny documents.

`--compare` makes that plainer than intended: at 240, 128 and every budget
between, the corpus produces the same 15 chunks and the same 0.68 / 0.828,
because no seeded source reaches 128 tokens. The seeded corpus cannot tell
these configurations apart at all, which is exactly what step 8's real
multi-page documents are for.

**What went away.** `STRATEGIES`, `fixed_chunks` and `heading_chunks` are gone,
with `CHUNK_MAX_CHARS` and `CHUNK_OVERLAP`. `evaluate.py --compare` no longer
compares chunkers; it compares token budgets (400 / 256 / 128), because Entry
41 already measured the heading strategy as not applicable to a corpus with no
headings. `store.py` also lost a `CHUNK_SETTINGS` dict that nothing read.

Twenty-two tests, 65 in the Python suite, 490 in the Node suite, all passing.
---

### Entry 47 — S1 step 5: bge-small-en-v1.5, and a prefix that did not help

Decision D1 in the agent plan: move the embedder from `all-MiniLM-L6-v2` to
`BAAI/bge-small-en-v1.5`. One argument decides it — MiniLM reads **256**
tokens, bge-small reads **512**, at the same **384** dimensions and a
comparable size. That limit is a hard ceiling on chunk size, and the previous
entry's 400-token budget was being clamped to 240 by it. The switch is what
makes the configured budget reachable, so these two steps are one change made
in two commits.

**No index rebuild, and the reason is one line.** `numDimensions` in the vector
index is set from `EMBEDDING_DIMS` (`ai/store.py`, the vector field in
`ensure_vector_index`), and both models are 384-wide, so the index definition
is unchanged and only the vectors inside it had to be rewritten. A model of a
different width would need a rebuild — and would fail loudly rather than
quietly, because Atlas rejects a query vector whose length does not match that
number. A test asserts `EMBEDDING_DIMS` against the loaded model, so the
mismatch is caught before an index exists rather than at query time.

**The configured ceiling is now asserted against the model.** `config.py` said
256 and now says 512; `test_the_configured_token_ceiling_is_the_model_s_ceiling`
reads `embedder().max_seq_length` and compares. The step-4 test that asserted
the 400-token budget was *not* reachable failed on this switch, which is
exactly what it was written to do.

**Passage and query are separate functions, not one with a flag.** BGE is
trained asymmetrically: passages bare, queries carrying
`"Represent this sentence for searching relevant passages: "`. A question and
the passage that answers it are not paraphrases, and the prefix tells the model
to encode a search intent rather than a statement. Prefixing both sides is the
common way to get this wrong, and it fails silently — so `embed_passages` and
`embed_query` exist separately, and tests assert the prefix is on the query and
off the passage by comparing the vectors, not by reading the code.

**And then the measurement disagreed with the decision.** 45 questions, same
corpus, same chunker, the prefix as the only variable:

| Configuration | recall@1 | @3 | @5 | MRR | separation |
| --- | --- | --- | --- | --- | --- |
| all-MiniLM-L6-v2 (baseline) | 0.68 | 1.00 | 1.00 | 0.828 | −0.208 |
| bge-small, **with** query prefix | 0.74 | 0.94 | 1.00 | 0.848 | −0.111 |
| bge-small, **without** query prefix | **0.81** | 0.94 | 1.00 | **0.875** | −0.105 |

The model switch is a clear win either way — recall@1 up from 0.68, MRR from
0.828, and the answerable/unanswerable separation halves from −0.208 to −0.11
(still negative: no threshold separates them, which was Entry 41's finding and
remains true). But the documented, trained-for query prefix **costs** 0.07
recall@1 here.

Three honest readings, and the measurement does not distinguish them:

1. 0.07 of 45 questions is **three questions**. This corpus has 15 chunks, all
   short first-party text. It cannot resolve a difference that size.
2. The prefix is for retrieving *passages* — paragraphs of prose from
   documents. There are no documents in the index yet. Step 8 is the first time
   this corpus contains the thing the prefix was trained on.
3. With the reranker on, both rows are **identical** (0.77 / 0.90, MRR 0.839):
   the cross-encoder re-scores the same candidates, so the prefix stops
   mattering to the final ranking on a corpus this small.

So the prefix stays, for the reason it was adopted — it is how the model was
fine-tuned, and D1 approved it — but it is now an environment variable
(`AI_QUERY_INSTRUCTION`, empty to disable) rather than a constant, the
no-prefix row is recorded above rather than discarded, and step 8 re-measures
both against real document questions. A first attempt to assert "the prefix
pulls a question towards its answer" as a unit test was **deleted**, because it
is false pair by pair: on the fixture used it came out 0.01 the wrong way. What
the unit test now asserts is that the prefix changes the ranking at all; the
question of whether it helps belongs to the evaluation, which is the only thing
that can answer it.

**Also worth recording: the reranker is currently a net loss here.** bge-small
with no prefix scores 0.81 / MRR 0.875 on its own, and 0.77 / 0.839 with the
cross-encoder. D7 approved serving the reranker by default, and step 7 builds
it; this says the default must be decided on step 8's document questions, not
on this.

**Versions pinned exactly** (C8): `sentence-transformers==6.1.0`,
`transformers==5.17.0`, `torch==2.14.0`, `numpy==2.4.6`, beside the extraction
pins from step 2. Everything that decides what a vector *is* is pinned, because
a change there does not fail — it produces different vectors for the same text,
and half an index would answer with the old geometry and half with the new one
while looking entirely valid. The version a number was measured with is part of
the number.

**One trap, worth writing down.** `ai/.env` is gitignored and it pinned
`AI_EMBEDDING_MODEL=all-MiniLM-L6-v2`. `load_dotenv()` does not override a real
environment variable, but it certainly overrides a *default* — so changing
`config.py` alone changed nothing locally, and the first measurement would have
been the old model under the new label. `.env.example` and the local `.env`
were both updated, and the stale `AI_CHUNK_MAX_CHARS` / `AI_CHUNK_OVERLAP` keys
removed. This is why the ceiling test reads the loaded model instead of trusting
the config value: a config file that lies is the failure mode here.

Fourteen new tests, 79 in the Python suite. `check_retrieval.py` still passes
on the new vectors, with better top scores (0.905 against 0.805 for the
indexing query).
---

### Entry 48 — S1 step 6: indexing attached files, and deleting them again

Steps 2 to 5 built a pipeline that can read a PDF, size a chunk honestly and
embed it. This step is what connects it to the application: the files people
actually attach.

**The plan was wrong about where attachments live, and the code said so.** It
asked for attachments "on assignments, submissions and resources". Only
submissions can carry a file: `attachmentSchema` appears once in the models
(`server/models/Submission.js`), there is a single `multer` route and it is
scoped to one hand-in, and a resource is a URL plus a note by design. Rather
than hard-code the one path that exists, the walk is written against the shape
of `attachmentSchema` and **called from all three** record loops. Briefs and
resources yield nothing today; the day either gains an upload route, `ai/`
needs no change and — more to the point — nobody has to remember that the
viewers must come from the record's own rule.

**Each file is its own source, keyed by the GridFS file id.** Not "the
submission, with its files folded in": a file id is unique across the whole
store, so one file's chunks can be replaced when it changes and found when it
is gone, without touching the hand-in's text beside it.

**Viewers are inherited, computed, not copied.** An attachment takes the
viewers of its parent record as that parent computes them —
`visibility: "student"` and the student as owner for a hand-in, the whole
mentorship for a brief. The plan's original sentence said "same as submission"
for all three, which would have published a mentor's rubric to every student
the day briefs gained uploads. Two tests assert the negative: one student's
file never carries another student or another mentor as a viewer, even though
both hand-ins are against the same shared brief.

**A hand-in with no typed text used to be skipped entirely.** `sources.py` had
`if not body.strip(): continue`, which was correct when text was all there was
and silently wrong the moment a PDF could be the whole submission. The text
document is now conditional; the attachment walk is not.

**What is deliberately not indexed, and why it is logged rather than ignored.**
Only `application/pdf` and the `.docx` type are read — keyed on `contentType`,
which the server decides from the extension and never takes from the upload, so
it is a fact rather than a claim. `.doc` is a different format that python-docx
cannot read, spreadsheets and slides have no extractor, and images need S7's
OCR. A scan with no text layer produces **zero** chunks and says it needs OCR:
indexing the filename alone would make an unreadable file look retrievable,
which is worse than not indexing it. The route's limits — 10 MB, 5 files — are
repeated here as a floor rather than trusted, because this service reads
whatever is in the database, including rows a seeder wrote, and extraction
allocates on the order of the file size. A test asserts the two numbers against
the route's.

**The deletion gap is closed, and it was not only about attachments.**
`replace_source` keeps one source honest, but it can only delete chunks it is
handed a source for. Nothing deleted the chunks of a source that was simply
gone — and that was already true of ordinary text: delete a hand-in and its
chunks stayed retrievable until someone ran with `--drop`. A run now ends by
**reconciling**: anything in the index that was not seen in this run is
deleted. A full run reconciles the whole index, because a mentorship that no
longer exists cannot appear in a list derived from the ones that do; a run
scoped with `--mentorship` reconciles only inside it, since deleting on the
strength of a partial view would empty the index one mentorship at a time.
Sources that produced zero chunks are still recorded as seen — a brief emptied
to nothing exists, and must not look deleted.

**A test found a bug in the key, which is the part worth writing down.** The
first version keyed a source by `(sourceType, sourceId)`, which is what the
decision as approved said. One assignment can be set to **several
mentorships**, and it is then one source in each of them with the same id in
all. Keying on the pair alone makes any still-live copy vouch for every dead
one: ending one of two mentorships that share a brief left its chunks in the
index permanently. The key is now `(mentorshipId, sourceType, sourceId)`, which
is still a whole-index pass — it is the identity that was wrong, not the scope.
The test that caught it is kept as its own case rather than folded into the
mentorship-deletion one, because the failure is about identity and the other
test would pass with the bug present on a corpus where no brief is shared.

Twenty-five tests, run against the Atlas Local container with no vector index
created: nothing here searches, so the assertions do not wait for a search node
to catch up. They cover every deletion the decision named — remove an
attachment, delete a hand-in, delete a whole mentorship, end a mentorship — and
the scoped run that must leave another mentorship alone. 104 in the Python
suite.

**Still missing, on purpose.** Nothing notices a deletion as it happens: the
index is stale until the next run, and an upload is invisible until then too.
That is S1.5, which the plan already says must land before S2 — once generation
exists, a stale chunk is not merely a wrong search result, it is wrong text
quoted back to someone as though it were current.
---

### Entry 49 — S1 step 7: the reranker and the soft cap move into the served search

Until now the cross-encoder lived in `evaluate.py` and nothing a user touched
ever ran it. The measured configuration and the served one were different
pipelines, which makes every number in Entry 41 a claim about something nobody
uses. D7 approved serving it; this is that, plus the diversity stage from
RAG-Project, with `k` at four.

    vector search (30)  ->  cross-encoder  ->  soft cap  ->  4
          recall             precision         coverage

**Why three stages and not one.** A bi-encoder embeds question and passage
separately, which is what makes passages indexable — and what limits it: the
passage's vector was computed without knowing the question, so it must
summarise that passage for every possible question at once. A cross-encoder
reads the pair together, so every token of the question can attend to the
passage, and it cannot be precomputed, so it only ever sees the candidates. The
cap exists because relevance ranking has no reason to spread results across
records: the four nearest chunks to a question are often four chunks of one
document.

**Over-fetching happens only when something downstream will reorder.** With
both stages off the search asks for exactly `k`; asking the index for 30 and
keeping the first four of the same ordering would cost it 26 candidates' work
and change nothing. A test asserts both limits.

**The security property is unchanged, and now asserted against the pipeline.**
The mentorship and viewer filter stays inside `$vectorSearch`. Reranking and
capping only ever *reorder* what that filtered search returned — no stage after
it can widen the set — which is the reason they are allowed to be on by
default. Two tests check it: one that the filter is in the `$vectorSearch`
stage, one that no later stage filters at all.

**The cap is keyed on the record, not the file or the chunk.** Ported from
`rag/retrieve.py` at 695795a with `arxiv_id` replaced by
`(parentType, parentId)`, falling back to the source's own identity. So a
twenty-page PDF and the hand-in text it was attached to count as one hand-in: a
long attachment cannot win every slot by being its own source. Nothing is ever
dropped to satisfy the cap — deferred chunks come back at the end rather than
returning fewer than `k`, because a cap that silently shrinks the context is
worse than one that bends.

**The margin is on a normalised scale, and the tests had to be rewritten to
say so.** `soft_cap` min-maxes the candidate scores before comparing them, so
"within 0.2" means within 0.2 of the spread of *this query's* candidates, not
0.2 of a score. Two tests written as though it were a raw gap failed, and they
were wrong rather than the port: among candidates spanning 0.05 a 0.02 gap is
decisive, and among candidates spanning 0.9 the same gap is noise. There is now
a test that asserts exactly that — identical records, identical raw gap,
opposite outcomes — because it is the one thing a reader of this function will
otherwise get wrong. It is also the same caveat as Entry 41's: these numbers
order results within a query and mean nothing across queries, which is why
nothing thresholds on them.

**Measured, per stage, on the 45 questions.**

| Stage | recall@1 | @3 | @5 | MRR | median latency |
| --- | --- | --- | --- | --- | --- |
| dense only | 0.74 | 0.94 | 1.00 | 0.848 | 36 ms |
| + reranker | 0.77 | 0.90 | 0.90 | 0.839 | 196 ms |
| + soft cap | 0.77 | 0.90 | 0.90 | 0.839 | 190 ms |

Read honestly, that table says the reranker buys 0.03 recall@1 for 160 ms and
costs 0.10 recall@5, and **the soft cap does nothing at all**. The second is not
a bug: the seeded corpus produces 15 chunks from 15 sources, one chunk each, so
no record ever holds two of the four slots and the cap has nothing to cap. A
stage that cannot act is being measured on a corpus that cannot exercise it.

That is the strongest argument yet for step 8. Both of these defaults — the
reranker on, `diversity="soft_cap"` — are approved decisions measured on a
corpus that cannot distinguish them, and `evaluate.py --ablation` now runs the
real served path stage by stage, so step 8's documents will produce a table
that can.

**`evaluate.py` no longer owns a copy of the pipeline.** It calls
`store.search` with the stage flags, so a measurement is a measurement of the
thing that runs. It also reports median wall-clock latency per search, which is
how the 160 ms above is known rather than assumed.

Nineteen new tests, 123 in the Python suite, 490 in the Node suite. The Copilot
route's default `k` moves from 5 to 4 to match the service; the 1–10 clamp,
the 503 when the service is not configured and the 502 on a bad upstream are
untouched.

---

### Open items / "later" list

- ~~**Server-side auth on mutating endpoints**~~ — done in Entry 15. Firebase
  ID tokens are verified on every REST route and at the socket handshake.
- ~~**ESLint is broken**~~ — fixed in Entry 11. `npm run lint` now covers
  `src/` and `server/`: 0 errors, 2 documented warnings.
- **Role enforcement, remaining edges** — done for groups and announcements
  (Entry 10), and the socket layer was closed in Entry 15. Still open:
  announcement editing doesn't exist — only post and delete.
- ~~**New-user live refresh**~~ — done in Entry 13 via `user-added` /
  `user-updated` broadcasts.
- ~~**Final cleanup pass**~~ — done in Entry 12. Docs rewritten, dead Firebase
  config files deleted, `localhost → 127.0.0.1` default committed.
- ~~**Group read receipts**~~ — done in Entry 27, along with group previews
  and unread counts.
- ~~**Presence is unreliable**~~ — fixed in Entry 17: login no longer marks you
  online, stale flags are cleared at boot, and multi-tab is handled properly.
- ~~**No automated test suite**~~ — done in Entry 18: 67 integration tests,
  `cd server && npm test`.
- ~~**No CI**~~ — done in Entry 28. GitHub Actions runs the linter, a
  production build and the suite on every push and pull request.
- **No frontend tests** — the 273 cover the server. React components are only
  checked by the Playwright screenshot harness, which catches render failures
  and console errors but asserts nothing about behaviour. The screenshot run
  is also not in CI: it needs both servers and a browser, which is a
  materially bigger job than the one that exists.
- ~~**Six server features are not in the test suite**~~ — done in Entry 28.
  All six were converted from hand checks into committed tests; the suite went
  from 105 to 273.
- **An ignored opt-out has no way out** — a mentor who never answers leaves
  the student stuck. `optOut.requestedAt` is the seam for a sweep, an admin
  action, or auto-approval after N days. Entry 26.
- ~~**Goals & milestones**~~ — done in Entry 21.
- ~~**Scheduling**~~ — done in Entry 22.
- ~~**Analytics**~~ — done in Entry 24. `/api/analytics/me` plus the Progress
  page, and the admin dashboard now counts mentorships, goals and sessions.
- ~~**Achievements**~~ — built in Entry 31, **removed** in Entry 37. The badges
  set challenges the platform is not about; assignment streaks replace them,
  and keep the one idea worth keeping: derived on read, never stored.
- **Deployment** and **frontend tests** are what remain, both infrastructure.
- ~~**Feedback ratings**~~ — built in Entry 29, switched **off** in Entry 32.
  The server half and its 27 tests stay live so the code cannot rot while
  dormant; `FEATURES.sessionRatings` brings the UI back.
- ~~**Resources**~~ — done in Entry 30.
- **Sessions never leave the app** — no calendar export, no invitation, and no
  reminder before one starts. Times are stored UTC and rendered per viewer, so
  two timezones agree on the moment; nothing tells either person it is coming.
- **No rate limiting** — a signed-in client can flood messages or announcements.
- **Pagination built but unused** — `?limit` / `?before` exist on the group
  history endpoint; no page calls them.
- **Eight dependency advisories** — body-parser, qs, path-to-regexp,
  socket.io, engine.io, ws and mongoose. `npm audit fix` resolves them within
  the current version ranges; it deserves its own commit and test run.
  Entry 35.
- **The bundle is past 500 kB** — Vite now warns. Splitting routes with
  dynamic `import()` is the fix. Entry 35.
