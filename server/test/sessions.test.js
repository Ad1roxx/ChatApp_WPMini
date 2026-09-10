/**
 * Session scheduling.
 *
 * The handshake is the feature: anyone may propose, the OTHER person
 * confirms. Most of what follows guards that asymmetry and the transitions
 * that are supposed to be one-way.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, db, mongoose } = require('./helpers/harness');

let mentorship;
let pendingMentorship;

test.before(async () => {
  await start();

  mentorship = await (await api('/api/mentorships', {
    as: USERS.mentor,
    method: 'POST',
    body: { studentId: USERS.student._id, topic: 'Backend interviews' }
  })).json();

  // A mentorship that is NOT active, for the "cannot schedule yet" case.
  pendingMentorship = await (await api('/api/mentorships', {
    as: USERS.student2,
    method: 'POST',
    body: { mentorId: USERS.mentor._id, topic: 'Still pending' }
  })).json();
});

test.after(() => stop());

const soon = (mins) => new Date(Date.now() + mins * 60000).toISOString();

const propose = (as, body, id = mentorship._id) =>
  api(`/api/mentorships/${id}/sessions`, { as, method: 'POST', body });

const act = (as, sessionId, body) =>
  api(`/api/sessions/${sessionId}`, { as, method: 'PATCH', body });

/** Move a session's start into the past, since creating one there is refused. */
const rewind = (sessionId, ms = 3600000) =>
  db()
    .collection('sessions')
    .updateOne(
      { _id: new mongoose.Types.ObjectId(sessionId) },
      { $set: { scheduledFor: new Date(Date.now() - ms) } }
    );

test('either party may propose a time', async (t) => {
  await t.test('the student can — the opposite of the goal rules', async () => {
    const res = await propose(USERS.student, {
      title: 'Weekly check-in',
      scheduledFor: soon(60 * 24)
    });
    const s = await res.json();

    assert.equal(res.status, 201);
    assert.equal(s.status, 'proposed');
    assert.equal(String(s.proposedBy._id), USERS.student._id);
    assert.equal(s.durationMinutes, 30);
  });

  await t.test('so can the mentor', async () => {
    const res = await propose(USERS.mentor, { title: 'Mock', scheduledFor: soon(60 * 25) });
    assert.equal(res.status, 201);
  });

  await t.test('but not someone outside the mentorship', async () => {
    const res = await propose(USERS.student2, { title: 'No', scheduledFor: soon(60) });
    assert.equal(res.status, 403);
  });

  await t.test('and not on a mentorship that is not active', async () => {
    const res = await propose(
      USERS.student2,
      { title: 'Too early', scheduledFor: soon(60) },
      pendingMentorship._id
    );
    assert.equal(res.status, 400);
  });
});

test('the proposer cannot confirm their own', async (t) => {
  const s = await (await propose(USERS.student, {
    title: 'Handshake',
    scheduledFor: soon(60 * 26)
  })).json();

  await t.test('the one who asked is refused', async () => {
    const res = await act(USERS.student, s._id, { action: 'confirm' });
    assert.equal(res.status, 403);
  });

  await t.test('the other one confirms', async () => {
    const confirmed = await (await act(USERS.mentor, s._id, { action: 'confirm' })).json();
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(confirmed.confirmedAt);
  });
});

test('validation on the way in', async (t) => {
  await t.test('a past date is refused', async () => {
    const res = await propose(USERS.student, { title: 'Past', scheduledFor: soon(-60) });
    assert.equal(res.status, 400);
  });

  await t.test('an unparseable date', async () => {
    const res = await propose(USERS.student, { title: 'Bad', scheduledFor: 'not a date' });
    assert.equal(res.status, 400);
  });

  await t.test('a blank title', async () => {
    const res = await propose(USERS.student, { title: '   ', scheduledFor: soon(120) });
    assert.equal(res.status, 400);
  });

  await t.test('a duration outside 5-480 minutes', async () => {
    const res = await propose(USERS.student, {
      title: 'Marathon',
      scheduledFor: soon(120),
      durationMinutes: 999
    });
    assert.equal(res.status, 400);
  });
});

test('rescheduling sends it back around the loop', async (t) => {
  const s = await (await propose(USERS.student, {
    title: 'To move',
    scheduledFor: soon(60 * 30)
  })).json();
  await act(USERS.mentor, s._id, { action: 'confirm' });

  await t.test('moving it un-confirms and flips the proposer', async () => {
    const moved = await (await act(USERS.mentor, s._id, {
      action: 'reschedule',
      scheduledFor: soon(60 * 48)
    })).json();

    assert.equal(moved.status, 'proposed');
    assert.equal(String(moved.proposedBy._id), USERS.mentor._id);
    // A confirmed time that changed silently would leave both people sure
    // they had agreed on different things.
    assert.equal(moved.confirmedAt, null);
  });

  await t.test('and cannot be moved into the past', async () => {
    const res = await act(USERS.mentor, s._id, {
      action: 'reschedule',
      scheduledFor: soon(-30)
    });
    assert.equal(res.status, 400);
  });
});

