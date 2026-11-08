/**
 * The agent route's guards that need a server of their own: the COPILOT_AGENT
 * setting, and the rule that the agent runs on synthetic databases only (the
 * user, 2026-11-07; BUILD_NOTES Entry 101).
 *
 * `chatapp` itself is never connected to: tests never touch it. The refusal for
 * that name is shown on the check itself (agent-budget.test.js) and, here, on a
 * real server connected to a throwaway database that is not on the list, which
 * goes down the same path. That database is made, seeded with the fixture
 * users, and dropped by this file.
 *
 * The S2 ask route is refused on the same list (BUILD_NOTES Entry 105), and keeps
 * working when only the agent is switched off.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const harness = require('./helpers/harness');

const { USERS, start, stop, api, mongoose } = harness;
const AI_SECRET = 'stub-secret';
const AGENT_SECRET = 'agent-token-secret-for-tests-only-0123456789';
const UNLISTED = 'mongodb://127.0.0.1:27017/chatapp_agent_unlisted_test';
const NOT_CONFIGURED = { error: 'The agent is not configured on this server.' };

let received = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    received.push({ path: req.url });
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ status: 'answered', answer: 'Five [1].', citations: [], modelCalls: 1 }));
  });
});

const env = (extra) => ({
  AI_SERVICE_URL: `http://127.0.0.1:${stub.address().port}`,
  AI_SERVICE_SECRET: AI_SECRET,
  AGENT_TOKEN_SECRET: AGENT_SECRET,
  COPILOT_ASKS_PER_MINUTE: '1000',
  ...extra
});

/** The fixture users, in a database the harness does not manage. */
async function seedUnlisted() {
  const conn = await mongoose.createConnection(UNLISTED).asPromise();
  await conn.dropDatabase();
  await conn.collection('users').insertMany(
    Object.values(USERS).map((u) => ({
      _id: new mongoose.Types.ObjectId(u._id),
      firebaseUid: `test-uid-${u._id}`,
      email: u.email,
      displayName: u.displayName,
      photoURL: '',
      role: u.role,
      isOnline: false,
      createdAt: new Date()
    }))
  );
  return conn;
}

async function mentorship() {
  const res = await api('/api/mentorships', {
    as: USERS.mentor,
    method: 'POST',
    body: { studentId: USERS.student._id, topic: 'Backend interviews' }
  });
  return (await res.json())._id;
}

const agent = (id) =>
  api(`/api/mentorships/${id}/copilot/agent`, { as: USERS.student, method: 'POST', body: { question: 'What is left?' } });
const ask = (id) =>
  api(`/api/mentorships/${id}/copilot/ask`, { as: USERS.student, method: 'POST', body: { question: 'What is left?' } });
const mode = async () => (await api('/api/copilot/mode', { as: USERS.student })).json();

test.before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
});

test.after(async () => {
  stub.closeAllConnections();
  await new Promise((r) => stub.close(r));
});

test.beforeEach(() => {
  received = [];
});

test('with COPILOT_AGENT off, the agent is not configured, and asking works as before', async () => {
  await start({ extraEnv: env({ COPILOT_AGENT: '' }) });
  try {
    const id = await mentorship();
    const res = await agent(id);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), NOT_CONFIGURED);
    assert.deepEqual(await mode(), { mode: 'ask' });
    assert.equal((await ask(id)).status, 200);
    assert.deepEqual(received.map((r) => r.path), ['/ask']);
  } finally {
    await stop();
  }
});

test('with no capability-token secret, the agent is not configured', async () => {
  await start({ extraEnv: env({ COPILOT_AGENT: '1', AGENT_TOKEN_SECRET: '' }) });
  try {
    const res = await agent(await mentorship());
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), NOT_CONFIGURED);
    assert.deepEqual(received, []);
  } finally {
    await stop();
  }
});

test('on a database that is not on the list, the agent is not configured, even switched on', async () => {
  const conn = await seedUnlisted();
  await start({ seedFirst: false, extraEnv: env({ COPILOT_AGENT: '1', MONGODB_URI: UNLISTED }) });
  try {
    const id = await mentorship();
    assert.ok(id, 'the server is up on the unlisted database');
    const res = await agent(id);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), NOT_CONFIGURED, 'the same sentence: which database is not said');
    assert.deepEqual(await mode(), { mode: 'ask' });

    // The S2 ask route is refused on the same list, and nothing reaches the service.
    const asked = await ask(id);
    assert.equal(asked.status, 503);
    assert.deepEqual(await asked.json(), { error: 'The Copilot is not configured on this server' });
    assert.deepEqual(received, [], 'nothing reached the AI service');
  } finally {
    await stop();
    await conn.dropDatabase();
    await conn.close();
  }
});

test('on the tests\' own database, switched on, the agent runs', async () => {
  await start({ extraEnv: env({ COPILOT_AGENT: '1' }) });
  try {
    assert.deepEqual(await mode(), { mode: 'agent' });
    const res = await agent(await mentorship());
    assert.equal(res.status, 200);
    assert.deepEqual(received.map((r) => r.path), ['/agent']);
  } finally {
    await stop();
  }
});
