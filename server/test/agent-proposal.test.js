/**
 * The signed write proposal and its single use (S5 Step 1).
 *
 * The real Express server, on the tests' own database, verifying with the key these
 * tests sign with. A tampered token here is a real token with its payload changed
 * and its signature left alone, which is what anyone without the key can produce.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { USERS, start, stop, api, db, mongoose } = require('./helpers/harness');
const proposals = require('../lib/agentProposal');
const agentToken = require('../lib/agentToken');
const { WRITE_TOOLS, writeTool } = require('../lib/agentWrites');

const SECRET = 'agent-proposal-secret-for-tests-only-012345';
const CAPABILITY_SECRET = 'agent-token-secret-for-tests-only-0123456789';
const AI_SECRET = 'stub-secret';

let mine; // mentor -> student
let theirs; // admin -> student2

test.before(async () => {
  await start({
    extraEnv: {
      // Never called in this file: the agent needs it set to count as configured.
      AI_SERVICE_URL: 'http://127.0.0.1:9',
      AI_SERVICE_SECRET: AI_SECRET,
      AGENT_TOKEN_SECRET: CAPABILITY_SECRET,
      AGENT_PROPOSAL_SECRET: SECRET,
      COPILOT_AGENT: '1'
    }
  });
  const add = (as, studentId, topic) =>
    api('/api/mentorships', { as, method: 'POST', body: { studentId, topic } }).then((r) => r.json());
  mine = await add(USERS.mentor, USERS.student._id, 'Backend interviews');
  theirs = await add(USERS.admin, USERS.student2._id, 'Something else');
});

test.after(() => stop());

const collection = () => db().collection('agentproposals');
const statusOf = async (pid) => (await collection().findOne({ _id: pid }))?.status;

const ARGS = { mentorshipId: '0'.repeat(23) + '1', title: 'A link', url: 'https://example.test/a', note: '' };
const FIELDS = [
  { label: 'Title', value: 'A link', arg: 'title' },
  { label: 'Link', value: 'https://example.test/a', arg: 'url' },
  { label: 'Note', value: '', arg: 'note' }
];

/** A proposal as Express issues one: a signed token and its pending record. */
async function issue({ as = USERS.student, mentorship = mine, role = 'student', tool = 'add_resource', ttlSeconds, record = true, secret = SECRET } = {}) {
  const pid = proposals.newProposalId();
  const { token, exp } = proposals.signProposal(secret, {
    pid, tool, args: ARGS, heading: 'Pin a link', fields: FIELDS, asked: 'Pin that article',
    userId: as._id, mentorshipId: mentorship._id, role, ttlSeconds
  });
  if (record) {
    await collection().insertOne({
      _id: pid,
      user: new mongoose.Types.ObjectId(as._id),
      mentorship: new mongoose.Types.ObjectId(mentorship._id),
      tool,
      status: 'pending',
      expiresAt: new Date((exp + 60) * 1000),
      createdAt: new Date()
    });
  }
  return { pid, token };
}

const claim = (as, proposal) => api('/api/copilot/proposals/claim', { as, method: 'POST', body: { proposal } });
const close = (as, proposal, decision) =>
  api('/api/copilot/proposals/close', { as, method: 'POST', body: { proposal, decision } });

