/**
 * The rubric flag on a brief's file (S8 Step 1, D5, AGENT_PLAN §4.3 property 9).
 *
 * - Only the mentor who set the assignment flags, unflags, shares or unshares.
 * - One rubric per assignment.
 * - An unshared rubric reaches nobody but that mentor, by any route that
 *   returns the brief: the file list and download, the student's own work, the
 *   mentorship's work list, and the reply of every hand-in route a student
 *   uses. Shared, it reaches the students the brief was set for; unshared
 *   again, it is gone from all of them.
 * Search is the index's half of the same rule: ai/tests/test_sync.py.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, USERS, start, stop, api } = require('./helpers/harness');

let m1; // mentor → student: the work is set here

const addStudent = (as, studentId, topic) =>
  api('/api/mentorships', { as, method: 'POST', body: { studentId, topic } }).then((r) => r.json());

test.before(async () => {
  await start();
  m1 = await addStudent(USERS.mentor, USERS.student._id, 'Backend interviews');
  // `admin` becomes another mentor of the same student.
  await addStudent(USERS.admin, USERS.student._id, 'Something else');
});

test.after(() => stop());

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

function uploadTo(path, as, name, content = '%PDF-1.4 x', type = 'application/pdf') {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: as ? { 'X-Dev-User-Id': as._id } : {},
    body: form
  });
}

async function setWork(title) {
  const res = await api('/api/assignments', {
    as: USERS.mentor,
    method: 'POST',
    body: { title, dueAt: inDays(7), mentorshipIds: [m1._id] }
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function attached(a, name) {
  const res = await uploadTo(`/api/assignments/${a._id}/files`, USERS.mentor, name, `%PDF-1.4 ${name}`);
  assert.equal(res.status, 201);
  return (await res.json()).attachments.find((f) => f.name === name);
}

const mark = (as, a, file, body) =>
  api(`/api/assignments/${a._id}/files/${file.fileId}`, { as, method: 'PATCH', body });

/** A brief with two files, one of them the (unshared) rubric. */
async function briefWithRubric(title) {
  const a = await setWork(title);
  const brief = await attached(a, 'brief.pdf');
  const rubric = await attached(a, 'rubric.pdf');
  const res = await mark(USERS.mentor, a, rubric, { rubric: true });
  assert.equal(res.status, 200);
  return { a, brief, rubric };
}

async function mySubmission(as, a) {
  const { mine } = await api('/api/assignments', { as }).then((r) => r.json());
  return mine.find((s) => String(s.assignment._id) === String(a._id));
}

const names = (files) => (files || []).map((f) => f.name).sort();

/** Every way the brief's files reach `as`, by name. */
async function everywhere(as, a) {
  const seen = {};
  const list = await api(`/api/assignments/${a._id}/files`, { as });
  seen['file list'] = list.status === 200 ? names((await list.json()).attachments) : `status ${list.status}`;
  if (as === USERS.student) {
    seen['own work'] = names((await mySubmission(as, a)).assignment.attachments);
  }
  const work = await api(`/api/mentorships/${m1._id}/assignments`, { as }).then((r) => r.json());
  const row = (Array.isArray(work) ? work : work.data || work.submissions || []).find(
    (s) => String(s.assignment._id) === String(a._id)
  );
  seen['mentorship work list'] = names(row.assignment.attachments);
  return seen;
}

