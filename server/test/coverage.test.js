/**
 * S8 Step 3: POST /api/submissions/:id/coverage. The AI service is a stub.
 *
 * - Only the mentor who set the assignment, in their own active mentorship.
 * - Nothing is assessed until the checklist has a confirmed version.
 * - The service is sent this hand-in's own text (never the mentor's review),
 *   its own files, and the confirmed criteria; nothing else.
 * - The reply passes on only named fields (a total from upstream never
 *   reaches the mentor), and nothing is written to the hand-in or sent to the
 *   student.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { BASE, USERS, start, stop, api } = require('./helpers/harness');

const SECRET = 'stub-secret';
const VERDICT = {
  criterionId: 'k1', criterion: 'States the rule', verdict: 'met', label: 'Met', present: 'It does.', absent: '',
  reason: null, reasonText: null, evidence: [{ handle: 'E1', quote: 'My rule', where: { file: null } }],
  strippedCitations: [], suggestedMarks: 8, maxMarks: 10, suggestion: true
};
const ASSESSED = {
  status: 'ok', verdicts: [{ ...VERDICT, grade: 'A', score: 8 }], notRead: [], setAside: [], droppedQuotes: 0,
  calls: 2, promptVersion: 'coverage-v1', total: 8, score: 8, overall: 'Good'
};
const EXTRACTED = {
  status: 'ok', criteria: [{ id: 'c1', sourceText: 'States the rule (10 marks).', marks: 10, weight: null }],
  rejected: [], notRead: [], calls: 1, promptVersion: 'criteria-v1'
};

let received = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    received.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
    const body = req.url === '/criteria/extract' ? EXTRACTED : ASSESSED;
    const send = () => !res.destroyed && res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    // A hand-in whose text says SLOW is answered after the route has given up.
    if (raw.includes('SLOW')) setTimeout(send, 1500);
    else send();
  });
});

let m1;
test.before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  await start({ extraEnv: { AI_SERVICE_URL: `http://127.0.0.1:${stub.address().port}`, AI_SERVICE_SECRET: SECRET, COVERAGE_ASSESS_TIMEOUT_MS: '600' } });
  m1 = await api('/api/mentorships', {
    as: USERS.mentor, method: 'POST', body: { studentId: USERS.student._id, topic: 'Backend' }
  }).then((r) => r.json());
  await api('/api/mentorships', { as: USERS.admin, method: 'POST', body: { studentId: USERS.student._id, topic: 'Other' } });
});
test.after(async () => {
  await stop();
  stub.close();
});

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

function upload(path, as, name, content) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'application/pdf' }), name);
  return fetch(`${BASE}${path}`, { method: 'POST', headers: { 'X-Dev-User-Id': as._id }, body: form }).then((r) => r.json());
}

/** Work with a rubric, its checklist extracted (and confirmed unless told not to), and the student's hand-in. */
async function scene(title, { confirmed = true, handIn = true } = {}) {
  const a = await api('/api/assignments', {
    as: USERS.mentor, method: 'POST', body: { title, dueAt: inDays(7), mentorshipIds: [m1._id] }
  }).then((r) => r.json());
  const rubric = (await upload(`/api/assignments/${a._id}/files`, USERS.mentor, 'rubric.pdf', '%PDF-1.4 r')).attachments[0];
  await api(`/api/assignments/${a._id}/files/${rubric.fileId}`, { as: USERS.mentor, method: 'PATCH', body: { rubric: true } });
  const set = await api(`/api/assignments/${a._id}/criteria/extract`, { as: USERS.mentor, method: 'POST' }).then((r) => r.json());
  if (confirmed) {
    await api(`/api/assignments/${a._id}/criteria/${set.id}/confirm`, {
      as: USERS.mentor, method: 'POST', body: { criteria: [{ text: 'States the rule', from: [set.extracted.criteria[0].id], marks: 10 }] }
    });
  }
  const { mine } = await api('/api/assignments', { as: USERS.student }).then((r) => r.json());
  const sub = mine.find((s) => String(s.assignment._id) === String(a._id));
  let file = null;
  if (handIn) {
    file = (await upload(`/api/submissions/${sub._id}/files`, USERS.student, 'mine.pdf', '%PDF-1.4 mine')).attachments[0];
    await api(`/api/submissions/${sub._id}`, { as: USERS.student, method: 'PUT', body: { text: 'My rule clears one list.' } });
  }
  return { a, set, sub, file };
}

const check = (as, sub, setId) => api(`/api/submissions/${sub._id}/coverage`, { as, method: 'POST', body: { setId } });

test('only the mentor who set the assignment can check a hand-in', async (t) => {
  const { sub, set } = await scene('Who');
  received = [];
  for (const [who, as] of [['the student', USERS.student], ['another mentor of the student', USERS.admin]]) {
    await t.test(who, async () => assert.equal((await check(as, sub, set.id)).status, 403));
  }
  await t.test('nobody signed in', async () => {
    const res = await fetch(`${BASE}/api/submissions/${sub._id}/coverage`, { method: 'POST' });
    assert.equal(res.status, 401);
  });
  await t.test('and the AI service was never asked', () => assert.deepEqual(received, []));
});

