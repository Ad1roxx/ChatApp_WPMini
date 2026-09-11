/**
 * Attachments — files handed in with the work.
 *
 * The bytes live in MongoDB (GridFS), and every file is reached THROUGH the
 * hand-in it belongs to: whoever may read the hand-in may read its files, and
 * nobody else. What is tested:
 *
 * - who can attach and who can download — the student, and the mentor who set
 *   the work; not a classmate, not another mentor of the same student
 * - what can be attached — an allow-list, a size cap and a count cap
 * - how it is served — as a download, with a type the server chose, so an
 *   uploaded file can never run as a page on this origin
 * - that files follow the rest of the hand-in's rules: attaching saves a
 *   draft, handed-in work is frozen until unsubmitted, and it is all in the
 *   history
 * - that withdrawing an assignment deletes the files, not just the records
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, USERS, start, stop, api, db, mongoose } = require('./helpers/harness');

let m1; // mentor → student
let m2; // mentor → student2

const addStudent = (as, studentId, topic) =>
  api('/api/mentorships', { as, method: 'POST', body: { studentId, topic } }).then((r) =>
    r.json()
  );

test.before(async () => {
  await start();

  m1 = await addStudent(USERS.mentor, USERS.student._id, 'Backend interviews');
  m2 = await addStudent(USERS.mentor, USERS.student2._id, 'System design');

  // Never read, but it has to exist: it makes `admin` another mentor of the
  // same student, which is what the "not another mentor" download test means.
  await addStudent(USERS.admin, USERS.student._id, 'Something else');
});

test.after(() => stop());

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

/** Multipart, the way the browser sends it — `api()` only speaks JSON. */
function upload(as, subId, name, content, type = 'application/octet-stream') {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);

  return fetch(`${BASE}/api/submissions/${subId}/files`, {
    method: 'POST',
    headers: as ? { 'X-Dev-User-Id': as._id } : {},
    body: form
  });
}

const uploaded = (res) => res.json().then((body) => body.attachments.at(-1));

const fileUrl = (subId, fileId) => `/api/submissions/${subId}/files/${fileId}`;
const download = (as, subId, fileId) => api(fileUrl(subId, fileId), { as });
const detach = (as, subId, fileId) => api(fileUrl(subId, fileId), { as, method: 'DELETE' });
const handIn = (as, subId, body) => api(`/api/submissions/${subId}`, { as, method: 'PUT', body });

/** The stored file's record straight from GridFS, or null once it is gone. */
const stored = (fileId) =>
  db()
    .collection('attachments.files')
    .findOne({ _id: new mongoose.Types.ObjectId(String(fileId)) });

const chunks = (fileId) =>
  db()
    .collection('attachments.chunks')
    .countDocuments({ files_id: new mongoose.Types.ObjectId(String(fileId)) });

/** A student's own hand-in for an assignment. */
async function own(assignmentId, student) {
  const { mine } = await api('/api/assignments', { as: student }).then((r) => r.json());
  return mine.find((s) => String(s.assignment._id) === String(assignmentId));
}

/** Fresh work for both of the mentor's students. */
async function freshWork(title) {
  const res = await api('/api/assignments', {
    as: USERS.mentor,
    method: 'POST',
    body: { title, dueAt: inDays(7), mentorshipIds: [m1._id, m2._id] }
  });
  assert.equal(res.status, 201);

  const a = await res.json();
  return { a, s1: await own(a._id, USERS.student), s2: await own(a._id, USERS.student2) };
}

test('a student attaches a file to their own work', async (t) => {
  const { a, s1 } = await freshWork('Write up the design');
  const CONTENT = '%PDF-1.4 the design';

  const res = await upload(USERS.student, s1._id, 'design.pdf', CONTENT, 'application/pdf');
  const body = await res.json();

  await t.test('it is accepted and listed on the hand-in', () => {
    assert.equal(res.status, 201);
    assert.equal(body.attachments.length, 1);
    assert.equal(body.attachments[0].name, 'design.pdf');
    assert.equal(body.attachments[0].size, Buffer.byteLength(CONTENT));
  });

  await t.test('the bytes are stored in the database', async () => {
    const file = await stored(body.attachments[0].fileId);
    assert.ok(file);
    assert.equal(file.length, Buffer.byteLength(CONTENT));
  });

  await t.test('attaching saves a draft — attached, not handed in', () => {
    assert.equal(body.status, 'draft');
    assert.equal(body.submittedAt, null);
    assert.ok(body.draftSavedAt);
  });

  await t.test('the history says what was attached, and by whom', () => {
    const last = body.history.at(-1);
    assert.equal(last.type, 'file-attached');
    assert.equal(last.detail, 'design.pdf');
    assert.equal(String(last.by), USERS.student._id);
  });

  await t.test('the mentor sees it among the drafts', async () => {
    const view = await api(`/api/assignments/${a._id}`, { as: USERS.mentor }).then((r) =>
      r.json()
    );
    assert.equal(view.summary.drafts, 1);

    const row = view.submissions.find((s) => String(s._id) === String(s1._id));
    assert.equal(row.attachments.length, 1);
  });

  await t.test('source code can be attached too', async () => {
    const code = await upload(USERS.student, s1._id, 'solution.py', 'print("hi")');
    assert.equal(code.status, 201);
  });
});

