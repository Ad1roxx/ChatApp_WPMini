/**
 * Analytics — the figures, and what they deliberately leave out.
 *
 * The interesting assertions here are exclusions. An archived goal's
 * milestones must not count, an ended mentorship must leave the worklist but
 * stay in the totals, and a viewer must only ever see their own. Those are
 * the ways a dashboard starts lying while every status code stays 200.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, db, mongoose } = require('./helpers/harness');

let m1; // mentor + student:  goals and sessions
let m2; // mentor + student2: a goal and an upcoming session

test.before(async () => {
  await start();

  const create = (studentId, topic) =>
    api('/api/mentorships', {
      as: USERS.mentor,
      method: 'POST',
      body: { studentId, topic }
    }).then((r) => r.json());

  m1 = await create(USERS.student._id, 'Backend interviews');
  m2 = await create(USERS.student2._id, 'System design');

  const setGoal = (m, title, milestones) =>
    api(`/api/mentorships/${m._id}/goals`, {
      as: USERS.mentor,
      method: 'POST',
      body: { title, milestones }
    }).then((r) => r.json());

  // m1: one live goal at 3 of 4 …
  const g1 = await setGoal(m1, 'DSA', ['a', 'b', 'c', 'd']);
  for (const ms of g1.milestones.slice(0, 3)) {
    await api(`/api/goals/${g1._id}/milestones/${ms._id}`, {
      as: USERS.student,
      method: 'PATCH',
      body: { done: true }
    });
  }

  // … and one ARCHIVED goal, whose two milestones must not appear anywhere.
  const archived = await setGoal(m1, 'Abandoned', ['x', 'y']);
  await api(`/api/goals/${archived._id}`, {
    as: USERS.mentor,
    method: 'PATCH',
    body: { archived: true }
  });

  // m2: a goal nobody has started
  await setGoal(m2, 'Scaling', ['p', 'q', 'r']);

  // m1: one completed 45-minute session, and one cancelled
  const met = await (await api(`/api/mentorships/${m1._id}/sessions`, {
    as: USERS.mentor,
    method: 'POST',
    body: { title: 'Met', scheduledFor: new Date(Date.now() + 3600000).toISOString(), durationMinutes: 45 }
  })).json();
  await db()
    .collection('sessions')
    .updateOne(
      { _id: new mongoose.Types.ObjectId(met._id) },
      { $set: { scheduledFor: new Date(Date.now() - 30 * 86400000) } }
    );
  await api(`/api/sessions/${met._id}`, {
    as: USERS.mentor,
    method: 'PATCH',
    body: { action: 'complete' }
  });

  const fell = await (await api(`/api/mentorships/${m1._id}/sessions`, {
    as: USERS.mentor,
    method: 'POST',
    body: { title: 'Fell through', scheduledFor: new Date(Date.now() + 7200000).toISOString() }
  })).json();
  await api(`/api/sessions/${fell._id}`, {
    as: USERS.mentor,
    method: 'PATCH',
    body: { action: 'cancel' }
  });

  // m2: one confirmed session still to come
  const next = await (await api(`/api/mentorships/${m2._id}/sessions`, {
    as: USERS.mentor,
    method: 'POST',
    body: { title: 'Kickoff', scheduledFor: new Date(Date.now() + 86400000).toISOString(), durationMinutes: 60 }
  })).json();
  await api(`/api/sessions/${next._id}`, {
    as: USERS.student2,
    method: 'PATCH',
    body: { action: 'confirm' }
  });
});

test.after(() => stop());

const mine = (as) => api('/api/analytics/me', { as }).then((r) => r.json());

test('the totals add up to the rows beneath them', async (t) => {
  const a = await mine(USERS.mentor);

  await t.test('both mentorships are active, both as mentor', () => {
    assert.equal(a.totals.mentorships.active, 2);
    assert.equal(a.totals.mentorships.asMentor, 2);
    assert.equal(a.totals.mentorships.asStudent, 0);
  });

  await t.test('an archived goal contributes NO milestones', () => {
    // 4 live in m1 + 3 in m2. The archived goal's 2 must not be here: a goal
    // you gave up on would otherwise drag the figure down forever.
    assert.equal(a.totals.milestones.total, 7);
    assert.equal(a.totals.milestones.done, 3);
  });

  await t.test('but it still counts as a goal, because it existed', () => {
    assert.equal(a.totals.goals.total, 3);
    assert.equal(a.totals.goals.completed, 0);
  });

  await t.test('minutes come from completed sessions only', () => {
    assert.equal(a.totals.sessions.completed, 1);
    assert.equal(a.totals.sessions.cancelled, 1);
    assert.equal(a.totals.sessions.minutesMet, 45);
  });

  await t.test('the totals equal the sum of the rows', () => {
    const sum = (pick) => a.mentorships.reduce((n, r) => n + pick(r), 0);
    assert.equal(a.totals.milestones.total, sum((r) => r.milestones.total));
    assert.equal(a.totals.milestones.done, sum((r) => r.milestones.done));
    assert.equal(a.totals.sessions.completed, sum((r) => r.sessions.completed));
  });
});

test('one row per active mentorship, quietest first', async (t) => {
  const a = await mine(USERS.mentor);

  await t.test('two rows', () => {
    assert.equal(a.mentorships.length, 2);
  });

  await t.test('a mentorship that has never met sorts above one that has', () => {
    // m2 has no completed session at all, so it is the one needing attention.
    assert.equal(String(a.mentorships[0]._id), String(m2._id));
  });

  await t.test('per-row figures are that row\'s own', () => {
    const row = a.mentorships.find((r) => String(r._id) === String(m1._id));
    assert.equal(row.milestones.done, 3);
    assert.equal(row.milestones.total, 4);
    assert.ok(row.lastMetAt);
    assert.equal(row.nextAt, null);
  });

  await t.test('the soonest upcoming session is surfaced', () => {
    const row = a.mentorships.find((r) => String(r._id) === String(m2._id));
    assert.ok(row.nextAt);
    assert.equal(row.lastMetAt, null);
  });
});

test('every figure is scoped to the viewer', async (t) => {
  const a = await mine(USERS.student);

  await t.test('a student sees only their own mentorship', () => {
    assert.equal(a.mentorships.length, 1);
    assert.equal(String(a.mentorships[0]._id), String(m1._id));
  });

  await t.test('counted as a student, not a mentor', () => {
    assert.equal(a.totals.mentorships.asStudent, 1);
    assert.equal(a.totals.mentorships.asMentor, 0);
  });

  await t.test('isMentor and `other` resolve per viewer', () => {
    assert.equal(a.mentorships[0].isMentor, false);
    assert.equal(String(a.mentorships[0].other._id), USERS.mentor._id);
  });
});

test('someone with no mentorships gets a zeroed shape, not an error', async () => {
  const res = await api('/api/analytics/me', { as: USERS.admin });
  const a = await res.json();

  assert.equal(res.status, 200);
  assert.equal(a.mentorships.length, 0);
  // Zeroes rather than undefined, so the page renders its empty state instead
  // of throwing on a missing property.
  assert.equal(a.totals.milestones.total, 0);
  assert.equal(a.totals.sessions.minutesMet, 0);
});

test('an ended mentorship leaves the worklist but stays in the totals', async () => {
  await api(`/api/mentorships/${m2._id}`, {
    as: USERS.mentor,
    method: 'PATCH',
    body: { action: 'end' }
  });

  const a = await mine(USERS.mentor);

  assert.equal(a.mentorships.length, 1);
  assert.equal(a.totals.mentorships.active, 1);
  assert.equal(a.totals.mentorships.ended, 1);
  // Its goal's milestones go with it — the rows are a worklist.
  assert.equal(a.totals.milestones.total, 4);
});

test('analytics needs a token', async () => {
  const res = await api('/api/analytics/me');
  assert.equal(res.status, 401);
});

test('the admin overview counts the whole product, not just messages', async (t) => {
  const stats = await (await api('/api/admin/stats', { as: USERS.admin })).json();

  await t.test('mentorships, goals and sessions all appear', () => {
    assert.equal(stats.mentorships, 2);
    assert.equal(stats.activeMentorships, 1);
    assert.equal(stats.goals, 3);
    assert.equal(stats.sessions, 3);
    assert.equal(stats.completedSessions, 1);
  });

  await t.test('the older figures are still there', () => {
    assert.equal(typeof stats.users, 'number');
    assert.equal(typeof stats.announcements, 'number');
  });

  await t.test('and it is still admin-only', async () => {
    const res = await api('/api/admin/stats', { as: USERS.student });
    assert.equal(res.status, 403);
  });
});

// ---------------------------------------------------------------------------
// Streaks
//
// Both are derived at read time from hand-ins, so the fixtures are dates
// rather than counters. The API refuses a deadline in the past - rightly - so
// the deadline and the hand-in time are written afterwards, the same way the
// session fixtures above backdate a meeting that has already happened.
// ---------------------------------------------------------------------------

const DAY = 86400000;

const setWork = async (mentorship, title, as = USERS.mentor) => {
  const res = await api('/api/assignments', {
    as,
    method: 'POST',
    body: {
      title,
      dueAt: new Date(Date.now() + 30 * DAY).toISOString(),
      mentorshipIds: [mentorship._id]
    }
  });
  assert.equal(res.status, 201);
  return res.json();
};

const subFor = async (assignmentId, student) => {
  const { mine: rows } = await api('/api/assignments', { as: student }).then((r) => r.json());
  return rows.find((x) => String(x.assignment._id) === String(assignmentId));
};

/**
 * One assignment, with its deadline `dueDaysAgo` in the past (negative for
 * the future) and, when `handedDaysAgo` is given, a hand-in that long ago.
 */
