/**
 * What the browser runs for an approved proposal (S5 Step 1). No browser and no server:
 * the mapping and the order of calls, with `authFetch` faked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTCOMES, approveProposal, dismissProposal, readProposal, requestFor } from '../../src/lib/agentActions.js';

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);

// tool -> signed args, and where each arg must land: in the path, or in the body under which name.
const CASES = {
  create_assignment: {
    args: { title: 'T', instructions: 'I', dueAt: '2027-01-01T05:30:00.000Z', mentorshipIds: [A] },
    method: 'POST', path: '/api/assignments', pathArgs: [], constant: {}
  },
  extend_assignment_deadline: {
    args: { assignmentId: A, dueAt: '2027-01-02T05:30:00.000Z' },
    method: 'PATCH', path: `/api/assignments/${A}`, pathArgs: ['assignmentId'], constant: {}
  },
  set_goal: {
    args: { mentorshipId: A, title: 'G', description: 'D', milestones: ['one', 'two'] },
    method: 'POST', path: `/api/mentorships/${A}/goals`, pathArgs: ['mentorshipId'], constant: {}
  },
  toggle_milestone: {
    args: { goalId: A, milestoneId: B, done: true },
    method: 'PATCH', path: `/api/goals/${A}/milestones/${B}`, pathArgs: ['goalId', 'milestoneId'], constant: {}
  },
  propose_session: {
    args: { mentorshipId: A, title: 'S', agenda: 'A', scheduledFor: '2027-01-03T05:30:00.000Z', durationMinutes: 45 },
    method: 'POST', path: `/api/mentorships/${A}/sessions`, pathArgs: ['mentorshipId'], constant: {}
  },
  confirm_session: {
    args: { sessionId: C },
    method: 'PATCH', path: `/api/sessions/${C}`, pathArgs: ['sessionId'], constant: { action: 'confirm' }
  },
  add_resource: {
    args: { mentorshipId: A, title: 'R', url: 'https://example.test/?a=1&b=2', note: 'N' },
    method: 'POST', path: `/api/mentorships/${A}/resources`, pathArgs: ['mentorshipId'], constant: {}
  }
};

/** A token the browser can read. The server is faked here, so the signature is not what is under test. */
function token(tool, args, over = {}) {
  const payload = {
    jti: 'f'.repeat(32), tool, args, heading: 'H', asked: 'Q', exp: Math.floor(Date.now() / 1000) + 300,
    fields: [{ label: 'L', value: 'V', arg: 'x' }], ...over
  };
  return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
}

function fake(answers = {}) {
  const calls = [];
  const authFetch = async (path, options) => {
    calls.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
    const a = answers[path] ?? answers.real ?? { status: 200 };
    if (a.throws) throw Object.assign(new Error('x'), { name: a.throws });
    return { ok: a.status < 400, status: a.status, json: async () => a.body ?? {} };
  };
  return { authFetch, calls };
}

const CLAIM = '/api/copilot/proposals/claim';
const CLOSE = '/api/copilot/proposals/close';

for (const [tool, c] of Object.entries(CASES)) {
  test(`${tool}: the request is the signed arguments, field for field`, () => {
    const r = requestFor(tool, c.args);
    assert.equal(r.method, c.method);
    assert.equal(r.path, c.path);
    const expectedBody = { ...c.constant };
    for (const [k, v] of Object.entries(c.args)) if (!c.pathArgs.includes(k)) expectedBody[k] = v;
    assert.deepEqual(r.body, expectedBody);
    for (const k of c.pathArgs) assert.ok(r.path.includes(c.args[k]), `${k} is in the path`);
  });

  test(`${tool}: an extra key in a proposal goes nowhere`, () => {
    const r = requestFor(tool, { ...c.args, method: 'DELETE', path: '/api/admin/users', url2: 'x', role: 'admin' });
    assert.equal(r.method, c.method);
    assert.equal(r.path, c.path);
    for (const k of ['method', 'path', 'url2', 'role']) assert.ok(!(k in r.body));
  });

  test(`${tool}: the real route is what approving runs, after the claim, and once`, async () => {
    const { authFetch, calls } = fake();
    const out = await approveProposal(authFetch, token(tool, c.args));
    assert.equal(out.state, 'done');
    assert.equal(out.message, OUTCOMES.done[tool]);
    assert.deepEqual(calls.map((x) => x.path), [CLAIM, c.path, CLOSE]);
    assert.equal(calls[1].method, c.method);
    assert.deepEqual(calls[1].body, requestFor(tool, c.args).body);
  });
}

test('a tool with no mapping cannot execute', async (t) => {
  for (const name of ['delete_resource', 'submit_assignment', 'accept_submission', 'post_announcement', 'constructor', '__proto__', 'toString', '', null, 7]) {
    await t.test(String(name), async () => {
      assert.equal(requestFor(name, { mentorshipId: A }), null);
      const { authFetch, calls } = fake();
      const out = await approveProposal(authFetch, token(name, { mentorshipId: A }));
      assert.equal(out.state, 'failed');
      assert.equal(calls.length, 0, 'not even a claim');
    });
  }
});

