/**
 * Groups are private (the human's decision, BUILD_NOTES Entry 159).
 *
 * - Only a group's members, and admins, can see it, its member list and its
 *   history, over REST and over the socket. Nobody can join a group themselves.
 * - A mentor can add only their own active mentees; an admin can add anyone.
 * - A member can leave. The group's creator, and admins, can remove a member, and
 *   a removal takes effect on that person's open sockets at once.
 *
 * Written before the code, to fail first.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, db, mongoose, connect, once, settle } = require('./helpers/harness');
const { joinRoomIfAllowed } = require('../lib/groupAccess');

const id = (hex) => new mongoose.Types.ObjectId(hex);
// A second mentor, whose mentee is student2. Not in the harness's seed.
const MENTOR2 = { _id: '0000000000000000000000b1', email: 'mentor2@test.local', displayName: 'Second Mentor', role: 'mentor' };

let G; // the group under test: made by the mentor, with their mentee, the student

const mentorship = (hex, mentor, student, status) => ({
  _id: id(hex), mentor: id(mentor._id), student: id(student._id), status, topic: 'T', initiatedBy: 'student', requestedAt: new Date()
});
const members = async (groupId = G) =>
  (await db().collection('groups').findOne({ _id: id(groupId) })).members.map(String).sort();
const online = async (user) => {
  const socket = await connect(user);
  socket.emit('user-online');
  await settle();
  return socket;
};
const say = (socket, text, groupId = G) => socket.emit('send-group-message', { groupId, text });

test.before(async () => {
  await start();
  await db().collection('users').insertOne({
    _id: id(MENTOR2._id), firebaseUid: 'uid-mentor2', email: MENTOR2.email, displayName: MENTOR2.displayName, role: 'mentor'
  });
  await db().collection('mentorships').insertMany([
    mentorship('0000000000000000000000e1', USERS.mentor, USERS.student, 'active'),   // the mentor's mentee
    mentorship('0000000000000000000000e2', MENTOR2, USERS.student2, 'active'),       // somebody else's mentee
    mentorship('0000000000000000000000e3', USERS.mentor, USERS.student2, 'pending')  // asked the mentor, not yet a mentee
  ]);

  const res = await api('/api/groups', {
    as: USERS.mentor, method: 'POST', body: { name: 'Private group', memberIds: [USERS.student._id] }
  });
  assert.equal(res.status, 200, 'a mentor can make a group with their own mentee');
  G = (await res.json())._id;
});
test.after(() => stop());

// ---------------------------------------------------------------- seeing a group

test('someone who is not a member cannot see a group', async (t) => {
  await t.test('it is not in their list', async () => {
    const res = await api('/api/groups', { as: USERS.student2 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  await t.test('nor can they list somebody else\'s groups', async () => {
    const res = await api(`/api/groups?userId=${USERS.mentor._id}`, { as: USERS.student2 });
    assert.equal(res.status, 403);
    assert.doesNotMatch(await res.text(), /Private group/);
  });

  await t.test('they cannot read its history', async () => {
    assert.equal((await api(`/api/groups/${G}/messages`, { as: USERS.student2 })).status, 403);
  });

  await t.test('or who has read what', async () => {
    assert.equal((await api(`/api/groups/${G}/reads`, { as: USERS.student2 })).status, 403);
  });

  await t.test('they cannot join it themselves', async () => {
    const res = await api(`/api/groups/${G}/join`, { as: USERS.student2, method: 'POST', body: {} });
    assert.ok(res.status === 403 || res.status === 404, `joining answered ${res.status}`);
    assert.equal((await members()).includes(USERS.student2._id), false);
  });

  await t.test('not over the socket either, and they hear nothing said in it', async () => {
    const outsider = await online(USERS.student2);
    const mentor = await online(USERS.mentor);
    mentor.emit('join-group', G);

    outsider.emit('join-group', G);
    assert.ok(await once(outsider, 'error'), 'joining the room is refused');

    const message = once(outsider, 'new-group-message', 700);
    const activity = once(outsider, 'group-activity', 700);
    say(mentor, 'for members only');
    assert.equal(await message, null, 'a non-member got the message');
    assert.equal(await activity, null, 'a non-member got the group\'s activity');

    outsider.close();
    mentor.close();
  });

  await t.test('and nothing they send reaches it: no message, no typing notice', async () => {
    const outsider = await online(USERS.student2);
    const mentor = await online(USERS.mentor);
    mentor.emit('join-group', G);
    await settle();

    const typing = once(mentor, 'group-user-typing', 700);
    outsider.emit('group-typing', { groupId: G });
    assert.equal(await typing, null, 'a non-member\'s typing notice reached the group');

    say(outsider, 'let me in');
    assert.ok(await once(outsider, 'error'));
    assert.equal(await db().collection('groupmessages').countDocuments({ text: 'let me in' }), 0);

    outsider.close();
    mentor.close();
  });
});

test('a member sees the group, and only groups they are in', async () => {
  const mine = await (await api('/api/groups', { as: USERS.student })).json();
  assert.deepEqual(mine.map((g) => g._id), [G]);
  assert.equal((await api(`/api/groups/${G}/messages`, { as: USERS.student })).status, 200);
  assert.equal((await api(`/api/groups?userId=${USERS.student._id}`, { as: USERS.student })).status, 200, 'asking for your own is allowed');
});

test('an admin can see any group, and is not thereby a member', async (t) => {
  await t.test('in the list, its members and its history', async () => {
    const all = await (await api('/api/groups', { as: USERS.admin })).json();
    const group = all.find((g) => g._id === G);
    assert.ok(group, 'the admin sees the group');
    assert.equal(group.members.length, 2);
    assert.equal((await api(`/api/groups/${G}/messages`, { as: USERS.admin })).status, 200);
    assert.equal((await api(`/api/groups/${G}/reads`, { as: USERS.admin })).status, 200);
  });

  await t.test('over the socket: hears it, cannot speak in it', async () => {
    const admin = await online(USERS.admin);
    const mentor = await online(USERS.mentor);
    admin.emit('join-group', G);
    mentor.emit('join-group', G);
    await settle();

    const heard = once(admin, 'new-group-message');
    say(mentor, 'the admin may read this');
    assert.equal((await heard).text, 'the admin may read this');

    say(admin, 'an admin is not a member');
    assert.ok(await once(admin, 'error'));
    assert.equal(await db().collection('groupmessages').countDocuments({ text: 'an admin is not a member' }), 0);
    assert.equal((await members()).includes(USERS.admin._id), false);

    admin.close();
    mentor.close();
  });
});

// ---------------------------------------------------------------- who can be added

test('a mentor can add only their own active mentees', async (t) => {
  const create = (as, memberIds) => api('/api/groups', { as, method: 'POST', body: { name: 'Another', memberIds } });
  const add = (as, userId, groupId = G) =>
    api(`/api/groups/${groupId}/members`, { as, method: 'POST', body: { userId } });
  const count = () => db().collection('groups').countDocuments({});

  await t.test('not somebody else\'s mentee, when creating a group', async () => {
    const before = await count();
    const res = await create(USERS.mentor, [USERS.student._id, USERS.student2._id]);
    assert.equal(res.status, 403);
    assert.equal(await count(), before, 'no group was made');
  });

  await t.test('not another mentor, or an admin, when creating a group', async () => {
    assert.equal((await create(USERS.mentor, [MENTOR2._id])).status, 403);
    assert.equal((await create(USERS.mentor, [USERS.admin._id])).status, 403);
  });

  await t.test('not somebody else\'s mentee, when adding to a group', async () => {
    const res = await add(USERS.mentor, USERS.student2._id);
    assert.equal(res.status, 403);
    assert.equal((await members()).includes(USERS.student2._id), false);
  });

  await t.test('a request still waiting does not make someone a mentee', async () => {
    // student2 has a PENDING mentorship with the mentor (and an active one with mentor2).
    assert.equal((await add(USERS.mentor, USERS.student2._id)).status, 403);
  });

  await t.test('a mentorship that has ended does not either', async () => {
    await db().collection('mentorships').updateOne({ _id: id('0000000000000000000000e3') }, { $set: { status: 'ended' } });
    assert.equal((await add(USERS.mentor, USERS.student2._id)).status, 403);
  });

  await t.test('another mentor cannot add their own mentee to a group that is not theirs', async () => {
    assert.equal((await add(MENTOR2, USERS.student2._id)).status, 403);
    assert.equal((await members()).includes(USERS.student2._id), false);
  });

  await t.test('a member who did not make the group cannot add anyone', async () => {
    assert.equal((await add(USERS.student, USERS.student2._id)).status, 403);
  });

  await t.test('not even a mentor who is a member, adding their own mentee: the group is not theirs', async () => {
    await db().collection('groups').updateOne({ _id: id(G) }, { $addToSet: { members: id(MENTOR2._id) } });
    assert.equal((await add(MENTOR2, USERS.student2._id)).status, 403);
    assert.equal((await members()).includes(USERS.student2._id), false);
    await db().collection('groups').updateOne({ _id: id(G) }, { $pull: { members: id(MENTOR2._id) } });
  });

  await t.test('an id that is not one, or nobody\'s, is refused', async () => {
    assert.equal((await add(USERS.admin, 'not-an-id')).status, 400);
    assert.equal((await add(USERS.admin, { $ne: null })).status, 400);
    assert.equal((await add(USERS.admin, '0000000000000000000000ff')).status, 404);
  });

  await t.test('the mentor can add their own mentee to a new group', async () => {
    const res = await create(USERS.mentor, [USERS.student._id]);
    assert.equal(res.status, 200);
    const group = await res.json();
    assert.deepEqual(group.members.map((m) => m._id).sort(), [USERS.mentor._id, USERS.student._id].sort());
  });

  await t.test('an admin can add anyone', async () => {
    const res = await add(USERS.admin, USERS.student2._id);
    assert.equal(res.status, 200);
    assert.equal((await members()).includes(USERS.student2._id), true);
    // and the person added can now see it
    assert.equal((await api(`/api/groups/${G}/messages`, { as: USERS.student2 })).status, 200);
  });

  await t.test('a suspended account is not added, to a new group or an existing one', async () => {
    await db().collection('users').updateOne({ _id: id(MENTOR2._id) }, { $set: { suspended: true } });
    const before = await count();
    assert.equal((await create(USERS.admin, [MENTOR2._id])).status, 400);
    assert.equal(await count(), before, 'no group was made');
    assert.equal((await add(USERS.admin, MENTOR2._id)).status, 400);
    assert.equal((await members()).includes(MENTOR2._id), false);
    await db().collection('users').updateOne({ _id: id(MENTOR2._id) }, { $set: { suspended: false } });
  });

  await t.test('an admin can create a group with anyone', async () => {
    const res = await create(USERS.admin, [USERS.student2._id, MENTOR2._id]);
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------- leaving and being removed

test('a member can leave', async (t) => {
  // student2 was added by the admin above.
  const leaver = await online(USERS.student2);
  const mentor = await online(USERS.mentor);
  leaver.emit('join-group', G);
  mentor.emit('join-group', G);
  leaver.emit('mark-group-read', { groupId: G });
  await settle();

  await t.test('someone who is not a member cannot', async () => {
    assert.equal((await api(`/api/groups/${G}/leave`, { as: MENTOR2, method: 'POST', body: {} })).status, 403);
  });

  await t.test('nor an admin, who can see the group and is not in it', async () => {
    const admin = await online(USERS.admin);
    const told = once(admin, 'group-removed', 500);
    assert.equal((await api(`/api/groups/${G}/leave`, { as: USERS.admin, method: 'POST', body: {} })).status, 403);
    assert.equal(await told, null, 'nobody is told they were removed from a group they were never in');
    admin.close();
  });

  await t.test('leaving takes them out of the group', async () => {
    const res = await api(`/api/groups/${G}/leave`, { as: USERS.student2, method: 'POST', body: {} });
    assert.equal(res.status, 200);
    assert.equal((await members()).includes(USERS.student2._id), false);
  });

  await t.test('and off its live events at once, on the socket they already had open', async () => {
    const message = once(leaver, 'new-group-message', 700);
    const activity = once(leaver, 'group-activity', 700);
    say(mentor, 'after they left');
    assert.equal(await message, null);
    assert.equal(await activity, null);
  });

  await t.test('they can no longer read it, and their read mark is gone', async () => {
    assert.equal((await api(`/api/groups/${G}/messages`, { as: USERS.student2 })).status, 403);
    assert.equal(await db().collection('groupreads').countDocuments({ group: id(G), user: id(USERS.student2._id) }), 0);
  });

  leaver.close();
  mentor.close();
});

test('the creator, and admins, can remove a member', async (t) => {
  const remove = (as, userId, groupId = G) => api(`/api/groups/${groupId}/members/${userId}`, { as, method: 'DELETE' });

  await t.test('a member who did not make the group cannot remove anyone', async () => {
    assert.equal((await remove(USERS.student, USERS.mentor._id)).status, 403);
    assert.equal((await members()).includes(USERS.mentor._id), true);
  });

  await t.test('someone outside the group cannot', async () => {
    assert.equal((await remove(MENTOR2, USERS.student._id)).status, 403);
    assert.equal((await remove(USERS.student2, USERS.student._id)).status, 403);
  });

  await t.test('removing someone who is not in it is a 404', async () => {
    assert.equal((await remove(USERS.mentor, USERS.student2._id)).status, 404);
    assert.equal((await remove(USERS.mentor, 'not-an-id')).status, 404);
  });

  await t.test('the creator removes a member, and it reaches the socket that member has open', async () => {
    const removed = await online(USERS.student);
    const mentor = await online(USERS.mentor);
    removed.emit('join-group', G);
    mentor.emit('join-group', G);
    removed.emit('mark-group-read', { groupId: G });
    await settle();

    // Before: the member hears the group.
    const before = once(removed, 'new-group-message');
    say(mentor, 'before the removal');
    assert.equal((await before).text, 'before the removal');

    const told = once(removed, 'group-removed');
    const res = await remove(USERS.mentor, USERS.student._id);
    assert.equal(res.status, 200);
    assert.equal((await told).groupId, G, 'the removed person is told');
    assert.equal((await members()).includes(USERS.student._id), false);

    // After: nothing, on the same socket, without reconnecting.
    const message = once(removed, 'new-group-message', 700);
    const activity = once(removed, 'group-activity', 700);
    const typing = once(removed, 'group-user-typing', 700);
    mentor.emit('group-typing', { groupId: G });
    say(mentor, 'after the removal');
    assert.equal(await message, null, 'a removed member still got a message');
    assert.equal(await activity, null, 'a removed member still got the group\'s activity');
    assert.equal(await typing, null, 'a removed member still got a typing notice');

    // And they cannot speak in it, rejoin its room, or read it.
    say(removed, 'still here?');
    assert.ok(await once(removed, 'error'));
    removed.emit('join-group', G);
    assert.ok(await once(removed, 'error'));
    assert.equal((await api(`/api/groups/${G}/messages`, { as: USERS.student })).status, 403);
    assert.equal(await db().collection('groupreads').countDocuments({ group: id(G), user: id(USERS.student._id) }), 0);

    removed.close();
    mentor.close();
  });

  await t.test('a removal that lands while they are joining the room still keeps them out', async () => {
    // Join and removal at the same moment, many times over. Whatever the order
    // they are handled in, once both are done the removed person must hear nothing.
    const mentor = await online(USERS.mentor);
    mentor.emit('join-group', G);
    for (let round = 0; round < 15; round++) {
      await db().collection('groups').updateOne({ _id: id(G) }, { $addToSet: { members: id(USERS.student._id) } });
      const racer = await online(USERS.student);
      racer.emit('join-group', G);
      const res = await remove(USERS.mentor, USERS.student._id);
      assert.equal(res.status, 200);
      await settle();

      const heard = once(racer, 'new-group-message', 400);
      const sent = once(mentor, 'new-group-message');
      say(mentor, `round ${round}`);
      // The message really went to the room: silence must mean "not in it", not "nothing was said".
      assert.equal((await sent)?.text, `round ${round}`);
      assert.equal(await heard, null, `round ${round}: a removed member was left in the room`);
      racer.close();
    }
    mentor.close();
  });

  await t.test('joining a room asks twice, and a removal between the two answers leaves the socket out', async () => {
    // The race above cannot be made to happen on demand, so the rule is tested where it lives.
    const fake = () => {
      const rooms = new Set();
      return { rooms, join: (r) => rooms.add(r), leave: (r) => rooms.delete(r) };
    };
    const answers = (...list) => { const left = [...list]; return async () => left.shift(); };

    const stays = fake();
    assert.equal(await joinRoomIfAllowed(stays, 'group:x', answers(true, true)), true);
    assert.deepEqual([...stays.rooms], ['group:x']);

    const removedInBetween = fake();
    assert.equal(await joinRoomIfAllowed(removedInBetween, 'group:x', answers(true, false)), false);
    assert.deepEqual([...removedInBetween.rooms], [], 'allowed, then removed before the join finished: not in the room');

    const never = fake();
    let asked = 0;
    assert.equal(await joinRoomIfAllowed(never, 'group:x', async () => { asked += 1; return false; }), false);
    assert.deepEqual([...never.rooms], []);
    assert.equal(asked, 1, 'refused at the first answer: never joined at all');
  });

  await t.test('an admin can remove a member too', async () => {
    await db().collection('groups').updateOne({ _id: id(G) }, { $addToSet: { members: id(USERS.student2._id) } });
    assert.equal((await remove(USERS.admin, USERS.student2._id)).status, 200);
    assert.equal((await members()).includes(USERS.student2._id), false);
  });

  await t.test('the creator does not remove themselves that way', async () => {
    assert.equal((await remove(USERS.mentor, USERS.mentor._id)).status, 400);
    assert.equal((await members()).includes(USERS.mentor._id), true);
  });
});
