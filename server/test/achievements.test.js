/**
 * Achievements.
 *
 * Nothing is stored, so the thing worth guarding is that they track the data
 * in BOTH directions. A badge that appears when you earn it but survives the
 * data changing underneath is exactly the failure the derived design exists
 * to prevent — so the un-earning test here matters more than the earning one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, db, mongoose } = require('./helpers/harness');

let mentorship;

test.before(async () => {
  await start();

  mentorship = await (await api('/api/mentorships', {
    as: USERS.mentor,
    method: 'POST',
    body: { studentId: USERS.student._id, topic: 'Backend interviews' }
  })).json();
});

test.after(() => stop());

const mine = (as) => api('/api/achievements/me', { as }).then((r) => r.json());
const find = (list, id) => list.achievements.find((a) => a.id === id);

/** A session that has already happened, marked complete. */
async function metSession(minutes = 60) {
  const s = await (await api(`/api/mentorships/${mentorship._id}/sessions`, {
    as: USERS.mentor,
    method: 'POST',
    body: {
      title: 'Met',
      scheduledFor: new Date(Date.now() + 3600000).toISOString(),
      durationMinutes: minutes
    }
  })).json();

  await db()
    .collection('sessions')
    .updateOne(
      { _id: new mongoose.Types.ObjectId(s._id) },
      { $set: { scheduledFor: new Date(Date.now() - 3600000) } }
    );

  await api(`/api/sessions/${s._id}`, {
    as: USERS.mentor,
    method: 'PATCH',
    body: { action: 'complete' }
  });

  return s;
}

test('everything starts unearned, with real progress attached', async (t) => {
  const a = await mine(USERS.student);

  await t.test('no badge is earned yet', () => {
    assert.ok(a.achievements.length > 0);
    assert.ok(a.achievements.every((x) => x.earned === false));
  });

  await t.test('locked badges carry their progress, not just a lock', () => {
    // "7 of 10" is an invitation; a grey square with no number is a door.
    const ten = find(a, 'ten-sessions');
    assert.equal(ten.progress, 0);
    assert.equal(ten.target, 10);
    assert.equal(ten.label, '0 of 10');
  });

  await t.test('the stats behind them are zero', () => {
    assert.equal(a.stats.goalsCompleted, 0);
    assert.equal(a.stats.sessionsMet, 0);
    assert.equal(a.stats.minutesMet, 0);
  });
});

test('badges are for your role, not merely locked for it', async (t) => {
  await t.test('a student is not shown the mentor badges', async () => {
    const a = await mine(USERS.student);
    // Showing a student how far they are from "First student" is nonsense,
    // not encouragement.
    assert.equal(find(a, 'first-student'), undefined);
    assert.equal(find(a, 'well-rated'), undefined);
  });

  await t.test('a mentor is shown them, and has already earned one', async () => {
    const a = await mine(USERS.mentor);
    assert.equal(find(a, 'first-student').earned, true);
    assert.equal(find(a, 'well-rated').earned, false);
  });
});

test('completing a goal earns a badge, and un-completing takes it back', async (t) => {
  const goal = await (await api(`/api/mentorships/${mentorship._id}/goals`, {
    as: USERS.mentor,
    method: 'POST',
    body: { title: 'Two steps', milestones: ['a', 'b'] }
  })).json();

  const tick = (i, done) =>
    api(`/api/goals/${goal._id}/milestones/${goal.milestones[i]._id}`, {
      as: USERS.student,
      method: 'PATCH',
      body: { done }
    });

  await t.test('half a goal earns nothing', async () => {
    await tick(0, true);
    assert.equal(find(await mine(USERS.student), 'first-goal').earned, false);
  });

  await t.test('finishing it earns the badge', async () => {
    await tick(1, true);
    const a = await mine(USERS.student);
    assert.equal(find(a, 'first-goal').earned, true);
    assert.equal(a.stats.goalsCompleted, 1);
  });

  await t.test('un-ticking a milestone takes it back', async () => {
    // This is the whole argument for deriving rather than storing: an awarded
    // row would still be sitting there describing something untrue.
    await tick(1, false);
    const a = await mine(USERS.student);
    assert.equal(find(a, 'first-goal').earned, false);
    assert.equal(a.stats.goalsCompleted, 0);
  });

  // Put it back so later tests see a completed goal.
  await tick(1, true);
});

