/**
 * The role matrix, layer (b): what Express refuses (S5 Step 5, AGENT_PLAN §4.3).
 *
 * §4.3.8: THIS FILE IS THE EXECUTION HALF. The model's tool filter is taken out of
 * the picture: the stub AI service returns whatever call a test says, as if the filter
 * had failed, and these tests check that the turn route, the proposal builder, the
 * claim and the real write routes still refuse. The filtering half, what the model is
 * offered per role, is ai/tests/test_agent_role_matrix.py. The two are separate so a
 * regression in one is not masked by the other.
 *
 * §4.3.9 (a rubric cannot be read by the wrong viewer) is tested in S8, when rubrics
 * exist. The mechanism it relies on, the viewer filter inside the search, is tested today by
 * ai/tests/test_search.py::test_the_permission_filter_is_inside_the_vector_search and
 * ai/tests/test_agent.py::test_search_runs_here_for_this_mentorship_and_this_viewer_only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { USERS, start, stop, api, db, mongoose } = require('./helpers/harness');
const agentProposal = require('../lib/agentProposal');

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
let theirs; // admin -> student2: the admin holds this one as its mentor
let actions;
const oid = (id) => new mongoose.Types.ObjectId(id);

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
const PARTIES = () => new Map([[mine._id, { mentor: USERS.mentor, student: USERS.student }], [theirs._id, { mentor: USERS.admin, student: USERS.student2 }]]);

/** Ask the agent as `as`, the stub having been told what the model "called". Returns the raw response. */
async function ask(as, tool, args, mentorship = mine) {
  reply = { tool, args };
  return api(`/api/mentorships/${mentorship._id}/copilot/agent`, { as, method: 'POST', body: { question: QUESTION } });
}
async function propose(as, tool, args, mentorship = mine) {
  const res = await ask(as, tool, args, mentorship);
  assert.equal(res.status, 200);
  return res.json();
}

const decode = (token) => jwt.verify(token, SECRET, { algorithms: ['HS256'] });
const claim = (as, proposal) => api('/api/copilot/proposals/claim', { as, method: 'POST', body: { proposal } });

/** What the browser does once the claim succeeds: its own table, against the real route. */
async function runAsBrowser(as, token) {
  const p = decode(token);
  const request = actions.requestFor(p.tool, p.args);
  assert.ok(request, 'the tool has a mapping');
  return api(request.path, { as, method: request.method, body: request.body });
}

const proposalRecords = () => db().collection('agentproposals').countDocuments({});
const count = (collection) => db().collection(collection).countDocuments({});

async function newGoal(mentorship, milestones = ['First', 'Second']) {
  const as = PARTIES().get(mentorship._id).mentor;
  return (await api(`/api/mentorships/${mentorship._id}/goals`, { as, method: 'POST', body: { title: 'A goal', milestones } })).json();
}
async function newSession(as, mentorship) {
  return (await api(`/api/mentorships/${mentorship._id}/sessions`, {
    as, method: 'POST', body: { title: 'Check-in', scheduledFor: '2030-04-01T04:30:00.000Z', durationMinutes: 45 }
  })).json();
}
async function newWork(mentorship) {
  const as = PARTIES().get(mentorship._id).mentor;
  return (await api('/api/assignments', {
    as, method: 'POST', body: { title: 'An essay', instructions: '', dueAt: '2030-03-01T18:29:00.000Z', mentorshipIds: [mentorship._id] }
  })).json();
}

const MISSING = 'a'.repeat(24);
/** Valid arguments for `tool` against `mentorship`, with whatever it needs to exist created first. */
async function argsFor(tool, actor, mentorship) {
  const parties = PARTIES().get(mentorship._id);
  switch (tool) {
    case 'create_assignment':
      return { title: 'Write a postmortem', instructions: 'Two pages.', due_at: FUTURE };
    case 'extend_assignment_deadline':
      return { assignmentId: (await newWork(mentorship))._id, new_due_at: FUTURE };
    case 'set_goal':
      return { title: 'Interview ready', description: 'By March', milestones: ['One', 'Two'] };
    case 'toggle_milestone':
      return { goalId: (await newGoal(mentorship))._id, milestone_number: 1, done: true };
    case 'propose_session':
      return { title: 'Mock', agenda: 'Trees', scheduled_for: LATER, duration_minutes: 60 };
    case 'confirm_session': {
      // Proposed by the other party, so the only thing that can refuse is the check under test.
      const other = actor._id === parties.mentor._id ? parties.student : parties.mentor;
      return { sessionId: (await newSession(other, mentorship))._id };
    }
    case 'add_resource':
      return { title: 'Article', url: 'https://example.test/a', note: 'Read this' };
    default:
      throw new Error(tool);
  }
}