test('only the student and the mentor who set it can download', async (t) => {
  const { s1, s2 } = await freshWork('Readers');
  const CONTENT = 'hello from the student';
  const file = await uploaded(await upload(USERS.student, s1._id, 'notes.txt', CONTENT));

  await t.test('the student', async () => {
    const res = await download(USERS.student, s1._id, file.fileId);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), CONTENT);
  });

  await t.test('the mentor who set it', async () => {
    const res = await download(USERS.mentor, s1._id, file.fileId);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), CONTENT);
  });

  await t.test('not a classmate', async () => {
    const res = await download(USERS.student2, s1._id, file.fileId);
    assert.equal(res.status, 403);
  });

  await t.test('not another mentor of the same student', async () => {
    // Mentoring this student in something else does not make this yours.
    const res = await download(USERS.admin, s1._id, file.fileId);
    assert.equal(res.status, 403);
  });

  await t.test('not signed out', async () => {
    const res = await download(null, s1._id, file.fileId);
    assert.equal(res.status, 401);
  });

  await t.test('a file is only reachable through its own hand-in', async () => {
    // The mentor may read both hand-ins, but this pairing is wrong: the file
    // belongs to the other one, so there is nothing here.
    const theirs = await uploaded(await upload(USERS.student2, s2._id, 'theirs.txt', 'theirs'));
    const res = await download(USERS.mentor, s1._id, theirs.fileId);
    assert.equal(res.status, 404);
  });

  await t.test('an id that is not an id', async () => {
    const res = await download(USERS.student, s1._id, 'nope');
    assert.equal(res.status, 404);
  });
});

