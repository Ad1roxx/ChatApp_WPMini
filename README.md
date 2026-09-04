# Chat App — Mentor/Student Mini Project

A real-time chat application with 1-to-1 messaging, group chats, mentor
announcements, and student/mentor roles.

**Firebase Authentication** answers *"who are you?"* (Google Sign-In only).
A custom **Express + Socket.IO + MongoDB** server answers *"what is your
data?"* — users, messages, groups, announcements and presence.

That split is the thing to internalise before reading the code. Firebase runs
the Google login popup and hands back a stable `uid`. The moment it does, the
frontend calls `POST /api/auth/login`, which creates or updates a matching user
document in MongoDB and returns its `_id`. **That Mongo `_id` — not the
Firebase `uid` — is the identity every other feature keys off.**

---

## Features

| Feature | Notes |
| --- | --- |
| Google Sign-In | Firebase Auth; no password handling of our own |
| 1-to-1 chat | Live over Socket.IO, with typing indicators and read receipts |
| Group chat | Create, join, and chat with typing indicators |
| Announcements | Mentors broadcast, everyone reads |
| Student / mentor roles | Chosen at first login, changeable from your profile |
| Admin dashboard | Live platform stats and role management, admins only |
| Profiles | Bio for everyone; expertise and availability for mentors |
| Presence | Live online/offline status across the app |

**What roles actually gate:**

- **Students** join groups, chat in them, and read announcements.
- **Mentors** additionally create groups and post announcements.
- **Admins** can do everything a mentor can, plus see the dashboard and change
  other people's roles.

Every rule is enforced on the server by reading the caller's stored role from
MongoDB — never from the request body. **Admin is not selectable:** it is
granted only by the `ADMIN_EMAILS` allowlist in the server's environment, so it
cannot be self-assigned by editing a request.

---

## Running it

You need **Node.js** and a **MongoDB** instance (local or Atlas).

**1. Backend**

```bash
cd server
npm install
cp .env.example .env      # set MONGODB_URI, FIREBASE_PROJECT_ID, and
                          # ADMIN_EMAILS if you want the dashboard
node index.js             # http://localhost:3001
```

**2. Frontend** (from the project root, in a second terminal)

```bash
npm install
npm run dev               # http://localhost:5173
```

Sign in with Google. On your first login you'll be asked to pick a role.

> To see the mentor-only features you need a mentor account. Pick Mentor at
> first login, or switch later from **Profile → Role**.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run lint` | ESLint across `src/` and `server/` |
| `npm run screenshot` | Playwright screenshots of every route (app must be running) |

From `server/`:

| Command | What it does |
| --- | --- |
| `npm start` | Run the API and Socket.IO server |
| `npm test` | 67 integration tests against a throwaway database |

---

## Project layout

```
src/
  App.jsx                    routes + the first-login role gate
  firebase.js                Firebase Auth setup (auth only — no Firestore)
  context/AuthContext.jsx    auth state, the socket, dbUser, authFetch
  styles/
    tokens.css               design tokens — every colour, space, type size
    base.css                 reset + element defaults
  components/
    AppShell.jsx             role-aware sidebar frame + responsive drawer
    Button/Card/Avatar/…     shared UI primitives (CSS Modules)
    Toast.jsx                replaces alert()
    ConfirmDialog.jsx        replaces window.confirm()
  pages/
    LoginPage.jsx            Google sign-in
    RoleSelectPage.jsx       one-time first-login role picker
    UsersPage.jsx            who you can chat with, with presence
    ChatPage.jsx             1-to-1 chat
    GroupsPage.jsx           browse/join groups; create (mentors only)
    GroupChatPage.jsx        group chat
    AnnouncementsPage.jsx    the feed; compose box for mentors
    ProfilePage.jsx          your own profile + role switcher
    UserProfilePage.jsx      someone else's profile (read-only)
    AdminPage.jsx            platform stats + role management (admins)
  lib/roles.js               canMentor / isAdmin — for rendering only

