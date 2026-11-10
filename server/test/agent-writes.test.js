/**
 * From a model's call to a person's dialog to the real route (S5 Step 3).
 *
 * The real Express server on the tests' own database, with a stub AI service that
 * returns whatever call the test says. What runs at the end is the browser's own
 * mapping (src/lib/agentActions.js) against the real routes, as the user.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { USERS, start, stop, api, db, mongoose } = require('./helpers/harness');
const { formatTime, parseLocal } = require('../lib/agentTime');
const { WRITE_TOOLS, prepare, recheck } = require('../lib/agentWrites');

const SECRET = 'agent-proposal-secret-for-tests-only-012345';
const FUTURE = '2030-03-05T23:59';
const LATER = '2030-03-09T10:00';
const FIGURES = { modelCalls: 2, toolCalls: 1, inputTokens: 900, summaryCalls: 0, promptVersion: 'agent-v4', provider: 'fake', model: 'f', steps: [] };

let reply; // what the stub AI service answers the next turn with
let resumes = [];
let sent = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/agent/resume') {
      resumes.push(body);
      return res.end('{"status":"closed"}');
    }
    if (req.url === '/agent/paused') return res.end('{"paused":true}');
    sent.push(body);
    const answer = typeof reply === 'function' ? reply(body) : reply;
    return res.end(JSON.stringify({ ...FIGURES, status: 'proposal', threadId: body.threadId, ...answer }));
  });
});

let mine; // mentor -> student
let theirs; // admin -> student2
let actions;

test.before(async () => {
  actions = await import('../../src/lib/agentActions.js');
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  await start({
    extraEnv: {
      AI_SERVICE_URL: `http://127.0.0.1:${stub.address().port}`,
      AI_SERVICE_SECRET: 'stub-secret',
      AGENT_TOKEN_SECRET: 'agent-token-secret-for-tests-only-0123456789',
      AGENT_PROPOSAL_SECRET: SECRET,
      COPILOT_AGENT: '1',
      AGENT_CALLS_PER_MINUTE: '100000',
      AGENT_CALLS_PER_DAY: '100000'
    }
  });
  const add = (as, studentId, topic) =>
    api('/api/mentorships', { as, method: 'POST', body: { studentId, topic } }).then((r) => r.json());
  mine = await add(USERS.mentor, USERS.student._id, 'Backend interviews');
  theirs = await add(USERS.admin, USERS.student2._id, 'Something else');
});

test.after(async () => {
  await stop();
  stub.closeAllConnections();
  await new Promise((r) => stub.close(r));
});

test.beforeEach(() => {
  resumes = [];
  sent = [];
});

const QUESTION = 'Please do this for me';

/** Ask the agent as `as`, having arranged the model's call. Returns the response body. */
async function propose(as, tool, args, mentorship = mine) {
  reply = { tool, args };
  const res = await api(`/api/mentorships/${mentorship._id}/copilot/agent`, { as, method: 'POST', body: { question: QUESTION } });
  assert.equal(res.status, 200);
  return res.json();
}

const decode = (token) => jwt.verify(token, SECRET, { algorithms: ['HS256'] });
const claim = (as, proposal) => api('/api/copilot/proposals/claim', { as, method: 'POST', body: { proposal } });
const close = (as, proposal, decision) => api('/api/copilot/proposals/close', { as, method: 'POST', body: { proposal, decision } });

/** What the browser does once the claim succeeds: its own table, against the real route. */
async function runAsBrowser(as, token) {
  const p = decode(token);
  const request = actions.requestFor(p.tool, p.args);
  assert.ok(request, 'the tool has a mapping');
  return api(request.path, { as, method: request.method, body: request.body });
}

const field = (p, label) => p.fields.find((f) => f.label === label)?.value;

