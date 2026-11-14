/**
 * What a group can be created with, and the ids the group routes are handed
 * (the audit, H9). Unchecked, something that was not an id was a 500, and the id
 * of nobody was stored as a member.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, db, mongoose } = require('./helpers/harness');

// Groups are private since Entry 159: a mentor adds only their own active mentees,
// so both students are the mentor's mentees here.
test.before(async () => {
  await start();
  const oid = (hex) => new mongoose.Types.ObjectId(hex);
  await db().collection('mentorships').insertMany([USERS.student, USERS.student2].map((s, i) => ({
    _id: oid(`0000000000000000000000e${i + 1}`), mentor: oid(USERS.mentor._id), student: oid(s._id),
    status: 'active', topic: 'T', initiatedBy: 'student', requestedAt: new Date()
  })));
});
test.after(() => stop());

const create = (body) => api('/api/groups', { as: USERS.mentor, method: 'POST', body });
const NOBODY = '0000000000000000000000ff';

test('creating a group', async (t) => {
  const refused = [
    ['a member that is not an id', { name: 'G', memberIds: ['not-an-id'] }],
    ['a member that is an object', { name: 'G', memberIds: [{ $ne: null }] }],
    ['a member that is a number', { name: 'G', memberIds: [7] }],
    ['members that are not a list', { name: 'G', memberIds: USERS.student._id }],
    ['members that are an object', { name: 'G', memberIds: { 0: USERS.student._id } }],
    ['the id of nobody', { name: 'G', memberIds: [USERS.student._id, NOBODY] }],
    ['more members than a group can start with', { name: 'G', memberIds: Array.from({ length: 201 }, () => USERS.student._id) }],
    ['a name that is not text', { name: { $ne: null }, memberIds: [] }],
    ['a name that is only spaces', { name: '   ', memberIds: [] }]
  ];
  for (const [what, body] of refused) {
    await t.test(`${what} is a 400, and no group is made`, async () => {
      const before = await db().collection('groups').countDocuments({});
      const res = await create(body);
      assert.equal(res.status, 400);
      assert.equal(await db().collection('groups').countDocuments({}), before);
    });
  }

  await t.test('real people are added, once each, with the creator', async () => {
    const res = await create({ name: 'Study group', memberIds: [USERS.student._id, USERS.student._id, USERS.student2._id] });
    assert.equal(res.status, 200);
    const group = await res.json();
    assert.deepEqual(
      group.members.map((m) => m._id).sort(),
      [USERS.mentor._id, USERS.student._id, USERS.student2._id].sort()
    );
  });

  await t.test('no members at all is a group of one', async () => {
    const res = await create({ name: 'Just me' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).members.length, 1);
  });
});

test('ids in the group routes', async (t) => {
  await t.test('joining something that is not an id is a 404', async () => {
    const res = await api('/api/groups/not-an-id/join', { as: USERS.student, method: 'POST', body: {} });
    assert.equal(res.status, 404);
  });

  await t.test('listing by something that is not a user id is a 400', async () => {
    assert.equal((await api('/api/groups?userId=not-an-id', { as: USERS.student })).status, 400);
    assert.equal((await api('/api/groups?userId=a&userId=b', { as: USERS.student })).status, 400);
  });

  await t.test('listing by your own id still works; by somebody else\'s it is refused, except for an admin', async () => {
    const own = await api(`/api/groups?userId=${USERS.mentor._id}`, { as: USERS.mentor });
    assert.equal(own.status, 200);
    assert.ok((await own.json()).length >= 1);
    // Whose groups someone is in is not public since Entry 159.
    assert.equal((await api(`/api/groups?userId=${USERS.mentor._id}`, { as: USERS.student2 })).status, 403);
    const admin = await api(`/api/groups?userId=${USERS.mentor._id}`, { as: USERS.admin });
    assert.equal(admin.status, 200);
    assert.ok((await admin.json()).length >= 1);
  });
});