/** After the browser has run an approved proposal: the record is there. */
async function assertStored(tool, p, res) {
  const made = await res.json();
  const byId = (collection) => db().collection(collection).findOne({ _id: oid(made._id) });
  switch (tool) {
    case 'create_assignment': {
      const row = await byId('assignments');
      assert.ok(row);
      assert.equal(row.title, p.args.title);
      break;
    }
    case 'extend_assignment_deadline': {
      const row = await db().collection('assignments').findOne({ _id: oid(p.args.assignmentId) });
      assert.equal(row.dueAt.toISOString(), p.args.dueAt);
      break;
    }
    case 'set_goal': {
      const row = await byId('goals');
      assert.ok(row);
      assert.equal(row.milestones.length, 2);
      break;
    }
    case 'toggle_milestone': {
      const row = await db().collection('goals').findOne({ _id: oid(p.args.goalId) });
      assert.equal(row.milestones.find((m) => String(m._id) === p.args.milestoneId).done, true);
      break;
    }
    case 'propose_session': {
      const row = await byId('sessions');
      assert.ok(row);
      assert.equal(row.status, 'proposed');
      break;
    }
    case 'confirm_session': {
      const row = await db().collection('sessions').findOne({ _id: oid(p.args.sessionId) });
      assert.equal(row.status, 'confirmed');
      break;
    }
    case 'add_resource': {
      const row = await byId('resources');
      assert.ok(row);
      assert.equal(row.url, p.args.url);
      break;
    }
    default:
      throw new Error(tool);
  }
}

const TOOLS = ['create_assignment', 'extend_assignment_deadline', 'set_goal', 'toggle_milestone', 'propose_session', 'confirm_session', 'add_resource'];
const P = 'proposal';
const N = 'not_allowed';
const F = 403;
// actor, in which mentorship, then the expected outcome for each of TOOLS in order.
const ROWS = [
  ['mentor', USERS.mentor, 'mine', 'own', [P, P, P, P, P, P, P]],
  ['student', USERS.student, 'mine', 'own', [N, N, N, P, P, P, P]],
  ['admin', USERS.admin, 'theirs', 'holds it as mentor', [P, P, P, P, P, P, P]],
  ['student2', USERS.student2, 'theirs', 'own', [N, N, N, P, P, P, P]],
  ['mentor', USERS.mentor, 'theirs', 'not theirs', [F, F, F, F, F, F, F]],
  ['student', USERS.student, 'theirs', 'not theirs', [F, F, F, F, F, F, F]],
  ['student2', USERS.student2, 'mine', 'not theirs', [F, F, F, F, F, F, F]],
  ['admin', USERS.admin, 'mine', 'admin, but not in it', [F, F, F, F, F, F, F]]
];

test('the role matrix: each actor, in each mentorship, for each write tool', async (t) => {
  for (const [name, actor, where, why, expected] of ROWS) {
    const mentorship = where === 'mine' ? mine : theirs;
    for (const [i, tool] of TOOLS.entries()) {
      const want = expected[i];
      await t.test(`${name} in ${where} (${why}): ${tool} -> ${want}`, async () => {
        sent = [];
        resumes = [];
        const args = want === F ? { title: 'x', url: 'https://example.test/', note: '' } : await argsFor(tool, actor, mentorship);
        const before = await proposalRecords();
        const res = await ask(actor, tool, args, mentorship);

        if (want === F) {
          assert.equal(res.status, 403);
          assert.equal(sent.length, 0, 'the AI service received nothing');
          assert.equal(await proposalRecords(), before);
          return;
        }

        assert.equal(res.status, 200);
        const out = await res.json();
        if (want === N) {
          assert.equal(out.status, 'declined');
          assert.equal(out.reason, 'not_allowed');
          assert.equal(out.proposal, undefined);
          assert.equal(await proposalRecords(), before, 'no proposal record');
          assert.equal(await db().collection('agentproposals').findOne({ _id: sent.at(-1).threadId }), null);
          return;
        }

        assert.equal(out.status, 'proposal');
        assert.ok(out.proposal);
        const p = decode(out.proposal);
        assert.equal(p.sub, actor._id);
        assert.equal(p.mid, mentorship._id);
        assert.equal(await proposalRecords(), before + 1);
        const claimed = await claim(actor, out.proposal);
        assert.equal(claimed.status, 200);
        const ran = await runAsBrowser(actor, out.proposal);
        assert.ok(ran.status >= 200 && ran.status < 300, `the route answered ${ran.status}`);
        await assertStored(tool, p, ran);
      });
    }
  }
});