async function newGoal(milestones = ['First', 'Second'], mentorship = mine, as = USERS.mentor) {
  return (await api(`/api/mentorships/${mentorship._id}/goals`, { as, method: 'POST', body: { title: 'A goal', milestones } })).json();
}
async function newSession(as = USERS.mentor, mentorship = mine) {
  return (await api(`/api/mentorships/${mentorship._id}/sessions`, {
    as, method: 'POST', body: { title: 'Check-in', scheduledFor: '2030-04-01T04:30:00.000Z', durationMinutes: 45 }
  })).json();
}
async function newWork(as = USERS.mentor, mentorship = mine, title = 'An essay') {
  return (await api('/api/assignments', {
    as, method: 'POST', body: { title, instructions: '', dueAt: '2030-03-01T18:29:00.000Z', mentorshipIds: [mentorship._id] }
  })).json();
}

// ---- from a call to a dialog to the real route, one tool at a time
test('each tool: what is shown is what is signed is what the route stores', async (t) => {
  await t.test('create_assignment', async () => {
    const out = await propose(USERS.mentor, 'create_assignment', { title: '  Write a postmortem ', instructions: ' Two pages. ', due_at: FUTURE });
    assert.equal(out.status, 'proposal');
    const p = decode(out.proposal);
    assert.deepEqual(p.args, { title: 'Write a postmortem', instructions: 'Two pages.', dueAt: parseLocal(FUTURE).toISOString(), mentorshipIds: [mine._id] });
    assert.equal(p.heading, `Set work for ${USERS.student.displayName}`);
    assert.equal(field(p, 'Title'), 'Write a postmortem');
    assert.equal(field(p, 'Due'), 'Tue 5 Mar 2030, 11:59 pm IST');
    assert.equal(field(p, 'For'), USERS.student.displayName);
    assert.equal((await claim(USERS.mentor, out.proposal)).status, 200);
    const res = await runAsBrowser(USERS.mentor, out.proposal);
    assert.equal(res.status, 201);
    const made = await res.json();
    assert.equal(made.title, 'Write a postmortem');
    assert.equal(made.instructions, 'Two pages.');
    assert.equal(new Date(made.dueAt).toISOString(), p.args.dueAt);
  });

  await t.test('extend_assignment_deadline', async () => {
    const work = await newWork();
    const out = await propose(USERS.mentor, 'extend_assignment_deadline', { assignmentId: work._id, new_due_at: FUTURE });
    const p = decode(out.proposal);
    assert.deepEqual(p.args, { assignmentId: work._id, dueAt: parseLocal(FUTURE).toISOString() });
    assert.equal(field(p, 'Work'), 'An essay');
    assert.equal(field(p, 'Currently due'), formatTime(work.dueAt));
    assert.equal(field(p, 'New due'), formatTime(p.args.dueAt));
    assert.match(field(p, 'Applies to'), /one student/);
    await claim(USERS.mentor, out.proposal);
    const res = await runAsBrowser(USERS.mentor, out.proposal);
    assert.equal(res.status, 200);
    assert.equal(new Date((await res.json()).dueAt).toISOString(), p.args.dueAt);
  });

  await t.test('set_goal', async () => {
    const out = await propose(USERS.mentor, 'set_goal', { title: 'Interview ready', description: 'By March', milestones: [' One ', 'Two'] });
    const p = decode(out.proposal);
    assert.deepEqual(p.args, { mentorshipId: mine._id, title: 'Interview ready', description: 'By March', milestones: ['One', 'Two'] });
    assert.equal(field(p, 'Milestones'), '1. One\n2. Two');
    await claim(USERS.mentor, out.proposal);
    const res = await runAsBrowser(USERS.mentor, out.proposal);
    assert.equal(res.status, 200);
    const made = await res.json();
    assert.deepEqual(made.milestones.map((m) => m.title), ['One', 'Two']);
    assert.equal(made.description, 'By March');
  });

  await t.test('toggle_milestone, by position in the list the model read', async () => {
    const goal = await newGoal();
    const out = await propose(USERS.student, 'toggle_milestone', { goalId: goal._id, milestone_number: 2, done: true });
    const p = decode(out.proposal);
    assert.deepEqual(p.args, { goalId: goal._id, milestoneId: goal.milestones[1]._id, done: true });
    assert.equal(field(p, 'Milestone'), 'Second');
    assert.equal(field(p, 'Change'), 'Not done → Done');
    await claim(USERS.student, out.proposal);
    const res = await runAsBrowser(USERS.student, out.proposal);
    const made = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(made.milestones.map((m) => m.done), [false, true]);
  });

  await t.test('propose_session', async () => {
    const out = await propose(USERS.student, 'propose_session', { title: 'Mock', agenda: 'Trees', scheduled_for: LATER, duration_minutes: 60 });
    const p = decode(out.proposal);
    assert.deepEqual(p.args, { mentorshipId: mine._id, title: 'Mock', agenda: 'Trees', scheduledFor: parseLocal(LATER).toISOString(), durationMinutes: 60 });
    assert.equal(p.heading, `Propose a session with ${USERS.mentor.displayName}`);
    assert.equal(field(p, 'Length'), '60 minutes');
    await claim(USERS.student, out.proposal);
    const res = await runAsBrowser(USERS.student, out.proposal);
    const made = await res.json();
    assert.equal(res.status, 201);
    assert.equal(made.status, 'proposed');
    assert.equal(String(made.proposedBy._id), USERS.student._id);
  });

  await t.test('confirm_session', async () => {
    const s = await newSession(USERS.mentor);
    const out = await propose(USERS.student, 'confirm_session', { sessionId: s._id });
    const p = decode(out.proposal);
    assert.deepEqual(p.args, { sessionId: s._id });
    assert.equal(field(p, 'When'), formatTime(s.scheduledFor));
    assert.equal(field(p, 'Length'), '45 minutes');
    assert.equal(field(p, 'Proposed by'), USERS.mentor.displayName);
    await claim(USERS.student, out.proposal);
    const res = await runAsBrowser(USERS.student, out.proposal);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'confirmed');
  });

  await t.test('add_resource: the link shown is the link kept, whole', async () => {
    const out = await propose(USERS.student, 'add_resource', { title: 'Article', url: 'https://EXAMPLE.test/a?x=1&secret=abc', note: 'Read this' });
    const p = decode(out.proposal);
    assert.equal(p.args.url, 'https://example.test/a?x=1&secret=abc');
    assert.equal(field(p, 'Link'), p.args.url);
    await claim(USERS.student, out.proposal);
    const res = await runAsBrowser(USERS.student, out.proposal);
    const made = await res.json();
    assert.equal(res.status, 201);
    assert.equal(made.url, field(p, 'Link'));
  });
});