test('only the mentor who set the assignment flags or shares', async (t) => {
  const a = await setWork('Who may flag');
  const file = await attached(a, 'rubric.pdf');

  for (const [who, as, status] of [
    ['the student it was set for', USERS.student, 403],
    ['another mentor of the same student', USERS.admin, 403]
  ]) {
    await t.test(who, async () => {
      assert.equal((await mark(as, a, file, { rubric: true })).status, status);
      assert.equal((await mark(as, a, file, { shared: true })).status, status);
    });
  }
  await t.test('nobody signed in', async () => {
    const res = await fetch(`${BASE}/api/assignments/${a._id}/files/${file.fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rubric: true })
    });
    assert.equal(res.status, 401);
  });
  await t.test('and the file is still not the rubric', async () => {
    const files = (await api(`/api/assignments/${a._id}/files`, { as: USERS.mentor }).then((r) => r.json())).attachments;
    assert.ok(!files[0].rubric || !files[0].rubric.isRubric);
  });

  await t.test('the mentor who set it can', async () => {
    const res = await mark(USERS.mentor, a, file, { rubric: true });
    assert.equal(res.status, 200);
    const [f] = (await res.json()).attachments;
    assert.equal(f.rubric.isRubric, true);
    assert.equal(f.rubric.shared, false, 'mentor-only by default');
    assert.ok(f.rubric.changedAt);
  });
});

test('nobody else can unmark or unshare it either', async () => {
  const { a, rubric } = await briefWithRubric('Who may unmark');
  assert.equal((await mark(USERS.mentor, a, rubric, { shared: true })).status, 200);
  for (const as of [USERS.student, USERS.admin]) {
    assert.equal((await mark(as, a, rubric, { shared: false })).status, 403);
    assert.equal((await mark(as, a, rubric, { rubric: false })).status, 403);
  }
  const files = (await api(`/api/assignments/${a._id}/files`, { as: USERS.mentor }).then((r) => r.json())).attachments;
  const f = files.find((x) => x.name === 'rubric.pdf');
  assert.deepEqual([f.rubric.isRubric, f.rubric.shared], [true, true]);
});

test('what the route accepts', async (t) => {
  const a = await setWork('Bodies');
  const file = await attached(a, 'rubric.pdf');
  const other = await attached(a, 'notes.pdf');

  for (const body of [{}, { rubric: 'yes' }, { shared: 1 }, { rubric: true, extra: true }, null]) {
    await t.test(`refuses ${JSON.stringify(body)}`, async () => {
      assert.equal((await mark(USERS.mentor, a, file, body)).status, 400);
    });
  }
  await t.test('only the rubric can be shared', async () => {
    assert.equal((await mark(USERS.mentor, a, other, { shared: true })).status, 400);
  });
  await t.test('a file that is not on this brief is not found', async () => {
    assert.equal((await mark(USERS.mentor, a, { fileId: '0000000000000000000000ff' }, { rubric: true })).status, 404);
  });
  await t.test('unmarking also unshares', async () => {
    await mark(USERS.mentor, a, file, { rubric: true, shared: true });
    const [f] = (await (await mark(USERS.mentor, a, file, { rubric: false })).json()).attachments;
    assert.deepEqual([f.rubric.isRubric, f.rubric.shared], [false, false]);
  });
});

test('one rubric per assignment', async () => {
  const a = await setWork('One rubric');
  const first = await attached(a, 'first.pdf');
  const second = await attached(a, 'second.pdf');
  assert.equal((await mark(USERS.mentor, a, first, { rubric: true })).status, 200);
  const res = await mark(USERS.mentor, a, second, { rubric: true });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /first\.pdf is already the rubric/);

  assert.equal((await mark(USERS.mentor, a, first, { rubric: false })).status, 200);
  assert.equal((await mark(USERS.mentor, a, second, { rubric: true })).status, 200);
});

test('an unshared rubric reaches nobody but the mentor who set it, by any route', async (t) => {
  const { a, brief, rubric } = await briefWithRubric('Private rubric');

  await t.test('the student sees the other file everywhere, and the rubric nowhere', async () => {
    assert.deepEqual(await everywhere(USERS.student, a), {
      'file list': ['brief.pdf'],
      'own work': ['brief.pdf'],
      'mentorship work list': ['brief.pdf']
    });
    assert.equal((await api(`/api/assignments/${a._id}/files/${rubric.fileId}`, { as: USERS.student })).status, 404);
    assert.equal((await api(`/api/assignments/${a._id}/files/${brief.fileId}`, { as: USERS.student })).status, 200);
  });

  await t.test('the mentor who set it sees both', async () => {
    assert.deepEqual(await everywhere(USERS.mentor, a), {
      'file list': ['brief.pdf', 'rubric.pdf'],
      'mentorship work list': ['brief.pdf', 'rubric.pdf']
    });
    assert.equal((await api(`/api/assignments/${a._id}/files/${rubric.fileId}`, { as: USERS.mentor })).status, 200);
  });

  await t.test("the mentor's own view of the assignment carries it", async () => {
    const res = await api(`/api/assignments/${a._id}`, { as: USERS.mentor });
    assert.equal(res.status, 200);
    assert.deepEqual(names((await res.json()).attachments), ['brief.pdf', 'rubric.pdf']);
  });

  await t.test('another mentor of the same student sees neither', async () => {
    assert.equal((await api(`/api/assignments/${a._id}/files`, { as: USERS.admin })).status, 403);
  });

  // Every hand-in route the student uses replies with the brief: none may carry the rubric.
  const sub = await mySubmission(USERS.student, a);
  const replies = [
    ['handing in (PUT)', () => api(`/api/submissions/${sub._id}`, { as: USERS.student, method: 'PUT', body: { text: 'My answer' } })],
    ['unsubmitting', () => api(`/api/submissions/${sub._id}/unsubmit`, { as: USERS.student, method: 'POST' })],
    ['attaching a file to the hand-in', () => uploadTo(`/api/submissions/${sub._id}/files`, USERS.student, 'mine.pdf')]
  ];
  let handInFile;
  for (const [name, act] of replies) {
    await t.test(`the reply to ${name}`, async () => {
      const res = await act();
      assert.ok(res.status === 200 || res.status === 201, `${name}: ${res.status}`);
      const body = await res.json();
      assert.deepEqual(names(body.assignment.attachments), ['brief.pdf']);
      if (name.startsWith('attaching')) handInFile = body.attachments.at(-1);
    });
  }
  await t.test('the reply to removing a file from the hand-in', async () => {
    const res = await api(`/api/submissions/${sub._id}/files/${handInFile.fileId}`, { as: USERS.student, method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(names((await res.json()).assignment.attachments), ['brief.pdf']);
  });
  await t.test('and the reply to the mentor\'s review carries it, because it goes to the mentor', async () => {
    await api(`/api/submissions/${sub._id}`, { as: USERS.student, method: 'PUT', body: { text: 'My answer' } });
    const res = await api(`/api/submissions/${sub._id}`, {
      as: USERS.mentor,
      method: 'PATCH',
      body: { action: 'request-changes', note: 'More, please' }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(names((await res.json()).assignment.attachments), ['brief.pdf', 'rubric.pdf']);
  });
});

test('shared, the students see it everywhere; unshared again, it is gone everywhere', async () => {
  const { a, rubric } = await briefWithRubric('Shared, then not');

  assert.equal((await mark(USERS.mentor, a, rubric, { shared: true })).status, 200);
  assert.deepEqual(await everywhere(USERS.student, a), {
    'file list': ['brief.pdf', 'rubric.pdf'],
    'own work': ['brief.pdf', 'rubric.pdf'],
    'mentorship work list': ['brief.pdf', 'rubric.pdf']
  });
  assert.equal((await api(`/api/assignments/${a._id}/files/${rubric.fileId}`, { as: USERS.student })).status, 200);

  assert.equal((await mark(USERS.mentor, a, rubric, { shared: false })).status, 200);
  assert.deepEqual(await everywhere(USERS.student, a), {
    'file list': ['brief.pdf'],
    'own work': ['brief.pdf'],
    'mentorship work list': ['brief.pdf']
  });
  assert.equal((await api(`/api/assignments/${a._id}/files/${rubric.fileId}`, { as: USERS.student })).status, 404);
});
