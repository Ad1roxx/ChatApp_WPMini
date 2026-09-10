/**
 * The mentorship relationship, in both directions.
 *
 * The tests that matter most here are the asymmetric ones. A mentor adding a
 * student is immediate; a student asking is a request. A mentor can remove a
 * student outright; a student has to ask. If any of those start behaving
 * symmetrically, the feature has quietly become something else.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api } = require('./helpers/harness');

test.before(() => start());
test.after(() => stop());

const create = (as, body) => api('/api/mentorships', { as, method: 'POST', body });
const act = (as, id, body) => api(`/api/mentorships/${id}`, { as, method: 'PATCH', body });

/** A fresh active mentorship, mentor-initiated, for tests that need one. */
async function activeMentorship(student = USERS.student, topic = 'Backend interviews') {
  const res = await create(USERS.mentor, { studentId: student._id, topic });
  assert.equal(res.status, 200);
  return res.json();
}

test('a mentor takes a student on, and it is active immediately', async (t) => {
  const m = await activeMentorship();

  await t.test('no acceptance step', () => {
    assert.equal(m.status, 'active');
  });

  await t.test('initiatedBy records which way round it went', () => {
    assert.equal(m.initiatedBy, 'mentor');
  });

  await t.test('respondedAt is set, because adding IS the answer', () => {
    assert.ok(m.respondedAt);
  });

  await t.test('the person added is the student, not the mentor', () => {
    assert.equal(String(m.student._id), USERS.student._id);
    assert.equal(String(m.mentor._id), USERS.mentor._id);
  });

  // Clean up so later tests can use this pair again.
  await act(USERS.mentor, m._id, { action: 'end' });
});

test('a student asking is a request, and waits', async (t) => {
  const res = await create(USERS.student2, { mentorId: USERS.mentor._id, topic: 'System design' });
  const m = await res.json();

  await t.test('it starts pending', () => {
    assert.equal(m.status, 'pending');
  });

  await t.test('initiatedBy is the student', () => {
    assert.equal(m.initiatedBy, 'student');
  });

  await t.test('nobody has responded yet', () => {
    assert.equal(m.respondedAt, null);
  });

  await t.test('the mentor can accept it', async () => {
    const accepted = await (await act(USERS.mentor, m._id, { action: 'accept' })).json();
    assert.equal(accepted.status, 'active');
    assert.ok(accepted.respondedAt);
  });

  await act(USERS.mentor, m._id, { action: 'end' });
});

test('only a mentor can take someone on', async (t) => {
  await t.test('a student adding a student is refused', async () => {
    const res = await create(USERS.student, { studentId: USERS.student2._id, topic: 'No' });
    assert.equal(res.status, 403);
  });

  await t.test('a mentor cannot "add" someone who can mentor', async () => {
    const res = await create(USERS.mentor, { studentId: USERS.admin._id, topic: 'No' });
    assert.equal(res.status, 400);
  });

  await t.test('a student cannot ask a non-mentor', async () => {
    const res = await create(USERS.student, { mentorId: USERS.student2._id, topic: 'No' });
    assert.equal(res.status, 400);
  });
});

test('exactly one direction, and a topic', async (t) => {
  await t.test('both ids at once is ambiguous', async () => {
    const res = await create(USERS.mentor, {
      studentId: USERS.student._id,
      mentorId: USERS.admin._id,
      topic: 'Both'
    });
    assert.equal(res.status, 400);
  });

  await t.test('neither id is not a request at all', async () => {
    const res = await create(USERS.mentor, { topic: 'Neither' });
    assert.equal(res.status, 400);
  });

  await t.test('a topic is required', async () => {
    const res = await create(USERS.mentor, { studentId: USERS.student._id });
    assert.equal(res.status, 400);
  });

  await t.test('you cannot mentor yourself', async () => {
    const res = await create(USERS.mentor, { studentId: USERS.mentor._id, topic: 'Self' });
    assert.equal(res.status, 400);
  });
});

test('one live relationship per pair, from either side', async (t) => {
  const m = await activeMentorship();

  await t.test('the mentor cannot add them twice', async () => {
    const res = await create(USERS.mentor, { studentId: USERS.student._id, topic: 'Again' });
    assert.equal(res.status, 409);
  });

  await t.test('and the student cannot ask on top of it', async () => {
    const res = await create(USERS.student, { mentorId: USERS.mentor._id, topic: 'Again' });
    assert.equal(res.status, 409);
  });

  await act(USERS.mentor, m._id, { action: 'end' });
});

test('a student cannot simply walk out of an active mentorship', async (t) => {
  const m = await activeMentorship();

  await t.test('ending it is refused', async () => {
    const res = await act(USERS.student, m._id, { action: 'end' });
    assert.equal(res.status, 403);
  });

  await t.test('but the mentor may remove them', async () => {
    const ended = await (await act(USERS.mentor, m._id, { action: 'end' })).json();
    assert.equal(ended.status, 'ended');
    assert.equal(String(ended.endedBy), USERS.mentor._id);
  });
});