test('every argument the request carries has a field that shows it', async () => {
  const goal = await newGoal();
  const session = await newSession(USERS.mentor);
  const work = await newWork();
  const cases = [
    [USERS.mentor, 'create_assignment', { title: 'x', instructions: 'y', due_at: FUTURE }],
    [USERS.mentor, 'extend_assignment_deadline', { assignmentId: work._id, new_due_at: FUTURE }],
    [USERS.mentor, 'set_goal', { title: 'x', description: 'y', milestones: ['z'] }],
    [USERS.mentor, 'toggle_milestone', { goalId: goal._id, milestone_number: 1, done: true }],
    [USERS.mentor, 'propose_session', { title: 'x', agenda: 'y', scheduled_for: LATER, duration_minutes: 30 }],
    [USERS.student, 'confirm_session', { sessionId: session._id }],
    [USERS.mentor, 'add_resource', { title: 'x', url: 'https://x.test/', note: 'y' }]
  ];
  assert.deepEqual(cases.map((c) => c[1]).sort(), Object.keys(WRITE_TOOLS).sort(), 'every tool is here');
  for (const [as, tool, args] of cases) {
    const p = decode((await propose(as, tool, args)).proposal);
    for (const key of Object.keys(p.args)) {
      assert.ok(p.fields.some((f) => f.arg === key), `${tool}: ${key} is shown`);
    }
    for (const f of p.fields) assert.ok(f.arg === '' || Object.hasOwn(p.args, f.arg), `${tool}: ${f.label} names a real argument`);
  }
});

