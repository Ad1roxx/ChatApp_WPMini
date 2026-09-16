/**
 * Assignments — one brief, several students, each handing in on their own.
 *
 * Three things carry the feature and each has tests below:
 *
 * - **Only your own, active students.** A mentor setting work for someone
 *   else's student would let any mentor put tasks in front of anyone.
 * - **Students never see each other's work.** The per-assignment view lists
 *   every hand-in and every piece of feedback, and belongs to the mentor.
 * - **Each student's state is their own.** One hand-in, one review, one late
 *   flag — nothing one student does moves another's row.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, db, mongoose } = require('./helpers/harness');

let m1; // mentor  → student
let m2; // mentor  → student2
let m3; // admin   → student   (someone else's student, as far as `mentor` is concerned)
let m4; // admin   → student2, ended

const addStudent = (as, studentId, topic) =>
  api('/api/mentorships', { as, method: 'POST', body: { studentId, topic } }).then((r) =>
    r.json()
  );

test.before(async () => {
  await start();

  m1 = await addStudent(USERS.mentor, USERS.student._id, 'Backend interviews');
  m2 = await addStudent(USERS.mentor, USERS.student2._id, 'System design');
  m3 = await addStudent(USERS.admin, USERS.student._id, 'Something else');
  m4 = await addStudent(USERS.admin, USERS.student2._id, 'Finished');

  await api(`/api/mentorships/${m4._id}`, {
    as: USERS.admin,
    method: 'PATCH',
    body: { action: 'end' }
  });
});

test.after(() => stop());

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

const setWork = (as, body) => api('/api/assignments', { as, method: 'POST', body });
const handIn = (as, subId, body) => api(`/api/submissions/${subId}`, { as, method: 'PUT', body });
const review = (as, subId, body) => api(`/api/submissions/${subId}`, { as, method: 'PATCH', body });
const edit = (as, id, body) => api(`/api/assignments/${id}`, { as, method: 'PATCH', body });
const detail = (as, id) => api(`/api/assignments/${id}`, { as });
const everything = (as) => api('/api/assignments', { as }).then((r) => r.json());

/** Set shared work and return it. */
async function shared(title = 'Task', ids = [m1._id, m2._id]) {
  const res = await setWork(USERS.mentor, { title, dueAt: inDays(7), mentorshipIds: ids });
  assert.equal(res.status, 201);
  return res.json();
}

/** A given student's own hand-in row for an assignment. */
async function subFor(assignmentId, student) {
  const { mine } = await everything(student);
  return mine.find((s) => String(s.assignment._id) === String(assignmentId));
}

test('one brief goes to several students at once', async (t) => {
  const a = await shared('Solve five array problems');

  await t.test('created, with a row per recipient', () => {
    assert.equal(a.summary.total, 2);
    assert.equal(a.summary.handedIn, 0);
    assert.equal(a.mentorships.length, 2);
  });

  await t.test('each student has exactly one hand-in, not yet started', async () => {
    const s1 = await subFor(a._id, USERS.student);
    const s2 = await subFor(a._id, USERS.student2);

    assert.ok(s1 && s2);
    assert.notEqual(String(s1._id), String(s2._id));
    assert.equal(s1.status, 'assigned');
    assert.equal(s2.status, 'assigned');
  });

  await t.test('sending the same student twice makes one row, not two', async () => {
    const dup = await shared('Duplicate recipient', [m1._id, m1._id]);
    assert.equal(dup.summary.total, 1);
  });
});

