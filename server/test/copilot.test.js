/**
 * The Copilot route — the trust boundary in front of the retrieval service.
 *
 * The retrieval service trusts the mentorship id it is handed, because it
 * never sees a Firebase token and could not verify one. Everything that stops
 * a person reading another mentorship's material therefore happens HERE, and
 * these are the tests for it.
 *
 * Nothing below needs Python or the Atlas Local container running. That is
 * deliberate: the checks that matter — who is refused, and where the viewer id
 * comes from — all happen before the service would be called. A clone with no
 * AI service configured answers 503, and the suite proves that too, which is
 * why CI stays a Node-only job.
 *
 * The end-to-end path (Express → FastAPI → $vectorSearch) is checked by
 * ai/check_retrieval.py and a scripted call, not from here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api } = require('./helpers/harness');

let mine; // mentor → student
let theirs; // admin  → student2, nothing to do with `mentor`

const addStudent = (as, studentId, topic) =>
  api('/api/mentorships', { as, method: 'POST', body: { studentId, topic } }).then((r) =>
    r.json()
  );

test.before(async () => {
  await start();

  mine = await addStudent(USERS.mentor, USERS.student._id, 'Backend interviews');
  theirs = await addStudent(USERS.admin, USERS.student2._id, 'Something else');
});

test.after(() => stop());

const ask = (as, mentorshipId, body = { query: 'what should I revise?' }) =>
  api(`/api/mentorships/${mentorshipId}/copilot/search`, { as, method: 'POST', body });

test('only the two people in a mentorship may ask about it', async (t) => {
  await t.test('the student may', async () => {
    const res = await ask(USERS.student, mine._id);
    // 503 is "configured off", which is still past the access check — the
    // point here is that it is not 403.
    assert.notEqual(res.status, 403);
    assert.notEqual(res.status, 404);
  });

  await t.test('their mentor may', async () => {
    const res = await ask(USERS.mentor, mine._id);
    assert.notEqual(res.status, 403);
  });

  await t.test('somebody else\'s mentor may not', async () => {
    const res = await ask(USERS.admin, mine._id);
    assert.equal(res.status, 403);
  });

  await t.test('somebody else\'s student may not', async () => {
    // The question a leak would answer: student2 asking about a mentorship
    // that is not theirs, in the hope of reading its material.
    const res = await ask(USERS.student2, mine._id);
    assert.equal(res.status, 403);
  });

  await t.test('and the refusal is the same either way round', async () => {
    const res = await ask(USERS.student, theirs._id);
    assert.equal(res.status, 403);
  });

  await t.test('signed out is refused before anything else', async () => {
    const res = await ask(null, mine._id);
    assert.equal(res.status, 401);
  });
});

test('a mentorship that does not exist is a 404, not a 403', async () => {
  // Distinguishable on purpose: "not yours" and "not a thing" are different
  // answers, and neither tells the caller about anyone else's data.
  const res = await ask(USERS.student, '0000000000000000000000ff');
  assert.equal(res.status, 404);
});

test('the question itself is validated', async (t) => {
  await t.test('an empty question is refused', async () => {
    const res = await ask(USERS.student, mine._id, { query: '   ' });
    assert.equal(res.status, 400);
  });

  await t.test('so is one longer than the service accepts', async () => {
    const res = await ask(USERS.student, mine._id, { query: 'x'.repeat(1001) });
    assert.equal(res.status, 400);
  });
});

test('with no retrieval service configured, the route says so', async () => {
  // The state a fresh clone is in: Node runs, Python does not, and the app
  // should neither crash nor pretend to answer.
  const res = await ask(USERS.student, mine._id);
  assert.equal(res.status, 503);

  const body = await res.json();
  assert.match(body.error, /not configured/i);
});