test('the token is all the browser gets', async () => {
  const out = await propose(USERS.mentor, 'add_resource', { title: 'x', url: 'https://x.test/', note: '' });
  assert.deepEqual(Object.keys(out).sort(), [...Object.keys(FIGURES), 'proposal', 'status'].sort());
  assert.equal(out.tool, undefined);
  assert.equal(out.args, undefined);
});

test('the question asked is signed, as the person asked it', async () => {
  const out = await propose(USERS.mentor, 'add_resource', { title: 'x', url: 'https://x.test/', note: '' });
  assert.equal(decode(out.proposal).asked, QUESTION);
});

test('the proposal is for the asker, from the record, whatever the model says', async () => {
  const out = await propose(USERS.student, 'add_resource', { title: 'x', url: 'https://x.test/', note: '' });
  const p = decode(out.proposal);
  assert.equal(p.sub, USERS.student._id);
  assert.equal(p.mid, mine._id);
  assert.equal(p.role, 'student');
  assert.equal(p.jti, sent.at(-1).threadId);
  const record = await db().collection('agentproposals').findOne({ _id: p.jti });
  assert.equal(record.status, 'pending');
  assert.equal(String(record.user), USERS.student._id);
});

test('what cannot be proposed is refused with a reason, and the paused turn is ended', async (t) => {
  const goal = await newGoal(['Only']);
  const cases = [
    ['a student asking for a mentor tool', USERS.student, 'create_assignment', { title: 'x', instructions: '', due_at: FUTURE }, 'not_allowed'],
    ['a student setting a goal', USERS.student, 'set_goal', { title: 'x', description: '', milestones: [] }, 'not_allowed'],
    ['a student moving a deadline', USERS.student, 'extend_assignment_deadline', { assignmentId: 'a'.repeat(24), new_due_at: FUTURE }, 'not_allowed'],
    ['a tool not on the list', USERS.mentor, 'delete_resource', { resourceId: 'a'.repeat(24) }, 'not_allowed'],
    ['a name that is not a tool', USERS.mentor, 'constructor', {}, 'not_allowed'],
    ['a past date', USERS.mentor, 'create_assignment', { title: 'x', instructions: '', due_at: '2020-01-01T10:00' }, 'past_date'],
    ['a date that does not exist', USERS.mentor, 'create_assignment', { title: 'x', instructions: '', due_at: '2030-02-31T10:00' }, 'bad_args'],
    ['a date in another form', USERS.mentor, 'create_assignment', { title: 'x', instructions: '', due_at: 'next Tuesday' }, 'bad_args'],
    ['an extra argument', USERS.mentor, 'create_assignment', { title: 'x', instructions: '', due_at: FUTURE, mentorshipIds: [theirs._id] }, 'bad_args'],
    ['a missing argument', USERS.mentor, 'create_assignment', { title: 'x', due_at: FUTURE }, 'bad_args'],
    ['a required argument that only the shape check can catch', USERS.student, 'confirm_session', {}, 'bad_args'],
    ['a text field that is not text', USERS.mentor, 'create_assignment', { title: 'x', instructions: 7, due_at: FUTURE }, 'bad_args'],
    ['milestones that are not a list', USERS.mentor, 'set_goal', { title: 'x', description: '', milestones: 'one' }, 'bad_args'],
    ['a value that is not text', USERS.mentor, 'create_assignment', { title: 7, instructions: '', due_at: FUTURE }, 'bad_args'],
    ['a title too long, refused rather than cut', USERS.mentor, 'create_assignment', { title: 'x'.repeat(201), instructions: '', due_at: FUTURE }, 'too_long'],
    ['text with a hidden direction change', USERS.mentor, 'add_resource', { title: 'safe‮txt.exe', url: 'https://x.test/', note: '' }, 'bad_text'],
    ['a title with a line break', USERS.mentor, 'add_resource', { title: 'one\ntwo', url: 'https://x.test/', note: '' }, 'bad_text'],
    ['a link that is not http', USERS.mentor, 'add_resource', { title: 'x', url: 'javascript:alert(1)', note: '' }, 'bad_url'],
    ['too many milestones', USERS.mentor, 'set_goal', { title: 'x', description: '', milestones: Array(51).fill('m') }, 'too_long'],
    ['a milestone that is not there', USERS.mentor, 'toggle_milestone', { goalId: goal._id, milestone_number: 2, done: true }, 'not_found'],
    ['a milestone already in that state', USERS.mentor, 'toggle_milestone', { goalId: goal._id, milestone_number: 1, done: false }, 'no_change'],
    ['a goal that does not exist', USERS.mentor, 'toggle_milestone', { goalId: 'a'.repeat(24), milestone_number: 1, done: true }, 'not_found'],
    ['a session that does not exist', USERS.mentor, 'confirm_session', { sessionId: 'a'.repeat(24) }, 'not_found']
  ];
  for (const [name, as, tool, args, reason] of cases) {
    await t.test(name, async () => {
      const out = await propose(as, tool, args);
      assert.equal(out.status, 'declined');
      assert.equal(out.reason, reason);
      assert.equal(out.proposal, undefined);
      assert.deepEqual(resumes, [{ threadId: sent.at(-1).threadId, decision: 'dismissed' }]);
      assert.equal(await db().collection('agentproposals').findOne({ _id: sent.at(-1).threadId }), null);
    });
  }
});

