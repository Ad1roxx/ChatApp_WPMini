/**
 * check_attachment: the internal tool behind the Copilot's file summary (S4 Step 4).
 *
 * The AI service calls it before it reads one chunk of a file: the model named
 * a hand-in by its handle and a file by its name, and this says whether the
 * asker may open that file and which file the name means. Run through the real
 * endpoint, with real capability tokens, against hand-ins and files made
 * through the real API. What is pinned:
 *
 * - it is never offered to the model, and both roles may have the AI service call it
 * - a hand-in can hold several files; each name finds its own file
 * - the hand-in must be in the token's mentorship, even for a mentor who has others
 * - the download route's own check (lib/reads.js `canReadSubmissionFile`)
 *   applies, even where the mentorship check alone would pass
 * - an unknown or ambiguous name is refused, never guessed
 * - arguments are exactly the tool's shape
 * - no person's name or email in what comes back
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { BASE, USERS, start, stop, api, db, mongoose } = require('./helpers/harness');
const { mintAgentToken } = require('../lib/agentToken');
const { toolsFor, internalToolsFor, argsProblem, TOOLS, MAX_FILE_NAME } = require('../lib/agentTools');

const AI_SECRET = 'stub-secret';
const AGENT_SECRET = crypto.randomBytes(24).toString('hex');

let mine; // mentor -> student
let other; // mentor -> student2
let theirs; // admin -> student2
let handIn; // the student's hand-in in mine: notes.pdf and report.docx
let otherHandIn; // student2's hand-in of the same work, in other: report.docx
let files; // name -> fileId on handIn

const post = (as, path, body, method = 'POST') =>
  api(path, { as, method, body }).then(async (r) => {
    const json = await r.json();
    assert.ok(r.ok, `${method} ${path}: ${r.status} ${JSON.stringify(json)}`);
    return json;
  });
const future = (days) => new Date(Date.now() + days * 86400000).toISOString();

function upload(as, subId, name, type) {
  const form = new FormData();
  form.append('file', new Blob([`bytes of ${name}`], { type }), name);
  return fetch(`${BASE}/api/submissions/${subId}/files`, {
    method: 'POST', headers: { 'X-Dev-User-Id': as._id }, body: form
  }).then(async (r) => {
    const json = await r.json();
    assert.equal(r.status, 201, JSON.stringify(json));
    return json;
  });
}

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function ownHandIn(mentorship, student) {
  const list = await api(`/api/mentorships/${mentorship._id}/assignments`, { as: student }).then((r) => r.json());
  return list[0];
}

test.before(async () => {
  await start({
    extraEnv: { AI_SERVICE_SECRET: AI_SECRET, AGENT_TOKEN_SECRET: AGENT_SECRET, AI_SERVICE_URL: '' }
  });
  const add = (as, studentId, topic) => post(as, '/api/mentorships', { studentId, topic });
  mine = await add(USERS.mentor, USERS.student._id, 'Backend interviews');
  other = await add(USERS.mentor, USERS.student2._id, 'Frontend basics');
  theirs = await add(USERS.admin, USERS.student2._id, 'Something else');

  await post(USERS.mentor, '/api/assignments', {
    title: 'Write a postmortem', dueAt: future(7), mentorshipIds: [mine._id, other._id]
  });
  handIn = await ownHandIn(mine, USERS.student);
  await upload(USERS.student, handIn._id, 'notes.pdf', PDF);
  const after = await upload(USERS.student, handIn._id, 'report.docx', DOCX);
  files = Object.fromEntries(after.attachments.map((f) => [f.name, String(f.fileId)]));

  otherHandIn = await ownHandIn(other, USERS.student2);
  await upload(USERS.student2, otherHandIn._id, 'report.docx', DOCX);
});

test.after(() => stop());

function check(user, mentorship, role, args) {
  const { token } = mintAgentToken(AGENT_SECRET, {
    userId: user._id, mentorshipId: mentorship._id, role, turnMs: 30000
  });
  return api('/internal/agent/tools/check_attachment', {
    method: 'POST',
    body: { args },
    headers: { 'X-AI-Secret': AI_SECRET, Authorization: `Bearer ${token}` }
  });
}

const args = (fileName, submissionId = handIn._id) => ({ submissionId: String(submissionId), fileName });

async function found(res) {
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.records.length, 1);
  return body.records[0];
}

async function refused(res, status, pattern) {
  const body = await res.json();
  assert.equal(res.status, status, JSON.stringify(body));
  assert.equal(body.records, undefined);
  assert.match(body.error, pattern);
  assert.equal(body.endsTurn, undefined, 'a refused lookup is told to the model; the turn goes on');
}

// ---------------------------------------------------------------------------
// As data
// ---------------------------------------------------------------------------
test('it is never offered to the model, and both roles may have it called', () => {
  for (const role of ['mentor', 'student']) {
    assert.ok(!toolsFor(role).includes('check_attachment'), role);
    assert.deepEqual(internalToolsFor(role), ['check_attachment'], role);
  }
  assert.deepEqual(internalToolsFor('admin'), []);
});

test('its arguments are exactly an id and a file name', () => {
  const spec = TOOLS.check_attachment;
  const id = '0000000000000000000000c1';
  assert.equal(argsProblem(spec, { submissionId: id, fileName: 'a.pdf' }), null);
  assert.equal(argsProblem(spec, { submissionId: id, fileName: 'x'.repeat(MAX_FILE_NAME) }), null);
  for (const bad of [
    {}, { submissionId: id }, { fileName: 'a.pdf' },
    { submissionId: id, fileName: '' },
    { submissionId: id, fileName: 'x'.repeat(MAX_FILE_NAME + 1) },
    { submissionId: id, fileName: { $ne: null } },
    { submissionId: id, fileName: ['a.pdf'] },
    { submissionId: 'x', fileName: 'a.pdf' },
    { submissionId: id, fileName: 'a.pdf', mentorshipId: id }
  ]) {
    assert.ok(argsProblem(spec, bad), JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Two files on one hand-in
// ---------------------------------------------------------------------------
test('each name on a hand-in with two files finds its own file', async () => {
  const report = await found(await check(USERS.student, mine, 'student', args('report.docx')));
  const notes = await found(await check(USERS.student, mine, 'student', args('notes.pdf')));
  assert.equal(report.id, files['report.docx']);
  assert.equal(notes.id, files['notes.pdf']);
  assert.notEqual(report.id, notes.id);
  assert.deepEqual(Object.keys(report).sort(), ['contentType', 'id', 'kind', 'mentorshipId', 'name', 'submissionId']);
  assert.equal(report.kind, 'file');
  assert.equal(report.submissionId, String(handIn._id));
  assert.equal(report.mentorshipId, String(mine._id));
  assert.equal(report.contentType, DOCX);
});

test('the mentor who set the work may have it checked too', async () => {
  const report = await found(await check(USERS.mentor, mine, 'mentor', args('report.docx')));
  assert.equal(report.id, files['report.docx']);
});

test('a name the hand-in does not have is refused, not guessed', async () => {
  await refused(await check(USERS.student, mine, 'student', args('report.pdf')), 404, /no file by that name/);
  await refused(await check(USERS.student, mine, 'student', args('REPORT.DOCX')), 404, /no file by that name/);
});

test('two files with the same name are refused, not guessed', async (t) => {
  await upload(USERS.student, handIn._id, 'notes.pdf', PDF);
  t.after(async () => {
    // Back to one notes.pdf, so the other tests see the hand-in as they expect.
    const sub = await db().collection('submissions').findOne({ _id: new mongoose.Types.ObjectId(handIn._id) });
    const extra = sub.attachments.filter((f) => f.name === 'notes.pdf').at(-1);
    await db().collection('submissions').updateOne({ _id: sub._id }, { $pull: { attachments: { fileId: extra.fileId } } });
  });
  await refused(await check(USERS.student, mine, 'student', args('notes.pdf')), 422, /More than one file/);
});

// ---------------------------------------------------------------------------
// This mentorship, and the download route's check
// ---------------------------------------------------------------------------
test('a hand-in in another mentorship is refused, even to a mentor of both', async () => {
  // The mentor may download student2's file through the route; not through mine's token.
  await refused(await check(USERS.mentor, mine, 'mentor', args('report.docx', otherHandIn._id)), 403,
    /isn't in this mentorship/);
  const there = await found(await check(USERS.mentor, other, 'mentor', args('report.docx', otherHandIn._id)));
  assert.notEqual(there.id, files['report.docx']);
});

test('someone outside the mentorship is refused at the gate', async () => {
  const res = await check(USERS.student2, mine, 'student', args('report.docx'));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).endsTurn, true);
  await refused(await check(USERS.admin, theirs, 'mentor', args('report.docx')), 403, /isn't in this mentorship/);
});

test('a hand-in id that does not exist is refused', async () => {
  await refused(await check(USERS.student, mine, 'student', args('report.docx', '0000000000000000000000c9')), 404,
    /Submission not found/);
});

test('the download route\'s check applies where the mentorship check alone would pass', async (t) => {
  // Records that disagree with each other: a hand-in in this mentorship whose
  // student is someone else, and work whose setter is not this mentor. The
  // mentorship check passes both; canReadSubmissionFile must not.
  const subs = db().collection('submissions');
  const id = new mongoose.Types.ObjectId(handIn._id);
  await t.test('not the student it belongs to', async () => {
    await subs.updateOne({ _id: id }, { $set: { student: new mongoose.Types.ObjectId(USERS.admin._id) } });
    try {
      await refused(await check(USERS.student, mine, 'student', args('report.docx')), 403, /Only the student and the mentor/);
    } finally {
      await subs.updateOne({ _id: id }, { $set: { student: new mongoose.Types.ObjectId(USERS.student._id) } });
    }
  });
  await t.test('not the mentor who set it', async () => {
    const sub = await subs.findOne({ _id: id });
    const work = db().collection('assignments');
    await work.updateOne({ _id: sub.assignment }, { $set: { mentor: new mongoose.Types.ObjectId(USERS.admin._id) } });
    try {
      await refused(await check(USERS.mentor, mine, 'mentor', args('report.docx')), 403, /Only the student and the mentor/);
    } finally {
      await work.updateOne({ _id: sub.assignment }, { $set: { mentor: new mongoose.Types.ObjectId(USERS.mentor._id) } });
    }
  });
  await t.test('and with the records agreeing again, both may', async () => {
    await found(await check(USERS.student, mine, 'student', args('report.docx')));
    await found(await check(USERS.mentor, mine, 'mentor', args('report.docx')));
  });
});

test('no name or email in what comes back', async () => {
  const text = JSON.stringify(await found(await check(USERS.mentor, mine, 'mentor', args('report.docx'))));
  for (const p of [USERS.mentor, USERS.student]) {
    assert.ok(!text.includes(p.displayName), p.displayName);
    assert.ok(!text.includes(p.email), p.email);
    assert.ok(!text.includes(p._id), 'no person\'s id');
  }
});