test('only your own, active students', async (t) => {
  await t.test('a student cannot set work', async () => {
    const res = await setWork(USERS.student, {
      title: 'Mine',
      dueAt: inDays(3),
      mentorshipIds: [m1._id]
    });
    assert.equal(res.status, 403);
  });

  await t.test('a mentor cannot include someone else\'s student', async () => {
    // Otherwise any mentor could put tasks in front of any student.
    const res = await setWork(USERS.mentor, {
      title: 'Poaching',
      dueAt: inDays(3),
      mentorshipIds: [m1._id, m3._id]
    });
    assert.equal(res.status, 403);
  });

  await t.test('and the whole list is refused, not just the bad entry', async () => {
    // A mentor who ticked two and reached one would not know which was missed.
    const { set } = await everything(USERS.mentor);
    assert.ok(set.every((x) => x.title !== 'Poaching'));
  });

  await t.test('an ended mentorship cannot receive work', async () => {
    const res = await setWork(USERS.admin, {
      title: 'Too late',
      dueAt: inDays(3),
      mentorshipIds: [m4._id]
    });
    assert.equal(res.status, 400);
  });

  await t.test('at least one student is required', async () => {
    const res = await setWork(USERS.mentor, { title: 'Nobody', dueAt: inDays(3), mentorshipIds: [] });
    assert.equal(res.status, 400);
  });

  await t.test('an unknown mentorship', async () => {
    const res = await setWork(USERS.mentor, {
      title: 'Ghost',
      dueAt: inDays(3),
      mentorshipIds: ['0000000000000000000000ff']
    });
    assert.equal(res.status, 404);
  });
});

test('the brief needs a title and a future deadline', async (t) => {
  const base = { mentorshipIds: [m1._id] };

  await t.test('no title', async () => {
    const res = await setWork(USERS.mentor, { ...base, title: '  ', dueAt: inDays(3) });
    assert.equal(res.status, 400);
  });

  await t.test('no deadline', async () => {
    const res = await setWork(USERS.mentor, { ...base, title: 'No date' });
    assert.equal(res.status, 400);
  });

  await t.test('an unparseable deadline', async () => {
    const res = await setWork(USERS.mentor, { ...base, title: 'Bad', dueAt: 'next Tuesday' });
    assert.equal(res.status, 400);
  });

  await t.test('a deadline in the past', async () => {
    const res = await setWork(USERS.mentor, { ...base, title: 'Past', dueAt: inDays(-1) });
    assert.equal(res.status, 400);
  });
});

test('each student hands in on their own', async (t) => {
  const a = await shared('Independent hand-ins');
  const s1 = await subFor(a._id, USERS.student);
  const s2 = await subFor(a._id, USERS.student2);

  await t.test('one student hands in', async () => {
    const done = await (await handIn(USERS.student, s1._id, { text: 'Solved all five.' })).json();
    assert.equal(done.status, 'submitted');
    assert.ok(done.submittedAt);
  });

  await t.test('and the other student\'s row is untouched', async () => {
    const other = await subFor(a._id, USERS.student2);
    assert.equal(other.status, 'assigned');
    assert.equal(other.submittedAt, null);
  });

  await t.test('the summary counts it', async () => {
    const d = await (await detail(USERS.mentor, a._id)).json();
    assert.equal(d.summary.handedIn, 1);
    assert.equal(d.summary.toReview, 1);
    assert.equal(d.summary.total, 2);
  });

  await t.test('a classmate cannot hand in someone else\'s work', async () => {
    const res = await handIn(USERS.student2, s1._id, { text: 'not mine' });
    assert.equal(res.status, 403);
  });

  await t.test('the mentor cannot hand in for them', async () => {
    const res = await handIn(USERS.mentor, s2._id, { text: 'done for you' });
    assert.equal(res.status, 403);
  });

  await t.test('an empty hand-in is not one', async () => {
    const res = await handIn(USERS.student2, s2._id, { text: '  ', url: '' });
    assert.equal(res.status, 400);
  });
});

test('a handed-in link is allow-listed', async (t) => {
  const a = await shared('Link rules', [m1._id]);
  const s = await subFor(a._id, USERS.student);

  // The mentor opens this from an href: a javascript: URL is XSS aimed at them.
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
    await t.test(`${url.slice(0, 22)} is refused`, async () => {
      const res = await handIn(USERS.student, s._id, { url });
      assert.equal(res.status, 400);
    });
  }

  await t.test('an https link is accepted', async () => {
    const done = await (await handIn(USERS.student, s._id, {
      url: 'https://github.com/example/pr/1'
    })).json();
    assert.equal(done.url, 'https://github.com/example/pr/1');
  });
});