test('nothing is assessed until the checklist is confirmed', async () => {
  const { sub, set } = await scene('Unconfirmed', { confirmed: false });
  received = [];
  const res = await check(USERS.mentor, sub, set.id);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /Confirm the checklist first/);
  assert.deepEqual(received, []);
});

test('a checklist from another assignment, or none, is not found', async () => {
  const { sub } = await scene('Mine');
  const { set: other } = await scene('Other');
  received = [];
  assert.equal((await check(USERS.mentor, sub, other.id)).status, 404);
  assert.equal((await check(USERS.mentor, sub, 'nope')).status, 404);
  assert.deepEqual(received, []);
});

test('an empty hand-in has nothing to check', async () => {
  const { sub, set } = await scene('Empty', { handIn: false });
  assert.equal((await check(USERS.mentor, sub, set.id)).status, 400);
});

test('the service gets this hand-in\'s own text and files and the confirmed criteria, never the review', async () => {
  const { sub, set, file } = await scene('What is sent');
  // A review exists, so the hand-in has the mentor's words on it.
  await api(`/api/submissions/${sub._id}`, {
    as: USERS.mentor, method: 'PATCH', body: { action: 'request-changes', note: 'Mentor private remark about the rule' }
  });
  received = [];
  const res = await check(USERS.mentor, sub, set.id);
  assert.equal(res.status, 200);
  const [call] = received;
  assert.equal(call.path, '/coverage/assess');
  assert.deepEqual(call.body, {
    mentorshipId: String(m1._id),
    viewerId: USERS.mentor._id,
    submissionId: String(sub._id),
    text: 'My rule clears one list.',
    files: [{ fileId: String(file.fileId), name: 'mine.pdf' }],
    criteria: [{ id: 'k1', text: 'States the rule', marks: 10 }]
  });
  assert.ok(!JSON.stringify(call.body).includes('Mentor private remark'));
});

test('the reply is a draft of named fields only, and nothing is written or sent', async () => {
  const { sub, set } = await scene('Reply');
  const before = await api(`/api/assignments`, { as: USERS.student }).then((r) => r.json());
  const res = await check(USERS.mentor, sub, set.id);
  const body = await res.json();
  assert.equal(body.draft, true);
  assert.deepEqual(body.checklist, { setId: set.id, version: 1, source: set.source });
  assert.deepEqual(body.verdicts, [VERDICT], 'the upstream verdict\'s extra field is dropped');
  for (const k of ['total', 'score', 'overall', 'grade']) {
    assert.ok(!(k in body), `${k} from upstream never reaches the mentor`);
  }
  const after = await api(`/api/assignments`, { as: USERS.student }).then((r) => r.json());
  const mineBefore = before.mine.find((s) => s._id === String(sub._id));
  const mineAfter = after.mine.find((s) => s._id === String(sub._id));
  assert.deepEqual(mineAfter.history, mineBefore.history);
  assert.deepEqual(mineAfter.review, mineBefore.review);
  assert.equal(mineAfter.status, mineBefore.status);
});

test('a hand-in in a mentorship that has ended cannot be checked', async () => {
  const m = await api('/api/mentorships', {
    as: USERS.mentor, method: 'POST', body: { studentId: USERS.student2._id, topic: 'Ends' }
  }).then((r) => r.json());
  const a = await api('/api/assignments', {
    as: USERS.mentor, method: 'POST', body: { title: 'Ended', dueAt: inDays(7), mentorshipIds: [m._id] }
  }).then((r) => r.json());
  const rubric = (await upload(`/api/assignments/${a._id}/files`, USERS.mentor, 'rubric.pdf', '%PDF-1.4 r')).attachments[0];
  await api(`/api/assignments/${a._id}/files/${rubric.fileId}`, { as: USERS.mentor, method: 'PATCH', body: { rubric: true } });
  const set = await api(`/api/assignments/${a._id}/criteria/extract`, { as: USERS.mentor, method: 'POST' }).then((r) => r.json());
  await api(`/api/assignments/${a._id}/criteria/${set.id}/confirm`, {
    as: USERS.mentor, method: 'POST', body: { criteria: [{ text: 'States the rule', from: [set.extracted.criteria[0].id] }] }
  });
  const { mine } = await api('/api/assignments', { as: USERS.student2 }).then((r) => r.json());
  const sub = mine.find((s) => String(s.assignment._id) === String(a._id));
  await api(`/api/submissions/${sub._id}`, { as: USERS.student2, method: 'PUT', body: { text: 'My answer.' } });
  assert.equal((await check(USERS.mentor, sub, set.id)).status, 200, 'checkable while active');

  assert.equal((await api(`/api/mentorships/${m._id}`, { as: USERS.mentor, method: 'PATCH', body: { action: 'end' } })).status, 200);
  received = [];
  assert.equal((await check(USERS.mentor, sub, set.id)).status, 403);
  assert.deepEqual(received, []);
});

test('a check that takes too long says so, and the reply is not a verdict', async () => {
  const { sub, set } = await scene('Slow', { handIn: false });
  await api(`/api/submissions/${sub._id}`, { as: USERS.student, method: 'PUT', body: { text: 'SLOW answer.' } });
  const res = await check(USERS.mentor, sub, set.id);
  assert.equal(res.status, 504);
  const body = await res.json();
  assert.match(body.error, /took too long/);
  assert.ok(!('verdicts' in body));
});