/** The token with its payload changed and the original signature kept. */
function tamper(token, change) {
  const [head, body, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  change(payload);
  return `${head}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
}

test('the key must be long, and differ from both of the others', () => {
  const good = 'x'.repeat(40);
  assert.equal(proposals.secretProblem(good, 'a'.repeat(40), 'b'.repeat(40)), null);
  assert.match(proposals.secretProblem('', 'a', 'b'), /not set/);
  assert.match(proposals.secretProblem('short', 'a', 'b'), /at least/);
  assert.match(proposals.secretProblem(good, good, 'b'), /AI_SERVICE_SECRET/);
  assert.match(proposals.secretProblem(good, 'a', good), /AGENT_TOKEN_SECRET/);
});

test('a signature covers every part of the proposal', async (t) => {
  const changes = {
    'an argument': (p) => { p.args.url = 'https://evil.test/'; },
    'an added argument': (p) => { p.args.extra = 1; },
    'the tool': (p) => { p.tool = 'create_assignment'; },
    'the user': (p) => { p.sub = USERS.student2._id; },
    'the mentorship': (p) => { p.mid = theirs._id; },
    'the role': (p) => { p.role = 'mentor'; },
    'the expiry': (p) => { p.exp += 3600; },
    'a field shown in the dialog': (p) => { p.fields[0].value = 'Something harmless'; },
    'the heading': (p) => { p.heading = 'Harmless'; },
    'what was asked': (p) => { p.asked = 'Do it'; },
    'the id': (p) => { p.jti = 'f'.repeat(32); }
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(`changing ${name} is refused, and it stays unused`, async () => {
      const { pid, token } = await issue();
      const res = await claim(USERS.student, tamper(token, change));
      assert.equal(res.status, 410);
      assert.equal(await statusOf(pid), 'pending');
      // And the untouched token still works, so the refusal was about the change.
      assert.equal((await claim(USERS.student, token)).status, 200);
    });
  }
});

test('only a proposal signed with this key, for this purpose, is accepted', async (t) => {
  await t.test('another key', async () => {
    const { pid, token } = await issue({ secret: 'some-other-secret-that-is-long-enough-0123' });
    assert.equal((await claim(USERS.student, token)).status, 410);
    assert.equal(await statusOf(pid), 'pending');
  });

  await t.test('the capability key', async () => {
    const { token } = await issue({ secret: CAPABILITY_SECRET });
    assert.equal((await claim(USERS.student, token)).status, 410);
  });

  await t.test('a capability token, even signed with the proposal key', async () => {
    const { token } = agentToken.mintAgentToken(SECRET, {
      userId: USERS.student._id, mentorshipId: mine._id, role: 'student', turnMs: 1000
    });
    assert.equal((await claim(USERS.student, token)).status, 410);
  });

  await t.test('a well-formed proposal for another audience', async () => {
    const pid = proposals.newProposalId();
    const token = jwt.sign(
      { mid: mine._id, role: 'student', tool: 'add_resource', args: ARGS, heading: 'x', fields: FIELDS, asked: 'x' },
      SECRET,
      { algorithm: 'HS256', subject: USERS.student._id, jwtid: pid, audience: agentToken.AUDIENCE, issuer: proposals.ISSUER, expiresIn: 60 }
    );
    assert.equal((await claim(USERS.student, token)).status, 410);
  });

  await t.test('alg none', async () => {
    const { token } = await issue();
    const [, body] = token.split('.');
    const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    assert.equal((await claim(USERS.student, `${head}.${body}.`)).status, 410);
  });

  await t.test('another algorithm', async () => {
    const { token } = await issue();
    const payload = jwt.decode(token);
    assert.equal((await claim(USERS.student, jwt.sign(payload, SECRET, { algorithm: 'HS512' }))).status, 410);
  });

  await t.test('nothing at all, or something that is not a string', async () => {
    assert.equal((await claim(USERS.student, undefined)).status, 410);
    assert.equal((await claim(USERS.student, { token: 'x' })).status, 410);
  });
});

test('an expired proposal cannot be claimed', async () => {
  const pid = proposals.newProposalId();
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { mid: mine._id, role: 'student', tool: 'add_resource', args: ARGS, heading: 'Pin a link', fields: FIELDS, asked: 'x', iat: now - 400, exp: now - 100 },
    SECRET,
    { algorithm: 'HS256', subject: USERS.student._id, jwtid: pid, audience: proposals.AUDIENCE, issuer: proposals.ISSUER }
  );
  await collection().insertOne({
    _id: pid, user: new mongoose.Types.ObjectId(USERS.student._id), mentorship: new mongoose.Types.ObjectId(mine._id),
    tool: 'add_resource', status: 'pending', expiresAt: new Date(Date.now() + 60000), createdAt: new Date()
  });
  assert.equal((await claim(USERS.student, token)).status, 410);
  assert.equal(await statusOf(pid), 'pending');
});

test('a proposal cannot be signed to live longer than five minutes', () => {
  const { exp } = proposals.signProposal(SECRET, {
    pid: proposals.newProposalId(), tool: 'add_resource', args: ARGS, heading: 'x', fields: FIELDS, asked: 'x',
    userId: USERS.student._id, mentorshipId: mine._id, role: 'student', ttlSeconds: 100000
  });
  assert.ok(exp - Date.now() / 1000 <= proposals.PROPOSAL_TTL_S + 1);
});

test('a token that claims a long life is refused, even correctly signed', async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { mid: mine._id, role: 'student', tool: 'add_resource', args: ARGS, heading: 'x', fields: FIELDS, asked: 'x', iat: now, exp: now + 86400 },
    SECRET,
    { algorithm: 'HS256', subject: USERS.student._id, jwtid: proposals.newProposalId(), audience: proposals.AUDIENCE, issuer: proposals.ISSUER }
  );
  assert.throws(() => proposals.verifyProposal(SECRET, token), /lives too long/);
});

test('a proposal is single use', async (t) => {
  await t.test('the second claim is refused', async () => {
    const { pid, token } = await issue();
    assert.equal((await claim(USERS.student, token)).status, 200);
    assert.equal(await statusOf(pid), 'claimed');
    const again = await claim(USERS.student, token);
    assert.equal(again.status, 409);
    assert.equal((await again.json()).reason, 'used');
  });

  await t.test('of many at once, exactly one wins', async () => {
    const { token } = await issue();
    const all = await Promise.all(Array.from({ length: 8 }, () => claim(USERS.student, token)));
    assert.deepEqual(all.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409]);
  });

  await t.test('one with no record cannot be claimed', async () => {
    const { token } = await issue({ record: false });
    assert.equal((await claim(USERS.student, token)).status, 409);
  });

  await t.test('one whose record has run out cannot be claimed', async () => {
    const { pid, token } = await issue();
    await collection().updateOne({ _id: pid }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await claim(USERS.student, token)).status, 409);
    assert.equal(await statusOf(pid), 'pending');
  });

  await t.test('a record for a different tool does not match', async () => {
    const { pid, token } = await issue();
    await collection().updateOne({ _id: pid }, { $set: { tool: 'set_goal' } });
    assert.equal((await claim(USERS.student, token)).status, 409);
    assert.equal(await statusOf(pid), 'pending');
  });
});

test('the record must be for the same person and mentorship as the token', async (t) => {
  await t.test('another mentorship in the record does not match', async () => {
    const { pid, token } = await issue();
    await collection().updateOne({ _id: pid }, { $set: { mentorship: new mongoose.Types.ObjectId(theirs._id) } });
    assert.equal((await claim(USERS.student, token)).status, 409);
    assert.equal(await statusOf(pid), 'pending');
  });

  await t.test('another person in the record does not match', async () => {
    const { pid, token } = await issue();
    await collection().updateOne({ _id: pid }, { $set: { user: new mongoose.Types.ObjectId(USERS.student2._id) } });
    assert.equal((await claim(USERS.student, token)).status, 409);
    assert.equal(await statusOf(pid), 'pending');
  });
});

test('a proposal is only its own person\'s, in their own place', async (t) => {
  await t.test('someone else presenting it is refused, and it stays unused', async () => {
    const { pid, token } = await issue();
    assert.equal((await claim(USERS.student2, token)).status, 403);
    // The other party is in this mentorship, so only the check on whose it is can answer this.
    const other = await claim(USERS.mentor, token);
    assert.equal(other.status, 403);
    assert.match((await other.json()).error, /not yours/);
    assert.equal(await statusOf(pid), 'pending');
  });

  await t.test('signed for a mentorship they are not in', async () => {
    const { pid, token } = await issue({ as: USERS.student, mentorship: theirs });
    assert.equal((await claim(USERS.student, token)).status, 403);
    assert.equal(await statusOf(pid), 'pending');
  });

  await t.test('signed with a role they do not hold there', async () => {
    const { pid, token } = await issue({ as: USERS.student, role: 'mentor', tool: 'create_assignment' });
    assert.equal((await claim(USERS.student, token)).status, 403);
    assert.equal(await statusOf(pid), 'pending');
  });

  await t.test('a tool both roles have, signed with the wrong role', async () => {
    const { pid, token } = await issue({ as: USERS.student, role: 'mentor', tool: 'add_resource' });
    const res = await claim(USERS.student, token);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /place in this mentorship/);
    assert.equal(await statusOf(pid), 'pending');
  });

  await t.test('a mentor-only tool, signed for a student', async () => {
    const { pid, token } = await issue({ as: USERS.student, role: 'student', tool: 'set_goal' });
    assert.equal((await claim(USERS.student, token)).status, 403);
    assert.equal(await statusOf(pid), 'pending');
  });

  await t.test('without signing in', async () => {
    const { token } = await issue();
    assert.equal((await claim(null, token)).status, 401);
  });
});

test('a mentorship that is not active cannot be claimed against', async () => {
  const { pid, token } = await issue();
  const id = new mongoose.Types.ObjectId(mine._id);
  await db().collection('mentorships').updateOne({ _id: id }, { $set: { status: 'ended' } });
  try {
    const res = await claim(USERS.student, token);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, 'ended');
    assert.equal(await statusOf(pid), 'pending');
  } finally {
    await db().collection('mentorships').updateOne({ _id: id }, { $set: { status: 'active' } });
  }
});

test('only the listed tools exist, and §4.4 is not among them', async (t) => {
  const NEVER = [
    'submit_assignment', 'edit_submission', 'accept_submission', 'request_changes', 'review_submission', 'delete_resource',
    'withdraw_assignment', 'unsubmit', 'request_optout', 'answer_optout', 'post_announcement', 'create_group',
    'add_student', 'set_role', 'suspend_user'
  ];

  await t.test('the registry is exactly the seven', () => {
    assert.deepEqual(Object.keys(WRITE_TOOLS).sort(), [
      'add_resource', 'confirm_session', 'create_assignment', 'extend_assignment_deadline', 'propose_session', 'set_goal', 'toggle_milestone'
    ]);
  });

  for (const name of [...NEVER, 'constructor', '__proto__', 'hasOwnProperty']) {
    await t.test(`${name}, even correctly signed, cannot be claimed`, async () => {
      assert.equal(writeTool(name), null);
      const { pid, token } = await issue({ tool: name });
      assert.equal((await claim(USERS.student, token)).status, 403);
      assert.equal(await statusOf(pid), 'pending');
    });
  }
});

test('closing', async (t) => {
  await t.test('dismissing closes one still pending, and then it cannot be claimed', async () => {
    const { pid, token } = await issue();
    assert.equal((await close(USERS.student, token, 'dismissed')).status, 200);
    assert.equal(await statusOf(pid), 'closed');
    assert.equal((await claim(USERS.student, token)).status, 409);
  });

  await t.test('a claimed one closes as approved, once', async () => {
    const { pid, token } = await issue();
    await claim(USERS.student, token);
    assert.equal((await close(USERS.student, token, 'approved')).status, 200);
    assert.equal(await statusOf(pid), 'closed');
    assert.equal((await close(USERS.student, token, 'approved')).status, 409);
  });

  await t.test('"approved" cannot close one nobody claimed', async () => {
    const { pid, token } = await issue();
    assert.equal((await close(USERS.student, token, 'approved')).status, 409);
    assert.equal(await statusOf(pid), 'pending');
  });

  await t.test('"dismissed" cannot close one that was claimed', async () => {
    const { pid, token } = await issue();
    await claim(USERS.student, token);
    assert.equal((await close(USERS.student, token, 'dismissed')).status, 409);
    assert.equal(await statusOf(pid), 'claimed');
  });

  await t.test('someone else cannot close it', async () => {
    const { pid, token } = await issue();
    assert.equal((await close(USERS.student2, token, 'dismissed')).status, 403);
    assert.equal(await statusOf(pid), 'pending');
  });

  await t.test('a tampered token cannot close it', async () => {
    const { pid, token } = await issue();
    assert.equal((await close(USERS.student, tamper(token, (p) => { p.tool = 'x'; }), 'dismissed')).status, 410);
    assert.equal(await statusOf(pid), 'pending');
  });

  await t.test('a decision we do not know is refused', async () => {
    const { token } = await issue();
    for (const decision of ['done', 'constructor', undefined, 1]) {
      assert.equal((await close(USERS.student, token, decision)).status, 400);
    }
  });

  await t.test('the record keeps nothing about how it went', async () => {
    const { pid, token } = await issue();
    await claim(USERS.student, token);
    await api('/api/copilot/proposals/close', {
      as: USERS.student, method: 'POST', body: { proposal: token, decision: 'approved', outcome: 'ok', result: 'it worked' }
    });
    const stored = await collection().findOne({ _id: pid });
    assert.deepEqual(Object.keys(stored).sort(), [
      '_id', 'claimedAt', 'closedAt', 'createdAt', 'expiresAt', 'mentorship', 'status', 'tool', 'user'
    ]);
  });
});

test('the record expires by itself', async () => {
  const AgentProposal = require('../models/AgentProposal');
  const ttl = AgentProposal.schema.indexes().find(([keys]) => keys.expiresAt === 1);
  assert.deepEqual(ttl[1].expireAfterSeconds, 0);
});
