# Chat App — Mentor/Student Mini Project

[![CI](https://github.com/Ad1roxx/ChatApp_WPMini/actions/workflows/ci.yml/badge.svg)](https://github.com/Ad1roxx/ChatApp_WPMini/actions/workflows/ci.yml)

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
| Admin dashboard | Live platform stats, role management, verification and moderation |
| Mentor verification | Mentors submit credentials; an admin approves before the badge appears |
| Suspension | Admins can suspend an account; it is locked out of REST and sockets |
| Reports | Anyone can report a user or content; admins resolve or dismiss |
| Mentorships | Mentors add students outright; students ask and can request to opt out |
| Goals & milestones | Mentors set goals; either party ticks milestones; progress is derived |
| Assignments | One brief to several students; each drafts, attaches files, hands in and unsubmits on their own; the mentor reviews each, with a full history |
| Assignment streaks | Hand-ins on time in a row, and weeks running — derived on read, never stored |
| Sessions | Either party proposes a time, the other confirms; reschedule, cancel, notes |
| Progress | What the mentorships add up to, sorted so the quiet one is at the top |
| Unread messages | Per-person and per-group counts, previews, and sidebar totals |
| Group read receipts | "Seen by" under your last message, from per-member read marks |
| ~~Feedback ratings~~ | Built and tested, switched **off** in `src/lib/features.js` — see below |
| Resources | Links pinned to a mentorship, so they do not scroll away in the chat |
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

The frontend talks to `http://localhost:3001` unless `VITE_SERVER_URL` says
otherwise, so nothing needs configuring to run it the usual way. Set that
variable to point a build at a deployed backend, or to run a second copy of
the app against a throwaway database without disturbing the one already on
3001.

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
| `npm test` | 478 integration tests against a throwaway database |

---

## Project layout

```
src/
  App.jsx                    routes + the first-login role gate
  firebase.js                Firebase Auth setup (auth only — no Firestore)
  context/
    AuthContext.jsx          auth state, the socket, dbUser, authFetch
    ConversationsContext.jsx previews and unread counts, shared by list and sidebar
    WorkContext.jsx          assignment counts, for the sidebar badge
  styles/
    tokens.css               design tokens — every colour, space, type size
    base.css                 reset + element defaults
  components/
    AppShell.jsx             role-aware sidebar frame + responsive drawer
    Button/Card/Avatar/…     shared UI primitives (CSS Modules)
    Toast.jsx                replaces alert()
    ConfirmDialog.jsx        replaces window.confirm()
    Progress.jsx             a done/total meter, not a percentage
    Stat.jsx                 a number worth reading on its own
    UnreadBadge.jsx          the count pill, capped at 99+
    Stars.jsx                a five-point rating (dormant — see features.js)
    Resources.jsx            the shared-links section of a mentorship
    Assignments.jsx          one student's slice, on the mentorship page
    SubmissionRow.jsx        one hand-in: draft, files, hand in, unsubmit, review, history
    Sessions.jsx             the scheduling section of a mentorship
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
    AdminPage.jsx            stats, verification queue, reports, users
    MentorshipsPage.jsx      requests, your mentors, your students, past
    MentorshipDetailPage.jsx one relationship: its goals and its sessions
    ProgressPage.jsx         goals and sessions read back as progress
    AssignmentsPage.jsx      the whole class: set for several, review each
    SuspendedPage.jsx        shown instead of the app to a suspended account
  lib/
    attachments.js           what can be attached, mirrored for the file picker
    features.js              switches for built-but-not-shipped features
    roles.js                 canMentor / isAdmin / isVerified — rendering only
    useNow.js                the clock as state, plus relative time formatting

server/
  index.js                   Express routes + all Socket.IO handlers
  middleware/
    auth.js                  Firebase ID token verification + role gates
  lib/
    fileStore.js             uploaded files, kept in MongoDB (GridFS)
  test/
    helpers/harness.js       spawns the server against a throwaway database
    auth.test.js             identity, ownership, role gates
    admin.test.js            admin role and dashboard endpoints
    realtime.test.js         socket identity, membership, presence
    moderation.test.js       verification, suspension, reports
    mentorship.test.js       both directions, and opt-outs
    goals.test.js            permissions, and the derived status
    sessions.test.js         the propose/confirm handshake, transitions
    analytics.test.js        the figures, and what they exclude
    conversations.test.js    previews, unread counts, read events
    groupreads.test.js       group previews, counts, receipts
    feedback.test.js         who may rate, the scale, and the average
    resources.test.js        the URL allow-list, and who may remove
    assignments.test.js      recipients, privacy, drafts, unsubmit, the history
    attachments.test.js      who uploads and downloads, limits, clean-up
    startup.test.js          stale-presence reset on boot
  models/
    User.js                  identity, presence, role, profile fields
    Message.js               1-to-1 messages
    Group.js                 group + members
    GroupMessage.js          group messages
    Announcement.js          mentor broadcasts
    Report.js                moderation reports
    Mentorship.js            the student–mentor relationship
    Goal.js                  goals with embedded milestones
    Session.js               scheduled meetings, proposed and confirmed
    GroupRead.js             per-member read marks, for group unread and receipts
    Feedback.js              a student's rating of one completed session
    Resource.js              a shared link, http(s) only
    Assignment.js            one brief and a deadline, sent to several students
    Submission.js            one student's hand-in, its files, status and history

.github/workflows/
  ci.yml                     lint, build and the test suite on every push

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
| POST | `/api/verification` | **Mentors only** — submit credentials for review |
| GET | `/api/admin/verifications` | **Admins only** — the review queue |
| PATCH | `/api/admin/verifications/:userId` | **Admins only** — approve or reject |
| PATCH | `/api/admin/users/:id/suspend` | **Admins only** — suspend or restore |
| POST | `/api/reports` | Report a user or a message |
| GET | `/api/admin/reports` | **Admins only** — the moderation queue |
| PATCH | `/api/admin/reports/:id` | **Admins only** — resolve or dismiss |
| POST | `/api/mentorships` | `mentorId` to ask a mentor · `studentId` to take a student on |
| GET | `/api/mentorships` | Yours, on either side (`?status=` to filter) |
| PATCH | `/api/mentorships/:id` | accept · decline · end · request/cancel/approve/decline-optout |
| GET | `/api/mentorships/:id/goals` | Goals of one mentorship (either party) |
| POST | `/api/mentorships/:id/goals` | **Mentor only** — set a goal |
| PATCH | `/api/goals/:goalId` | **Mentor only** — edit or archive |
| PATCH | `/api/goals/:goalId/milestones/:milestoneId` | Tick a milestone (either party) |
| GET | `/api/sessions/upcoming` | Your next sessions across every mentorship |
| GET | `/api/mentorships/:id/sessions` | Sessions of one mentorship (either party) |
| POST | `/api/mentorships/:id/sessions` | Propose a time (either party) |
| PATCH | `/api/sessions/:sessionId` | confirm · reschedule · cancel · complete · notes |
| GET | `/api/analytics/me` | Your totals, and one row per active mentorship |
| GET | `/api/conversations` | Last message and unread count, per person |
| GET | `/api/groups/conversations` | The same, per group |
| GET | `/api/groups/:groupId/reads` | Every member's read mark, for receipts |
| PUT | `/api/sessions/:sessionId/feedback` | **Student only** — rate a completed session |
| GET | `/api/mentorships/:id/feedback` | Every rating in one mentorship |
| GET | `/api/users/:id/feedback` | A mentor's count, average and recent comments |
| GET | `/api/mentorships/:id/resources` | Links shared in one mentorship |
| POST | `/api/mentorships/:id/resources` | Share a link (either party, http/https only) |
| DELETE | `/api/resources/:resourceId` | Whoever shared it, or the mentor |
| POST | `/api/assignments` | **Mentor only** — set work for one or several of your students |
| GET | `/api/assignments` | Work you set (with "4 of 6" summaries) and work set for you |
| GET | `/api/assignments/counts` | The two numbers behind the sidebar badge: owed, and waiting on you |
| GET | `/api/assignments/:id` | **The mentor who set it** — every hand-in and its history |
| PATCH | `/api/assignments/:id` | **Mentor only** — edit the brief, move the deadline, add students |
| DELETE | `/api/assignments/:id` | **Mentor only** — withdraw, unless any work is accepted |
| GET | `/api/mentorships/:id/assignments` | One student's hand-ins, in one mentorship |
| PUT | `/api/submissions/:id` | **Student only** — save a draft, or hand it in |
| POST | `/api/submissions/:id/unsubmit` | **Student only** — take a hand-in back to edit it |
| PATCH | `/api/submissions/:id` | **The mentor who set it** — accept, or ask for changes |
| POST | `/api/submissions/:id/files` | **Student only** — attach a file (10 MB, 5 per hand-in); saves a draft |
| GET | `/api/submissions/:id/files/:fileId` | The student, or the mentor who set it — download, always as an attachment |
| DELETE | `/api/submissions/:id/files/:fileId` | **Student only** — remove a file, unless the work is handed in |

## Socket.IO events

**Client → server:** `user-online`, `send-message`, `typing`, `stop-typing`,
`mark-read`, `mark-group-read`, `join-group`, `leave-group`,
`send-group-message`, `group-typing`, `group-stop-typing`

**Server → client:** `online-users`, `user-status-change`, `user-added`,
`user-updated`, `new-message`, `message-sent`, `user-typing`,
`user-stop-typing`, `messages-read`, `new-group-message`, `group-user-typing`,
`group-user-stop-typing`, `new-announcement`, `announcement-deleted`,
`mentorship-updated`, `goal-updated`, `session-updated`, `conversation-read`,
`group-activity`, `group-read`, `group-receipt`, `resource-added`,
`resource-removed`, `feedback-updated`, `assignment-changed`, `work-notice`,
`error`

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
- **Suspension.** Checked once in `requireAuth` and the socket handshake, not
  per route, so there is no endpoint left open by omission. Suspending also
  disconnects any live socket immediately. Sign-in still succeeds, so the
  person can be shown why rather than failing blankly.
- **Verification.** The ✓ badge means an administrator reviewed the submitted
  evidence — nothing more, and it cannot be self-assigned. Only a *pending*
  request can be decided, so one admin cannot silently overturn another.

No service-account key is needed: verifying an ID token only requires Google's
public certificates. Set `FIREBASE_PROJECT_ID` and the server runs.

## A feature that is built but switched off

**Session ratings** — a `Feedback` model, three endpoints, a `Stars`
component and 27 tests — are complete and passing, but hidden. A five-star
score sits oddly in a two-person mentorship: the number adds little the
session notes do not already say, and rating the person helping you nudges
the relationship towards a marketplace.

The **server half is deliberately left switched on**. The endpoints stay
mounted and their tests keep running, because dead code that nothing
exercises rots — if the routes were commented out and the tests skipped,
turning this back on later would mean debugging three endpoints that had
drifted out of step with the models around them. Kept live and tested,
flipping `FEATURES.sessionRatings` in `src/lib/features.js` is the whole job.

---

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
- **Sessions do not leave the app.** There is no calendar export and no
  reminder before one starts — you find out a session is coming by opening
  Mentorship. Times are stored as UTC and rendered in each viewer's own
  timezone, so two people in different places see the same moment correctly,
  but neither gets told about it.

`docs/BUILD_NOTES.md` keeps a running log of every meaningful change — what was
built, which files moved, the design decisions and their tradeoffs.