server/
  index.js                   Express routes + all Socket.IO handlers
  middleware/
    auth.js                  Firebase ID token verification + role gates
  test/
    helpers/harness.js       spawns the server against a throwaway database
    auth.test.js             identity, ownership, role gates
    admin.test.js            admin role and dashboard endpoints
    realtime.test.js         socket identity, membership, presence
    startup.test.js          stale-presence reset on boot
  models/
    User.js                  identity, presence, role, profile fields
    Message.js               1-to-1 messages
    Group.js                 group + members
    GroupMessage.js          group messages
    Announcement.js          mentor broadcasts

docs/
  BUILD_NOTES.md             running log: what was built and why
```

---

## REST API

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/login` | Upsert the Mongo user after Firebase sign-in |
| GET | `/api/users` | All users (`?exclude=<firebaseUid>`) |
| GET | `/api/user/:id` | One user, including profile fields |
| POST | `/api/users/:id/role` | Set or change role |
| PUT | `/api/users/:id/profile` | Bio; expertise/availability for mentors only |
| GET | `/api/messages/:visitorId/:peerId` | 1-to-1 history |
| GET | `/api/groups` | All groups (`?userId=` to filter) |
| POST | `/api/groups` | **Mentors only** |
| POST | `/api/groups/:groupId/join` | Join a group |
| GET | `/api/groups/:groupId/messages` | Group history |
| GET | `/api/announcements` | Public feed, newest first |
| POST | `/api/announcements` | **Mentors only** |
| DELETE | `/api/announcements/:id` | **Author only** |
| GET | `/api/admin/stats` | **Admins only** — live platform counts |
| GET | `/api/admin/users` | **Admins only** |
| PATCH | `/api/admin/users/:id/role` | **Admins only** — cannot grant admin |

## Socket.IO events

**Client → server:** `user-online`, `send-message`, `typing`, `stop-typing`,
`mark-read`, `join-group`, `leave-group`, `send-group-message`,
`group-typing`, `group-stop-typing`

**Server → client:** `online-users`, `user-status-change`, `new-message`,
`message-sent`, `user-typing`, `user-stop-typing`, `messages-read`,
`new-group-message`, `group-user-typing`, `group-user-stop-typing`,
`new-announcement`, `announcement-deleted`, `error`

---

## Security

What is actually enforced, since a chat app with roles invites the question:

- **Identity.** Every REST request carries the caller's Firebase ID token;
  every socket carries it in the handshake. The server verifies the signature
  against Google's public certificates and checks the audience and issuer
  match this Firebase project. Handlers then read the caller from the verified
  token — **never** from an id in the request body.
- **Ownership.** You can only edit your own profile, change your own role,
  read conversations you are part of, delete announcements you wrote, and add
  yourself to a group.
- **Roles.** Mentor-only actions re-read the role from MongoDB rather than
  trusting anything the client sent, so a client cannot promote itself.
- **Admin.** Granted solely by the `ADMIN_EMAILS` allowlist at sign-in. The
  role picker, the profile switcher and the self-service role endpoint all
  refuse it, and the admin endpoint cannot grant it either — otherwise one
  compromised admin account would be enough to mint more.
- **Group membership.** Both `join-group` and `send-group-message` check
  membership, as does the REST history endpoint. Joining a room you don't
  belong to is refused.

No service-account key is needed: verifying an ID token only requires Google's
public certificates. Set `FIREBASE_PROJECT_ID` and the server runs.

## Known limitations

Worth stating plainly rather than discovering later:

- **Presence is connection-based.** "Online" means "has a live socket", so a
  half-closed connection can leave a stale green dot until the socket times
  out.
- **No pagination in the UI.** The group history endpoint supports `?limit`
  and `?before`, but no page uses them; the announcement feed is capped at 50
  server-side. Fine at project scale, the first thing to revisit beyond it.
- **No rate limiting.** Nothing stops a signed-in client from flooding
  messages or announcements.

`docs/BUILD_NOTES.md` keeps a running log of every meaningful change — what was
built, which files moved, the design decisions and their tradeoffs.