test('students never see each other\'s work', async (t) => {
  const a = await shared('Privacy');

  await t.test('the per-assignment view is refused to a student', async () => {
    // It lists every classmate's hand-in and every piece of feedback.
    const res = await detail(USERS.student, a._id);
    assert.equal(res.status, 403);
  });

  await t.test('a student\'s own list holds only their rows', async () => {
    const { mine } = await everything(USERS.student);
    assert.ok(mine.length > 0);
    assert.ok(mine.every((s) => String(s.student._id) === USERS.student._id));
  });

  await t.test('another mentor cannot open it either', async () => {
    const res = await detail(USERS.admin, a._id);
    assert.equal(res.status, 403);
  });

  await t.test('and a student cannot read a mentorship they are not in', async () => {
    const res = await api(`/api/mentorships/${m1._id}/assignments`, { as: USERS.student2 });
    assert.equal(res.status, 403);
  });
});

test('the mentor sees every student at once', async () => {
  const a = await shared('Whole class');
  const d = await (await detail(USERS.mentor, a._id)).json();

  assert.equal(d.submissions.length, 2);
  assert.ok(d.submissions.every((s) => s.student?.displayName));
});

test('review is per student, and only by the mentor who set it', async (t) => {
  const a = await shared('Review loop');
  const s1 = await subFor(a._id, USERS.student);
  await handIn(USERS.student, s1._id, { text: 'here you go' });

  await t.test('nothing can be reviewed before it is handed in', async () => {
    const s2 = await subFor(a._id, USERS.student2);
    const res = await review(USERS.mentor, s2._id, { action: 'accept' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /handed in/i);
  });

  await t.test('a student cannot accept their own work', async () => {
    const res = await review(USERS.student, s1._id, { action: 'accept' });
    assert.equal(res.status, 403);
  });

  await t.test('being their mentor elsewhere does not make you the reviewer', async () => {
    // admin mentors this student in m3, but did not set this work.
    const res = await review(USERS.admin, s1._id, { action: 'accept' });
    assert.equal(res.status, 403);
  });

  await t.test('asking for changes needs a reason', async () => {
    const res = await review(USERS.mentor, s1._id, { action: 'request-changes', note: '  ' });
    assert.equal(res.status, 400);
  });

  await t.test('sent back, it drops out of "handed in"', async () => {
    await review(USERS.mentor, s1._id, {
      action: 'request-changes',
      note: 'Question three is wrong.'
    });

    const d = await (await detail(USERS.mentor, a._id)).json();
    // The student owes something again, so counting it as done would flatter
    // the headline number.
    assert.equal(d.summary.handedIn, 0);
    assert.equal(d.summary.changesRequested, 1);
  });

  await t.test('resubmitting clears the old note', async () => {
    const again = await (await handIn(USERS.student, s1._id, { text: 'fixed it' })).json();
    assert.equal(again.status, 'submitted');
    assert.equal(again.review.note, '');
  });

  await t.test('accepted is terminal for both sides', async () => {
    const ok = await (await review(USERS.mentor, s1._id, { action: 'accept' })).json();
    assert.equal(ok.status, 'accepted');

    assert.equal((await handIn(USERS.student, s1._id, { text: 'more' })).status, 400);
    assert.equal((await review(USERS.mentor, s1._id, { action: 'accept' })).status, 400);
  });
});

test('lateness is per student, and derived', async (t) => {
  const a = await shared('Timing');

  await db()
    .collection('assignments')
    .updateOne(
      { _id: new mongoose.Types.ObjectId(a._id) },
      { $set: { dueAt: new Date(Date.now() - 86400000) } }
    );

  await t.test('past the deadline with nothing in: late, and overdue in the summary', async () => {
    const s2 = await subFor(a._id, USERS.student2);
    assert.equal(s2.late, true);

    const d = await (await detail(USERS.mentor, a._id)).json();
    assert.equal(d.summary.overdue, 2);
  });

  await t.test('handing in after the deadline is late', async () => {
    const s1 = await subFor(a._id, USERS.student);
    const done = await (await handIn(USERS.student, s1._id, { text: 'sorry' })).json();
    assert.equal(done.late, true);
  });

  await t.test('extending the deadline un-lates everyone, with no flag to fix', async () => {
    await edit(USERS.mentor, a._id, { dueAt: inDays(5) });

    const s1 = await subFor(a._id, USERS.student);
    const s2 = await subFor(a._id, USERS.student2);
    assert.equal(s1.late, false);
    assert.equal(s2.late, false);
  });
});

test('editing the brief changes it for everyone', async () => {
  const a = await shared('Before');
  await edit(USERS.mentor, a._id, { title: 'After', instructions: 'New brief' });

  const s1 = await subFor(a._id, USERS.student);
  const s2 = await subFor(a._id, USERS.student2);
  assert.equal(s1.assignment.title, 'After');
  assert.equal(s2.assignment.title, 'After');
  assert.equal(s2.assignment.instructions, 'New brief');
});

test('a student can be added after the work was set', async (t) => {
  const a = await shared('Late joiner', [m1._id]);

  await t.test('adding them creates their row', async () => {
    const updated = await (await edit(USERS.mentor, a._id, { addMentorshipIds: [m2._id] })).json();
    assert.equal(updated.summary.total, 2);
    assert.ok(await subFor(a._id, USERS.student2));
  });

  await t.test('adding someone already there is a harmless no-op', async () => {
    const updated = await (await edit(USERS.mentor, a._id, { addMentorshipIds: [m1._id] })).json();
    assert.equal(updated.summary.total, 2);
  });

  await t.test('but not someone else\'s student', async () => {
    const res = await edit(USERS.mentor, a._id, { addMentorshipIds: [m3._id] });
    assert.equal(res.status, 403);
  });
});

test('withdrawing', async (t) => {
  await t.test('a student cannot withdraw work set for them', async () => {
    const a = await shared('Student withdraw');
    const res = await api(`/api/assignments/${a._id}`, { as: USERS.student, method: 'DELETE' });
    assert.equal(res.status, 403);
  });

  await t.test('the mentor can, and every hand-in goes with it', async () => {
    const a = await shared('To withdraw');
    const res = await api(`/api/assignments/${a._id}`, { as: USERS.mentor, method: 'DELETE' });
    assert.equal(res.status, 200);

    const left = await db()
      .collection('submissions')
      .countDocuments({ assignment: new mongoose.Types.ObjectId(a._id) });
    assert.equal(left, 0);
  });

  await t.test('but not once any student\'s work is accepted', async () => {
    const a = await shared('Partly accepted');
    const s1 = await subFor(a._id, USERS.student);
    await handIn(USERS.student, s1._id, { text: 'done' });
    await review(USERS.mentor, s1._id, { action: 'accept' });

    const res = await api(`/api/assignments/${a._id}`, { as: USERS.mentor, method: 'DELETE' });
    assert.equal(res.status, 400);
  });
});

test('the mentorship page sees one student\'s slice', async () => {
  const rows = await (await api(`/api/mentorships/${m1._id}/assignments`, {
    as: USERS.mentor
  })).json();

  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => String(r.student._id) === USERS.student._id));
});

