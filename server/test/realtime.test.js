/**
 * Socket authentication, group membership, and presence.
 *
 * The presence cases here are the ones that caught four separate bugs in
 * BUILD_NOTES Entry 17 — all four came from storing a single socket per user.
 * They are the reason this file exists rather than being verified by hand
 * again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  USERS, start, stop, api, db, connect, once, settle
} = require('./helpers/harness');

test.before(() => start());
test.after(() => stop());

const isOnline = async (user) => {
  const doc = await db().collection('users').findOne({ email: user.email });
  return doc.isOnline;
};

test('the socket handshake requires identity', async (t) => {
  await t.test('no credentials is refused', async () => {
    await assert.rejects(() => connect({}));
  });

  await t.test('a garbage token is refused', async () => {
    await assert.rejects(() => connect({ token: 'not.a.real.token' }));
  });

  await t.test('a known identity connects', async () => {
    const socket = await connect(USERS.student);
    assert.ok(socket.connected);
    socket.close();
  });
});

test('the sender is the socket, not the payload', async () => {
  const student = await connect(USERS.student);
  const mentor = await connect(USERS.mentor);
  mentor.emit('user-online');
  await settle();

  // The student sends a message while CLAIMING to be the mentor.
  student.emit('send-message', {
    senderId: USERS.mentor._id,
    receiverId: USERS.mentor._id,
    text: 'forged sender'
  });

  const received = await once(mentor, 'new-message');
  assert.ok(received, 'the message should still be delivered');

  const actualSender = received.sender._id || received.sender;
  assert.equal(
    String(actualSender),
    USERS.student._id,
    'the message must be attributed to the authenticated socket, not the claim'
  );

  student.close();
  mentor.close();
  await settle();
});

test('group membership is enforced over the socket', async (t) => {
  let groupId;

  await t.test('a mentor creates a group with only themselves in it', async () => {
    const res = await api('/api/groups', {
      as: USERS.mentor,
      method: 'POST',
      body: { name: 'Members only' }
    });
    assert.equal(res.status, 200);
    groupId = (await res.json())._id;
  });

  await t.test('a non-member cannot join the room', async () => {
    const outsider = await connect(USERS.student);
    outsider.emit('join-group', groupId);

    const err = await once(outsider, 'error');
    assert.ok(err, 'the server should refuse and say so');
    outsider.close();
  });

  await t.test('a non-member cannot post to it', async () => {
    const outsider = await connect(USERS.student);
    outsider.emit('send-group-message', { groupId, text: 'should not land' });

    const err = await once(outsider, 'error');
    assert.ok(err);
    outsider.close();

    const count = await db()
      .collection('groupmessages')
      .countDocuments({ text: 'should not land' });
    assert.equal(count, 0, 'the refused message must not be stored');
  });

  await t.test('a non-member cannot read the history over REST either', async () => {
    const res = await api(`/api/groups/${groupId}/messages`, { as: USERS.student });
    assert.equal(res.status, 403);
  });

  await t.test('a member can join and post', async () => {
    const member = await connect(USERS.mentor);
    member.emit('join-group', groupId);
    await settle();

    member.emit('send-group-message', { groupId, text: 'hello group' });
    const msg = await once(member, 'new-group-message');

    assert.ok(msg, 'the member should receive their own broadcast message');
    assert.equal(msg.text, 'hello group');
    member.close();
  });
});

test('presence is owned by the socket, not by signing in', async (t) => {
  await t.test('a REST login alone does not mark you online', async () => {
    const res = await api('/api/auth/login', {
      as: USERS.student2,
      method: 'POST',
      body: {}
    });
    assert.equal(res.status, 200);
    await settle();

    assert.equal(
      await isOnline(USERS.student2),
      false,
      'signing in is not the same as being connected'
    );
  });

  await t.test('the first socket brings you online', async () => {
    const tab = await connect(USERS.student2);
    tab.emit('user-online');
    await settle();

    assert.equal(await isOnline(USERS.student2), true);
    tab.close();
    await settle();
  });
});

test('multiple tabs are handled as one person', async (t) => {
  const watcher = await connect(USERS.mentor);

  let statusChanges = 0;
  watcher.on('user-status-change', ({ visitorId }) => {
    if (visitorId === USERS.student._id) statusChanges++;
  });

  const tabA = await connect(USERS.student);
  tabA.emit('user-online');
  await settle();

  await t.test('the first tab announces once', () => {
    assert.equal(statusChanges, 1);
  });

  const tabB = await connect(USERS.student);
  tabB.emit('user-online');
  await settle();

  await t.test('a second tab does not re-announce', () => {
    assert.equal(statusChanges, 1, 'opening another tab is not a status change');
  });

  await t.test('a message reaches every open tab', async () => {
    const onA = once(tabA, 'new-message');
    const onB = once(tabB, 'new-message');

    watcher.emit('send-message', { receiverId: USERS.student._id, text: 'to all tabs' });
    const [a, b] = await Promise.all([onA, onB]);

    assert.ok(a, 'first tab should receive it');
    assert.ok(b, 'second tab should receive it too');
  });

  await t.test('closing one tab leaves you online', async () => {
    tabA.close();
    await settle(800);

    assert.equal(await isOnline(USERS.student), true);
    assert.equal(statusChanges, 1, 'closing one of two tabs is not a status change');
  });

  await t.test('closing the last tab takes you offline', async () => {
    tabB.close();
    await settle(800);

    assert.equal(await isOnline(USERS.student), false);
    assert.equal(statusChanges, 2, 'going offline is announced exactly once');
  });

  watcher.close();
  await settle();
});
