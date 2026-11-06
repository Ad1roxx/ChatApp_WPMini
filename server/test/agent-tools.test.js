/**
 * POST /internal/agent/tools/:name — who may run an agent tool, as whom.
 *
 * The property (AGENT_PLAN §4.3, S4 Step 0): the shared secret alone does not
 * let the AI service act as anybody. A tool runs only for the user, the
 * mentorship and the role a valid capability token names, and only while the
 * database still agrees with all three.
 *
 * A call that passes every check is answered 200 with `records`, here from
 * `list_goals`; every refusal is a different status, asserted below. What the
 * tools return is tested in agent-read-tools.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const jwt = require('jsonwebtoken');
const { USERS, start, stop, api, db, mongoose } = require('./helpers/harness');

const PORT = Number(process.env.TEST_PORT || 3199);
const { mintAgentToken, AUDIENCE, ISSUER } = require('../lib/agentToken');

const AI_SECRET = 'stub-secret';
const AGENT_SECRET = crypto.randomBytes(24).toString('hex');

let mine; // mentor -> student
let theirs; // admin -> student2

test.before(async () => {
  await start({
    extraEnv: { AI_SERVICE_SECRET: AI_SECRET, AGENT_TOKEN_SECRET: AGENT_SECRET, AI_SERVICE_URL: '' }
  });
  const add = (as, studentId, topic) =>
    api('/api/mentorships', { as, method: 'POST', body: { studentId, topic } }).then((r) => r.json());
  mine = await add(USERS.mentor, USERS.student._id, 'Backend interviews');
  theirs = await add(USERS.admin, USERS.student2._id, 'Something else');
});

test.after(() => stop());

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const setMentorship = (id, fields) => db().collection('mentorships').updateOne({ _id: oid(id) }, { $set: fields });
const setUser = (id, fields) => db().collection('users').updateOne({ _id: oid(id) }, { $set: fields });

const tokenFor = (user, mentorship, role, turnMs = 30000) =>
  mintAgentToken(AGENT_SECRET, { userId: user._id, mentorshipId: mentorship._id, role, turnMs }).token;

function call(token, { name = 'list_goals', secret = AI_SECRET, headers = {}, body = { args: {} } } = {}) {
  const h = { ...headers };
  if (secret !== null) h['X-AI-Secret'] = secret;
  if (token !== null) h.Authorization = `Bearer ${token}`;
  return api(`/internal/agent/tools/${name}`, { method: 'POST', body, headers: h });
}

async function expect(res, status, pattern) {
  assert.equal(res.status, status);
  const body = await res.json();
  if (status === 200) {
    assert.ok(Array.isArray(body.records));
    return body;
  }
  assert.equal(typeof body.error, 'string');
  if (pattern) assert.match(body.error, pattern);
  return body;
}

const PASSED = [200];

// ---------------------------------------------------------------------------
// A call that should get through
// ---------------------------------------------------------------------------
test('the asker, in their own mentorship, in their own role, gets through', async (t) => {
  await t.test('as the student', async () => {
    await expect(await call(tokenFor(USERS.student, mine, 'student')), ...PASSED);
  });
  await t.test('as the mentor', async () => {
    await expect(await call(tokenFor(USERS.mentor, mine, 'mentor')), ...PASSED);
  });
  await t.test('an admin only as the mentor of their own mentorship', async () => {
    await expect(await call(tokenFor(USERS.admin, theirs, 'mentor')), ...PASSED);
  });
});

// ---------------------------------------------------------------------------
// The secret, and where the call comes from
// ---------------------------------------------------------------------------
test('without the shared secret nothing gets through, even with a good token', async (t) => {
  const token = tokenFor(USERS.student, mine, 'student');
  await t.test('no secret', async () => expect(await call(token, { secret: null }), 401));
  await t.test('the wrong secret', async () => expect(await call(token, { secret: 'stub-secre' }), 401));
});

test('from another address it is refused, with the secret and a good token', async (t) => {
  // This machine's own LAN address: the server sees a peer that is not loopback.
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) return t.skip('no non-loopback address on this machine');
  const res = await fetch(`http://${lan.address}:${PORT}/internal/agent/tools/list_goals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AI-Secret': AI_SECRET,
      Authorization: `Bearer ${tokenFor(USERS.student, mine, 'student')}`
    },
    body: JSON.stringify({ args: {} })
  });
  await expect(res, 403, /Not available from here/);
});

test('a browser cannot use it, even from this machine', async () => {
  const res = await call(tokenFor(USERS.student, mine, 'student'), {
    headers: { Origin: 'http://localhost:5173' }
  });
  await expect(res, 403);
});

test('a user\'s own sign-in does not open it', async () => {
  const res = await api('/internal/agent/tools/list_goals', {
    as: USERS.student,
    method: 'POST',
    body: { args: {} },
    headers: { 'X-AI-Secret': AI_SECRET }
  });
  await expect(res, 401);
});

// ---------------------------------------------------------------------------
// The token: the secret alone must not let the service act as anyone
// ---------------------------------------------------------------------------
test('with the secret but no valid token, nothing gets through', async (t) => {
  const forge = (key, payload = {}, options = {}) =>
    jwt.sign({ mid: String(mine._id), role: 'student', ...payload }, key, {
      algorithm: 'HS256',
      subject: USERS.student._id,
      jwtid: crypto.randomBytes(16).toString('hex'),
      audience: AUDIENCE,
      issuer: ISSUER,
      expiresIn: 30,
      ...options
    });

  await t.test('no token', async () => expect(await call(null), 401));
  await t.test('not a token', async () => expect(await call('not-a-token'), 401));
  await t.test('a token the AI service could make: signed with the shared secret', async () => {
    await expect(await call(forge(AI_SECRET)), 401);
  });
  await t.test('an expired token', async () => {
    await expect(await call(forge(AGENT_SECRET, {}, { expiresIn: -1 })), 401, /run out of time/);
  });
  await t.test('a token for another audience', async () => {
    await expect(await call(forge(AGENT_SECRET, {}, { audience: 'elsewhere' })), 401);
  });
  await t.test('identity in the body changes nothing', async () => {
    // A student's token, with the body naming the mentor and another mentorship.
    const res = await call(tokenFor(USERS.student, mine, 'student'), {
      name: 'list_goals',
      body: { args: {}, userId: USERS.mentor._id, mentorshipId: String(theirs._id), role: 'mentor' }
    });
    await expect(res, ...PASSED);
  });
});

test('a token is checked against the record, not taken on trust', async (t) => {
  await t.test('for a mentorship the user is not in: the same 403 the API gives', async () => {
    await expect(await call(tokenFor(USERS.student, theirs, 'student')), 403, /not your mentorship/);
  });
  await t.test('for a mentorship that does not exist', async () => {
    await expect(await call(tokenFor(USERS.student, { _id: '0000000000000000000000ff' }, 'student')), 404);
  });
  await t.test('claiming the mentor role, signed by the right key, for the student', async () => {
    await expect(await call(tokenFor(USERS.student, mine, 'mentor')), 403, /role/);
  });
  await t.test('claiming the student role for the mentor', async () => {
    await expect(await call(tokenFor(USERS.mentor, mine, 'student')), 403, /role/);
  });
  await t.test('for a user who no longer exists', async () => {
    await expect(await call(tokenFor({ _id: '0000000000000000000000ee' }, mine, 'student')), 403);
  });
});

// ---------------------------------------------------------------------------
// Things that change during a turn
// ---------------------------------------------------------------------------
test('a user suspended mid-turn is refused at the next tool call', async () => {
  const token = tokenFor(USERS.student, mine, 'student');
  await expect(await call(token), ...PASSED);
  await setUser(USERS.student._id, { suspended: true });
  try {
    await expect(await call(token), 403, /suspended/);
  } finally {
    await setUser(USERS.student._id, { suspended: false });
  }
});

test('a mentorship that ends mid-turn is refused at the next tool call', async () => {
  const token = tokenFor(USERS.mentor, mine, 'mentor');
  await expect(await call(token), ...PASSED);
  await setMentorship(mine._id, { status: 'ended' });
  try {
    await expect(await call(token), 409, /ended mentorships/);
  } finally {
    await setMentorship(mine._id, { status: 'active' });
  }
});

// ---------------------------------------------------------------------------
// The per-turn cap
// ---------------------------------------------------------------------------
test('one token makes at most three tool calls', async (t) => {
  const token = tokenFor(USERS.student, mine, 'student');
  for (let i = 1; i <= 3; i += 1) {
    await expect(await call(token), ...PASSED);
  }
  await t.test('the fourth is refused in a plain sentence', async () => {
    await expect(await call(token), 429, /at most 3 times for one question/);
  });
  await t.test('another turn has its own count', async () => {
    await expect(await call(tokenFor(USERS.student, mine, 'student')), ...PASSED);
  });
  await t.test('a refused call is not counted', async () => {
    const fresh = tokenFor(USERS.mentor, mine, 'mentor');
    for (let i = 0; i < 5; i += 1) await expect(await call(fresh, { secret: 'wrong' }), 401);
    await expect(await call(fresh), ...PASSED);
  });
});

test('a tool name that is not a tool reaches nothing', async (t) => {
  for (const name of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) {
    const token = tokenFor(USERS.student, mine, 'student');
    await t.test(name, async () => expect(await call(token, { name }), 404, /No such tool/));
  }
});

test('a refusal of the turn says it ends the turn; a refused lookup does not', async (t) => {
  const ends = async (res, status) => {
    assert.equal(res.status, status);
    assert.equal((await res.json()).endsTurn, true);
  };
  await t.test('no token', async () => ends(await call(null), 401));
  await t.test('the wrong secret', async () => ends(await call(tokenFor(USERS.student, mine, 'student'), { secret: 'x' }), 401));
  await t.test('not your mentorship', async () => ends(await call(tokenFor(USERS.student, theirs, 'student')), 403));
  await t.test('a role the record does not support', async () => ends(await call(tokenFor(USERS.student, mine, 'mentor')), 403));
  await t.test('over the cap', async () => {
    const token = tokenFor(USERS.student, mine, 'student');
    for (let i = 0; i < 3; i += 1) await call(token);
    await ends(await call(token), 429);
  });
  await t.test('no such tool: the model is told, the turn goes on', async () => {
    const res = await call(tokenFor(USERS.student, mine, 'student'), { name: 'read_everything' });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).endsTurn, undefined);
  });
  await t.test('arguments that are not the shape: the same', async () => {
    const res = await call(tokenFor(USERS.student, mine, 'student'), { body: { args: { mentorshipId: String(theirs._id) } } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).endsTurn, undefined);
  });
});
