/**
 * Assignment files — attachments on the brief itself.
 *
 * Who may do what, for every role:
 * - the mentor who set it: upload, list, download, remove
 * - a student it was set for: list and download, never upload or remove
 * - a student of the same mentor it was NOT set for: nothing
 * - another mentor of the same student: nothing
 * - nobody signed in: nothing
 * And: the same limits as hand-in files, a file reached only through its own
 * brief, the student sees the files on the brief, and withdrawing the
 * assignment deletes the bytes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, USERS, start, stop, api, db, mongoose } = require('./helpers/harness');

let m1; // mentor → student: the work is set here
let m2; // mentor → student2: not set here

const addStudent = (as, studentId, topic) =>
  api('/api/mentorships', { as, method: 'POST', body: { studentId, topic } }).then((r) => r.json());

test.before(async () => {
  await start();
  m1 = await addStudent(USERS.mentor, USERS.student._id, 'Backend interviews');
  m2 = await addStudent(USERS.mentor, USERS.student2._id, 'System design');
  // `admin` becomes another mentor of the same student.
  await addStudent(USERS.admin, USERS.student._id, 'Something else');
});

test.after(() => stop());

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

function upload(as, assignmentId, name, content, type = 'application/pdf') {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  return fetch(`${BASE}/api/assignments/${assignmentId}/files`, {
    method: 'POST',
    headers: as ? { 'X-Dev-User-Id': as._id } : {},
    body: form
  });
}

const list = (as, id) => api(`/api/assignments/${id}/files`, { as });
const download = (as, id, fileId) => api(`/api/assignments/${id}/files/${fileId}`, { as });
const remove = (as, id, fileId) => api(`/api/assignments/${id}/files/${fileId}`, { as, method: 'DELETE' });
const anon = (path, method = 'GET') => fetch(`${BASE}${path}`, { method });

const stored = (fileId) =>
  db().collection('attachments.files').findOne({ _id: new mongoose.Types.ObjectId(String(fileId)) });

async function setWork(title, mentorshipIds = [m1._id]) {
  const res = await api('/api/assignments', {
    as: USERS.mentor,
    method: 'POST',
    body: { title, dueAt: inDays(7), mentorshipIds }
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function attached(a, name = 'brief.pdf', content = '%PDF-1.4 the brief') {
  const res = await upload(USERS.mentor, a._id, name, content);
  assert.equal(res.status, 201);
  return (await res.json()).attachments.at(-1);
}

test('the mentor who set it uploads, lists, downloads and removes', async (t) => {
  const a = await setWork('Read the brief');
  const CONTENT = '%PDF-1.4 the brief';
  const file = await attached(a, 'brief.pdf', CONTENT);

  await t.test('it is listed, and the bytes are stored', async () => {
    assert.equal(file.name, 'brief.pdf');
    assert.equal(file.size, Buffer.byteLength(CONTENT));
    assert.ok(await stored(file.fileId));
    const res = await list(USERS.mentor, a._id);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).attachments.map((f) => f.name), ['brief.pdf']);
  });

  await t.test('it downloads as a file, never as a page', async () => {
    const res = await download(USERS.mentor, a._id, file.fileId);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), CONTENT);
    assert.match(res.headers.get('content-disposition'), /^attachment;/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
  });

  await t.test('removing it takes the record and the bytes', async () => {
    const res = await remove(USERS.mentor, a._id, file.fileId);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).attachments, []);
    assert.equal(await stored(file.fileId), null);
    assert.equal((await download(USERS.mentor, a._id, file.fileId)).status, 404);
  });
});

test('a student it was set for lists and downloads, and sees the files on the brief', async (t) => {
  const a = await setWork('Brief with a file');
  const file = await attached(a);

  await t.test('list and download', async () => {
    const res = await list(USERS.student, a._id);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).attachments.length, 1);
    assert.equal((await download(USERS.student, a._id, file.fileId)).status, 200);
  });

  await t.test('the files are on the brief in their own work', async () => {
    const { mine } = await api('/api/assignments', { as: USERS.student }).then((r) => r.json());
    const own = mine.find((s) => String(s.assignment._id) === String(a._id));
    assert.deepEqual(own.assignment.attachments.map((f) => f.name), ['brief.pdf']);
  });

  await t.test('but never uploads or removes', async () => {
    assert.equal((await upload(USERS.student, a._id, 'mine.pdf', '%PDF-1.4 x')).status, 403);
    assert.equal((await remove(USERS.student, a._id, file.fileId)).status, 403);
    assert.ok(await stored(file.fileId));
  });
});

test('nobody else can do anything with them', async (t) => {
  const a = await setWork('Only for the first student');
  const file = await attached(a);

  const outsiders = [
    ['a student of the same mentor it was not set for', USERS.student2],
    ['another mentor of the same student', USERS.admin]
  ];
  for (const [who, as] of outsiders) {
    await t.test(who, async () => {
      assert.equal((await list(as, a._id)).status, 403);
      assert.equal((await download(as, a._id, file.fileId)).status, 403);
      assert.equal((await upload(as, a._id, 'x.pdf', '%PDF-1.4 x')).status, 403);
      assert.equal((await remove(as, a._id, file.fileId)).status, 403);
    });
  }

  await t.test('nobody signed in', async () => {
    assert.equal((await anon(`/api/assignments/${a._id}/files`)).status, 401);
    assert.equal((await anon(`/api/assignments/${a._id}/files/${file.fileId}`)).status, 401);
    assert.equal((await upload(null, a._id, 'x.pdf', '%PDF-1.4 x')).status, 401);
    assert.equal((await anon(`/api/assignments/${a._id}/files/${file.fileId}`, 'DELETE')).status, 401);
  });

  await t.test('and the file is still there, untouched', async () => {
    assert.ok(await stored(file.fileId));
    assert.equal((await list(USERS.mentor, a._id).then((r) => r.json())).attachments.length, 1);
  });
});

test('a student added later can then open them', async () => {
  const a = await setWork('Joined late');
  const file = await attached(a);
  assert.equal((await download(USERS.student2, a._id, file.fileId)).status, 403);

  const res = await api(`/api/assignments/${a._id}`, {
    as: USERS.mentor,
    method: 'PATCH',
    body: { addMentorshipIds: [m2._id] }
  });
  assert.equal(res.status, 200);
  assert.equal((await download(USERS.student2, a._id, file.fileId)).status, 200);
});

test('a file is reached only through its own brief', async () => {
  const a = await setWork('First');
  const b = await setWork('Second');
  const file = await attached(a);
  assert.equal((await download(USERS.mentor, b._id, file.fileId)).status, 404);
  assert.equal((await download(USERS.student, b._id, file.fileId)).status, 404);
  assert.equal((await remove(USERS.mentor, b._id, file.fileId)).status, 404);
  assert.ok(await stored(file.fileId));
});

test('the same limits as hand-in files', async (t) => {
  await t.test('only allowed kinds of file', async () => {
    const a = await setWork('Kinds');
    const res = await upload(USERS.mentor, a._id, 'run.exe', 'MZ', 'application/octet-stream');
    assert.equal(res.status, 400);
    assert.equal((await list(USERS.mentor, a._id).then((r) => r.json())).attachments.length, 0);
  });

  await t.test('not empty', async () => {
    const a = await setWork('Empty');
    assert.equal((await upload(USERS.mentor, a._id, 'empty.pdf', '')).status, 400);
  });

  await t.test('at most ten megabytes', async () => {
    const a = await setWork('Big');
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 'a');
    assert.equal((await upload(USERS.mentor, a._id, 'big.pdf', big)).status, 413);
  });

  await t.test('at most five files', async () => {
    const a = await setWork('Five');
    for (let i = 1; i <= 5; i++) await attached(a, `part${i}.pdf`);
    const res = await upload(USERS.mentor, a._id, 'part6.pdf', '%PDF-1.4 six');
    assert.equal(res.status, 400);
    assert.equal((await list(USERS.mentor, a._id).then((r) => r.json())).attachments.length, 5);
  });
});

test('a missing or malformed assignment is not found', async () => {
  assert.equal((await list(USERS.mentor, '0000000000000000000000ff')).status, 404);
  assert.equal((await list(USERS.mentor, 'not-an-id')).status, 404);
  assert.equal((await upload(USERS.mentor, '0000000000000000000000ff', 'x.pdf', '%PDF-1.4 x')).status, 404);
});

test('withdrawing the assignment deletes the brief\'s files', async () => {
  const a = await setWork('Withdrawn');
  const file = await attached(a);
  const res = await api(`/api/assignments/${a._id}`, { as: USERS.mentor, method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(await stored(file.fileId), null);
});
