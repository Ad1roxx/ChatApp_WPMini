/**
 * Test harness — starts a real server against a THROWAWAY database.
 *
 * Everything here exists to make one rule enforceable: **tests never touch
 * the development database.** Earlier verification runs were done by hand
 * against `chatapp`, which twice meant repairing real records afterwards and
 * once overwrote a real user's name and email. Pointing MONGODB_URI at
 * `chatapp_test` and dropping it between runs removes the possibility.
 *
 * The server is spawned as a child process rather than imported, so the tests
 * exercise the real startup path — config validation, the Mongo connection,
 * and the stale-presence reset — exactly as it runs in production.
 *
 * Authentication uses the ALLOW_DEV_AUTH escape hatch, because a Google
 * sign-in popup cannot be automated. That is the whole reason it exists.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const mongoose = require('mongoose');
const { io } = require('socket.io-client');

const PORT = Number(process.env.TEST_PORT || 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DB = 'mongodb://127.0.0.1:27017/chatapp_test';

// Fixed ids so tests can reference users without a lookup dance.
const USERS = {
  student: {
    _id: '0000000000000000000000a1',
    email: 'student@test.local',
    displayName: 'Test Student',
    role: 'student'
  },
  student2: {
    _id: '0000000000000000000000a2',
    email: 'student2@test.local',
    displayName: 'Second Student',
    role: 'student'
  },
  mentor: {
    _id: '0000000000000000000000a3',
    email: 'mentor@test.local',
    displayName: 'Test Mentor',
    role: 'mentor'
  },
  admin: {
    _id: '0000000000000000000000a4',
    email: 'admin@test.local',
    displayName: 'Test Admin',
    role: 'admin'
  }
};

let child = null;

/** Wait until the server answers, or give up. */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      // Any HTTP response means it is listening. This route 401s without a
      // token, which is itself a fine readiness signal.
      await fetch(`${BASE}/api/announcements`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  throw new Error(`server did not start on ${BASE} within ${timeoutMs}ms`);
}

/** Wipe the test database and insert the fixture users. */
async function seed() {
  await mongoose.connect(TEST_DB);
  const db = mongoose.connection.db;

  // Drop everything rather than deleting known ids — a test that creates a
  // stray document should not leak into the next run.
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));

  await db.collection('users').insertMany(
    Object.values(USERS).map((u) => ({
      _id: new mongoose.Types.ObjectId(u._id),
      firebaseUid: `test-uid-${u._id}`,
      email: u.email,
      displayName: u.displayName,
      photoURL: '',
      role: u.role,
      isOnline: false,
      bio: '',
      expertise: '',
      availability: '',
      createdAt: new Date()
    }))
  );
}

/** Start the server. Seeds first, so startup sees a known database. */
async function start({ seedFirst = true, extraEnv = {} } = {}) {
  if (seedFirst) await seed();

  child = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGODB_URI: TEST_DB,
      // Any non-empty value works: no test presents a real Google token, so
      // the audience check is never reached.
      FIREBASE_PROJECT_ID: 'test-project',
      ALLOW_DEV_AUTH: 'true',
      ADMIN_EMAILS: USERS.admin.email,
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  await waitForServer();
  return { log: () => log.join('') };
}

/** Stop the server and drop the test database. */
async function stop() {
  if (child) {
    child.kill();
    child = null;
  }

  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}

/**
 * Call the API as a given fixture user, or anonymously when `as` is null.
 * Mirrors the frontend's authFetch: a path, not a URL.
 */
function api(path, { as = null, method = 'GET', body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (as) h['X-Dev-User-Id'] = as._id;

  return fetch(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

/** Direct database access, for asserting on state the API does not expose. */
const db = () => mongoose.connection.db;

/**
 * Open a socket as a fixture user, or with whatever `auth` you pass — the
 * latter is how the handshake-rejection cases are exercised.
 *
 * Resolves with the socket on connect, rejects on refusal, so a test can
 * assert on either outcome with the same call.
 */
function connect(userOrAuth) {
  const auth =
    userOrAuth && userOrAuth._id ? { devUserId: userOrAuth._id } : userOrAuth || {};

  return new Promise((resolve, reject) => {
    const socket = io(BASE, { transports: ['websocket'], auth, reconnection: false });

    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

/**
 * Resolve with the first matching event, or null after `ms`.
 *
 * Returning null rather than throwing lets a test assert that something did
 * NOT arrive, which is most of what the presence checks are about.
 */
function once(socket, event, ms = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);

    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Let queued socket work settle before asserting on the database. */
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  BASE, PORT, TEST_DB, USERS,
  start, stop, seed, api, db, mongoose,
  connect, once, settle
};