test('section 4.3.1: a student cannot create, edit, reschedule or withdraw an assignment', async (t) => {
  const work = await newWork(mine);
  const assignmentsBefore = await count('assignments');

  await t.test('create, on the real route', async () => {
    const res = await api('/api/assignments', {
      as: USERS.student, method: 'POST',
      body: { title: 'Mine now', instructions: '', dueAt: '2030-03-01T18:29:00.000Z', mentorshipIds: [mine._id] }
    });
    assert.equal(res.status, 403);
    assert.equal(await count('assignments'), assignmentsBefore);
  });

  await t.test('edit and reschedule, on the real route', async () => {
    const res = await api(`/api/assignments/${work._id}`, { as: USERS.student, method: 'PATCH', body: { dueAt: '2031-01-01T10:00:00.000Z', title: 'Changed' } });
    assert.equal(res.status, 403);
    const row = await db().collection('assignments').findOne({ _id: oid(work._id) });
    assert.equal(row.title, 'An essay');
    assert.equal(row.dueAt.toISOString(), '2030-03-01T18:29:00.000Z');
  });

  await t.test('withdraw (the delete route), on the real route', async () => {
    const res = await api(`/api/assignments/${work._id}`, { as: USERS.student, method: 'DELETE' });
    assert.equal(res.status, 403);
    assert.ok(await db().collection('assignments').findOne({ _id: oid(work._id) }));
    assert.equal(await count('assignments'), assignmentsBefore);
  });

  await t.test('extend_assignment_deadline proposed for a student is not_allowed', async () => {
    const out = await propose(USERS.student, 'extend_assignment_deadline', { assignmentId: work._id, new_due_at: FUTURE });
    assert.equal(out.status, 'declined');
    assert.equal(out.reason, 'not_allowed');
    assert.equal(out.proposal, undefined);
  });
});

test('section 4.3.2: a student cannot post an announcement or create a group', async (t) => {
  await t.test('the real routes', async () => {
    const announcements = await count('announcements');
    const groups = await count('groups');
    const a = await api('/api/announcements', { as: USERS.student, method: 'POST', body: { text: 'Hello all' } });
    assert.equal(a.status, 403);
    const g = await api('/api/groups', { as: USERS.student, method: 'POST', body: { name: 'A group', memberIds: [] } });
    assert.equal(g.status, 403);
    assert.equal(await count('announcements'), announcements);
    assert.equal(await count('groups'), groups);
  });

  for (const tool of ['post_announcement', 'create_group']) {
    for (const [name, actor, mentorship] of [['student', USERS.student, mine], ['mentor', USERS.mentor, mine], ['admin', USERS.admin, theirs]]) {
      await t.test(`${tool} as ${name}, returned by the stub as if the model called it`, async () => {
        const before = await proposalRecords();
        const out = await propose(actor, tool, { text: 'Hello all', name: 'A group' }, mentorship);
        assert.equal(out.status, 'declined');
        assert.equal(out.reason, 'not_allowed');
        assert.equal(out.proposal, undefined);
        assert.equal(await proposalRecords(), before);
      });
    }
  }
});

test('section 4.3.3: a mentor cannot act on another mentor\'s mentorship', async (t) => {
  const cases = [
    ['goals', 'goals', { title: 'Sneaky', milestones: ['x'] }],
    ['sessions', 'sessions', { title: 'Sneaky', scheduledFor: '2030-04-01T04:30:00.000Z', durationMinutes: 30 }],
    ['resources', 'resources', { title: 'Sneaky', url: 'https://example.test/' }]
  ];
  for (const [route, collection, body] of cases) {
    await t.test(`POST ${route}`, async () => {
      const before = await count(collection);
      const res = await api(`/api/mentorships/${theirs._id}/${route}`, { as: USERS.mentor, method: 'POST', body });
      assert.equal(res.status, 403, 'a 403, not an empty success');
      assert.equal(await count(collection), before);
    });
  }
});

test('section 4.3.4: no role can change anyone\'s role through the agent', async (t) => {
  for (const tool of ['set_role', 'change_role']) {
    for (const [name, actor, mentorship] of [['student', USERS.student, mine], ['mentor', USERS.mentor, mine], ['admin', USERS.admin, theirs]]) {
      await t.test(`${tool} as ${name}`, async () => {
        const before = await proposalRecords();
        const out = await propose(actor, tool, { userId: USERS.student._id, role: 'admin' }, mentorship);
        assert.equal(out.status, 'declined');
        assert.equal(out.reason, 'not_allowed');
        assert.equal(out.proposal, undefined);
        assert.equal(await proposalRecords(), before);
        for (const u of Object.values(USERS)) {
          assert.equal((await db().collection('users').findOne({ _id: oid(u._id) })).role, u.role);
        }
      });
    }
  }
});

