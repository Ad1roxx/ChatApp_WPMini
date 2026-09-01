# Project Feature Documentation

This document maps the course outcomes to where and how each one is
implemented in this repository. Paths are relative to the project root.

**Architecture in one line:** Firebase Authentication handles identity (Google
Sign-In only); a custom Express + Socket.IO + MongoDB server handles all data —
users, messages, groups, announcements and presence. See `README.md` for the
full picture and `docs/BUILD_NOTES.md` for the reasoning behind each feature.

---

## 1. Basic React Web Page Design (JSX, Components and props) — CO1

**Files:** `src/main.jsx`, `src/App.jsx`, `src/styles/` (design tokens and
base styles), eleven reusable components in `src/components/`, and nine page
components in `src/pages/`.

- `src/App.jsx` composes the whole route table and holds the first-login role
  gate that renders `RoleSelectPage` in place of everything else when a
  signed-in user has no role yet.
- Page components: `LoginPage`, `RoleSelectPage`, `UsersPage`, `ChatPage`,
  `GroupsPage`, `GroupChatPage`, `AnnouncementsPage`, `ProfilePage`,
  `UserProfilePage`.
- Reusable components in `src/components/`: `AppShell` (the role-aware sidebar
  frame every signed-in page renders inside), plus `Button`, `Card`, `Avatar`,
  `Badge`, `Field`, `EmptyState`, `Loading`, `Toast`, `ConfirmDialog`, `Icons`.
- Styling is **CSS Modules** with design tokens as CSS custom properties in
  `src/styles/tokens.css`. Every colour, space and type size resolves to one
  token, so nothing hardcodes a hex value.

**Props in practice.** State is shared through React Context rather than long
prop chains (see item 2), so props mostly carry per-item data into repeated
markup — for example each user card in `UsersPage` and each announcement card
in `AnnouncementsPage` is rendered from a `.map()` over fetched data, keyed by
its MongoDB `_id`. Conditional rendering off props/state is used throughout:
`UserProfilePage` renders a mentoring section only when
`profile.role === 'mentor'`.

## 2. Demonstrate the use of React hooks (useState and useEffect) — CO1

Across `src/`: **50** `useState`, **24** `useEffect`, plus `useContext`,
`useRef`, `useNavigate` and `useParams`.

- **`useState`** — `ProfilePage` holds every form field (`bio`, `expertise`,
  `availability`, `saving`, `status`); `UsersPage` holds the user list and a
  `Set` of online user ids; `AnnouncementsPage` holds the feed and compose box.
- **`useEffect` for data fetching** — `UsersPage` fetches `/api/users` on
  mount; `UserProfilePage` re-fetches whenever the `:userId` in the URL
  changes; `ChatPage` loads peer info and message history together.
- **`useEffect` for subscriptions, with cleanup** — the important pattern here.
  Every page that listens to Socket.IO registers handlers and returns a cleanup
  function that calls `socket.off(...)`. `GroupChatPage` additionally emits
  `leave-group` on cleanup and clears its typing timeout. Without this, handlers
  would stack up on every re-render.
- **`useRef`** — `ChatPage` and `GroupChatPage` use refs for the
  scroll-to-bottom anchor and for the typing-indicator debounce timeout, i.e.
  values that must survive re-renders without causing one.
- **`useContext` + a custom hook** — `src/context/AuthContext.jsx` defines
  `AuthProvider` and the `useAuth()` hook that wraps `useContext`. It also
  throws a clear error when used outside the provider.

## 3. Form Handling using React — CO1

Five controlled forms, each with `onSubmit` and `value`/`onChange` bindings:

| Form | File | Handler |
| --- | --- | --- |
| Edit profile | `src/pages/ProfilePage.jsx` | `handleSave` |
| Create group | `src/pages/GroupsPage.jsx` | `handleCreate` |
| Post announcement | `src/pages/AnnouncementsPage.jsx` | `handlePost` |
| Send message | `src/pages/ChatPage.jsx` | `sendMessage` |
| Send group message | `src/pages/GroupChatPage.jsx` | `sendMessage` |

Every one calls `e.preventDefault()` and drives its inputs from state.
`GroupsPage` also manages a checkbox group as a `Set` of selected member ids,
toggled immutably. `ProfilePage` seeds its fields from the logged-in user with
a `useEffect` keyed on `dbUser`, so after a save the form re-fills from the
server's authoritative copy.