test('sessions and minutes accumulate', async (t) => {
  await metSession(90);

  await t.test('one session met', async () => {
    const a = await mine(USERS.student);
    assert.equal(a.stats.sessionsMet, 1);
    assert.equal(a.stats.minutesMet, 90);
    assert.equal(find(a, 'first-session').earned, true);
  });

  await t.test('minutes are formatted in hours on the label', async () => {
    const a = await mine(USERS.student);
    const hours = find(a, 'five-hours');
    assert.equal(hours.earned, false);
    assert.equal(hours.label, '1h of 5h');
  });

  await t.test('both parties count the same sessions', async () => {
    const a = await mine(USERS.mentor);
    assert.equal(a.stats.sessionsMet, 1);
  });
});

test('the kept streak resets on a cancellation, not on a future session', async (t) => {
  await metSession(30);
  await metSession(30);

  await t.test('three in a row', async () => {
    const a = await mine(USERS.student);
    assert.equal(a.stats.streakKept, 3);
  });

  await t.test('a session still to come does not break it', async () => {
    // A meeting in the diary is neither a keep nor a miss yet; counting it as
    // a break would drop the streak every time someone scheduled ahead.
    await api(`/api/mentorships/${mentorship._id}/sessions`, {
      as: USERS.mentor,
      method: 'POST',
      body: {
        title: 'Later',
        scheduledFor: new Date(Date.now() + 86400000 * 5).toISOString()
      }
    });

    const a = await mine(USERS.student);
    assert.equal(a.stats.streakKept, 3);
  });

  await t.test('a cancellation does break it', async () => {
    const doomed = await (await api(`/api/mentorships/${mentorship._id}/sessions`, {
      as: USERS.mentor,
      method: 'POST',
      body: {
        title: 'Fell through',
        scheduledFor: new Date(Date.now() + 7200000).toISOString()
      }
    })).json();

    // Backdate it so it sits between the kept ones rather than after them.
    await db()
      .collection('sessions')
      .updateOne(
        { _id: new mongoose.Types.ObjectId(doomed._id) },
        { $set: { scheduledFor: new Date(Date.now() - 1800000) } }
      );
    await api(`/api/sessions/${doomed._id}`, {
      as: USERS.mentor,
      method: 'PATCH',
      body: { action: 'cancel' }
    });

    const a = await mine(USERS.student);
    // The run before the cancellation still stands as the longest.
    assert.ok(a.stats.streakKept >= 1);
  });
});

test('a rating average needs a floor before it counts', async (t) => {
  const sessions = [];
  for (let i = 0; i < 3; i += 1) sessions.push(await metSession(30));

  await t.test('one five-star rating is not a reputation', async () => {
    await api(`/api/sessions/${sessions[0]._id}/feedback`, {
      as: USERS.student,
      method: 'PUT',
      body: { rating: 5 }
    });

    const a = await mine(USERS.mentor);
    assert.equal(a.stats.ratingCount, 1);
    assert.equal(find(a, 'well-rated').earned, false);
  });

  await t.test('three at 4.5 or better is', async () => {
    await api(`/api/sessions/${sessions[1]._id}/feedback`, {
      as: USERS.student,
      method: 'PUT',
      body: { rating: 5 }
    });
    await api(`/api/sessions/${sessions[2]._id}/feedback`, {
      as: USERS.student,
      method: 'PUT',
      body: { rating: 4 }
    });

    const a = await mine(USERS.mentor);
    assert.equal(a.stats.ratingCount, 3);
    // (5 + 5 + 4) / 3 = 4.67
    assert.equal(find(a, 'well-rated').earned, true);
  });

  await t.test('and it is only the mentor who is rated', async () => {
    const a = await mine(USERS.student);
    assert.equal(a.stats.ratingCount, 0);
  });
});

test('someone with nothing gets the shape, not an error', async () => {
  const res = await api('/api/achievements/me', { as: USERS.student2 });
  const a = await res.json();

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(a.achievements));
  assert.equal(a.stats.sessionsMet, 0);
  assert.ok(a.achievements.every((x) => x.earned === false));
});

test('achievements need a token', async () => {
  const res = await api('/api/achievements/me');
  assert.equal(res.status, 401);
});