test('a student may withdraw their own unanswered request', async () => {
  // Nobody has agreed to anything yet, so this is not the same act as
  // leaving a live relationship and needs no reason.
  const m = await (await create(USERS.student2, {
    mentorId: USERS.mentor._id,
    topic: 'Withdrawing'
  })).json();

  const res = await act(USERS.student2, m._id, { action: 'end' });
  const withdrawn = await res.json();

  assert.equal(res.status, 200);
  assert.equal(withdrawn.status, 'ended');
});

test('opting out is the student\'s to ask and the mentor\'s to answer', async (t) => {
  const m = await activeMentorship();

  await t.test('a reason is required — it is the point of the request', async () => {
    const res = await act(USERS.student, m._id, { action: 'request-optout' });
    assert.equal(res.status, 400);
  });

  await t.test('the mentor cannot request it on their behalf', async () => {
    const res = await act(USERS.mentor, m._id, {
      action: 'request-optout',
      note: 'not mine to send'
    });
    assert.equal(res.status, 403);
  });

  await t.test('the student asks, and the mentorship stays active', async () => {
    const asked = await (await act(USERS.student, m._id, {
      action: 'request-optout',
      note: 'Wrong topic for me'
    })).json();

    assert.equal(asked.optOut.status, 'pending');
    assert.equal(asked.optOut.reason, 'Wrong topic for me');
    assert.ok(asked.optOut.requestedAt);
    // The whole reason opt-out is not a status value: this is still active.
    assert.equal(asked.status, 'active');
  });

  await t.test('asking twice is refused', async () => {
    const res = await act(USERS.student, m._id, { action: 'request-optout', note: 'again' });
    assert.equal(res.status, 400);
  });

  await t.test('the student can withdraw it', async () => {
    const back = await (await act(USERS.student, m._id, { action: 'cancel-optout' })).json();
    assert.equal(back.optOut.status, 'none');

    const again = await act(USERS.student, m._id, { action: 'cancel-optout' });
    assert.equal(again.status, 400);
  });

  await t.test('the student cannot answer their own request', async () => {
    await act(USERS.student, m._id, { action: 'request-optout', note: 'Second thoughts' });
    const res = await act(USERS.student, m._id, { action: 'decline-optout' });
    assert.equal(res.status, 403);
  });

  await t.test('the mentor can decline, and it carries on', async () => {
    const declined = await (await act(USERS.mentor, m._id, {
      action: 'decline-optout',
      note: 'Give it two more weeks'
    })).json();

    assert.equal(declined.optOut.status, 'declined');
    assert.equal(declined.optOut.responseNote, 'Give it two more weeks');
    assert.equal(declined.status, 'active');
  });

  await t.test('an answered opt-out cannot be answered again', async () => {
    const res = await act(USERS.mentor, m._id, { action: 'approve-optout' });
    assert.equal(res.status, 400);
  });

  await t.test('approving ends it, credited to the student who asked', async () => {
    await act(USERS.student, m._id, { action: 'request-optout', note: 'Really, this time' });
    const done = await (await act(USERS.mentor, m._id, { action: 'approve-optout' })).json();

    assert.equal(done.status, 'ended');
    assert.ok(done.endedAt);
    // The student asked; the mentor only agreed. Recording the mentor here
    // would misread the history later.
    assert.equal(String(done.endedBy), USERS.student._id);
  });

  await t.test('and an ended mentorship cannot be opted out of', async () => {
    const res = await act(USERS.student, m._id, { action: 'request-optout', note: 'too late' });
    assert.equal(res.status, 400);
  });
});

test('the usual refusals', async (t) => {
  const m = await activeMentorship(USERS.student2, 'Refusals');

  await t.test('an outsider is not party to it', async () => {
    const res = await act(USERS.admin, m._id, { action: 'end' });
    assert.equal(res.status, 403);
  });

  await t.test('an unknown action', async () => {
    const res = await act(USERS.mentor, m._id, { action: 'explode' });
    assert.equal(res.status, 400);
  });

  await t.test('a missing mentorship', async () => {
    const res = await act(USERS.mentor, '0000000000000000000000ff', { action: 'end' });
    assert.equal(res.status, 404);
  });

  await t.test('no token', async () => {
    const res = await api(`/api/mentorships/${m._id}`, {
      method: 'PATCH',
      body: { action: 'end' }
    });
    assert.equal(res.status, 401);
  });

  await act(USERS.mentor, m._id, { action: 'end' });
});

test('a suspended account cannot be taken on', async () => {
  await api(`/api/admin/users/${USERS.student._id}/suspend`, {
    as: USERS.admin,
    method: 'PATCH',
    body: { suspended: true, reason: 'testing' }
  });

  const res = await create(USERS.mentor, { studentId: USERS.student._id, topic: 'Suspended' });
  assert.equal(res.status, 400);

  // Restore, so file order cannot affect anything that runs after this.
  await api(`/api/admin/users/${USERS.student._id}/suspend`, {
    as: USERS.admin,
    method: 'PATCH',
    body: { suspended: false }
  });
});
