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
- **Group read receipts** — 1-to-1 chat has them (Entry 5), groups do not.
  (Socket membership enforcement, the other half of this item, was done in
  Entry 15.)
- ~~**Presence is unreliable**~~ — fixed in Entry 17: login no longer marks you
  online, stale flags are cleared at boot, and multi-tab is handled properly.
- **No automated test suite** — Entries 15, 16 and 17 each ran verification by
  hand with scripts that were not kept. Converting them into committed tests is
  the largest remaining gap; `docs/PROJECT_BRIEF.md` has to describe all of it
  as manual testing.
- **No rate limiting** — a signed-in client can flood messages or announcements.
- **Pagination built but unused** — `?limit` / `?before` exist on the group
  history endpoint; no page calls them.
