/**
 * Group previews, unread counts and read receipts.
 *
 * The one that would be easiest to break by accident is the last test here:
 * `group-activity` has to reach members who are NOT in the group's Socket.IO
 * room, because those are exactly the people an unread badge is for. Sending
 * only to the room looks completely correct until you check.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, connect, once, settle } = require('./helpers/harness');

let sStudent;
let sStudent2;
let sMentor;
let group;

test.before(async () => {
  await start();

  sStudent = await connect(USERS.student);
  sStudent2 = await connect(USERS.student2);
  sMentor = await connect(USERS.mentor);

  // Unicast fans out from the onlineUsers map, which `user-online` fills.
  [sStudent, sStudent2, sMentor].forEach((s) => s.emit('user-online'));
  await settle(400);

  group = await (await api('/api/groups', {
    as: USERS.mentor,
    method: 'POST',
    body: { name: 'Backend crew', description: '' }
  })).json();

  await api(`/api/groups/${group._id}/join`, { as: USERS.student, method: 'POST' });
  await api(`/api/groups/${group._id}/join`, { as: USERS.student2, method: 'POST' });
});

test.after(async () => {
  [sStudent, sStudent2, sMentor].forEach((s) => s?.disconnect());
  await stop();
});

const post = async (sock, text) => {
  sock.emit('send-group-message', { groupId: group._id, text });
  await settle(250);
};

const markRead = async (sock) => {
  sock.emit('mark-group-read', { groupId: group._id });
  await settle(250);
};

const groupRows = (as) =>
  api('/api/groups/conversations', { as }).then((r) => r.json());

test('an empty group has nothing to preview', async () => {
  assert.deepEqual(await groupRows(USERS.student), []);
});

test('a message gives every member a preview, and non-senders a count', async (t) => {
  await post(sMentor, 'welcome everyone');

  await t.test('the preview names who spoke', async () => {
    const [row] = await groupRows(USERS.student);
    assert.equal(row.lastText, 'welcome everyone');
    // A group row does not imply who spoke, unlike a one-to-one row.
    assert.equal(row.lastSenderName, USERS.mentor.displayName);
    assert.equal(row.lastFromMe, false);
  });

  await t.test('a member who has never opened it has everything unread', async () => {
    const [row] = await groupRows(USERS.student);
    assert.equal(row.unread, 1);
  });

  await t.test('but your own message is never unread to you', async () => {
    const [row] = await groupRows(USERS.mentor);
    assert.equal(row.unread, 0);
    assert.equal(row.lastFromMe, true);
  });
});

test('counts accumulate and clear per member, independently', async (t) => {
  await post(sMentor, 'second');
  await post(sMentor, 'third');

  await t.test('both members are at three', async () => {
    assert.equal((await groupRows(USERS.student))[0].unread, 3);
    assert.equal((await groupRows(USERS.student2))[0].unread, 3);
  });

  await t.test('reading tells your own tabs', async () => {
    const heard = once(sStudent, 'group-read', 2000);
    sStudent.emit('mark-group-read', { groupId: group._id });
    const evt = await heard;

    assert.ok(evt, 'expected group-read');
    assert.equal(String(evt.groupId), String(group._id));
  });

  await t.test('and clears only that member', async () => {
    await settle(250);
    assert.equal((await groupRows(USERS.student))[0].unread, 0);
    assert.equal((await groupRows(USERS.student2))[0].unread, 3);
  });

  await t.test('sending does not raise your own count, but does count for others', async () => {
    await post(sStudent, 'thanks');

    const mine = (await groupRows(USERS.student))[0];
    assert.equal(mine.unread, 0);
    assert.equal(mine.lastText, 'thanks');
    assert.equal(mine.lastFromMe, true);

    assert.equal((await groupRows(USERS.student2))[0].unread, 4);
  });
});

test('read marks are the raw material for receipts', async (t) => {
  await t.test('only members who have opened it have a mark', async () => {
    const reads = await (await api(`/api/groups/${group._id}/reads`, {
      as: USERS.mentor
    })).json();
    const ids = reads.map((r) => String(r.userId));

    assert.ok(ids.includes(USERS.student._id));
    assert.ok(!ids.includes(USERS.student2._id));
    assert.ok(reads[0].displayName);
  });

  await t.test('a read broadcasts a receipt to the room', async () => {
    sMentor.emit('join-group', String(group._id));
    await settle(250);

    const receipt = once(sMentor, 'group-receipt', 2000);
    sStudent2.emit('mark-group-read', { groupId: group._id });
    const got = await receipt;

    assert.ok(got, 'expected group-receipt');
    assert.equal(String(got.userId), USERS.student2._id);
  });

  await t.test('re-reading upserts rather than duplicating', async () => {
    await markRead(sStudent2);
    const reads = await (await api(`/api/groups/${group._id}/reads`, {
      as: USERS.mentor
    })).json();
    assert.equal(reads.length, 2);
  });
});

test('activity reaches members who are NOT in the room', async (t) => {
  // student2 never joined the room. Their badge still has to move, which is
  // the whole reason group-activity exists alongside new-group-message.
  const heard = once(sStudent2, 'group-activity', 2000);
  await post(sMentor, 'anyone around?');
  const act = await heard;

  await t.test('the event arrives', () => {
    assert.ok(act, 'expected group-activity');
    assert.equal(act.text, 'anyone around?');
  });

  await t.test('and carries who said it, for the preview', () => {
    assert.equal(act.senderName, USERS.mentor.displayName);
    assert.equal(String(act.groupId), String(group._id));
  });
});

test('none of it is visible to a non-member', async (t) => {
  await t.test('no group conversations', async () => {
    assert.deepEqual(await groupRows(USERS.admin), []);
  });

  await t.test('and the receipts are refused', async () => {
    const res = await api(`/api/groups/${group._id}/reads`, { as: USERS.admin });
    assert.equal(res.status, 403);
  });
});

test('the usual refusals', async (t) => {
  await t.test('no token on conversations', async () => {
    assert.equal((await api('/api/groups/conversations')).status, 401);
  });

  await t.test('no token on reads', async () => {
    assert.equal((await api(`/api/groups/${group._id}/reads`)).status, 401);
  });

  await t.test('a group that does not exist', async () => {
    const res = await api('/api/groups/0000000000000000000000ff/reads', { as: USERS.mentor });
    assert.equal(res.status, 404);
  });
});