test('the list returns both sides of the desk', async () => {
  const mentor = await everything(USERS.mentor);
  assert.ok(mentor.set.length > 0);
  assert.ok(mentor.set.every((a) => typeof a.summary.total === 'number'));

  const student = await everything(USERS.student);
  assert.equal(student.set.length, 0);
  assert.ok(student.mine.length > 0);
});

test('the usual refusals', async (t) => {
  await t.test('a missing assignment', async () => {
    assert.equal((await detail(USERS.mentor, '0000000000000000000000ff')).status, 404);
  });

  await t.test('a malformed id', async () => {
    assert.equal((await detail(USERS.mentor, 'not-an-id')).status, 404);
  });

  await t.test('a missing submission', async () => {
    const res = await handIn(USERS.student, '0000000000000000000000ff', { text: 'x' });
    assert.equal(res.status, 404);
  });

  await t.test('an edit that changes nothing', async () => {
    const a = await shared('Nothing to change');
    assert.equal((await edit(USERS.mentor, a._id, {})).status, 400);
  });

  await t.test('an unknown review action', async () => {
    const a = await shared('Unknown action', [m1._id]);
    const s = await subFor(a._id, USERS.student);
    assert.equal((await review(USERS.mentor, s._id, { action: 'explode' })).status, 400);
  });

  await t.test('no token', async () => {
    assert.equal((await api('/api/assignments')).status, 401);
  });
});

