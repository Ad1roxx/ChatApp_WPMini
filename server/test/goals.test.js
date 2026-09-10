/**
 * Goals and milestones.
 *
 * Two things are worth guarding here. The permissions are asymmetric on
 * purpose — the mentor sets goals, either party ticks milestones — and the
 * status is *derived*, so the interesting failure is not a wrong status code
 * but a status that quietly disagrees with the milestones it summarises.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api } = require('./helpers/harness');

let mentorship;

// One hook, not two: a second root `before` is not guaranteed to run after
// the first has resolved, and the seeding below needs a listening server.
test.before(async () => {
  await start();

  const res = await api('/api/mentorships', {
    as: USERS.mentor,
    method: 'POST',
    body: { studentId: USERS.student._id, topic: 'Backend interviews' }
  });
  mentorship = await res.json();
});

test.after(() => stop());

const setGoal = (as, body) =>
  api(`/api/mentorships/${mentorship._id}/goals`, { as, method: 'POST', body });

const tick = (goalId, milestoneId, as, done) =>
  api(`/api/goals/${goalId}/milestones/${milestoneId}`, {
    as,
    method: 'PATCH',
    body: { done }
  });

test('only the mentor sets goals', async (t) => {
  await t.test('a student cannot', async () => {
    const res = await setGoal(USERS.student, { title: 'My own goal' });
    assert.equal(res.status, 403);
  });

  await t.test('someone outside the mentorship cannot', async () => {
    const res = await setGoal(USERS.student2, { title: 'Not mine' });
    assert.equal(res.status, 403);
  });

  await t.test('a title is required', async () => {
    const res = await setGoal(USERS.mentor, { title: '   ' });
    assert.equal(res.status, 400);
  });

  await t.test('the mentor can', async () => {
    const res = await setGoal(USERS.mentor, {
      title: 'Be ready for interviews',
      milestones: ['Arrays', 'Linked lists']
    });
    assert.equal(res.status, 200);
  });
});

test('either party may tick a milestone', async (t) => {
  const goal = await (await setGoal(USERS.mentor, {
    title: 'Ticking',
    milestones: ['one', 'two']
  })).json();

  await t.test('the student can, and it records who did', async () => {
    const updated = await (await tick(goal._id, goal.milestones[0]._id, USERS.student, true)).json();
    const m = updated.milestones[0];

    assert.equal(m.done, true);
    assert.ok(m.doneAt);
    // doneBy is what keeps "the student says it is done" distinguishable
    // from "the mentor confirmed it".
    assert.equal(String(m.doneBy), USERS.student._id);
  });

  await t.test('so can the mentor', async () => {
    const updated = await (await tick(goal._id, goal.milestones[1]._id, USERS.mentor, true)).json();
    assert.equal(String(updated.milestones[1].doneBy), USERS.mentor._id);
  });

  await t.test('but nobody else', async () => {
    const res = await tick(goal._id, goal.milestones[0]._id, USERS.student2, false);
    assert.equal(res.status, 403);
  });

  await t.test('and `done` has to be a boolean', async () => {
    const res = await api(`/api/goals/${goal._id}/milestones/${goal.milestones[0]._id}`, {
      as: USERS.student,
      method: 'PATCH',
      body: { done: 'yes' }
    });
    assert.equal(res.status, 400);
  });
});

test('status is derived from the milestones, in both directions', async (t) => {
  const goal = await (await setGoal(USERS.mentor, {
    title: 'Derived status',
    milestones: ['a', 'b']
  })).json();

  await t.test('it starts active', () => {
    assert.equal(goal.status, 'active');
    assert.equal(goal.completedAt, null);
  });

  await t.test('half done is still active', async () => {
    const half = await (await tick(goal._id, goal.milestones[0]._id, USERS.student, true)).json();
    assert.equal(half.status, 'active');
  });

  await t.test('the last tick completes it', async () => {
    const full = await (await tick(goal._id, goal.milestones[1]._id, USERS.student, true)).json();
    assert.equal(full.status, 'completed');
    assert.ok(full.completedAt);
  });

  await t.test('un-ticking takes it back, and clears completedAt', async () => {
    const back = await (await tick(goal._id, goal.milestones[1]._id, USERS.student, false)).json();
    assert.equal(back.status, 'active');
    assert.equal(back.completedAt, null);
  });
});

test('a goal with no milestones is never complete', async () => {
  // 0 of 0 reading as 100% would be a lie: there is nothing to have done.
  const goal = await (await setGoal(USERS.mentor, { title: 'Nothing to tick' })).json();
  assert.equal(goal.milestones.length, 0);
  assert.equal(goal.status, 'active');
});

test('archiving is the one status a person sets', async (t) => {
  const goal = await (await setGoal(USERS.mentor, {
    title: 'To archive',
    milestones: ['x', 'y']
  })).json();

  await t.test('a student cannot archive', async () => {
    const res = await api(`/api/goals/${goal._id}`, {
      as: USERS.student,
      method: 'PATCH',
      body: { archived: true }
    });
    assert.equal(res.status, 403);
  });

  await t.test('the mentor can', async () => {
    const archived = await (await api(`/api/goals/${goal._id}`, {
      as: USERS.mentor,
      method: 'PATCH',
      body: { archived: true }
    })).json();
    assert.equal(archived.status, 'archived');
  });

  await t.test('an archived goal cannot be ticked', async () => {
    const res = await tick(goal._id, goal.milestones[0]._id, USERS.student, true);
    assert.equal(res.status, 400);
  });

  await t.test('un-archiving hands the status back to the milestones', async () => {
    const back = await (await api(`/api/goals/${goal._id}`, {
      as: USERS.mentor,
      method: 'PATCH',
      body: { archived: false }
    })).json();
    // Not a guess at 'active': it is recomputed, and these are undone.
    assert.equal(back.status, 'active');
  });
});

test('listing and the usual refusals', async (t) => {
  await t.test('both parties see the same list', async () => {
    const asMentor = await (await api(`/api/mentorships/${mentorship._id}/goals`, {
      as: USERS.mentor
    })).json();
    const asStudent = await (await api(`/api/mentorships/${mentorship._id}/goals`, {
      as: USERS.student
    })).json();

    assert.equal(asMentor.length, asStudent.length);
    assert.ok(asMentor.length > 0);
  });

  await t.test('an outsider sees none of it', async () => {
    const res = await api(`/api/mentorships/${mentorship._id}/goals`, { as: USERS.student2 });
    assert.equal(res.status, 403);
  });

  await t.test('a missing goal', async () => {
    const res = await api('/api/goals/0000000000000000000000ff', {
      as: USERS.mentor,
      method: 'PATCH',
      body: { archived: true }
    });
    assert.equal(res.status, 404);
  });

  await t.test('no token', async () => {
    const res = await api(`/api/mentorships/${mentorship._id}/goals`);
    assert.equal(res.status, 401);
  });
});
