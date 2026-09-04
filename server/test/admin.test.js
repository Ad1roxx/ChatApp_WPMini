/**
 * Admin role and dashboard.
 *
 * The important tests here are the ones that prove admin CANNOT be handed
 * out: if any of them start passing the wrong way, one compromised admin
 * account becomes enough to mint more.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, db } = require('./helpers/harness');

test.before(() => start());
test.after(() => stop());

test('admin endpoints require the admin role', async (t) => {
  for (const path of ['/api/admin/stats', '/api/admin/users']) {
    await t.test(`${path} refuses a student`, async () => {
      const res = await api(path, { as: USERS.student });
      assert.equal(res.status, 403);
    });

    await t.test(`${path} refuses a mentor`, async () => {
      const res = await api(path, { as: USERS.mentor });
      assert.equal(res.status, 403);
    });

    await t.test(`${path} allows an admin`, async () => {
      const res = await api(path, { as: USERS.admin });
      assert.equal(res.status, 200);
    });
  }
});

test('stats are counted from the database, not invented', async () => {
  const res = await api('/api/admin/stats', { as: USERS.admin });
  const stats = await res.json();

  const actualUsers = await db().collection('users').countDocuments();
  assert.equal(stats.users, actualUsers);

  // The fixture set is one mentor, one admin, two students.
  assert.equal(stats.students, 2);
  assert.equal(stats.mentors, 1);
  assert.equal(stats.admins, 1);
  assert.equal(stats.unassigned, 0);

  // Nothing has been created in this file, so the content counts are zero —
  // which is the honest answer and what the dashboard should show.
  assert.equal(stats.groups, 0);
  assert.equal(stats.messages, 0);
  assert.equal(stats.announcements, 0);
});

test('admin cannot be handed out', async (t) => {
  await t.test('the admin endpoint refuses to grant admin', async () => {
    const res = await api(`/api/admin/users/${USERS.student._id}/role`, {
      as: USERS.admin,
      method: 'PATCH',
      body: { role: 'admin' }
    });
    assert.equal(res.status, 400);
  });

  await t.test('the self-service endpoint refuses to set admin', async () => {
    const res = await api(`/api/users/${USERS.student._id}/role`, {
      as: USERS.student,
      method: 'POST',
      body: { role: 'admin' }
    });
    assert.equal(res.status, 400);
  });

  await t.test('nobody gained the role', async () => {
    const user = await db()
      .collection('users')
      .findOne({ email: USERS.student.email });
    assert.equal(user.role, 'student');
  });
});

test('an admin cannot demote themselves or another admin', async (t) => {
  await t.test('changing your own role here is refused', async () => {
    const res = await api(`/api/admin/users/${USERS.admin._id}/role`, {
      as: USERS.admin,
      method: 'PATCH',
      body: { role: 'student' }
    });
    assert.equal(res.status, 400);
  });

  await t.test('the admin still has the role', async () => {
    const user = await db().collection('users').findOne({ email: USERS.admin.email });
    assert.equal(user.role, 'admin');
  });
});

test('an admin can change an ordinary role', async (t) => {
  await t.test('student becomes mentor', async () => {
    const res = await api(`/api/admin/users/${USERS.student2._id}/role`, {
      as: USERS.admin,
      method: 'PATCH',
      body: { role: 'mentor' }
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).role, 'mentor');
  });

  await t.test('and the change is persisted', async () => {
    const user = await db()
      .collection('users')
      .findOne({ email: USERS.student2.email });
    assert.equal(user.role, 'mentor');
  });

  await t.test('a non-admin cannot use the same endpoint', async () => {
    const res = await api(`/api/admin/users/${USERS.student._id}/role`, {
      as: USERS.mentor,
      method: 'PATCH',
      body: { role: 'mentor' }
    });
    assert.equal(res.status, 403);
  });
});

test('the allowlist grants admin at sign-in', async (t) => {
  // ADMIN_EMAILS is set to the admin fixture's address by the harness, so a
  // login for that account should hold the role even if it is changed first.
  await t.test('a demoted allowlisted account is restored on login', async () => {
    await db()
      .collection('users')
      .updateOne({ email: USERS.admin.email }, { $set: { role: 'student' } });

    const res = await api('/api/auth/login', {
      as: USERS.admin,
      method: 'POST',
      body: {}
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).role, 'admin');
  });

  await t.test('a non-allowlisted account is not promoted by logging in', async () => {
    const res = await api('/api/auth/login', {
      as: USERS.student,
      method: 'POST',
      body: {}
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).role, 'student');
  });
});
