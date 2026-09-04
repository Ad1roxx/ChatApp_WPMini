/**
 * Authentication and authorization.
 *
 * These are the checks that were run by hand in BUILD_NOTES Entry 15 and then
 * thrown away. The point of each one is that it fails loudly if a future
 * change reopens the hole it covers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api } = require('./helpers/harness');

test.before(() => start());
test.after(() => stop());

test('identity is required', async (t) => {
  await t.test('anonymous request is refused', async () => {
    const res = await api('/api/users');
    assert.equal(res.status, 401);
  });

  await t.test('a malformed bearer token is refused', async () => {
    const res = await api('/api/users', {
      headers: { Authorization: 'Bearer not.a.real.token' }
    });
    assert.equal(res.status, 401);
  });

  await t.test('a known identity is accepted', async () => {
    const res = await api('/api/users', { as: USERS.student });
    assert.equal(res.status, 200);
  });
});

test('you cannot act as somebody else', async (t) => {
  await t.test('reading your own conversation is allowed', async () => {
    const res = await api(
      `/api/messages/${USERS.student._id}/${USERS.mentor._id}`,
      { as: USERS.student }
    );
    assert.equal(res.status, 200);
  });

  await t.test("reading another person's conversation is refused", async () => {
    const res = await api(
      `/api/messages/${USERS.student2._id}/${USERS.mentor._id}`,
      { as: USERS.student }
    );
    assert.equal(res.status, 403);
  });

  await t.test("editing another person's profile is refused", async () => {
    const res = await api(`/api/users/${USERS.mentor._id}/profile`, {
      as: USERS.student,
      method: 'PUT',
      body: { bio: 'hijacked' }
    });
    assert.equal(res.status, 403);

    // And the bio really is untouched, not merely reported as refused.
    const check = await api(`/api/user/${USERS.mentor._id}`, { as: USERS.mentor });
    const mentor = await check.json();
    assert.equal(mentor.bio, '');
  });

  await t.test("changing another person's role is refused", async () => {
    const res = await api(`/api/users/${USERS.mentor._id}/role`, {
      as: USERS.student,
      method: 'POST',
      body: { role: 'student' }
    });
    assert.equal(res.status, 403);
  });

  await t.test('editing your own profile is allowed', async () => {
    const res = await api(`/api/users/${USERS.student._id}/profile`, {
      as: USERS.student,
      method: 'PUT',
      body: { bio: 'my own bio' }
    });
    assert.equal(res.status, 200);

    const updated = await res.json();
    assert.equal(updated.bio, 'my own bio');
  });
});

test('role gates sit on top of identity', async (t) => {
  await t.test('a student cannot create a group', async () => {
    const res = await api('/api/groups', {
      as: USERS.student,
      method: 'POST',
      body: { name: 'should not exist' }
    });
    assert.equal(res.status, 403);
  });

  await t.test('a student cannot post an announcement', async () => {
    const res = await api('/api/announcements', {
      as: USERS.student,
      method: 'POST',
      body: { text: 'should not exist' }
    });
    assert.equal(res.status, 403);
  });

  await t.test('a mentor can create a group', async () => {
    const res = await api('/api/groups', {
      as: USERS.mentor,
      method: 'POST',
      body: { name: 'Mentor group' }
    });
    assert.equal(res.status, 200);

    const group = await res.json();
    // The creator is taken from the token, not the body — nothing was sent.
    assert.equal(String(group.createdBy), USERS.mentor._id);
  });

  await t.test('an admin can do mentor things too', async () => {
    const res = await api('/api/announcements', {
      as: USERS.admin,
      method: 'POST',
      body: { text: 'Admin announcement' }
    });
    assert.equal(res.status, 200);
  });

  await t.test('a rejected request writes nothing', async () => {
    const res = await api('/api/groups', { as: USERS.admin });
    const groups = await res.json();

    assert.ok(
      !groups.some((g) => g.name === 'should not exist'),
      'the refused group must not have been created'
    );
  });
});

test('mentor-only profile fields are dropped for students', async () => {
  // The UI hides these inputs, but the server is what actually enforces it.
  const res = await api(`/api/users/${USERS.student._id}/profile`, {
    as: USERS.student,
    method: 'PUT',
    body: { bio: 'ok', expertise: 'smuggled', availability: 'smuggled' }
  });
  assert.equal(res.status, 200);

  const updated = await res.json();
  assert.equal(updated.bio, 'ok');
  assert.equal(updated.expertise, '', 'expertise must be ignored for a student');
  assert.equal(updated.availability, '', 'availability must be ignored for a student');
});

test('announcements can only be deleted by their author', async (t) => {
  let announcementId;

  await t.test('mentor posts one', async () => {
    const res = await api('/api/announcements', {
      as: USERS.mentor,
      method: 'POST',
      body: { text: 'Mentor notice' }
    });
    assert.equal(res.status, 200);
    announcementId = (await res.json())._id;
  });

  await t.test('a different mentor-capable user cannot delete it', async () => {
    // Admin can post announcements, so this is an OWNERSHIP check rather than
    // a role check — the distinction the delete route exists to make.
    const res = await api(`/api/announcements/${announcementId}`, {
      as: USERS.admin,
      method: 'DELETE'
    });
    assert.equal(res.status, 403);
  });

  await t.test('the author can delete it', async () => {
    const res = await api(`/api/announcements/${announcementId}`, {
      as: USERS.mentor,
      method: 'DELETE'
    });
    assert.equal(res.status, 200);
  });
});