const unsubmit = (as, subId) =>
  api(`/api/submissions/${subId}/unsubmit`, { as, method: 'POST' });

test('drafts: attached, not handed in, and visible to the mentor', async (t) => {
  const a = await shared('Drafts', [m1._id]);
  const s = await subFor(a._id, USERS.student);

  await t.test('saving without turning in makes a draft', async () => {
    const d = await (await handIn(USERS.student, s._id, { text: 'half done', turnIn: false })).json();
    assert.equal(d.status, 'draft');
    assert.equal(d.submittedAt, null);
    assert.ok(d.draftSavedAt);
  });

  await t.test('the mentor sees it, and that it is not handed in', async () => {
    const dt = await (await detail(USERS.mentor, a._id)).json();
    const row = dt.submissions[0];

    assert.equal(row.status, 'draft');
    assert.equal(row.text, 'half done');
    assert.equal(dt.summary.drafts, 1);
    // Attached is not handed in, and the headline number must not pretend.
    assert.equal(dt.summary.handedIn, 0);
  });

  await t.test('a draft cannot be reviewed', async () => {
    const res = await review(USERS.mentor, s._id, { action: 'accept' });
    assert.equal(res.status, 400);
  });

  await t.test('a draft past the deadline is overdue', async () => {
    const b = await shared('Overdue draft', [m1._id]);
    const sb = await subFor(b._id, USERS.student);
    await handIn(USERS.student, sb._id, { text: 'started', turnIn: false });

    await db()
      .collection('assignments')
      .updateOne(
        { _id: new mongoose.Types.ObjectId(b._id) },
        { $set: { dueAt: new Date(Date.now() - 86400000) } }
      );

    const dt = await (await detail(USERS.mentor, b._id)).json();
    assert.equal(dt.summary.overdue, 1);
    assert.equal(dt.submissions[0].late, true);
  });

  await t.test('turning it in from a draft', async () => {
    const d = await (await handIn(USERS.student, s._id, { text: 'all done' })).json();
    assert.equal(d.status, 'submitted');
    assert.ok(d.submittedAt);
  });
});

test('unsubmit takes it back, and keeps the work', async (t) => {
  const a = await shared('Unsubmit', [m1._id]);
  const s = await subFor(a._id, USERS.student);
  await handIn(USERS.student, s._id, { text: 'v1' });

  await t.test('only the student can', async () => {
    assert.equal((await unsubmit(USERS.mentor, s._id)).status, 403);
    assert.equal((await unsubmit(USERS.student2, s._id)).status, 403);
  });

  await t.test('it becomes a draft, no longer handed in, work intact', async () => {
    const d = await (await unsubmit(USERS.student, s._id)).json();
    assert.equal(d.status, 'draft');
    // Cleared, because lateness derives from it and it is not handed in now.
    assert.equal(d.submittedAt, null);
    assert.equal(d.text, 'v1');
  });

  await t.test('handed-in work cannot be edited as a draft without unsubmitting', async () => {
    await handIn(USERS.student, s._id, { text: 'v2' });
    // An edit the history never saw would defeat the history.
    const res = await handIn(USERS.student, s._id, { text: 'sneaky', turnIn: false });
    assert.equal(res.status, 400);
  });

  await t.test('work that is not handed in cannot be unsubmitted', async () => {
    const b = await shared('Nothing in', [m1._id]);
    const sb = await subFor(b._id, USERS.student);
    assert.equal((await unsubmit(USERS.student, sb._id)).status, 400);
  });

  await t.test('accepted work cannot be pulled back', async () => {
    await review(USERS.mentor, s._id, { action: 'accept' });
    const res = await unsubmit(USERS.student, s._id);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /accepted/i);
  });
});