## 4. Navigation and Form Validation — CO2

**Navigation** — React Router v6 (`react-router-dom`):

- Routes declared in `src/App.jsx`; `useNavigate()` for programmatic navigation
  (14 uses); `useParams()` to read `:peerId`, `:groupId` and `:userId`.
- **Protected routes:** every route renders its page only `if (user)` and
  otherwise `<Navigate to="/login" />`.
- **Route gating on state:** while auth is resolving, `App` renders a spinner
  rather than briefly flashing the login page; and a signed-in user with no
  role gets `RoleSelectPage` instead of any route at all.
- A catch-all `path="*"` redirects unknown URLs home.

**Validation — client side:**

- `maxLength` on every free-text input, matching the database limits exactly:
  bio 500, expertise/availability 200, announcement 2000. Live character
  counters show the remaining budget.
- Submit buttons are `disabled` while a request is in flight and when the
  required field is empty (`!groupName.trim()`, `!text.trim()`), so empty
  submissions cannot be sent.
- Failed requests surface the server's own error message rather than a generic
  failure, and destructive or consequential actions confirm first (deleting an
  announcement, switching role).

**Validation — server side.** The client checks are convenience; the server
re-checks independently:

- Required-field checks return `400` (`server/index.js`).
- Mongoose schema `maxlength` validators, applied on update with
  `runValidators: true`.
- `role` is constrained by an `enum: ['student', 'mentor', 'admin']`.

## 5. API integration — CO2

Two complementary transports:

- **REST over `fetch`** for request/response work — loading users, history,
  groups, profiles; saving a profile; creating a group; posting an
  announcement. Every call goes through `authFetch()` from `AuthContext`,
  which attaches the caller's Firebase ID token.
- **WebSockets via Socket.IO** for anything live — messages, typing
  indicators, read receipts, presence, and announcements.

Responses are checked with `res.ok` before use, `try/catch/finally` wraps every
call, and loading and empty states are rendered explicitly.

## 6. Demonstrate use of Node.js (server) — CO2

`server/index.js` — an Express application that also hosts the Socket.IO
server on the same HTTP server (`http.createServer(app)`), with:

- `cors` configured for the Vite dev origin
- `dotenv` for configuration (`MONGODB_URI`, `PORT`, `FIREBASE_PROJECT_ID`)
- `jsonwebtoken` to verify Firebase ID tokens against Google's public certs
- `mongoose` for MongoDB
- an in-memory map of `userId → socket.id` for routing direct messages
- graceful shutdown handling and startup logging

**Socket.IO events handled:** `user-online`, `send-message`, `typing`,
`stop-typing`, `mark-read`, `join-group`, `leave-group`,
`send-group-message`, `group-typing`, `group-stop-typing`, `disconnect`.

**Events emitted:** `online-users`, `user-status-change`, `new-message`,
`message-sent`, `user-typing`, `user-stop-typing`, `messages-read`,
`new-group-message`, `group-user-typing`, `group-user-stop-typing`,
`new-announcement`, `announcement-deleted`, `error`.

Note the three different broadcast shapes, which is the interesting part:
direct messages go to one socket id, group messages go to a room
(`io.to('group:<id>')`), and announcements go to **everyone** (`io.emit`),
because a public broadcast has no room that means "all users".

