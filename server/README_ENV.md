Setup & run (PowerShell)
========================

`server/.env.example` is the authoritative list of settings — it documents
every variable and why it exists. This file is the short version: what to do,
in order, on Windows.

There is **no Firebase service account and no key file**. Verifying a Firebase
ID token only needs Google's public certificates, which the server fetches
itself, so there is nothing secret to download and no Firebase Console step
before it will run. If you find a `GOOGLE_APPLICATION_CREDENTIALS` anywhere,
it is left over from an earlier design and can be deleted.


1) Create your `.env`
---------------------

```powershell
cd server   # from the repository root
Copy-Item .env.example .env
notepad .env
```

Two values are required:

- **`MONGODB_URI`** — either a local install or Atlas.

  Local: `mongodb://127.0.0.1:27017/chatapp`

  Use `127.0.0.1`, not `localhost`. On Windows `localhost` resolves to IPv6
  (`::1`) first, while a default MongoDB install listens only on IPv4, so
  `localhost` fails with `ECONNREFUSED ::1:27017` even though MongoDB is
  running.

  Atlas: the connection string from your cluster, with the password filled in
  and a database name on the end —
  `mongodb+srv://USER:PASSWORD@cluster.mongodb.net/chatapp?retryWrites=true&w=majority`

- **`FIREBASE_PROJECT_ID`** — must match `projectId` in `src/firebase.js`.

  Not a secret; it already ships in the frontend bundle. The server needs it
  to check a token's `aud` and `iss`, which is what stops a token minted for
  somebody else's Firebase project being replayed against this one.

Optional:

- **`ADMIN_EMAILS`** — comma-separated addresses granted `admin` at sign-in.
  This is the only way to become an admin. Real addresses stay out of the
  repository folder: it goes in `server.env`, beside the file `AI_ENV_FILE`
  names. The server will not start without that file, though it may be empty.
- **`PORT`** — defaults to 3001.
- **`AI_SERVICE_URL`** and **`AI_SERVICE_SECRET`** — where the retrieval
  service (`ai/`) listens, and the secret it expects. Both or neither. With
  them set, the Copilot route can search, and every write the index cares
  about tells the service which record changed (`lib/indexSync.js`). With them
  unset the Copilot answers 503, nothing is sent, and the rest of the app is
  unaffected — which is how CI runs.
- **`AGENT_TOKEN_SECRET`** — signs the agent's per-turn capability tokens.
  Express only; never in `ai/.env`. At least 32 characters and different from
  `AI_SERVICE_SECRET`, or the server will not start. Unset, the agent's tool
  endpoint answers 503.


2) Start it
-----------

```powershell
npm install     # first time only
npm start
```


3) What a healthy start looks like
----------------------------------

```
🔒 Admin allowlist: 1 address(es)        (only if ADMIN_EMAILS is set)
✅ Connected to MongoDB

  🚀 Server running on http://localhost:3001
  📡 Socket.IO ready for connections
  💾 MongoDB: mongodb://127.0.0.1:27017/chatapp
```

Quick check from a second terminal — this should return `401`, which is the
correct answer to an unauthenticated request and proves the server is up and
enforcing auth:

```powershell
try { Invoke-RestMethod -Uri 'http://localhost:3001/api/announcements' }
catch { $_.Exception.Response.StatusCode }
```


4) The frontend
---------------

From the project root, in another terminal:

```powershell
npm install     # first time only
npm run dev     # http://localhost:5173
```

The frontend talks to `http://localhost:3001` unless `VITE_SERVER_URL` says
otherwise. Set that to point a build at a deployed backend, or to run a second
copy against a throwaway database without disturbing the one already running.


Running the tests
-----------------

```powershell
cd server
npm test
```

They need a MongoDB reachable at `127.0.0.1:27017`. The harness spawns a real
server against a **throwaway `chatapp_test` database** and drops it afterwards
— that address is hardcoded and ignores `MONGODB_URI` on purpose, so a test
run can never point `dropDatabase()` at your real data.


ALLOW_DEV_AUTH
--------------

Leave it unset. When set to exactly `true` (and `NODE_ENV` is not
`production`) the server accepts an `X-Dev-User-Id` header instead of a real
token, so an automated browser — which cannot complete a Google sign-in popup
— can drive the app.

**It turns authentication off for anyone who can reach the server.** The
server prints a loud warning at startup whenever it is on:

```
*** ALLOW_DEV_AUTH is on: an X-Dev-User-Id header can stand in for a real sign-in.
*** Never enable this on a deployed server.
```


Security notes
--------------

- Never commit `.env`. `server/.gitignore` covers it; check the repo-level
  `.gitignore` too.
- The Atlas connection string contains a password. Treat the whole string as
  the secret, not just the password field.
- `FIREBASE_PROJECT_ID` is *not* a secret and does not need protecting.
