/**
 * What one user may learn about another (lib/publicUser.js, the audit's F6), and
 * what filing a report may reveal (F3).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, db, mongoose, connect, once, settle } = require('./helpers/harness');
const { publicUser, PUBLIC_FIELDS } = require('../lib/publicUser');

const id = (hex) => new mongoose.Types.ObjectId(hex);

// Everything a user document can hold that is nobody else's business.
const PRIVATE = {
  firebaseUid: 'uid-private-marker',
  suspendedReason: 'reason-private-marker',
  suspendedBy: id(USERS.admin._id),
  suspendedAt: new Date(),
  verification: {
    status: 'approved',
    linkedinUrl: 'https://example.com/linkedin-private-marker',
    company: 'company-private-marker',
    title: 'title-private-marker',
    yearsExperience: 7,
    reviewNote: 'note-private-marker',
    reviewedBy: id(USERS.admin._id)
  }
};
const MARKERS = /private-marker/;
const NEVER = ['firebaseUid', 'suspended', 'suspendedReason', 'suspendedBy', 'suspendedAt', '__v'];

const DM = '0000000000000000000000d1'; // mentor -> student2: the student is no party to it
const GROUP = '0000000000000000000000c2'; // mentor only
const GM = '0000000000000000000000d2';
const ANNOUNCEMENT = '0000000000000000000000d3';

test.before(async () => {
  await start();
  await db().collection('users').updateOne({ email: USERS.mentor.email }, { $set: PRIVATE });
  await db().collection('messages').insertOne({
    _id: id(DM), sender: id(USERS.mentor._id), receiver: id(USERS.student2._id),
    text: 'dm-secret-text', timestamp: new Date(), read: false
  });
  await db().collection('groups').insertOne({
    _id: id(GROUP), name: 'Closed', createdBy: id(USERS.mentor._id), members: [id(USERS.mentor._id)], createdAt: new Date()
  });
  await db().collection('groupmessages').insertOne({
    _id: id(GM), group: id(GROUP), sender: id(USERS.mentor._id), text: 'group-secret-text', timestamp: new Date()
  });
  await db().collection('announcements').insertOne({
    _id: id(ANNOUNCEMENT), author: id(USERS.mentor._id), text: 'a public notice', timestamp: new Date()
  });
});
test.after(() => stop());

const assertPublic = (user, what) => {
  assert.doesNotMatch(JSON.stringify(user), MARKERS, `${what} carries private text`);
  for (const field of NEVER) assert.equal(field in user, false, `${what} carries ${field}`);
  assert.deepEqual(Object.keys(user.verification), ['status'], `${what} carries more than the verification status`);
};

test('another user sees the public view, nothing more', async (t) => {
  await t.test('in the user list', async () => {
    const res = await api('/api/users?exclude=me', { as: USERS.student });
    assert.equal(res.status, 200);
    const users = await res.json();
    const mentor = users.find((u) => u._id === USERS.mentor._id);
    assert.ok(mentor, 'the mentor is listed');
    assertPublic(mentor, 'the list row');
    assert.equal(mentor.verification.status, 'approved', 'the badge still has its status');
    assert.equal(mentor.displayName, USERS.mentor.displayName);
    for (const u of users) assertPublic(u, `the row for ${u.displayName}`);
  });

  await t.test('exclude leaves the caller out, whatever its value; without it they are in', async () => {
    const without = await (await api('/api/users?exclude=anything', { as: USERS.student })).json();
    assert.equal(without.some((u) => u._id === USERS.student._id), false);
    const withMe = await (await api('/api/users', { as: USERS.student })).json();
    assert.equal(withMe.some((u) => u._id === USERS.student._id), true);
  });

  await t.test('in a single lookup', async () => {
    const res = await api(`/api/user/${USERS.mentor._id}`, { as: USERS.student });
    assert.equal(res.status, 200);
    assertPublic(await res.json(), 'the lookup');
  });

  await t.test('your own lookup is your whole record', async () => {
    const own = await (await api(`/api/user/${USERS.mentor._id}`, { as: USERS.mentor })).json();
    assert.equal(own.firebaseUid, PRIVATE.firebaseUid);
    assert.equal(own.verification.company, PRIVATE.verification.company);
  });

  await t.test('a lookup with something that is not an id is a 404', async () => {
    assert.equal((await api('/api/user/not-an-id', { as: USERS.student })).status, 404);
  });

  await t.test('an admin still sees everything in the admin list', async () => {
    const users = await (await api('/api/admin/users', { as: USERS.admin })).json();
    const mentor = users.find((u) => u._id === USERS.mentor._id);
    assert.equal(mentor.verification.company, PRIVATE.verification.company);
  });
});

test('the user-updated broadcast is the public view', async () => {
  const watcher = await connect(USERS.student);
  await settle();
  const heard = once(watcher, 'user-updated');
  const res = await api(`/api/users/${USERS.mentor._id}/role`, { as: USERS.mentor, method: 'POST', body: { role: 'mentor' } });
  assert.equal(res.status, 200);
  const own = await res.json();
  assert.equal(own.firebaseUid, PRIVATE.firebaseUid, 'the caller gets their own record in full');
  const update = await heard;
  assert.equal(update._id, USERS.mentor._id);
  assertPublic(update, 'the broadcast');
  watcher.close();
});

test('publicUser', async (t) => {
  await t.test('is an allowlist: a field nobody listed stays private', () => {
    const view = publicUser({ _id: 'x', displayName: 'A', somethingAddedLater: 'private-marker', ...PRIVATE });
    assert.doesNotMatch(JSON.stringify(view), MARKERS);
    for (const key of Object.keys(view)) assert.ok(PUBLIC_FIELDS.includes(key) || key === 'verification');
  });

  await t.test('a user with no verification is unverified', () => {
    assert.deepEqual(publicUser({ _id: 'x' }).verification, { status: 'unverified' });
  });

  await t.test('nothing stays nothing', () => {
    assert.equal(publicUser(null), null);
  });
});

test('a report reveals nothing the reporter could not already see', async (t) => {
  const file = (as, targetType, targetId) =>
    api('/api/reports', { as, method: 'POST', body: { targetType, targetId, reason: 'spam' } });
  const reportsOn = (targetId) => db().collection('reports').find({ targetId: id(targetId) }).toArray();

  await t.test('a 1-to-1 message between two other people cannot be reported, and nothing is stored', async () => {
    const res = await file(USERS.student, 'message', DM);
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /dm-secret-text/);
    assert.equal((await reportsOn(DM)).length, 0);
  });

  await t.test('a message in a group you are not in cannot be reported, and nothing is stored', async () => {
    const res = await file(USERS.student, 'groupMessage', GM);
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /group-secret-text/);
    assert.equal((await reportsOn(GM)).length, 0);
  });

  await t.test('the receiver of a message can report it; the snapshot is stored but not sent back', async () => {
    const res = await file(USERS.student2, 'message', DM);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.doesNotMatch(body, /dm-secret-text/);
    assert.equal('targetSnapshot' in JSON.parse(body), false);
    const [stored] = await reportsOn(DM);
    assert.equal(stored.targetSnapshot, 'dm-secret-text', 'the admin queue still has what was reported');
  });

  await t.test('the sender of a message can report it too', async () => {
    assert.equal((await file(USERS.mentor, 'message', DM)).status, 200);
  });

  await t.test('a member can report a message in their group', async () => {
    const res = await file(USERS.mentor, 'groupMessage', GM);
    assert.equal(res.status, 200);
    assert.equal((await reportsOn(GM))[0].targetSnapshot, 'group-secret-text');
  });

  await t.test('anyone can report an announcement', async () => {
    assert.equal((await file(USERS.student, 'announcement', ANNOUNCEMENT)).status, 200);
  });

  await t.test('a target id that is not an id is a 404, not a server error', async () => {
    for (const bad of ['not-an-id', { $ne: null }, ['a']]) {
      assert.equal((await file(USERS.student, 'message', bad)).status, 404);
    }
  });

  await t.test('the admin sees the snapshot in the queue', async () => {
    const queue = await (await api('/api/admin/reports', { as: USERS.admin })).json();
    assert.ok(queue.some((r) => r.targetSnapshot === 'dm-secret-text'));
  });
});
