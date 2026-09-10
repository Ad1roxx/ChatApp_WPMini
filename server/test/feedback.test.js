/**
 * Session feedback.
 *
 * Two rules carry the feature and both are one-directional, so both are easy
 * to break into something symmetric by accident: only the student rates, and
 * only a session that actually happened can be rated. The third thing worth
 * guarding is that re-rating REPLACES — a double submit that double-counted
 * would quietly inflate a mentor's average with nothing visibly wrong.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, db, mongoose } = require('./helpers/harness');

let mentorship;
let completed;
let upcoming;

test.before(async () => {
  await start();

  mentorship = await (await api('/api/mentorships', {
    as: USERS.mentor,
    method: 'POST',
    body: { studentId: USERS.student._id, topic: 'Backend interviews' }
  })).json();

  const makeSession = (title, mins) =>
    api(`/api/mentorships/${mentorship._id}/sessions`, {
      as: USERS.mentor,
      method: 'POST',
      body: { title, scheduledFor: new Date(Date.now() + mins * 60000).toISOString() }
    }).then((r) => r.json());

  completed = await makeSession('Met', 60);
  upcoming = await makeSession('Still to come', 60 * 48);

  // Creating a session in the past is refused on purpose, so the clock moves
  // in the database instead.
  await db()
    .collection('sessions')
    .updateOne(
      { _id: new mongoose.Types.ObjectId(completed._id) },
      { $set: { scheduledFor: new Date(Date.now() - 3600000) } }
    );

  await api(`/api/sessions/${completed._id}`, {
    as: USERS.mentor,
    method: 'PATCH',
    body: { action: 'complete' }
  });
});

test.after(() => stop());

const rate = (as, sessionId, body) =>
  api(`/api/sessions/${sessionId}/feedback`, { as, method: 'PUT', body });

test('only the student rates, and only a session that happened', async (t) => {
  await t.test('the mentor cannot rate their own session', async () => {
    const res = await rate(USERS.mentor, completed._id, { rating: 5 });
    assert.equal(res.status, 403);
  });

  await t.test('an outsider cannot rate it either', async () => {
    const res = await rate(USERS.student2, completed._id, { rating: 5 });
    assert.equal(res.status, 403);
  });

  await t.test('a session that has not happened cannot be rated', async () => {
    // Rating a meeting that is still to come would be rating an intention.
    const res = await rate(USERS.student, upcoming._id, { rating: 5 });
    assert.equal(res.status, 400);
  });

  await t.test('the student can rate a completed one', async () => {
    const res = await rate(USERS.student, completed._id, {
      rating: 4,
      comment: 'Union-find finally clicked.'
    });
    const saved = await res.json();

    assert.equal(res.status, 200);
    assert.equal(saved.rating, 4);
    assert.equal(saved.comment, 'Union-find finally clicked.');
    // Attributed, because a room of two makes anonymity impossible anyway.
    assert.equal(String(saved.from._id), USERS.student._id);
    assert.equal(String(saved.to), USERS.mentor._id);
  });
});

test('the scale is five whole points', async (t) => {
  for (const bad of [0, 6, 3.5, 'five', null]) {
    await t.test(`${JSON.stringify(bad)} is refused`, async () => {
      const res = await rate(USERS.student, completed._id, { rating: bad });
      assert.equal(res.status, 400);
    });
  }
});

test('rating again replaces rather than adds', async (t) => {
  await t.test('the second rating wins', async () => {
    const updated = await (await rate(USERS.student, completed._id, {
      rating: 5,
      comment: 'Better than I first said.'
    })).json();

    assert.equal(updated.rating, 5);
    assert.equal(updated.comment, 'Better than I first said.');
  });

  await t.test('and there is still only one', async () => {
    // A double submit that double-counted would inflate the average with
    // nothing visibly wrong on the page.
    const count = await db()
      .collection('feedbacks')
      .countDocuments({ session: new mongoose.Types.ObjectId(completed._id) });
    assert.equal(count, 1);
  });
});

test('both parties see the feedback in their mentorship', async (t) => {
  await t.test('the student sees theirs', async () => {
    const rows = await (await api(`/api/mentorships/${mentorship._id}/feedback`, {
      as: USERS.student
    })).json();
    assert.equal(rows.length, 1);
  });

  await t.test('the mentor sees it too, because it is about them', async () => {
    const rows = await (await api(`/api/mentorships/${mentorship._id}/feedback`, {
      as: USERS.mentor
    })).json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rating, 5);
  });

  await t.test('an outsider sees none of it', async () => {
    const res = await api(`/api/mentorships/${mentorship._id}/feedback`, {
      as: USERS.student2
    });
    assert.equal(res.status, 403);
  });
});

test('the profile summary averages what a mentor has received', async (t) => {
  await t.test('one five-star rating', async () => {
    const s = await (await api(`/api/users/${USERS.mentor._id}/feedback`, {
      as: USERS.student
    })).json();

    assert.equal(s.count, 1);
    assert.equal(s.average, 5);
    assert.equal(s.recent.length, 1);
  });

  await t.test('a second rating moves the average, rounded to one decimal', async () => {
    const second = await (await api(`/api/mentorships/${mentorship._id}/sessions`, {
      as: USERS.mentor,
      method: 'POST',
      body: { title: 'Another', scheduledFor: new Date(Date.now() + 3600000).toISOString() }
    })).json();

    await db()
      .collection('sessions')
      .updateOne(
        { _id: new mongoose.Types.ObjectId(second._id) },
        { $set: { scheduledFor: new Date(Date.now() - 3600000) } }
      );
    await api(`/api/sessions/${second._id}`, {
      as: USERS.mentor,
      method: 'PATCH',
      body: { action: 'complete' }
    });
    await rate(USERS.student, second._id, { rating: 4 });

    const s = await (await api(`/api/users/${USERS.mentor._id}/feedback`, {
      as: USERS.student
    })).json();

    assert.equal(s.count, 2);
    assert.equal(s.average, 4.5);
  });

  await t.test('ratings with no comment stay out of the quotes', async () => {
    const s = await (await api(`/api/users/${USERS.mentor._id}/feedback`, {
      as: USERS.student
    })).json();

    // Two ratings, but only one of them said anything. A blank quote would
    // be a row of whitespace pretending to be a review.
    assert.equal(s.count, 2);
    assert.equal(s.recent.length, 1);
    assert.ok(s.recent.every((f) => f.comment));
  });

  await t.test('someone with no ratings gets zeroes, not an error', async () => {
    const res = await api(`/api/users/${USERS.student2._id}/feedback`, { as: USERS.student });
    const s = await res.json();

    assert.equal(res.status, 200);
    assert.equal(s.count, 0);
    assert.equal(s.average, null);
    assert.deepEqual(s.recent, []);
  });
});

test('the usual refusals', async (t) => {
  await t.test('a missing session', async () => {
    const res = await rate(USERS.student, '0000000000000000000000ff', { rating: 5 });
    assert.equal(res.status, 404);
  });

  await t.test('no token on rating', async () => {
    const res = await api(`/api/sessions/${completed._id}/feedback`, {
      method: 'PUT',
      body: { rating: 5 }
    });
    assert.equal(res.status, 401);
  });

  await t.test('no token on the summary', async () => {
    const res = await api(`/api/users/${USERS.mentor._id}/feedback`);
    assert.equal(res.status, 401);
  });
});
