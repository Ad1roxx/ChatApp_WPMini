/**
 * Verification, suspension and reports.
 *
 * Note that the fixture users are inserted through the driver, so they have
 * NO `verification` or `suspended` fields at all — exactly like the accounts
 * that already exist in a real database before this feature shipped. These
 * tests therefore also cover the "old document meets new schema" case.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  USERS, start, stop, api, db, connect, settle
} = require('./helpers/harness');

test.before(() => start());
test.after(() => stop());

const findUser = (user) => db().collection('users').findOne({ email: user.email });

// ---------------------------------------------------------------- verification

test('verification is requested by mentors, not students', async (t) => {
  await t.test('a student cannot request it', async () => {
    const res = await api('/api/verification', {
      as: USERS.student,
      method: 'POST',
      body: { company: 'Somewhere', title: 'Student' }
    });
    assert.equal(res.status, 403);
  });

  await t.test('company and title are required', async () => {
    const res = await api('/api/verification', {
      as: USERS.mentor,
      method: 'POST',
      body: { linkedinUrl: 'https://linkedin.com/in/someone' }
    });
    assert.equal(res.status, 400);
  });

  await t.test('a mentor can submit', async () => {
    const res = await api('/api/verification', {
      as: USERS.mentor,
      method: 'POST',
      body: {
        company: 'Acme',
        title: 'Senior Engineer',
        yearsExperience: 8,
        linkedinUrl: 'https://linkedin.com/in/someone'
      }
    });
    assert.equal(res.status, 200);

    const updated = await res.json();
    assert.equal(updated.verification.status, 'pending');
    assert.equal(updated.verification.company, 'Acme');
    assert.ok(updated.verification.submittedAt);
  });
});

test('the verification queue is admin-only', async (t) => {
  await t.test('a mentor cannot read it', async () => {
    const res = await api('/api/admin/verifications', { as: USERS.mentor });
    assert.equal(res.status, 403);
  });

  await t.test('an admin sees the pending request', async () => {
    const res = await api('/api/admin/verifications', { as: USERS.admin });
    assert.equal(res.status, 200);

    const queue = await res.json();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].email, USERS.mentor.email);
  });
});

test('an admin decides the request', async (t) => {
  await t.test('a mentor cannot decide their own', async () => {
    const res = await api(`/api/admin/verifications/${USERS.mentor._id}`, {
      as: USERS.mentor,
      method: 'PATCH',
      body: { decision: 'approved' }
    });
    assert.equal(res.status, 403);
  });

  await t.test('the decision must be approved or rejected', async () => {
    const res = await api(`/api/admin/verifications/${USERS.mentor._id}`, {
      as: USERS.admin,
      method: 'PATCH',
      body: { decision: 'maybe' }
    });
    assert.equal(res.status, 400);
  });

  await t.test('an admin rejects it with a note', async () => {
    const res = await api(`/api/admin/verifications/${USERS.mentor._id}`, {
      as: USERS.admin,
      method: 'PATCH',
      body: { decision: 'rejected', note: 'LinkedIn profile is private' }
    });
    assert.equal(res.status, 200);

    const updated = await res.json();
    assert.equal(updated.verification.status, 'rejected');
    assert.equal(updated.verification.reviewNote, 'LinkedIn profile is private');
    assert.equal(String(updated.verification.reviewedBy), USERS.admin._id);
  });

  await t.test('the same request cannot be decided twice', async () => {
    const res = await api(`/api/admin/verifications/${USERS.mentor._id}`, {
      as: USERS.admin,
      method: 'PATCH',
      body: { decision: 'approved' }
    });
    assert.equal(res.status, 400, 'only a pending request can be decided');
  });

  await t.test('a rejected mentor can re-submit, which reopens it', async () => {
    const res = await api('/api/verification', {
      as: USERS.mentor,
      method: 'POST',
      body: { company: 'Acme', title: 'Senior Engineer', yearsExperience: 8 }
    });
    assert.equal(res.status, 200);

    const updated = await res.json();
    assert.equal(updated.verification.status, 'pending');
    assert.equal(updated.verification.reviewNote, '', 'the old decision is cleared');
    assert.equal(updated.verification.reviewedBy, null);
  });

  await t.test('an admin approves the new request', async () => {
    const res = await api(`/api/admin/verifications/${USERS.mentor._id}`, {
      as: USERS.admin,
      method: 'PATCH',
      body: { decision: 'approved' }
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).verification.status, 'approved');
  });

  await t.test('an approved mentor cannot swap the evidence', async () => {
    const res = await api('/api/verification', {
      as: USERS.mentor,
      method: 'POST',
      body: { company: 'Different Co', title: 'Something Else' }
    });
    assert.equal(res.status, 400);

    const stored = await findUser(USERS.mentor);
    assert.equal(stored.verification.company, 'Acme', 'the approved evidence stands');
  });
});

// ----------------------------------------------------------------- suspension

test('suspension locks an account out of everything', async (t) => {
  await t.test('a mentor cannot suspend anyone', async () => {
    const res = await api(`/api/admin/users/${USERS.student._id}/suspend`, {
      as: USERS.mentor,
      method: 'PATCH',
      body: { suspended: true }
    });
    assert.equal(res.status, 403);
  });

  await t.test('an admin cannot suspend themselves', async () => {
    const res = await api(`/api/admin/users/${USERS.admin._id}/suspend`, {
      as: USERS.admin,
      method: 'PATCH',
      body: { suspended: true }
    });
    assert.equal(res.status, 400);
  });

  await t.test('the student is working normally beforehand', async () => {
    const res = await api('/api/users', { as: USERS.student });
    assert.equal(res.status, 200);
  });

  await t.test('an admin suspends the student', async () => {
    const res = await api(`/api/admin/users/${USERS.student._id}/suspend`, {
      as: USERS.admin,
      method: 'PATCH',
      body: { suspended: true, reason: 'Spamming the announcements feed' }
    });
    assert.equal(res.status, 200);

    const updated = await res.json();
    assert.equal(updated.suspended, true);
    assert.equal(updated.suspendedReason, 'Spamming the announcements feed');
  });

  await t.test('every REST route now refuses them', async () => {
    for (const path of ['/api/users', '/api/groups', '/api/announcements']) {
      const res = await api(path, { as: USERS.student });
      assert.equal(res.status, 403, `${path} should refuse a suspended account`);

      const body = await res.json();
      assert.equal(body.suspended, true, 'the client needs to know why');
    }
  });

  await t.test('and the socket refuses them too', async () => {
    await assert.rejects(
      () => connect(USERS.student),
      'a suspended account must not get a live socket'
    );
  });

  await t.test('but signing in still works, so they can be told why', async () => {
    const res = await api('/api/auth/login', {
      as: USERS.student,
      method: 'POST',
      body: {}
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).suspended, true);
  });

  await t.test('restoring the account brings it back', async () => {
    const res = await api(`/api/admin/users/${USERS.student._id}/suspend`, {
      as: USERS.admin,
      method: 'PATCH',
      body: { suspended: false }
    });
    assert.equal(res.status, 200);

    const restored = await res.json();
    assert.equal(restored.suspended, false);
    assert.equal(restored.suspendedReason, '', 'the reason is cleared on restore');

    const check = await api('/api/users', { as: USERS.student });
    assert.equal(check.status, 200);
  });
});

// -------------------------------------------------------------------- reports

test('anyone can file a report', async (t) => {
  await t.test('a student reports a user', async () => {
    const res = await api('/api/reports', {
      as: USERS.student,
      method: 'POST',
      body: { targetType: 'user', targetId: USERS.student2._id, reason: 'harassment' }
    });
    assert.equal(res.status, 200);

    const report = await res.json();
    assert.equal(report.status, 'open');
    assert.match(report.targetSnapshot, /Second Student/, 'the target is snapshotted');
  });

  await t.test('the same report cannot be filed twice', async () => {
    const res = await api('/api/reports', {
      as: USERS.student,
      method: 'POST',
      body: { targetType: 'user', targetId: USERS.student2._id, reason: 'spam' }
    });
    assert.equal(res.status, 409);
  });

  await t.test('you cannot report yourself', async () => {
    const res = await api('/api/reports', {
      as: USERS.student,
      method: 'POST',
      body: { targetType: 'user', targetId: USERS.student._id, reason: 'spam' }
    });
    assert.equal(res.status, 400);
  });

  await t.test('an unknown reason is refused', async () => {
    const res = await api('/api/reports', {
      as: USERS.student,
      method: 'POST',
      body: { targetType: 'user', targetId: USERS.mentor._id, reason: 'because' }
    });
    assert.equal(res.status, 400);
  });

  await t.test('reporting something that does not exist is refused', async () => {
    const res = await api('/api/reports', {
      as: USERS.student,
      method: 'POST',
      body: {
        targetType: 'announcement',
        targetId: '00000000000000000000dead',
        reason: 'spam'
      }
    });
    assert.equal(res.status, 404);
  });
});

test('the report queue is admin-only and auditable', async (t) => {
  let reportId;

  await t.test('a mentor cannot read it', async () => {
    const res = await api('/api/admin/reports', { as: USERS.mentor });
    assert.equal(res.status, 403);
  });

  await t.test('an admin sees the open report', async () => {
    const res = await api('/api/admin/reports', { as: USERS.admin });
    assert.equal(res.status, 200);

    const reports = await res.json();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].reporter.displayName, USERS.student.displayName);
    reportId = reports[0]._id;
  });

  await t.test('the snapshot survives the target being deleted', async () => {
    // Acting on a report usually means removing what it points at.
    await db()
      .collection('users')
      .updateOne({ email: USERS.student2.email }, { $set: { displayName: 'Renamed' } });

    const res = await api('/api/admin/reports', { as: USERS.admin });
    const [report] = await res.json();

    assert.match(
      report.targetSnapshot,
      /Second Student/,
      'the snapshot records what was reported, not what it says now'
    );
  });

  await t.test('an admin resolves it with a note', async () => {
    const res = await api(`/api/admin/reports/${reportId}`, {
      as: USERS.admin,
      method: 'PATCH',
      body: { status: 'resolved', note: 'Warned the user' }
    });
    assert.equal(res.status, 200);

    const closed = await res.json();
    assert.equal(closed.status, 'resolved');
    assert.equal(closed.resolutionNote, 'Warned the user');
    assert.equal(closed.reviewedBy.displayName, USERS.admin.displayName);
  });

  await t.test('a closed report cannot be re-decided', async () => {
    const res = await api(`/api/admin/reports/${reportId}`, {
      as: USERS.admin,
      method: 'PATCH',
      body: { status: 'dismissed' }
    });
    assert.equal(res.status, 400);
  });

  await t.test('it leaves the open queue but still exists', async () => {
    const open = await api('/api/admin/reports', { as: USERS.admin });
    assert.equal((await open.json()).length, 0);

    const resolved = await api('/api/admin/reports?status=resolved', { as: USERS.admin });
    assert.equal((await resolved.json()).length, 1, 'reports are closed, never deleted');
  });

  await t.test('closing the old one lets the same report be filed again', async () => {
    const res = await api('/api/reports', {
      as: USERS.student,
      method: 'POST',
      body: { targetType: 'user', targetId: USERS.student2._id, reason: 'spam' }
    });
    assert.equal(res.status, 200, 'the duplicate guard only covers OPEN reports');
  });

  await settle(100);
});