test('a session cannot be marked done before it starts', async (t) => {
  const s = await (await propose(USERS.student, {
    title: 'Not yet',
    scheduledFor: soon(60 * 40)
  })).json();

  await t.test('completing a future session is refused', async () => {
    const res = await act(USERS.mentor, s._id, { action: 'complete' });
    assert.equal(res.status, 400);
  });

  await t.test('once the time has passed, either party may', async () => {
    await rewind(s._id);
    const done = await (await act(USERS.student, s._id, { action: 'complete' })).json();
    assert.equal(done.status, 'completed');
    assert.ok(done.completedAt);
  });

  await t.test('notes belong to a session that has happened', async () => {
    const saved = await (await act(USERS.student, s._id, { notes: 'Covered DP.' })).json();
    assert.equal(saved.notes, 'Covered DP.');
  });

  await t.test('completed and cancelled are terminal', async () => {
    const confirm = await act(USERS.mentor, s._id, { action: 'confirm' });
    assert.equal(confirm.status, 400);

    const cancel = await act(USERS.mentor, s._id, { action: 'cancel' });
    assert.equal(cancel.status, 400);
  });
});

test('notes are refused before anything has happened', async () => {
  // Before a session, the agenda is the field for intent.
  const s = await (await propose(USERS.mentor, {
    title: 'Future',
    scheduledFor: soon(60 * 72)
  })).json();

  const res = await act(USERS.mentor, s._id, { notes: 'too early' });
  assert.equal(res.status, 400);
});

test('cancelling records who and why', async (t) => {
  const s = await (await propose(USERS.mentor, {
    title: 'To cancel',
    scheduledFor: soon(60 * 80)
  })).json();

  const cancelled = await (await act(USERS.student, s._id, {
    action: 'cancel',
    reason: 'Exam that week'
  })).json();

  await t.test('the status and the reason', () => {
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelReason, 'Exam that week');
    assert.equal(String(cancelled.cancelledBy._id), USERS.student._id);
  });

  await t.test('and it cannot then be moved', async () => {
    const res = await act(USERS.student, s._id, {
      action: 'reschedule',
      scheduledFor: soon(200)
    });
    assert.equal(res.status, 400);
  });
});

test('upcoming spans every mentorship, soonest first', async (t) => {
  const upcoming = await (await api('/api/sessions/upcoming', { as: USERS.student })).json();

  await t.test('only open, future sessions', () => {
    assert.ok(upcoming.length > 0);
    for (const s of upcoming) {
      assert.ok(['proposed', 'confirmed'].includes(s.status));
      assert.ok(new Date(s.scheduledFor).getTime() >= Date.now());
    }
  });

  await t.test('sorted soonest first', () => {
    const times = upcoming.map((s) => new Date(s.scheduledFor).getTime());
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i - 1] <= times[i]);
    }
  });

  await t.test('the mentorship is populated with names to render', () => {
    assert.ok(upcoming[0].mentorship?.mentor?.displayName);
    assert.ok(upcoming[0].mentorship?.student?.displayName);
  });

  await t.test('someone whose only mentorship is pending sees none', async () => {
    const none = await (await api('/api/sessions/upcoming', { as: USERS.student2 })).json();
    assert.equal(none.length, 0);
  });
});

test('the list keeps cancelled and completed sessions', async (t) => {
  const list = await (await api(`/api/mentorships/${mentorship._id}/sessions`, {
    as: USERS.mentor
  })).json();

  await t.test('history is not hidden', () => {
    assert.ok(list.some((s) => s.status === 'cancelled'));
    assert.ok(list.some((s) => s.status === 'completed'));
  });

  await t.test('newest first', () => {
    const times = list.map((s) => new Date(s.scheduledFor).getTime());
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i - 1] >= times[i]);
    }
  });

  await t.test('an outsider cannot read it', async () => {
    const res = await api(`/api/mentorships/${mentorship._id}/sessions`, { as: USERS.student2 });
    assert.equal(res.status, 403);
  });
});

test('the usual refusals', async (t) => {
  await t.test('an unknown action', async () => {
    const s = await (await propose(USERS.student, {
      title: 'Refusals',
      scheduledFor: soon(60 * 90)
    })).json();

    const res = await act(USERS.student, s._id, { action: 'explode' });
    assert.equal(res.status, 400);
  });

  await t.test('a missing session', async () => {
    const res = await act(USERS.student, '0000000000000000000000ff', { action: 'confirm' });
    assert.equal(res.status, 404);
  });

  await t.test('no token', async () => {
    const res = await api(`/api/mentorships/${mentorship._id}/sessions`);
    assert.equal(res.status, 401);
  });
});
