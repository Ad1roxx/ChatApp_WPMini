
# Project Feature Documentation

This document maps course outcomes / feature requirements to where and how they are implemented in this repository (MentorConnect).

Paths referenced are relative to the project root.

---

## 1. Basic React Web Page Design (JSX, Components and props) — CO1

- Files / folders:
  - `src/main.jsx`, `src/App.jsx`, `src/index.css`, `src/App.css`
  - Reusable components in `src/components/` (examples: `Avatar.jsx`, `Composer.jsx`, `MessageBubble.jsx`, `TopBar.jsx`, `Footer.jsx`, `RecordsList.jsx`)
  - Page-level components in `src/pages/` (examples: `ChatPage.jsx`, `ChatsListPage.jsx`, `EditProfilePage.jsx`, `LoginPage.jsx`, `RegisterPage.jsx`)

- Notes: Each component uses JSX and props to receive data (e.g., `Avatar` accepts `uid`/`label` props; `MessageBubble` accepts `mine` and `time` props). The `App.jsx` composes routes and top-level layout.

## 2. Demonstrate the use of React hooks (useState and useEffect) — CO1

- Examples in the repo:
  - `src/pages/EditProfilePage.jsx`: uses `useState` for form fields and `useEffect` to load user data from Firestore.
  - `src/pages/ChatPage.jsx`: `useState` for messages/typing state; `useEffect` to subscribe to server-sent events and to fetch initial messages/chat info.
  - `src/pages/ChatsListPage.jsx`: `useState` for recent chats and typing statuses; `useEffect` to connect to SSE for live chat updates.
  - `src/components/TopBar.jsx`: uses `useEffect` for auth state and snapshot listeners.

## 3. Form Handling using React — CO1

- Implementations:
  - `src/pages/EditProfilePage.jsx`: edit profile form (display name, bio) and file input for uploading records. Handles validation and submission via `handleSave`.
  - `src/pages/RegisterPage.jsx` and `src/pages/LoginPage.jsx`: form handling for authentication (email/password), with basic error handling and input state management.

## 4. Navigation and Form Validation — CO2

- Routing / navigation:
  - React Router v6 used: `src/main.jsx` registers routes; pages use `useNavigate` for programmatic navigation (examples: `EditProfilePage.jsx`, `ChatsListPage.jsx`, `TopBar.jsx`).

- Form validation:
  - Basic client-side validation is performed in registration/login flows and in `EditProfilePage.jsx` (required fields, network errors are surfaced to the user). For stricter validation, the project shows where to add checks before `setDoc` / `updateProfile` calls.

## 5. API integration — CO2

- Server-Sent Events (SSE):
  - Frontend listens to SSE endpoints for real-time updates:
    - `src/pages/ChatPage.jsx` connects to `GET /api/chats/:chatId/messages/live` for live chat messages and typing/activity events.
    - `src/pages/ChatsListPage.jsx` connects to `GET /api/chats/live` for new chats and typing/activity.

- REST calls:
  - Client-side `fetch` calls to server endpoints for actions such as typing/activity updates, marking messages read, and posting announcements (examples in `ChatPage.jsx`).

## 6. Demonstrate use of Node.js (server) — CO2

- Server app located in `server/index.js`.
  - Implements an Express application, CORS setup, SSE endpoints, and endpoints for typing/activity/announcements.
  - Uses `firebase-admin` (optional, initialized when service account is provided via environment variable). Also integrates with optional MongoDB (mongoose) for announcements.

## 7. Routing using Express.js — CO2

- Routes implemented in `server/index.js` include:
  - `GET /api/announcements`, `GET /api/announcements/live`, `POST /api/announcements` (mentor-only)
  - `GET /api/chats/live`, `GET /api/chats/:chatId/messages/live` (SSE)
  - `POST /api/activity/update`, `POST /api/typing/update`, `POST /api/chats/:chatId/markAsRead` (behavioral endpoints)

