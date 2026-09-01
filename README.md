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
| Profiles | Bio for everyone; expertise and availability for mentors |
| Presence | Live online/offline status across the app |

**What roles actually gate:** mentors can create groups and post
announcements. Students can join groups, chat in them, and read announcements.
Nothing else differs. Both rules are enforced on the server by reading the
caller's stored role from MongoDB — never from the request body.

---

## Running it

You need **Node.js** and a **MongoDB** instance (local or Atlas).

**1. Backend**

```bash
cd server
npm install
cp .env.example .env      # then set MONGODB_URI
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

---

## Project layout

```
src/
  App.jsx                    routes + the first-login role gate
  firebase.js                Firebase Auth setup (auth only — no Firestore)
  context/AuthContext.jsx    auth state, the socket, and dbUser
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

server/
  index.js                   Express routes + all Socket.IO handlers
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

## Socket.IO events

**Client → server:** `user-online`, `send-message`, `typing`, `stop-typing`,
`mark-read`, `join-group`, `leave-group`, `send-group-message`,
`group-typing`, `group-stop-typing`

**Server → client:** `online-users`, `user-status-change`, `new-message`,
`message-sent`, `user-typing`, `user-stop-typing`, `messages-read`,
`new-group-message`, `group-user-typing`, `group-user-stop-typing`,
`new-announcement`, `announcement-deleted`, `error`

---

## Known limitations

Worth stating plainly rather than discovering later:

- **No server-side token verification.** No endpoint checks that a caller is
  who they claim to be — they trust the Mongo `_id` in the request. The
  mentor-only and author-only rules above are enforced against the *database's*
  copy of your role, so a client can't promote itself by editing a payload, but
  it could act as another user by sending their id. Closing this properly means
  verifying the Firebase ID token server-side on every mutating route.
- **Group sockets don't check membership.** `join-group` will put any socket
  into any group room. The REST layer is gated; the socket layer isn't yet.
- **The users list doesn't live-update on new signups.** Only online/offline
  status is pushed; a brand-new account appears after a refresh.

`docs/BUILD_NOTES.md` keeps a running log of every meaningful change — what was
built, which files moved, the design decisions and their tradeoffs.