async function work(mentorship, student, title, { dueDaysAgo, handedDaysAgo, as = USERS.mentor }) {
  const a = await setWork(mentorship, title, as);
  const sub = await subFor(a._id, student);

  if (handedDaysAgo !== undefined) {
    const res = await api(`/api/submissions/${sub._id}`, {
      as: student,
      method: 'PUT',
      body: { text: 'done', turnIn: true }
    });
    assert.equal(res.status, 200);

    await db()
      .collection('submissions')
      .updateOne(
        { _id: new mongoose.Types.ObjectId(sub._id) },
        { $set: { submittedAt: new Date(Date.now() - handedDaysAgo * DAY) } }
      );
  }

  await db()
    .collection('assignments')
    .updateOne(
      { _id: new mongoose.Types.ObjectId(a._id) },
      { $set: { dueAt: new Date(Date.now() - dueDaysAgo * DAY) } }
    );

  return a;
}

test('the on-time streak counts hand-ins that beat their deadline', async (t) => {
  await work(m1, USERS.student, 'S1', { dueDaysAgo: 31, handedDaysAgo: 32 });
  await work(m1, USERS.student, 'S2', { dueDaysAgo: 24, handedDaysAgo: 25 });
  await work(m1, USERS.student, 'S3', { dueDaysAgo: 17, handedDaysAgo: 18 });
  await work(m1, USERS.student, 'S4, handed in late', { dueDaysAgo: 10, handedDaysAgo: 9 });
  await work(m1, USERS.student, 'S5', { dueDaysAgo: 3, handedDaysAgo: 4 });
  await work(m1, USERS.student, 'S6, not due yet', { dueDaysAgo: -5 });

  const a = await mine(USERS.student);

  await t.test('a late hand-in breaks the run', () => {
    assert.equal(a.streaks.onTime.current, 1);
  });

  await t.test('the best run is remembered', () => {
    assert.equal(a.streaks.onTime.best, 3);
  });

  await t.test('work not yet due neither counts nor breaks it', () => {
    // Six were set, five handed in; the sixth is not yet either.
    assert.equal(a.streaks.handedIn, 5);
  });
});

