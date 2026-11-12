/**
 * S8 Step 2: a rubric's criteria, proposed by the AI service and confirmed by
 * the mentor (D6). The AI service is a stub; nothing here calls a provider.
 *
 * - Only the mentor who set the assignment extracts, reads or confirms.
 * - Extraction is a proposal: it creates no confirmed version.
 * - Each confirmation is a new version; earlier ones are kept unchanged, and
 *   extracting again does not touch them.
 * - A confirmed quote is always copied from the extraction, never sent by the
 *   client; edits, merges, deletions and additions are recorded as such.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { BASE, USERS, start, stop, api } = require('./helpers/harness');
const { nextVersion, JOIN } = require('../lib/criteria');

const SECRET = 'stub-secret';
const QUOTES = [
  'States the invalidation rule as a comment (10 marks).',
  'Explains which entries become stale.',
  'Describes two requests missing at once.'
];
const EXTRACTED = {
  status: 'ok',
  criteria: QUOTES.map((q, i) => ({ id: `c${i + 1}`, sourceText: q, marks: i === 0 ? 10 : null, weight: null })),
  rejected: [{ sourceText: 'Uses Redis.', reason: 'not in the document' }],
  notRead: [],
  calls: 1,
  promptVersion: 'criteria-v1'
};

let reply = { status: 200, body: EXTRACTED };
let received = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    received.push({ path: req.url, secret: req.headers['x-ai-secret'], body: raw ? JSON.parse(raw) : null });
    res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply.body));
  });
});

let m1;
test.before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  await start({ extraEnv: { AI_SERVICE_URL: `http://127.0.0.1:${stub.address().port}`, AI_SERVICE_SECRET: SECRET } });
  m1 = await api('/api/mentorships', {
    as: USERS.mentor, method: 'POST', body: { studentId: USERS.student._id, topic: 'Backend' }
  }).then((r) => r.json());
  await api('/api/mentorships', {
    as: USERS.admin, method: 'POST', body: { studentId: USERS.student._id, topic: 'Other' }
  });
});
test.after(async () => {
  await stop();
  stub.close();
});

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

async function workWithRubric(title, { mark = true } = {}) {
  const a = await api('/api/assignments', {
    as: USERS.mentor, method: 'POST', body: { title, dueAt: inDays(7), mentorshipIds: [m1._id] }
  }).then((r) => r.json());
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 rubric'], { type: 'application/pdf' }), 'rubric.pdf');
  const up = await fetch(`${BASE}/api/assignments/${a._id}/files`, {
    method: 'POST', headers: { 'X-Dev-User-Id': USERS.mentor._id }, body: form
  }).then((r) => r.json());
  const file = up.attachments[0];
  if (mark) {
    await api(`/api/assignments/${a._id}/files/${file.fileId}`, { as: USERS.mentor, method: 'PATCH', body: { rubric: true } });
  }
  return { a, file };
}

const extract = (as, a) => api(`/api/assignments/${a._id}/criteria/extract`, { as, method: 'POST' });
const list = (as, a) => api(`/api/assignments/${a._id}/criteria`, { as });
const confirm = (as, a, setId, criteria) =>
  api(`/api/assignments/${a._id}/criteria/${setId}/confirm`, { as, method: 'POST', body: { criteria } });

// ---------------------------------------------------------------------------
// The rule, on its own
// ---------------------------------------------------------------------------
test('nextVersion: what comes from the client and what never does', async (t) => {
  const set = { extracted: { criteria: EXTRACTED.criteria }, versions: [] };

  await t.test('kept, edited, merged and added, each recorded as such', () => {
    const { criteria, error } = nextVersion(set, [
      { text: QUOTES[0], from: ['c1'], marks: 10 },
      { text: 'Says which entries go stale, and why', from: ['c2'] },
      { text: 'Covers stale entries and concurrent misses', from: ['c2', 'c3'] },
      { text: 'Includes a test', from: [] }
    ]);
    assert.equal(error, undefined);
    assert.deepEqual(criteria.map((c) => [c.id, c.origin, c.sourceText]), [
      ['k1', 'extracted', QUOTES[0]],
      ['k2', 'edited', QUOTES[1]],
      ['k3', 'merged', `${QUOTES[1]}${JOIN}${QUOTES[2]}`],
      ['k4', 'added', null]
    ]);
    assert.equal(criteria[0].marks, 10);
  });

  await t.test('a quote sent by the client is refused, never stored', () => {
    assert.match(nextVersion(set, [{ text: 'x', from: ['c1'], sourceText: 'Invented quote' }]).error, /unknown field sourceText/);
  });

  for (const [why, sent, msg] of [
    ['nothing', [], /at least one/],
    ['not a list', 'all of them', /at least one/],
    ['no text', [{ text: '  ', from: ['c1'] }], /no text/],
    ['an unknown source', [{ text: 'x', from: ['c9'] }], /c9, which is not in this checklist/],
    ['one source twice', [{ text: 'x', from: ['c1', 'c1'] }], /twice/],
    ['marks out of range', [{ text: 'x', from: ['c1'], marks: -1 }], /marks/],
    ['marks as text', [{ text: 'x', from: ['c1'], marks: '10' }], /marks/],
    ['a weight over 100', [{ text: 'x', from: ['c1'], weight: 120 }], /weight/],
    ['too many', Array.from({ length: 41 }, () => ({ text: 'x', from: [] })), /At most 40/],
    ['text too long', [{ text: 'x'.repeat(1001), from: [] }], /longer than 1000/]
  ]) {
    await t.test(`refuses ${why}`, () => assert.match(nextVersion(set, sent).error, msg));
  }

  await t.test('an unchanged criterion carried into the next version keeps its origin', () => {
    const v1 = nextVersion(set, [{ text: 'Reworded', from: ['c1'] }]).criteria;
    const next = nextVersion({ ...set, versions: [{ n: 1, criteria: v1 }] }, [{ text: 'Reworded', from: ['k1'] }]);
    assert.deepEqual([next.criteria[0].origin, next.criteria[0].sourceText], ['edited', QUOTES[0]]);
  });
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------
test('only the mentor who set the assignment extracts, reads or confirms', async (t) => {
  const { a } = await workWithRubric('Who');
  received = [];
  for (const [who, as, status] of [['the student', USERS.student, 403], ['another mentor of the student', USERS.admin, 403]]) {
    await t.test(who, async () => {
      assert.equal((await extract(as, a)).status, status);
      assert.equal((await list(as, a)).status, status);
      assert.equal((await confirm(as, a, '0000000000000000000000ff', [{ text: 'x' }])).status, status);
    });
  }
  await t.test('nobody signed in', async () => {
    const res = await fetch(`${BASE}/api/assignments/${a._id}/criteria`);
    assert.equal(res.status, 401);
  });
  await t.test('and the AI service was never asked', () => assert.deepEqual(received, []));
});

test('extraction is read as the mentor, in their mentorship, and is only a proposal', async () => {
  const { a, file } = await workWithRubric('Extract');
  received = [];
  const res = await extract(USERS.mentor, a);
  assert.equal(res.status, 200);
  const set = await res.json();
  assert.deepEqual(received.map((r) => [r.path, r.secret, r.body]), [[
    '/criteria/extract', SECRET,
    { mentorshipId: String(m1._id), viewerId: USERS.mentor._id, fileId: String(file.fileId) }
  ]]);
  assert.deepEqual(set.source, { kind: 'rubric', fileId: String(file.fileId), fileName: 'rubric.pdf' });
  assert.deepEqual(set.extracted.criteria.map((c) => c.id.replace(/^x[0-9a-z]+-/, '')), ['c1', 'c2', 'c3']);
  assert.match(set.extracted.criteria[0].id, /^x[0-9a-z]+-c1$/, 'each extraction has ids of its own');
  assert.deepEqual(set.extracted.rejected, EXTRACTED.rejected);
  assert.deepEqual(set.versions, []);
  assert.equal(set.latest, null, 'nothing confirmed, so nothing may be assessed');
});

test('extraction needs a rubric, and passes on what the service could not do', async (t) => {
  await t.test('no rubric marked', async () => {
    const { a } = await workWithRubric('No rubric', { mark: false });
    received = [];
    const res = await extract(USERS.mentor, a);
    assert.equal(res.status, 400);
    assert.deepEqual(received, []);
  });
  const { a } = await workWithRubric('Upstream');
  for (const [status, body, expect] of [
    [404, { status: 'unreadable', message: 'x' }, 409],
    [503, { status: 'error', message: 'Rubric checks are not configured on this server.' }, 503],
    [500, { detail: 'boom' }, 502]
  ]) {
    await t.test(`the service answers ${status}`, async () => {
      reply = { status, body };
      const res = await extract(USERS.mentor, a);
      assert.equal(res.status, expect);
      const err = (await res.json()).error;
      assert.ok(!err.includes('boom'), 'never the upstream\'s own text');
    });
  }
  reply = { status: 200, body: EXTRACTED };
  await t.test('and nothing was stored', async () => {
    assert.deepEqual((await list(USERS.mentor, a).then((r) => r.json())).sets, []);
  });
});

test('each confirmation is a new version, and earlier ones are kept unchanged', async () => {
  const { a } = await workWithRubric('Versions');
  const set = await extract(USERS.mentor, a).then((r) => r.json());
  const [c1, c2, c3] = set.extracted.criteria.map((c) => c.id);

  const v1res = await confirm(USERS.mentor, a, set.id, [
    { text: QUOTES[0], from: [c1], marks: 10 },
    { text: 'Covers stale entries and concurrent misses', from: [c2, c3] }
  ]);
  assert.equal(v1res.status, 201);
  const afterV1 = await v1res.json();
  assert.equal(afterV1.latest.n, 1);
  assert.deepEqual(afterV1.latest.criteria.map((c) => c.origin), ['extracted', 'merged']);
  const v1 = afterV1.versions[0];

  // Edit one, delete the merged one, add one.
  const v2res = await confirm(USERS.mentor, a, set.id, [
    { text: 'States the rule in a comment', from: ['k1'], marks: 8 },
    { text: 'Includes a test', from: [] }
  ]);
  assert.equal(v2res.status, 201);
  const afterV2 = await v2res.json();
  assert.deepEqual(afterV2.versions.map((v) => v.n), [1, 2]);
  assert.deepEqual(afterV2.versions[0], v1, 'version 1 is unchanged');
  assert.deepEqual(afterV2.latest.criteria.map((c) => [c.origin, c.sourceText, c.marks]), [
    ['edited', QUOTES[0], 8],
    ['added', null, null]
  ]);

  // Extracting again replaces the proposal and nothing else.
  reply = { status: 200, body: { ...EXTRACTED, criteria: EXTRACTED.criteria.slice(0, 1) } };
  const again = await extract(USERS.mentor, a).then((r) => r.json());
  reply = { status: 200, body: EXTRACTED };
  assert.equal(again.extracted.criteria.length, 1);
  assert.deepEqual(again.versions, afterV2.versions);

  // A screen still holding the earlier extraction cannot confirm its ids against the new one.
  const stale = await confirm(USERS.mentor, a, set.id, [{ text: 'x', from: [c1] }]);
  assert.equal(stale.status, 400);
  assert.match((await stale.json()).error, /not in this checklist/);
});

test('a confirmation that refers to nothing in the checklist is refused and stores nothing', async () => {
  const { a } = await workWithRubric('Bad confirm');
  const set = await extract(USERS.mentor, a).then((r) => r.json());
  const res = await confirm(USERS.mentor, a, set.id, [{ text: 'x', from: ['c7'] }]);
  assert.equal(res.status, 400);
  assert.deepEqual((await list(USERS.mentor, a).then((r) => r.json())).sets[0].versions, []);
  assert.equal((await confirm(USERS.mentor, a, 'not-an-id', [{ text: 'x' }])).status, 404);
});

test('a checklist from another assignment cannot be confirmed through this one', async () => {
  const { a } = await workWithRubric('Mine');
  const { a: b } = await workWithRubric('Other');
  const set = await extract(USERS.mentor, a).then((r) => r.json());
  assert.equal((await confirm(USERS.mentor, b, set.id, [{ text: 'x', from: [] }])).status, 404);
});

test('two confirmations at once cannot both become the same version', async () => {
  const { a } = await workWithRubric('Race');
  const set = await extract(USERS.mentor, a).then((r) => r.json());
  const results = await Promise.all([1, 2, 3].map((i) => confirm(USERS.mentor, a, set.id, [{ text: `Take ${i}`, from: [] }])));
  const statuses = results.map((r) => r.status).sort();
  const final = (await list(USERS.mentor, a).then((r) => r.json())).sets[0];
  assert.deepEqual(final.versions.map((v) => v.n), Array.from({ length: final.versions.length }, (_, i) => i + 1));
  assert.equal(statuses.filter((s) => s === 201).length, final.versions.length);
  assert.ok(statuses.every((s) => s === 201 || s === 409), statuses.join());
});

test('withdrawing the assignment removes its checklists', async () => {
  const { db, mongoose } = require('./helpers/harness');
  const { a } = await workWithRubric('Withdrawn');
  await extract(USERS.mentor, a);
  const mine = { assignment: new mongoose.Types.ObjectId(String(a._id)) };
  assert.equal(await db().collection('criteriasets').countDocuments(mine), 1);
  assert.equal((await api(`/api/assignments/${a._id}`, { as: USERS.mentor, method: 'DELETE' })).status, 200);
  assert.equal(await db().collection('criteriasets').countDocuments(mine), 0);
});
