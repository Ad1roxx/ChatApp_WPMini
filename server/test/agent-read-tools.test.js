/**
 * The agent's read tools: what each returns, to whom, and what never leaves.
 *
 * Run through the real endpoint, with real capability tokens, against records
 * made through the real API. The properties (AGENT_PLAN §4.3, S4 Step 0):
 *
 * - a tool sees what its page shows, and no more: the same loader runs both
 * - a mentorship tool reads THIS mentorship, even for a mentor who has others
 * - the mentor-only tool is refused to a student, at the endpoint too
 * - arguments are exactly the tool's shape; identity never rides in on one
 * - no person's name, and no email, appears in any result
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { USERS, start, stop, api, db, mongoose } = require('./helpers/harness');
const { mintAgentToken } = require('../lib/agentToken');
const { TOOLS, toolsFor, argsProblem } = require('../lib/agentTools');

const AI_SECRET = 'stub-secret';
const AGENT_SECRET = crypto.randomBytes(24).toString('hex');

let mine; // mentor -> student
let other; // mentor -> student2: the same mentor's other mentorship
let theirs; // admin -> student2
let both; // work set by the mentor in mine AND other
let elsewhere; // work set by the mentor in other only

const post = (as, path, body, method = 'POST') =>
  api(path, { as, method, body }).then(async (r) => {
    const json = await r.json();
    assert.ok(r.ok, `${method} ${path}: ${r.status} ${JSON.stringify(json)}`);
    return json;
  });
const DAY = 24 * 60 * 60 * 1000;
const future = (days) => new Date(Date.now() + days * DAY).toISOString();

test.before(async () => {
  await start({
    extraEnv: { AI_SERVICE_SECRET: AI_SECRET, AGENT_TOKEN_SECRET: AGENT_SECRET, AI_SERVICE_URL: '' }
  });
  const add = (as, studentId, topic) => post(as, '/api/mentorships', { studentId, topic });
  mine = await add(USERS.mentor, USERS.student._id, 'Backend interviews');
  other = await add(USERS.mentor, USERS.student2._id, 'Frontend basics');
  theirs = await add(USERS.admin, USERS.student2._id, 'Something else');

  const goal = await post(USERS.mentor, `/api/mentorships/${mine._id}/goals`, {
    title: 'Ready for backend interviews',
    milestones: ['Design a rate limiter', 'Pass a mock interview']
  });
  await db()
    .collection('goals')
    .updateOne({ _id: new mongoose.Types.ObjectId(goal._id) }, { $set: { 'milestones.0.done': true } });
  await post(USERS.mentor, `/api/mentorships/${other._id}/goals`, { title: 'A goal in the other mentorship' });

  await post(USERS.student, `/api/mentorships/${mine._id}/sessions`, {
    title: 'Mock interview', agenda: 'System design', scheduledFor: future(3), durationMinutes: 45
  });
  await post(USERS.mentor, `/api/mentorships/${other._id}/sessions`, {
    title: 'CSS review', scheduledFor: future(5), durationMinutes: 30
  });
  await post(USERS.student, `/api/mentorships/${mine._id}/resources`, {
    title: 'Rate limiting article', url: 'https://example.com/rate-limits', note: 'Read section 2'
  });
  await post(USERS.mentor, `/api/mentorships/${other._id}/resources`, {
    title: 'A link in the other mentorship', url: 'https://example.com/other'
  });

  both = await post(USERS.mentor, '/api/assignments', {
    title: 'Write a postmortem', dueAt: future(7), mentorshipIds: [mine._id, other._id]
  });
  elsewhere = await post(USERS.mentor, '/api/assignments', {
    title: 'Build a navbar', dueAt: future(9), mentorshipIds: [other._id]
  });
  await post(USERS.admin, '/api/assignments', {
    title: 'Admin-set work', dueAt: future(4), mentorshipIds: [theirs._id]
  });

  const [handIn] = await api(`/api/mentorships/${mine._id}/assignments`, { as: USERS.student }).then((r) => r.json());
  await post(USERS.student, `/api/submissions/${handIn._id}`, { text: 'My postmortem' }, 'PUT');
  await post(USERS.mentor, `/api/submissions/${handIn._id}`, { action: 'request-changes', note: 'Add the timeline' }, 'PATCH');
});

test.after(() => stop());

function run(name, user, mentorship, role, args = {}) {
  const { token } = mintAgentToken(AGENT_SECRET, {
    userId: user._id, mentorshipId: mentorship._id, role, turnMs: 30000
  });
  return api(`/internal/agent/tools/${name}`, {
    method: 'POST',
    body: { args },
    headers: { 'X-AI-Secret': AI_SECRET, Authorization: `Bearer ${token}` }
  });
}

async function ok(name, user, mentorship, role, args) {
  const res = await run(name, user, mentorship, role, args);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

async function refused(res, status, pattern) {
  assert.equal(res.status, status);
  const body = await res.json();
  assert.equal(body.records, undefined);
  if (pattern) assert.match(body.error, pattern);
}

// ---------------------------------------------------------------------------
// The role filter, as data
// ---------------------------------------------------------------------------
test('which tools each role is offered', () => {
  assert.ok(!toolsFor('student').includes('get_assignment_overview'));
  assert.ok(toolsFor('mentor').includes('get_assignment_overview'));
  assert.deepEqual(
    toolsFor('student'),
    Object.keys(TOOLS).filter((n) => n !== 'get_assignment_overview' && !TOOLS[n].internal)
  );
  assert.deepEqual(toolsFor('admin'), [], 'an account role is not a mentorship role');
});

test('arguments must be exactly the tool\'s shape', () => {
  const none = TOOLS.list_goals;
  const one = TOOLS.get_assignment_overview;
  assert.equal(argsProblem(none, {}), null);
  assert.equal(argsProblem(one, { assignmentId: '0000000000000000000000c1' }), null);
  for (const bad of [undefined, null, [], 'x', { mentorshipId: '0000000000000000000000c1' }]) {
    assert.ok(argsProblem(none, bad), JSON.stringify(bad));
  }
  for (const bad of [{}, { assignmentId: 'x' }, { assignmentId: { $ne: null } }, { assignmentId: 7 },
    { assignmentId: '0000000000000000000000c1', userId: '0000000000000000000000a3' },
    { assignmentId: '0000000000000000000000C1' }]) {
    assert.ok(argsProblem(one, bad), JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// This mentorship's tools
// ---------------------------------------------------------------------------
test('list_goals: this mentorship\'s goals, milestones and whether each is done', async () => {
  const { records } = await ok('list_goals', USERS.student, mine, 'student');
  assert.equal(records.length, 1);
  const [g] = records;
  assert.equal(g.kind, 'goal');
  assert.equal(g.title, 'Ready for backend interviews');
  assert.equal(g.setBy, 'mentor');
  assert.deepEqual(g.milestones, [
    { title: 'Design a rate limiter', done: true },
    { title: 'Pass a mock interview', done: false }
  ]);
});

test('list_mentorship_assignments: this mentorship\'s hand-ins with status and review', async (t) => {
  await t.test('the student sees their own', async () => {
    const { records } = await ok('list_mentorship_assignments', USERS.student, mine, 'student');
    assert.equal(records.length, 1);
    const [h] = records;
    assert.equal(h.kind, 'submission');
    assert.equal(h.assignment, 'Write a postmortem');
    assert.equal(h.status, 'changes-requested');
    assert.equal(h.assignmentId, String(both._id));
    assert.equal(h.review.comment, 'Add the timeline');
    assert.equal(h.late, false);
  });
  await t.test('their mentor, in this mentorship, sees the same one and not their other student\'s', async () => {
    const { records } = await ok('list_mentorship_assignments', USERS.mentor, mine, 'mentor');
    assert.deepEqual(records.map((r) => r.assignment), ['Write a postmortem']);
  });
  await t.test('in the other mentorship, the mentor sees that one\'s', async () => {
    const { records } = await ok('list_mentorship_assignments', USERS.mentor, other, 'mentor');
    assert.deepEqual(records.map((r) => r.assignment).sort(), ['Build a navbar', 'Write a postmortem']);
    assert.ok(records.every((r) => r.status === 'assigned'));
  });
});

test('list_sessions: this mentorship\'s sessions, and who proposed each, as a role', async () => {
  const { records } = await ok('list_sessions', USERS.mentor, mine, 'mentor');
  assert.deepEqual(records.map((s) => s.title), ['Mock interview']);
  assert.equal(records[0].proposedBy, 'student');
  assert.equal(records[0].status, 'proposed');
  assert.equal(records[0].minutes, 45);
});

test('list_resources: this mentorship\'s links', async () => {
  const { records } = await ok('list_resources', USERS.mentor, mine, 'mentor');
  assert.deepEqual(records.map((r) => [r.title, r.url, r.note, r.addedBy]), [
    ['Rate limiting article', 'https://example.com/rate-limits', 'Read section 2', 'student']
  ]);
});

// ---------------------------------------------------------------------------
// The mentor-only overview
// ---------------------------------------------------------------------------
test('get_assignment_overview: counts for work set in this mentorship, to the mentor who set it', async (t) => {
  await t.test('the mentor gets counts, and no per-student rows', async () => {
    const { records } = await ok('get_assignment_overview', USERS.mentor, mine, 'mentor', { assignmentId: both._id });
    assert.equal(records.length, 1);
    const [a] = records;
    assert.equal(a.title, 'Write a postmortem');
    assert.equal(a.students, 2);
    assert.equal(a.changesRequested, 1);
    assert.equal(a.handedIn, 1, 'what was sent back has been handed in');
    assert.equal(a.submissions, undefined);
  });
  await t.test('not for work set only in their other mentorship', async () => {
    await refused(
      await run('get_assignment_overview', USERS.mentor, mine, 'mentor', { assignmentId: elsewhere._id }),
      403, /wasn't set in this mentorship/
    );
  });
  await t.test('not to the student, even when asked for by name', async () => {
    await refused(
      await run('get_assignment_overview', USERS.student, mine, 'student', { assignmentId: both._id }),
      403, /isn't something I can look up/
    );
  });
  await t.test('not to another mentor', async () => {
    await refused(
      await run('get_assignment_overview', USERS.admin, theirs, 'mentor', { assignmentId: both._id }),
      403, /Only the mentor who set this/
    );
  });
  await t.test('not for an assignment that does not exist', async () => {
    await refused(
      await run('get_assignment_overview', USERS.mentor, mine, 'mentor', { assignmentId: '0000000000000000000000ff' }),
      404
    );
  });
});

test('arguments that are not the tool\'s shape are refused at the endpoint', async (t) => {
  const cases = [
    ['an invented mentorship', 'list_goals', { mentorshipId: String(other._id) }],
    ['an invented user', 'list_my_work', { userId: USERS.student2._id }],
    ['an operator for an id', 'get_assignment_overview', { assignmentId: { $ne: null } }],
    ['a missing argument', 'get_assignment_overview', {}],
    ['an extra argument', 'get_assignment_overview', { assignmentId: String(both._id), mentorshipId: String(other._id) }]
  ];
  for (const [label, name, args] of cases) {
    await t.test(label, async () => refused(await run(name, USERS.mentor, mine, 'mentor', args), 400));
  }
  await t.test('no args at all', async () => {
    const { token } = mintAgentToken(AGENT_SECRET, { userId: USERS.mentor._id, mentorshipId: mine._id, role: 'mentor', turnMs: 30000 });
    const res = await api('/internal/agent/tools/list_goals', {
      method: 'POST', body: {}, headers: { 'X-AI-Secret': AI_SECRET, Authorization: `Bearer ${token}` }
    });
    await refused(res, 400);
  });
});

// ---------------------------------------------------------------------------
// The asker's own, across their mentorships
// ---------------------------------------------------------------------------
test('list_my_work: the asker\'s own hand-ins, and what waits on them', async (t) => {
  await t.test('the student: their work and what they owe, nobody else\'s', async () => {
    const body = await ok('list_my_work', USERS.student, mine, 'student');
    assert.deepEqual(body.records.map((r) => [r.kind, r.assignment, r.topic, r.inThisMentorship]), [
      ['submission', 'Write a postmortem', 'Backend interviews', true]
    ]);
    assert.deepEqual(body.counts, { owedByYou: 1, waitingForYourReview: 0 });
  });
  await t.test('the mentor: what they set, with counts', async () => {
    const body = await ok('list_my_work', USERS.mentor, mine, 'mentor');
    const set = body.records.filter((r) => r.kind === 'assignment');
    assert.deepEqual(set.map((a) => [a.title, a.students]), [['Write a postmortem', 2], ['Build a navbar', 1]]);
    assert.equal(body.records.filter((r) => r.kind === 'submission').length, 0);
    assert.deepEqual(body.counts, { owedByYou: 0, waitingForYourReview: 0 });
  });
});

test('list_my_upcoming_sessions: the asker\'s next sessions, marked by mentorship', async (t) => {
  await t.test('the mentor sees both of their mentorships\'', async () => {
    const { records } = await ok('list_my_upcoming_sessions', USERS.mentor, mine, 'mentor');
    assert.deepEqual(records.map((s) => [s.title, s.topic, s.inThisMentorship]), [
      ['Mock interview', 'Backend interviews', true],
      ['CSS review', 'Frontend basics', false]
    ]);
  });
  await t.test('the student only theirs', async () => {
    const { records } = await ok('list_my_upcoming_sessions', USERS.student, mine, 'student');
    assert.deepEqual(records.map((s) => s.title), ['Mock interview']);
  });
});

// ---------------------------------------------------------------------------
// Nothing personal leaves
// ---------------------------------------------------------------------------
test('no tool result carries a name, an email or a person\'s id', async (t) => {
  const people = Object.values(USERS);
  const calls = [];
  for (const [user, mentorship, role] of [[USERS.student, mine, 'student'], [USERS.mentor, mine, 'mentor'], [USERS.mentor, other, 'mentor']]) {
    for (const name of toolsFor(role)) {
      const args = name === 'get_assignment_overview' ? { assignmentId: String(both._id) } : {};
      calls.push([`${name} as ${role} in ${mentorship.topic}`, name, user, mentorship, role, args]);
    }
  }
  for (const [label, name, user, mentorship, role, args] of calls) {
    await t.test(label, async () => {
      const text = JSON.stringify(await ok(name, user, mentorship, role, args));
      for (const p of people) {
        assert.ok(!text.includes(p.displayName), `${p.displayName} in ${label}`);
        assert.ok(!text.includes(p.email), `${p.email} in ${label}`);
        assert.ok(!text.includes(p._id), `a user id in ${label}`);
      }
    });
  }
});