test('a deadline that passes with nothing handed in breaks it too', async () => {
  await work(m1, USERS.student, 'S7, missed', { dueDaysAgo: 1 });

  const a = await mine(USERS.student);
  assert.equal(a.streaks.onTime.current, 0);
  assert.equal(a.streaks.onTime.best, 3, 'the best run still happened');
});

test('the weekly streak counts weeks with a hand-in in them', async (t) => {
  // m2 was ended by the test above, and work cannot be set for an ended
  // mentorship - rightly. A fresh one under the admin also keeps this
  // student's hand-ins to exactly the three below.
  const m3 = await api('/api/mentorships', {
    as: USERS.admin,
    method: 'POST',
    body: { studentId: USERS.student2._id, topic: 'Streaks' }
  }).then((r) => r.json());

  // Exactly seven days apart, so these are three consecutive weeks whatever
  // day the suite runs on.
  const byAdmin = { as: USERS.admin };
  await work(m3, USERS.student2, 'W1', { dueDaysAgo: 13, handedDaysAgo: 14, ...byAdmin });
  await work(m3, USERS.student2, 'W2', { dueDaysAgo: 6, handedDaysAgo: 7, ...byAdmin });
  await work(m3, USERS.student2, 'W3', { dueDaysAgo: -1, handedDaysAgo: 0, ...byAdmin });

  const a = await mine(USERS.student2);

  await t.test('three weeks running', () => {
    assert.equal(a.streaks.weeks, 3);
  });

  await t.test('and all three beat their deadlines', () => {
    assert.equal(a.streaks.onTime.current, 3);
  });
});

test('streaks are about your own hand-ins', async () => {
  // The mentor set every assignment above and handed in none of them.
  const a = await mine(USERS.mentor);
  assert.equal(a.streaks.handedIn, 0);
  assert.equal(a.streaks.onTime.current, 0);
  assert.equal(a.streaks.weeks, 0);
});