test('a proposal is only ever about this mentorship', async (t) => {
  const otherGoal = await newGoal(['x'], theirs, USERS.admin);
  const otherSession = await newSession(USERS.admin, theirs);

  await t.test('a goal from another mentorship', async () => {
    assert.equal((await propose(USERS.mentor, 'toggle_milestone', { goalId: otherGoal._id, milestone_number: 1, done: true })).reason, 'not_here');
  });
  await t.test('a session from another mentorship', async () => {
    assert.equal((await propose(USERS.student, 'confirm_session', { sessionId: otherSession._id })).reason, 'not_here');
  });
  await t.test('work this mentor set, but not in this mentorship', async () => {
    const third = await (await api('/api/mentorships', { as: USERS.mentor, method: 'POST', body: { studentId: USERS.student2._id, topic: 'Third' } })).json();
    const work = await newWork(USERS.mentor, third);
    assert.equal((await propose(USERS.mentor, 'extend_assignment_deadline', { assignmentId: work._id, new_due_at: FUTURE })).reason, 'not_here');
  });
  await t.test('work another mentor set', async () => {
    const work = await newWork(USERS.admin, theirs);
    assert.equal((await propose(USERS.mentor, 'extend_assignment_deadline', { assignmentId: work._id, new_due_at: FUTURE })).reason, 'not_yours');
  });
  await t.test('new work always names only this mentorship', async () => {
    const p = decode((await propose(USERS.mentor, 'create_assignment', { title: 'x', instructions: '', due_at: FUTURE })).proposal);
    assert.deepEqual(p.args.mentorshipIds, [mine._id]);
  });
});

test('section 3.2 and 4.3: narrower than the routes', async (t) => {
  await t.test('a deadline moves forward only', async () => {
    const work = await newWork();
    const out = await propose(USERS.mentor, 'extend_assignment_deadline', { assignmentId: work._id, new_due_at: '2030-02-01T10:00' });
    assert.equal(out.reason, 'not_later');
  });
  await t.test('the same deadline is not a later one', async () => {
    const work = await newWork();
    // 2030-03-01T18:29Z is 23:59 IST on 1 March 2030.
    const out = await propose(USERS.mentor, 'extend_assignment_deadline', { assignmentId: work._id, new_due_at: '2030-03-01T23:59' });
    assert.equal(out.reason, 'not_later');
  });
  await t.test('a proposer cannot confirm their own session', async () => {
    const s = await newSession(USERS.mentor);
    assert.equal((await propose(USERS.mentor, 'confirm_session', { sessionId: s._id })).reason, 'your_proposal');
  });
  await t.test('a confirmed session cannot be confirmed again', async () => {
    const s = await newSession(USERS.mentor);
    await api(`/api/sessions/${s._id}`, { as: USERS.student, method: 'PATCH', body: { action: 'confirm' } });
    assert.equal((await propose(USERS.student, 'confirm_session', { sessionId: s._id })).reason, 'wrong_state');
  });
  await t.test('an archived goal', async () => {
    const goal = await newGoal(['x']);
    await db().collection('goals').updateOne({ _id: new mongoose.Types.ObjectId(goal._id) }, { $set: { status: 'archived' } });
    assert.equal((await propose(USERS.student, 'toggle_milestone', { goalId: goal._id, milestone_number: 1, done: true })).reason, 'archived');
  });
});

