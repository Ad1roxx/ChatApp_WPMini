/**
 * Assignments — set, handed in, reviewed.
 *
 * The permissions are the point and they are strictly one-directional: the
 * mentor sets and reviews, the student submits, and neither can do the
 * other's half. Everything else here guards the transitions, which are the
 * part most likely to be loosened later by someone who does not know why
 * `changes-requested` goes back to `submitted` rather than to `assigned`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, db, mongoose } = require('./helpers/harness');

let mentorship;
let ended;

test.before(async () => {
  await start();

  mentorship = await (await api('/api/mentorships', {
    as: USERS.mentor,
    method: 'POST',
    body: { studentId: USERS.student._id, topic: 'Backend interviews' }
  })).json();

  ended = await (await api('/api/mentorships', {
    as: USERS.mentor,
    method: 'POST',
    body: { studentId: USERS.student2._id, topic: 'Finished' }
  })).json();

  await api(`/api/mentorships/${ended._id}`, {
    as: USERS.mentor,
    method: 'PATCH',
    body: { action: 'end' }
  });
});

test.after(() => stop());

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

const setWork = (as, body, id = mentorship._id) =>
  api(`/api/mentorships/${id}/assignments`, { as, method: 'POST', body });

const handIn = (as, id, body) =>
  api(`/api/assignments/${id}/submission`, { as, method: 'PUT', body });

const review = (as, id, body) =>
  api(`/api/assignments/${id}`, { as, method: 'PATCH', body });

/** A fresh assignment, for tests that need one of their own. */
async function fresh(title = 'Task') {
  const res = await setWork(USERS.mentor, { title, dueAt: inDays(7) });
  assert.equal(res.status, 201);
  return res.json();
}

test('only the mentor sets work', async (t) => {
  await t.test('a student cannot', async () => {
    const res = await setWork(USERS.student, { title: 'Mine', dueAt: inDays(3) });
    assert.equal(res.status, 403);
  });

  await t.test('an outsider cannot', async () => {
    const res = await setWork(USERS.admin, { title: 'Nope', dueAt: inDays(3) });
    assert.equal(res.status, 403);
  });

  await t.test('not on an ended mentorship', async () => {
    const res = await setWork(USERS.mentor, { title: 'Late', dueAt: inDays(3) }, ended._id);
    assert.equal(res.status, 400);
  });

  await t.test('the mentor can, and it starts unassigned-to-nobody', async () => {
    const a = await fresh('Solve five array problems');
    assert.equal(a.status, 'assigned');
    assert.equal(a.submission.submittedAt, null);
    assert.equal(a.late, false);
  });
});

test('a due date is required, and must be in the future', async (t) => {
  await t.test('missing', async () => {
    const res = await setWork(USERS.mentor, { title: 'No date' });
    assert.equal(res.status, 400);
  });

  await t.test('unparseable', async () => {
    const res = await setWork(USERS.mentor, { title: 'Bad', dueAt: 'next Tuesday' });
    assert.equal(res.status, 400);
  });

  await t.test('in the past', async () => {
    // Work that was already overdue when it appeared is a typo, not a plan.
    const res = await setWork(USERS.mentor, { title: 'Past', dueAt: inDays(-1) });
    assert.equal(res.status, 400);
  });

  await t.test('and a title is required', async () => {
    const res = await setWork(USERS.mentor, { title: '  ', dueAt: inDays(3) });
    assert.equal(res.status, 400);
  });
});

test('only the student hands work in', async (t) => {
  const a = await fresh('Hand-in rules');

  await t.test('the mentor cannot submit on their behalf', async () => {
    const res = await handIn(USERS.mentor, a._id, { text: 'done' });
    assert.equal(res.status, 403);
  });

  await t.test('an outsider cannot', async () => {
    const res = await handIn(USERS.student2, a._id, { text: 'done' });
    assert.equal(res.status, 403);
  });

  await t.test('an empty submission is not a submission', async () => {
    const res = await handIn(USERS.student, a._id, { text: '   ', url: '' });
    assert.equal(res.status, 400);
  });

  await t.test('the student can, with text', async () => {
    const done = await (await handIn(USERS.student, a._id, {
      text: 'Solved all five, notes attached.'
    })).json();

    assert.equal(done.status, 'submitted');
    assert.ok(done.submission.submittedAt);
    assert.equal(done.submission.text, 'Solved all five, notes attached.');
  });
});

test('a submitted link is allow-listed like every other link', async (t) => {
  const a = await fresh('Link rules');

  // The mentor opens this from an href, so a javascript: URL here is stored
  // XSS pointed at them.
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
    await t.test(`${url.slice(0, 22)} is refused`, async () => {
      const res = await handIn(USERS.student, a._id, { url });
      assert.equal(res.status, 400);
    });
  }

  await t.test('an http link is accepted', async () => {
    const done = await (await handIn(USERS.student, a._id, {
      url: 'https://github.com/example/pr/1'
    })).json();
    assert.equal(done.submission.url, 'https://github.com/example/pr/1');
  });
});