## 7. Routing using Express.js — CO2

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/login` | Upsert the Mongo user after Firebase sign-in |
| GET | `/api/users` | List users (`?exclude=<firebaseUid>`) |
| GET | `/api/user/:visitorId` | One user, including profile fields |
| POST | `/api/users/:id/role` | Set or change role |
| PUT | `/api/users/:id/profile` | Update profile |
| GET | `/api/messages/:visitorId/:peerId` | 1-to-1 history |
| GET | `/api/groups` | List groups |
| POST | `/api/groups` | Create a group — **mentors only** |
| POST | `/api/groups/:groupId/join` | Join a group |
| GET | `/api/groups/:groupId/messages` | Group history (supports `?limit`/`?before`) |
| GET | `/api/announcements` | Public feed |
| POST | `/api/announcements` | Post — **mentors only** |
| DELETE | `/api/announcements/:id` | Delete — **author only** |

Demonstrated along the way: route parameters (`:id`), query strings
(`?exclude=`, `?limit=`), `express.json()` body parsing, and meaningful status
codes — `400` invalid input, `403` not allowed, `404` not found, `500` server
error.

## 8. Database Integration — CO3

**MongoDB via Mongoose.** Five schemas in `server/models/`:

| Model | Shape |
| --- | --- |
| `User` | `firebaseUid`, `email`, `displayName`, `photoURL`, `isOnline`, `lastSeen`, `role` (student/mentor/admin), `bio`, `expertise`, `availability`, `createdAt` |
| `Message` | `sender`, `receiver`, `text`, `timestamp`, `isRead` |
| `Group` | `name`, `createdBy`, `members[]` |
| `GroupMessage` | `group`, `sender`, `text`, `timestamp` |
| `Announcement` | `author`, `text`, `timestamp` |

Techniques used: `ObjectId` references with `.populate()` to join user data
onto messages; compound indexes for the common query orders (e.g.
`{ group: 1, timestamp: 1 }`); `findByIdAndUpdate` with `{ new: true }` and
`runValidators: true`; `$addToSet` so joining a group twice cannot duplicate a
member; `upsert` on login; schema-level `enum`, `maxlength`, `trim` and
`default` validation.

**Firebase** is used for **Authentication only** (`src/firebase.js` exports
`auth` and `googleProvider`, with `browserLocalPersistence` so sessions survive
a browser restart). Firestore is *not* used — all data lives in MongoDB.

## 9. Integrating React with Node.js using REST API

The integration point is `src/context/AuthContext.jsx`, which is where the two
halves of the system are stitched together:

1. Firebase reports a Google sign-in via `onAuthStateChanged`.
2. The context immediately `POST`s the Firebase profile to `/api/auth/login`.
3. The server upserts a MongoDB user and returns the document.
4. That document is stored as `dbUser`, and a Socket.IO connection opens with
   `user-online` carrying its `_id`.
5. Every other page reads `dbUser`, `socket` and `SERVER_URL` from
   `useAuth()`.

**The key design point:** the Mongo `_id`, not the Firebase `uid`, is the
identity every feature keys off — messages, group membership, announcements and
presence all reference it. Firebase answers "who are you?"; MongoDB answers
"what is your data?".

## 10. Role-based access control

There are three roles. Student and mentor are set at first login
(`RoleSelectPage`) and changeable later from `ProfilePage`. **Admin is
different in kind:** it is granted by the server's `ADMIN_EMAILS` allowlist at
sign-in and cannot be chosen — the picker, the profile switcher and the
self-service role endpoint all refuse it. A role a user can assign to
themselves is not an access control.

Enforcement, all server-side:

- `POST /api/groups` and `POST /api/announcements` load the caller's role
  **from MongoDB** and return `403` unless it is `mentor` or `admin`.
- `PUT /api/users/:id/profile` writes `expertise` and `availability` only when
  the stored role is `mentor`, silently dropping them otherwise.
- `DELETE /api/announcements/:id` checks **authorship**, not role — being a
  mentor lets you delete your own announcements, not everyone's.

- `GET /api/admin/stats`, `GET /api/admin/users` and
  `PATCH /api/admin/users/:id/role` are `requireRole('admin')`. The last one
  refuses to assign `admin`, to touch another admin, or to change the caller's
  own role.

The UI hides what you cannot do (no create form or compose box for students,
no dashboard link for non-admins), but that is convenience only. The rule that
actually holds is the server's, because it reads the database's copy of your
role rather than anything the client sent.

---

## How to run the project locally

See `README.md`. In short: start MongoDB, then `cd server && npm install &&
node index.js` (port 3001), then `npm install && npm run dev` in the project
root (port 5173). `npm run lint` runs ESLint over both `src/` and `server/`.

## Known limitations

Stated deliberately rather than left to be discovered:

- **Presence is connection-based.** "Online" means "has a live socket", so a
  half-closed connection can leave a stale green dot until it times out.
- **No pagination in the UI.** The group history endpoint supports `?limit`
  and `?before`, but no page uses them.
- **No rate limiting.** Nothing stops a signed-in client from flooding
  messages or announcements.