test('what was approved must still be true when it is claimed', async (t) => {
  await t.test('the deadline it would move has moved', async () => {
    const work = await newWork();
    const out = await propose(USERS.mentor, 'extend_assignment_deadline', { assignmentId: work._id, new_due_at: FUTURE });
    await api(`/api/assignments/${work._id}`, { as: USERS.mentor, method: 'PATCH', body: { dueAt: '2030-03-02T18:29:00.000Z' } });
    const res = await claim(USERS.mentor, out.proposal);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, 'changed');
  });

  await t.test('the milestone is already in that state', async () => {
    const goal = await newGoal(['x']);
    const out = await propose(USERS.student, 'toggle_milestone', { goalId: goal._id, milestone_number: 1, done: true });
    await api(`/api/goals/${goal._id}/milestones/${goal.milestones[0]._id}`, { as: USERS.mentor, method: 'PATCH', body: { done: true } });
    const res = await claim(USERS.student, out.proposal);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, 'changed');
    const p = decode(out.proposal);
    assert.equal((await db().collection('agentproposals').findOne({ _id: p.jti })).status, 'pending');
  });

  await t.test('the session has been cancelled', async () => {
    const s = await newSession(USERS.mentor);
    const out = await propose(USERS.student, 'confirm_session', { sessionId: s._id });
    await api(`/api/sessions/${s._id}`, { as: USERS.mentor, method: 'PATCH', body: { action: 'cancel' } });
    assert.equal((await claim(USERS.student, out.proposal)).status, 409);
  });

  await t.test('a name shown in the dialog has changed', async () => {
    const out = await propose(USERS.mentor, 'create_assignment', { title: 'x', instructions: '', due_at: FUTURE });
    const id = new mongoose.Types.ObjectId(USERS.student._id);
    await db().collection('users').updateOne({ _id: id }, { $set: { displayName: 'Renamed' } });
    try {
      assert.equal((await claim(USERS.mentor, out.proposal)).status, 409);
    } finally {
      await db().collection('users').updateOne({ _id: id }, { $set: { displayName: USERS.student.displayName } });
    }
  });
});

test('every write still passes the real route: a proposal is not a pass', async (t) => {
  await t.test('a claimed proposal, its mentorship ended before the browser ran it', async () => {
    const third = await (await api('/api/mentorships', { as: USERS.admin, method: 'POST', body: { studentId: USERS.student._id, topic: 'Short' } })).json();
    const out = await propose(USERS.student, 'add_resource', { title: 'x', url: 'https://x.test/', note: '' }, third);
    assert.equal((await claim(USERS.student, out.proposal)).status, 200);
    await db().collection('mentorships').updateOne({ _id: new mongoose.Types.ObjectId(third._id) }, { $set: { status: 'ended' } });
    assert.equal((await runAsBrowser(USERS.student, out.proposal)).status, 400);
  });

  await t.test('someone else running its request is refused by the route', async () => {
    const out = await propose(USERS.student, 'add_resource', { title: 'x', url: 'https://x.test/', note: '' });
    assert.equal((await runAsBrowser(USERS.student2, out.proposal)).status, 403);
  });
});