## 8. Database Integration — CO3

- Firebase (Firestore):
  - `src/firebase.js` initializes Firebase SDK and exports `db`, `auth`, `storage` (storage export added). Firestore is used across page components via modular SDK calls (`getDoc`, `getDocs`, `addDoc`, `setDoc`, `updateDoc`, `query`, `orderBy`).
  - Example reads/writes: `chats/*` collections (messages), `users/{uid}` documents (profile, records metadata), `announcements` (server may use Mongo or Firestore depending on configuration).

- Optional: MongoDB (mongoose) is supported by the server for announcements when `MONGODB_URI` is provided (check `server/index.js`).

## 9. Integrating React with Node.js using REST API

- Integration points:
  - Frontend `fetch` calls to Express REST endpoints for typing/activity and announcement operations (`ChatPage.jsx`, `ChatsListPage.jsx`).
  - SSE endpoints implemented by the Node server are consumed by the frontend to drive real-time UI updates.

## 10. Onscreen test / online course certification

- The current project does not include a built-in online certification/test subsystem. Recommended next steps if you want to add this feature:
  - Create a `tests` or `courses` sub-system in Firestore where tests/quizzes are stored and results are recorded.
  - Create frontend pages to take tests and a serverless function or server endpoint to grade/issue certificates (PDFs) and flag completion.
  - Use the existing authentication and role model to gate mentor-only certification issuance.

## Other Firebase features used

- Authentication: `src/firebase.js` exports `auth` and client pages use Firebase Auth to sign in/up (`RegisterPage.jsx`, `LoginPage.jsx`).
- Firestore: used for chats, messages, users, and announcements.
- Storage: SDK export added; client upload flow scaffolding exists in `EditProfilePage.jsx` but Firebase Storage requires enabling & CORS/rules in the console to work. A server-side fallback (uploads via Express) is available as an alternative.
- Offline persistence: `enableIndexedDbPersistence` is configured in `src/firebase.js`.
- Admin SDK: `server/index.js` can initialize `firebase-admin` when `GOOGLE_APPLICATION_CREDENTIALS` env var is provided; admin SDK is used to verify tokens and read Firestore on the server.

## Where records/achievements were implemented (summary)
- UI: `src/pages/EditProfilePage.jsx` (file input & uploaded records list) and `src/components/RecordsList.jsx`.
- Viewing: `src/pages/ChatPage.jsx` — click the peer name to open a modal showing that user's records (reads `users/{uid}` document and shows `records`).
- Storage & metadata: client code uploads to Firebase Storage path `users/{uid}/records/{fileId}_{name}` and writes metadata into the user doc (`records` array). Note: this requires Firebase Storage to be enabled and properly configured (CORS & rules). A server-based upload alternative is suggested in the README.

## How to run the project locally

1. Install frontend deps and start dev server:
   - `npm install`
   - `npm run dev` (runs Vite dev server, default at http://localhost:5173)

2. Start the server (optional, for SSE and REST endpoints):
   - `cd server`
   - `npm install` (installs server deps)
   - `node index.js` (server listens on port 3001 by default)

3. Environment notes:
   - `src/firebase.js` contains Firebase config. Ensure the project in the Firebase Console matches these credentials.
   - To enable admin features on the server provide `GOOGLE_APPLICATION_CREDENTIALS` env var pointing to a service account JSON.

## Next steps / recommendations
- If you plan to enable uploads in production, configure Firebase Storage in the Console and set CORS + security rules as described in code comments and earlier notes.
- For production-grade file handling, prefer storing records metadata in a subcollection `users/{uid}/records/{recordId}` (more robust than arrays) and keep blobs in object storage (Firebase Storage / S3).
- Consider adding deletion and moderation workflows (Cloud Functions or server-side scanning) before exposing download URLs.

---

If you want, I can turn this into a `docs/FEATURES.md` with screenshots and code snippets for teachers or reviewers. Tell me if you want more detail on any CO item.