test('an id that is not an id cannot reshape the path', async (t) => {
  for (const bad of ['../admin/users', `${A}/../x`, `${A}?x=1`, '', 7, null, undefined, A.toUpperCase()]) {
    await t.test(String(bad), () => {
      assert.equal(requestFor('confirm_session', { sessionId: bad }), null);
      assert.equal(requestFor('set_goal', { mentorshipId: bad, title: 'x', description: '', milestones: [] }), null);
      assert.equal(requestFor('create_assignment', { title: 'x', instructions: '', dueAt: 'x', mentorshipIds: [bad] }), null);
    });
  }
});

test('arguments that are not an object run nothing', () => {
  for (const args of [null, undefined, [], 'x', 3]) assert.equal(requestFor('confirm_session', args), null);
});

test('readProposal reads what was signed, non-ASCII included', () => {
  const p = readProposal(token('add_resource', { title: 'नमस्ते — ✓' }));
  assert.equal(p.tool, 'add_resource');
  assert.equal(p.args.title, 'नमस्ते — ✓');
  assert.equal(p.id, 'f'.repeat(32));
});

test('readProposal returns null for anything malformed', () => {
  for (const bad of ['', 'x', 'a.b.c', null, undefined, token('x', {}, { fields: 'no' }), token('x', {}, { exp: 'soon' }), token('x', null)]) {
    assert.equal(readProposal(bad), null);
  }
});

test('the claim comes first, and a refused claim runs nothing', async (t) => {
  const cases = [
    [410, undefined, 'expired'], [409, 'used', 'used'], [409, 'ended', 'ended'], [403, undefined, 'notAllowed'],
    [503, undefined, 'unavailable'], [500, undefined, 'failed']
  ];
  for (const [status, reason, state] of cases) {
    await t.test(`${status} ${reason ?? ''} -> ${state}`, async () => {
      const { authFetch, calls } = fake({ [CLAIM]: { status, body: { reason, error: '<b>server text</b>' } } });
      const out = await approveProposal(authFetch, token('confirm_session', { sessionId: C }));
      assert.equal(out.state, state);
      assert.equal(out.message, OUTCOMES[state]);
      assert.deepEqual(calls.map((x) => x.path), [CLAIM]);
    });
  }

  await t.test('a claim that never answers runs nothing', async () => {
    const { authFetch, calls } = fake({ [CLAIM]: { throws: 'TypeError' } });
    const out = await approveProposal(authFetch, token('confirm_session', { sessionId: C }));
    assert.equal(out.state, 'failed');
    assert.deepEqual(calls.map((x) => x.path), [CLAIM]);
  });
});

test('one already past its time is not even claimed', async () => {
  const { authFetch, calls } = fake();
  const out = await approveProposal(authFetch, token('confirm_session', { sessionId: C }, { exp: Math.floor(Date.now() / 1000) - 1 }));
  assert.equal(out.state, 'expired');
  assert.equal(calls.length, 0);
});

test('the real route refusing is reported as refused, and in our words', async () => {
  const { authFetch, calls } = fake({ real: { status: 400, body: { error: '<img src=x> from the server' } }, [CLAIM]: { status: 200 }, [CLOSE]: { status: 200 } });
  const out = await approveProposal(authFetch, token('confirm_session', { sessionId: C }));
  assert.equal(out.state, 'refused');
  assert.equal(out.message, OUTCOMES.refused);
  assert.equal(calls.length, 3);
});

test('a lost answer is never retried, and says it cannot tell', async () => {
  const path = `/api/sessions/${C}`;
  const { authFetch, calls } = fake({ [path]: { throws: 'TypeError' } });
  const out = await approveProposal(authFetch, token('confirm_session', { sessionId: C }));
  assert.equal(out.state, 'unknown');
  assert.equal(out.message, OUTCOMES.unknown);
  assert.equal(calls.filter((x) => x.path === path).length, 1);
});

test('closing failing changes nothing about the outcome', async () => {
  const { authFetch } = fake({ [CLOSE]: { throws: 'TypeError' } });
  const out = await approveProposal(authFetch, token('confirm_session', { sessionId: C }));
  assert.equal(out.state, 'done');
});

test('dismissing runs nothing but the close', async () => {
  const { authFetch, calls } = fake();
  const out = await dismissProposal(authFetch, token('confirm_session', { sessionId: C }));
  assert.equal(out.state, 'dismissed');
  assert.deepEqual(calls.map((x) => [x.path, x.body.decision]), [[CLOSE, 'dismissed']]);
});

test('the close says only which of two decisions it was', async () => {
  const { authFetch, calls } = fake();
  const t = token('confirm_session', { sessionId: C });
  await approveProposal(authFetch, t);
  assert.deepEqual(Object.keys(calls.at(-1).body).sort(), ['decision', 'proposal']);
  assert.equal(calls.at(-1).body.decision, 'approved');
});