test('closing a real proposal ends its turn', async () => {
  const out = await propose(USERS.mentor, 'add_resource', { title: 'x', url: 'https://x.test/', note: '' });
  assert.equal((await close(USERS.mentor, out.proposal, 'dismissed')).status, 200);
  assert.deepEqual(resumes, [{ threadId: decode(out.proposal).jti, decision: 'dismissed' }]);
});

test('a reply naming a different turn cannot become a proposal', async () => {
  reply = (body) => ({ tool: 'add_resource', args: { title: 'x', url: 'https://x.test/', note: '' }, threadId: 'f'.repeat(32), echoed: body.threadId });
  const res = await api(`/api/mentorships/${mine._id}/copilot/agent`, { as: USERS.mentor, method: 'POST', body: { question: QUESTION } });
  const body = await res.json();
  assert.equal(body.status, 'declined');
  assert.equal(body.reason, 'unavailable');
});

test('the role and mentorship are the caller\'s, never the call\'s', async () => {
  const context = { input: { title: 'x', instructions: '', due_at: FUTURE }, user: { _id: USERS.student._id }, mentorship: { _id: mine._id }, role: 'student', parties: {} };
  assert.deepEqual(await prepare('create_assignment', context), { refuse: 'not_allowed' });
});

test('a time in the past is refused for every tool that takes one', async (t) => {
  const past = '2020-01-01T10:00';
  await t.test('new work', async () => {
    assert.equal((await propose(USERS.mentor, 'create_assignment', { title: 'x', instructions: '', due_at: past })).reason, 'past_date');
  });
  await t.test('a moved deadline', async () => {
    const work = await newWork();
    assert.equal((await propose(USERS.mentor, 'extend_assignment_deadline', { assignmentId: work._id, new_due_at: past })).reason, 'past_date');
  });
  await t.test('a session', async () => {
    assert.equal((await propose(USERS.mentor, 'propose_session', { title: 'x', agenda: '', scheduled_for: past, duration_minutes: 30 })).reason, 'past_date');
  });
});

test('a signed proposal cannot point at another mentorship', async (t) => {
  const here = { _id: 'a'.repeat(24) };
  const elsewhere = 'b'.repeat(24);
  const context = { user: { _id: 'c'.repeat(24) }, mentorship: here, role: 'mentor', parties: { mentor: 'M', student: 'S' } };
  const dueAt = '2030-03-05T18:29:00.000Z';
  const cases = {
    create_assignment: { title: 'x', instructions: '', dueAt, mentorshipIds: [elsewhere] },
    set_goal: { mentorshipId: elsewhere, title: 'x', description: '', milestones: [] },
    propose_session: { mentorshipId: elsewhere, title: 'x', agenda: '', scheduledFor: dueAt, durationMinutes: 30 },
    add_resource: { mentorshipId: elsewhere, title: 'x', url: 'https://x.test/', note: '' }
  };
  for (const [tool, args] of Object.entries(cases)) {
    await t.test(tool, async () => {
      assert.deepEqual(await recheck({ tool, args, heading: 'x', fields: [] }, context), { refuse: 'not_here' });
    });
  }
  await t.test('nor name more than one', async () => {
    const args = { title: 'x', instructions: '', dueAt, mentorshipIds: [here._id, elsewhere] };
    assert.deepEqual(await recheck({ tool: 'create_assignment', args, heading: 'x', fields: [] }, context), { refuse: 'not_here' });
  });
});

test('the time parser reads the shown zone, and refuses what is not a real time', () => {
  assert.equal(parseLocal('2030-03-05T23:59').toISOString(), '2030-03-05T18:29:00.000Z');
  assert.equal(parseLocal('2030-01-01T00:00').toISOString(), '2029-12-31T18:30:00.000Z');
  for (const bad of ['2030-02-30T10:00', '2030-13-01T10:00', '2030-01-01T24:00', '2030-01-01T10:60', '2030-1-1T10:00', 'tomorrow', '', null, 7, '2030-01-01T10:00:00Z']) {
    assert.equal(parseLocal(bad), null, String(bad));
  }
});