test('files are served as downloads, never as pages', async (t) => {
  const { s1 } = await freshWork('Serving');

  await t.test('the type comes from the extension, not from the upload', async () => {
    // The type a browser claims is whatever the sender says it is.
    const file = await uploaded(
      await upload(USERS.student, s1._id, 'report.pdf', '<script>alert(1)</script>', 'text/html')
    );
    const res = await download(USERS.mentor, s1._id, file.fileId);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
  });

  await t.test('HTML is served as plain text', async () => {
    const file = await uploaded(
      await upload(USERS.student, s1._id, 'page.html', '<h1>hi</h1>', 'text/html')
    );
    const res = await download(USERS.mentor, s1._id, file.fileId);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
  });

  await t.test('always as an attachment, with sniffing and scripts off', async () => {
    const file = await uploaded(await upload(USERS.student, s1._id, 'plain.txt', 'plain'));
    const res = await download(USERS.mentor, s1._id, file.fileId);

    assert.match(res.headers.get('content-disposition'), /^attachment;/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
  });
});

test('what can be attached', async (t) => {
  const { a, s1 } = await freshWork('Limits');

  await t.test('not by the mentor', async () => {
    const res = await upload(USERS.mentor, s1._id, 'a.pdf', 'x');
    assert.equal(res.status, 403);
  });

  await t.test('not by a classmate', async () => {
    const res = await upload(USERS.student2, s1._id, 'a.pdf', 'x');
    assert.equal(res.status, 403);
  });

  await t.test('not signed out', async () => {
    const res = await upload(null, s1._id, 'a.pdf', 'x');
    assert.equal(res.status, 401);
  });

  await t.test('not a program', async () => {
    const res = await upload(USERS.student, s1._id, 'setup.exe', 'MZ');
    assert.equal(res.status, 400);
  });

  await t.test('not a file with no extension', async () => {
    const res = await upload(USERS.student, s1._id, 'README', 'x');
    assert.equal(res.status, 400);
  });

  await t.test('not an extension named after a built-in property', async () => {
    // `TYPES['constructor']` exists on every object; the check must not see it.
    const res = await upload(USERS.student, s1._id, 'x.constructor', 'x');
    assert.equal(res.status, 400);
  });

  await t.test('not an empty file', async () => {
    const res = await upload(USERS.student, s1._id, 'empty.txt', '');
    assert.equal(res.status, 400);
  });

  await t.test('not a request with no file in it', async () => {
    const form = new FormData();
    form.append('note', 'no file here');

    const res = await fetch(`${BASE}/api/submissions/${s1._id}/files`, {
      method: 'POST',
      headers: { 'X-Dev-User-Id': USERS.student._id },
      body: form
    });
    assert.equal(res.status, 400);
  });

  await t.test('not over 10 MB', async () => {
    const res = await upload(USERS.student, s1._id, 'big.zip', new Uint8Array(10 * 1024 * 1024 + 1));
    assert.equal(res.status, 413);
  });

  await t.test('exactly 10 MB is fine', async () => {
    const res = await upload(USERS.student, s1._id, 'exact.zip', new Uint8Array(10 * 1024 * 1024));
    assert.equal(res.status, 201);
  });

  await t.test('a path in the name is dropped', async () => {
    const unix = await uploaded(await upload(USERS.student, s1._id, '../../etc/evil.pdf', 'x'));
    const win = await uploaded(await upload(USERS.student, s1._id, 'C:\\Users\\x\\evil2.pdf', 'x'));
    assert.equal(unix.name, 'evil.pdf');
    assert.equal(win.name, 'evil2.pdf');
  });

  await t.test('a non-English name survives intact', async () => {
    const file = await uploaded(await upload(USERS.student, s1._id, 'résumé.pdf', 'x'));
    assert.equal(file.name, 'résumé.pdf');
  });

  await t.test('none of the refusals left anything behind', async () => {
    const view = await api(`/api/assignments/${a._id}`, { as: USERS.mentor }).then((r) =>
      r.json()
    );
    const row = view.submissions.find((s) => String(s._id) === String(s1._id));
    assert.deepEqual(
      row.attachments.map((f) => f.name),
      ['exact.zip', 'evil.pdf', 'evil2.pdf', 'résumé.pdf']
    );
  });
});

test('at most five files on one hand-in', async () => {
  const { s1 } = await freshWork('Count');

  for (let i = 1; i <= 5; i += 1) {
    const res = await upload(USERS.student, s1._id, `part${i}.txt`, `part ${i}`);
    assert.equal(res.status, 201);
  }

  const sixth = await upload(USERS.student, s1._id, 'part6.txt', 'part 6');
  assert.equal(sixth.status, 400);
});

test('files follow the same rules as the rest of the hand-in', async (t) => {
  const { s1, s2 } = await freshWork('Rules');
  const file = await uploaded(await upload(USERS.student, s1._id, 'answer.pdf', '%PDF answer'));

  await t.test('a file on its own is enough to hand in', async () => {
    const res = await handIn(USERS.student, s1._id, { turnIn: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'submitted');
  });

  await t.test('handed-in work cannot gain a file', async () => {
    const res = await upload(USERS.student, s1._id, 'extra.pdf', 'x');
    assert.equal(res.status, 400);
  });

  await t.test('or lose one', async () => {
    const res = await detach(USERS.student, s1._id, file.fileId);
    assert.equal(res.status, 400);
  });

  await t.test('until it is unsubmitted', async () => {
    const un = await api(`/api/submissions/${s1._id}/unsubmit`, {
      as: USERS.student,
      method: 'POST'
    });
    assert.equal(un.status, 200);

    const res = await detach(USERS.student, s1._id, file.fileId);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.attachments.length, 0);
    assert.equal(body.history.at(-1).type, 'file-removed');
    assert.equal(body.history.at(-1).detail, 'answer.pdf');
  });

  await t.test('a removed file is deleted, not just unlisted', async () => {
    assert.equal(await stored(file.fileId), null);
    assert.equal(await chunks(file.fileId), 0);
  });

  await t.test('the mentor cannot remove a student\'s file', async () => {
    const again = await uploaded(await upload(USERS.student, s1._id, 'answer2.pdf', 'x'));
    const res = await detach(USERS.mentor, s1._id, again.fileId);
    assert.equal(res.status, 403);
  });

  await t.test('removing a file that is not there', async () => {
    const res = await detach(USERS.student, s1._id, '0000000000000000000000ff');
    assert.equal(res.status, 404);
  });

  await t.test('the history tells the whole story, in order', async () => {
    const row = await own(s1.assignment._id, USERS.student);
    assert.deepEqual(
      row.history.map((e) => e.type),
      ['assigned', 'file-attached', 'submitted', 'unsubmitted', 'file-removed', 'file-attached']
    );
  });

  await t.test('with nothing at all, handing in is still refused', async () => {
    const res = await handIn(USERS.student2, s2._id, { turnIn: true });
    assert.equal(res.status, 400);
  });

  await t.test('accepted work is a record — no new files', async () => {
    await handIn(USERS.student2, s2._id, { text: 'done', turnIn: true });
    await api(`/api/submissions/${s2._id}`, {
      as: USERS.mentor,
      method: 'PATCH',
      body: { action: 'accept' }
    });

    const res = await upload(USERS.student2, s2._id, 'late.pdf', 'x');
    assert.equal(res.status, 400);
  });
});

test('withdrawing an assignment deletes its files', async () => {
  const { a, s1, s2 } = await freshWork('Withdrawn');

  const f1 = await uploaded(await upload(USERS.student, s1._id, 'one.pdf', 'one'));
  const f2 = await uploaded(await upload(USERS.student2, s2._id, 'two.pdf', 'two'));

  const res = await api(`/api/assignments/${a._id}`, { as: USERS.mentor, method: 'DELETE' });
  assert.equal(res.status, 200);

  for (const f of [f1, f2]) {
    assert.equal(await stored(f.fileId), null);
    assert.equal(await chunks(f.fileId), 0);
  }
});
