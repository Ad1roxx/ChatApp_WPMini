/**
 * S8 Step 4: rubric, brief and summary mode. The AI service is a stub.
 *
 * - The rule: a rubric means rubric mode; otherwise the brief's extracted
 *   checklist decides, brief mode at N = 3 or more, summary mode below.
 * - Brief mode is labelled "assessed against the assignment brief; no rubric
 *   was provided" and, like a rubric's, needs a confirmed checklist.
 * - Summary mode carries no verdict and no marks, even if upstream sends them.
 * - The mentor can override within what exists; once a rubric is confirmed, a
 *   check in another mode says the rubric is available, and the next check by
 *   the rule is in rubric mode.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { BASE, USERS, start, stop, api } = require('./helpers/harness');
const { chooseMode, LABELS, N } = require('../lib/coverageMode');

const SECRET = 'stub-secret';
const crit = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, sourceText: `Requirement ${i + 1}.`, marks: null, weight: null }));
let briefItems = 3;
let received = [];
const VERDICT = { criterionId: 'k1', criterion: 'x', verdict: 'met', label: 'Met', evidence: [], suggestedMarks: null, suggestion: true };
const POINT = { point: 'Describes a cache.', evidence: { quote: 'My rule', where: { file: null } } };

const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    received.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
    const reply = {
      '/criteria/extract': { status: 'ok', criteria: crit(2), rejected: [], notRead: [], promptVersion: 'criteria-v1' },
      '/criteria/extract-brief': { status: 'ok', criteria: crit(briefItems), rejected: [], notRead: [], promptVersion: 'criteria-v1' },
      '/coverage/assess': { status: 'ok', verdicts: [VERDICT], notRead: [], setAside: [], calls: 2 },
      // A summary that tries to smuggle verdicts and marks in.
      '/coverage/summary': {
        status: 'ok', points: [{ ...POINT, verdict: 'met', suggestedMarks: 5 }], notRead: [], setAside: [],
        calls: 1, verdicts: [VERDICT], marks: 5, total: 5
      }
    }[req.url];
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
  });
});

let m1;
test.before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  await start({ extraEnv: { AI_SERVICE_URL: `http://127.0.0.1:${stub.address().port}`, AI_SERVICE_SECRET: SECRET } });
  m1 = await api('/api/mentorships', {
    as: USERS.mentor, method: 'POST', body: { studentId: USERS.student._id, topic: 'Backend' }
  }).then((r) => r.json());
});
test.after(async () => {
  await stop();
  stub.close();
});

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

async function work(title, instructions = 'Add caching. Write the rule. Explain staleness.') {
  const a = await api('/api/assignments', {
    as: USERS.mentor, method: 'POST', body: { title, instructions, dueAt: inDays(7), mentorshipIds: [m1._id] }
  }).then((r) => r.json());
  const { mine } = await api('/api/assignments', { as: USERS.student }).then((r) => r.json());
  const sub = mine.find((s) => String(s.assignment._id) === String(a._id));
  await api(`/api/submissions/${sub._id}`, { as: USERS.student, method: 'PUT', body: { text: 'My rule clears one list.' } });
  return { a, sub };
}

async function addRubric(a) {
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 r'], { type: 'application/pdf' }), 'rubric.pdf');
  const up = await fetch(`${BASE}/api/assignments/${a._id}/files`, {
    method: 'POST', headers: { 'X-Dev-User-Id': USERS.mentor._id }, body: form
  }).then((r) => r.json());
  await api(`/api/assignments/${a._id}/files/${up.attachments[0].fileId}`, { as: USERS.mentor, method: 'PATCH', body: { rubric: true } });
}

const extract = (a, source) => api(`/api/assignments/${a._id}/criteria/extract`, { as: USERS.mentor, method: 'POST', body: { source } })
  .then((r) => r.json());
const confirm = (a, set) => api(`/api/assignments/${a._id}/criteria/${set.id}/confirm`, {
  as: USERS.mentor, method: 'POST', body: { criteria: set.extracted.criteria.map((c) => ({ text: c.sourceText, from: [c.id] })) }
});
const check = (sub, body = {}) => api(`/api/submissions/${sub._id}/coverage`, { as: USERS.mentor, method: 'POST', body });

function keys(obj, out = new Set()) {
  if (Array.isArray(obj)) obj.forEach((v) => keys(v, out));
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) { out.add(k); keys(v, out); }
  return out;
}

// ---------------------------------------------------------------------------
// The rule, on its own
// ---------------------------------------------------------------------------
test('the rule: rubric, then the brief\'s count against N = 3, then the mentor\'s choice within what exists', () => {
  assert.equal(N, 3);
  assert.equal(chooseMode({ rubricMarked: true, briefCount: 0 }).mode, 'rubric');
  assert.equal(chooseMode({ rubricMarked: true, briefCount: null }).mode, 'rubric');
  assert.deepEqual(chooseMode({ rubricMarked: false, briefCount: null }), { needsBrief: true });
  assert.equal(chooseMode({ rubricMarked: false, briefCount: 2 }).mode, 'summary');
  assert.equal(chooseMode({ rubricMarked: false, briefCount: 3 }).mode, 'brief');
  assert.equal(chooseMode({ rubricMarked: false, briefCount: 0 }).mode, 'summary');
  assert.equal(chooseMode({ rubricMarked: false, briefCount: 3 }).label, 'Assessed against the assignment brief; no rubric was provided');
  assert.deepEqual(chooseMode({ rubricMarked: true, briefCount: 5, override: 'summary' }),
    { mode: 'summary', chosenBy: 'mentor', label: LABELS.summary });
  assert.match(chooseMode({ rubricMarked: false, briefCount: 5, override: 'rubric' }).error, /rubric first/);
  assert.match(chooseMode({ rubricMarked: true, briefCount: null, override: 'brief' }).error, /brief first/);
  assert.match(chooseMode({ rubricMarked: true, briefCount: 3, override: 'grade' }).error, /rubric, brief or summary/);
});

// ---------------------------------------------------------------------------
// Each mode, through the route
// ---------------------------------------------------------------------------
test('rubric mode: a rubric means its checklist, whatever the brief says', async () => {
  const { a, sub } = await work('Rubric mode');
  await addRubric(a);
  await confirm(a, await extract(a, 'rubric'));
  received = [];
  const res = await check(sub);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([body.mode, body.modeLabel, body.modeChosenBy], ['rubric', 'Assessed against the rubric', 'rule']);
  assert.equal(body.checklist.source.kind, 'rubric');
  assert.deepEqual(received.map((r) => r.path), ['/coverage/assess'], 'the brief is not read when a rubric exists');
});

test('brief mode: N or more checkable items, read from the brief, confirmed, and labelled', async () => {
  briefItems = 3;
  const { a, sub } = await work('Brief mode', 'Write the rule. Explain staleness. Add a test.');
  received = [];
  const first = await check(sub);
  assert.equal(first.status, 409, 'the brief\'s checklist must be confirmed first');
  const err = await first.json();
  assert.equal(err.mode, 'brief');
  assert.deepEqual(received.map((r) => r.path), ['/criteria/extract-brief']);
  assert.deepEqual(received[0].body, { text: 'Brief mode\n\nWrite the rule. Explain staleness. Add a test.' });

  const sets = await api(`/api/assignments/${a._id}/criteria`, { as: USERS.mentor }).then((r) => r.json());
  const brief = sets.sets.find((s) => s.source.kind === 'brief');
  assert.equal(brief.id, err.setId);
  await confirm(a, brief);
  received = [];
  const body = await check(sub).then((r) => r.json());
  assert.equal(body.mode, 'brief');
  assert.equal(body.modeLabel, 'Assessed against the assignment brief; no rubric was provided');
  assert.equal(body.checklist.source.kind, 'brief');
  assert.deepEqual(received.map((r) => r.path), ['/coverage/assess'], 'the brief is read once, not on every check');
});

test('summary mode: fewer than N, and no verdict or marks reach the mentor whatever upstream sends', async () => {
  briefItems = 2;
  const { sub } = await work('Summary mode', 'Have a go at caching.');
  received = [];
  const res = await check(sub);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'summary');
  assert.match(body.modeLabel, /^Summary only/);
  assert.equal(body.checklist, null);
  assert.deepEqual(body.points, [POINT]);
  const found = [...keys(body)].filter((k) => /verdict|mark|grade|score|total|label$/i.test(k) && k !== 'modeLabel');
  assert.deepEqual(found, [], 'no verdict or marks anywhere in a summary');
  assert.deepEqual(received.map((r) => r.path), ['/criteria/extract-brief', '/coverage/summary']);
  assert.ok(!('criteria' in received[1].body), 'a summary is never asked against criteria');
});

test('the mentor can override the mode, within what exists', async () => {
  briefItems = 5;
  const { a, sub } = await work('Override');
  await addRubric(a);
  await confirm(a, await extract(a, 'rubric'));

  const summary = await check(sub, { mode: 'summary' }).then((r) => r.json());
  assert.deepEqual([summary.mode, summary.modeChosenBy], ['summary', 'mentor']);
  assert.equal(summary.rubricAvailable, true, 'a confirmed rubric exists: the mentor can regenerate in rubric mode');

  assert.equal((await check(sub, { mode: 'brief' })).status, 400, 'no checklist read from the brief yet');
  await confirm(a, await extract(a, 'brief'));
  const brief = await check(sub, { mode: 'brief' }).then((r) => r.json());
  assert.deepEqual([brief.mode, brief.modeChosenBy, brief.checklist.source.kind], ['brief', 'mentor', 'brief']);
  assert.equal((await check(sub, { mode: 'nonsense' })).status, 400);

  const { sub: plain } = await work('No rubric to choose');
  assert.equal((await check(plain, { mode: 'rubric' })).status, 400);
});

test('once a rubric is added, the next check by the rule is in rubric mode', async () => {
  briefItems = 1;
  const { a, sub } = await work('Regenerate');
  const before = await check(sub).then((r) => r.json());
  assert.equal(before.mode, 'summary');
  assert.equal(before.rubricAvailable, false);

  await addRubric(a);
  assert.equal((await check(sub)).status, 409, 'rubric mode, waiting for its checklist to be confirmed');
  await confirm(a, await extract(a, 'rubric'));
  const after = await check(sub).then((r) => r.json());
  assert.equal(after.mode, 'rubric');
  assert.equal(after.rubricAvailable, false, 'already in rubric mode');
});

test('extracting from the brief is the setting mentor\'s alone, and only rubric or brief', async () => {
  const { a } = await work('Brief extraction');
  assert.equal((await api(`/api/assignments/${a._id}/criteria/extract`, {
    as: USERS.student, method: 'POST', body: { source: 'brief' }
  })).status, 403);
  assert.equal((await api(`/api/assignments/${a._id}/criteria/extract`, {
    as: USERS.mentor, method: 'POST', body: { source: 'submission' }
  })).status, 400);
});