test('every move is logged, in order, with when and who', async (t) => {
  const a = await shared('History', [m1._id]);
  const s = await subFor(a._id, USERS.student);

  await handIn(USERS.student, s._id, { text: 'draft', turnIn: false });
  await handIn(USERS.student, s._id, { text: 'v1' });
  await unsubmit(USERS.student, s._id);
  await handIn(USERS.student, s._id, { text: 'v2' });
  await review(USERS.mentor, s._id, { action: 'request-changes', note: 'fix it' });
  await handIn(USERS.student, s._id, { text: 'v3' });
  await review(USERS.mentor, s._id, { action: 'accept' });

  const dt = await (await detail(USERS.mentor, a._id)).json();
  const history = dt.submissions[0].history;

  await t.test('the sequence reads as it happened', () => {
    assert.deepEqual(
      history.map((e) => e.type),
      [
        'assigned',
        'draft-saved',
        'submitted',
        'unsubmitted',
        'submitted',
        'changes-requested',
        'submitted',
        'accepted'
      ]
    );
  });

  await t.test('each entry has a time, and they are in order', () => {
    const times = history.map((e) => new Date(e.at).getTime());
    assert.ok(times.every((ms) => Number.isFinite(ms)));
    for (let i = 1; i < times.length; i += 1) assert.ok(times[i - 1] <= times[i]);
  });

  await t.test('and who did each thing', () => {
    const byType = Object.fromEntries(history.map((e) => [e.type, String(e.by)]));
    assert.equal(byType.assigned, USERS.mentor._id);
    assert.equal(byType['draft-saved'], USERS.student._id);
    assert.equal(byType.unsubmitted, USERS.student._id);
    assert.equal(byType.accepted, USERS.mentor._id);
  });

  await t.test('the student can read their own history', async () => {
    const own = await subFor(a._id, USERS.student);
    assert.equal(own.history.length, history.length);
  });

  await t.test('a student added later starts their history when they were added', async () => {
    const b = await shared('Late joiner history', [m1._id]);
    await edit(USERS.mentor, b._id, { addMentorshipIds: [m2._id] });
    const late = await subFor(b._id, USERS.student2);
    assert.deepEqual(late.history.map((e) => e.type), ['assigned']);
  });
});

/**
 * The two numbers behind the sidebar badge.
 *
 * Asserted as changes rather than absolutes: the tests above leave a varying
 * amount of work lying around, and a badge test that depends on the exact
 * state of every test before it is a badge test that breaks whenever one of
 * them is edited.
 */
test('the counts behind the sidebar badge', async (t) => {
  const counts = (as) => api('/api/assignments/counts', { as }).then((r) => r.json());

  const studentBefore = await counts(USERS.student);
  const mentorBefore = await counts(USERS.mentor);

  const a = await shared('Counted', [m1._id]);
  const sub = await subFor(a._id, USERS.student);

  await t.test('work set for you is owed', async () => {
    assert.equal((await counts(USERS.student)).owed, studentBefore.owed + 1);
  });

  await t.test('and is not yet waiting on the mentor', async () => {
    assert.equal((await counts(USERS.mentor)).toReview, mentorBefore.toReview);
  });

  await t.test('handing it in moves it from one side to the other', async () => {
    const res = await handIn(USERS.student, sub._id, { text: 'done' });
    assert.equal(res.status, 200);

    assert.equal((await counts(USERS.student)).owed, studentBefore.owed);
    assert.equal((await counts(USERS.mentor)).toReview, mentorBefore.toReview + 1);
  });

  await t.test('accepting it clears it from the mentor', async () => {
    await review(USERS.mentor, sub._id, { action: 'accept' });
    assert.equal((await counts(USERS.mentor)).toReview, mentorBefore.toReview);
  });

  await t.test('a draft is still owed - attached is not handed in', async () => {
    const b = await shared('Drafted', [m1._id]);
    const s2 = await subFor(b._id, USERS.student);
    await handIn(USERS.student, s2._id, { text: 'half of it', turnIn: false });

    assert.equal((await counts(USERS.student)).owed, studentBefore.owed + 1);
  });

  await t.test('and the counts need a token', async () => {
    const res = await api('/api/assignments/counts');
    assert.equal(res.status, 401);
  });
});