test('only the mentor reviews', async (t) => {
  const a = await fresh('Review rules');
  await handIn(USERS.student, a._id, { text: 'here you go' });

  await t.test('the student cannot accept their own work', async () => {
    const res = await review(USERS.student, a._id, { action: 'accept' });
    assert.equal(res.status, 403);
  });

  await t.test('asking for changes needs a reason', async () => {
    // "Do it again" with no note leaves the student guessing.
    const res = await review(USERS.mentor, a._id, { action: 'request-changes', note: '  ' });
    assert.equal(res.status, 400);
  });

  await t.test('the mentor can send it back with one', async () => {
    const back = await (await review(USERS.mentor, a._id, {
      action: 'request-changes',
      note: 'Question three is wrong — try again.'
    })).json();

    assert.equal(back.status, 'changes-requested');
    assert.equal(back.review.note, 'Question three is wrong — try again.');
    assert.ok(back.review.reviewedAt);
  });

  await t.test('the student resubmits, and the old note is cleared', async () => {
    const again = await (await handIn(USERS.student, a._id, { text: 'fixed it' })).json();

    assert.equal(again.status, 'submitted');
    // A resubmission is a fresh answer; leaving the old "change this" hanging
    // over new work would misread as a second rejection.
    assert.equal(again.review.note, '');
    assert.equal(again.review.reviewedAt, null);
  });

  await t.test('and then it can be accepted', async () => {
    const ok = await (await review(USERS.mentor, a._id, { action: 'accept' })).json();
    assert.equal(ok.status, 'accepted');
  });

  await t.test('accepted is terminal for both sides', async () => {
    const resub = await handIn(USERS.student, a._id, { text: 'more' });
    assert.equal(resub.status, 400);

    const rereview = await review(USERS.mentor, a._id, { action: 'accept' });
    assert.equal(rereview.status, 400);
  });
});

test('nothing can be reviewed before it is handed in', async () => {
  const a = await fresh('Not yet');
  const res = await review(USERS.mentor, a._id, { action: 'accept' });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /handed in/i);
});

test('lateness is derived from the dates, in both directions', async (t) => {
  const a = await fresh('Timing');

  await t.test('not late before the deadline', () => {
    assert.equal(a.late, false);
  });

  await t.test('late once the deadline passes with nothing handed in', async () => {
    await db()
      .collection('assignments')
      .updateOne(
        { _id: new mongoose.Types.ObjectId(a._id) },
        { $set: { dueAt: new Date(Date.now() - 86400000) } }
      );

    const [row] = await (await api(`/api/mentorships/${mentorship._id}/assignments`, {
      as: USERS.student
    })).json().then((rows) => rows.filter((x) => x._id === a._id));

    assert.equal(row.late, true);
  });

  await t.test('still late once handed in after the deadline', async () => {
    const done = await (await handIn(USERS.student, a._id, { text: 'sorry' })).json();
    assert.equal(done.late, true);
  });

  await t.test('extending the deadline un-lates it, with no stored flag to fix', async () => {
    // The whole argument for deriving: the answer changes the moment the
    // date does, with nothing to keep in step.
    const moved = await (await review(USERS.mentor, a._id, { dueAt: inDays(5) })).json();
    assert.equal(moved.late, false);
  });
});

test('withdrawing is the mentor\'s, and not once accepted', async (t) => {
  const a = await fresh('To withdraw');

  await t.test('a student cannot withdraw work set for them', async () => {
    const res = await api(`/api/assignments/${a._id}`, {
      as: USERS.student,
      method: 'DELETE'
    });
    assert.equal(res.status, 403);
  });

  await t.test('the mentor can', async () => {
    const res = await api(`/api/assignments/${a._id}`, {
      as: USERS.mentor,
      method: 'DELETE'
    });
    assert.equal(res.status, 200);
  });

  await t.test('but not accepted work — that is a record of what they did', async () => {
    const b = await fresh('Accepted');
    await handIn(USERS.student, b._id, { text: 'done' });
    await review(USERS.mentor, b._id, { action: 'accept' });

    const res = await api(`/api/assignments/${b._id}`, {
      as: USERS.mentor,
      method: 'DELETE'
    });
    assert.equal(res.status, 400);
  });
});

test('both parties see the list, soonest deadline first', async (t) => {
  await t.test('the student sees what was set', async () => {
    const rows = await (await api(`/api/mentorships/${mentorship._id}/assignments`, {
      as: USERS.student
    })).json();
    assert.ok(rows.length > 0);
  });

  await t.test('sorted by due date', async () => {
    const rows = await (await api(`/api/mentorships/${mentorship._id}/assignments`, {
      as: USERS.mentor
    })).json();
    const times = rows.map((r) => new Date(r.dueAt).getTime());
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i - 1] <= times[i]);
    }
  });

  await t.test('an outsider sees none of it', async () => {
    const res = await api(`/api/mentorships/${mentorship._id}/assignments`, {
      as: USERS.admin
    });
    assert.equal(res.status, 403);
  });
});

test('the usual refusals', async (t) => {
  await t.test('a missing assignment', async () => {
    const res = await review(USERS.mentor, '0000000000000000000000ff', { action: 'accept' });
    assert.equal(res.status, 404);
  });

  await t.test('an unknown action', async () => {
    const a = await fresh('Unknown action');
    const res = await review(USERS.mentor, a._id, { action: 'explode' });
    assert.equal(res.status, 400);
  });

  await t.test('a PATCH that changes nothing', async () => {
    const a = await fresh('Nothing to change');
    const res = await review(USERS.mentor, a._id, {});
    assert.equal(res.status, 400);
  });

  await t.test('no token', async () => {
    const res = await api(`/api/mentorships/${mentorship._id}/assignments`);
    assert.equal(res.status, 401);
  });
});