test('section 4.3.5: no role can reach an admin function through the agent', async (t) => {
  for (const tool of ['list_users', 'get_stats', 'suspend_user', 'verify_user', 'list_reports', 'add_student']) {
    for (const [name, actor, mentorship] of [['student', USERS.student, mine], ['mentor', USERS.mentor, mine], ['admin', USERS.admin, theirs]]) {
      await t.test(`${tool} as ${name}`, async () => {
        const before = await proposalRecords();
        const out = await propose(actor, tool, { userId: USERS.student._id, suspended: true }, mentorship);
        assert.equal(out.status, 'declined');
        assert.equal(out.reason, 'not_allowed');
        assert.equal(out.proposal, undefined);
        assert.equal(await proposalRecords(), before);
        assert.notEqual((await db().collection('users').findOne({ _id: oid(USERS.student._id) })).suspended, true);
      });
    }
  }
});

test('section 4.3.6: a proposer cannot confirm their own session', async (t) => {
  await t.test('through the agent', async () => {
    const s = await newSession(USERS.mentor, mine);
    const out = await propose(USERS.mentor, 'confirm_session', { sessionId: s._id });
    assert.equal(out.status, 'declined');
    assert.equal(out.reason, 'your_proposal');
    assert.equal(out.proposal, undefined);
  });

  await t.test('a proposal forged with the signing key is stopped at the claim', async () => {
    const s = await newSession(USERS.mentor, mine);
    const pid = agentProposal.newProposalId();
    const { token, exp } = agentProposal.signProposal(SECRET, {
      pid, tool: 'confirm_session', args: { sessionId: s._id }, heading: 'Confirm this session', fields: [{ label: 'Title', value: s.title, arg: 'sessionId' }],
      asked: QUESTION, userId: USERS.mentor._id, mentorshipId: mine._id, role: 'mentor'
    });
    // A pending record exists, so it is the check under test that refuses, not a missing record.
    await db().collection('agentproposals').insertOne({
      _id: pid, user: oid(USERS.mentor._id), mentorship: oid(mine._id), tool: 'confirm_session',
      status: 'pending', expiresAt: new Date((exp + 60) * 1000), createdAt: new Date()
    });
    const res = await claim(USERS.mentor, token);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, 'changed');
    assert.equal((await db().collection('agentproposals').findOne({ _id: pid })).status, 'pending');
  });

  await t.test('the real route', async () => {
    const s = await newSession(USERS.mentor, mine);
    const res = await api(`/api/sessions/${s._id}`, { as: USERS.mentor, method: 'PATCH', body: { action: 'confirm' } });
    assert.equal(res.status, 403);
    assert.equal((await db().collection('sessions').findOne({ _id: oid(s._id) })).status, 'proposed');
  });
});

test('section 4.3.7: a suspended user gets nothing', async (t) => {
  const setSuspended = (value) => db().collection('users').updateOne({ _id: oid(USERS.mentor._id) }, { $set: { suspended: value } });
  const issued = await propose(USERS.mentor, 'add_resource', { title: 'x', url: 'https://example.test/', note: '' });
  assert.equal(issued.status, 'proposal');
  const pid = decode(issued.proposal).jti;
  sent = [];
  await setSuspended(true);
  try {
    await t.test('the turn route refuses and the AI service receives nothing', async () => {
      const res = await ask(USERS.mentor, 'add_resource', { title: 'x', url: 'https://example.test/', note: '' });
      assert.equal(res.status, 403);
      assert.equal(sent.length, 0);
    });
    await t.test('a proposal issued before cannot be claimed', async () => {
      assert.equal((await claim(USERS.mentor, issued.proposal)).status, 403);
      assert.equal((await db().collection('agentproposals').findOne({ _id: pid })).status, 'pending');
    });
    await t.test('the real write route refuses', async () => {
      const before = await count('resources');
      const res = await runAsBrowser(USERS.mentor, issued.proposal);
      assert.equal(res.status, 403);
      assert.equal(await count('resources'), before);
    });
  } finally {
    await setSuspended(false);
  }
});

test('a proposal issued to one user, presented by each of the other three, is refused and stays pending', async (t) => {
  const out = await propose(USERS.mentor, 'add_resource', { title: 'x', url: 'https://example.test/', note: '' });
  const pid = decode(out.proposal).jti;
  for (const [name, other] of [['student', USERS.student], ['student2', USERS.student2], ['admin', USERS.admin]]) {
    await t.test(`presented by ${name}`, async () => {
      const res = await claim(other, out.proposal);
      assert.equal(res.status, 403);
      // Later checks would also refuse some of these, so this says which one answered.
      assert.match((await res.json()).error, /not yours/);
      assert.equal((await db().collection('agentproposals').findOne({ _id: pid })).status, 'pending');
    });
  }
});
