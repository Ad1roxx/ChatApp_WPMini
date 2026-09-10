/**
 * Unread counts and message previews, for direct messages.
 *
 * Note the `user-online` emits in the setup. Unicast fans out from the
 * `onlineUsers` map, which that event populates — a socket that is connected
 * but never registered looks identical from the outside and silently receives
 * nothing. The real client emits it on connect.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, connect, once, settle } = require('./helpers/harness');

let sStudent;
let sStudent2;
let sMentor;

test.before(async () => {
  await start();

  sStudent = await connect(USERS.student);
  sStudent2 = await connect(USERS.student2);
  sMentor = await connect(USERS.mentor);

  [sStudent, sStudent2, sMentor].forEach((s) => s.emit('user-online'));
  await settle(400);
});

test.after(async () => {
  [sStudent, sStudent2, sMentor].forEach((s) => s?.disconnect());
  await stop();
});

/** Send and let the write land before asserting on it. */
const send = async (sock, receiverId, text) => {
  sock.emit('send-message', { receiverId, text });
  await settle(220);
};

const conversations = (as) => api('/api/conversations', { as }).then((r) => r.json());

test('nothing said yet means nothing to show', async () => {
  const rows = await conversations(USERS.student);
  assert.deepEqual(rows, []);
});

test('one message creates a row on both sides, read differently', async (t) => {
  await send(sMentor, USERS.student._id, 'hello could you mentor me pls');

  await t.test('the receiver sees it unread', async () => {
    const [row] = await conversations(USERS.student);
    assert.equal(String(row.peerId), USERS.mentor._id);
    assert.equal(row.lastText, 'hello could you mentor me pls');
    assert.equal(row.unread, 1);
    assert.equal(row.lastFromMe, false);
  });

  await t.test('the sender sees the same row with nothing owed', async () => {
    const [row] = await conversations(USERS.mentor);
    assert.equal(row.unread, 0);
    assert.equal(row.lastFromMe, true);
  });
});

test('counts accumulate, and the preview is always the newest', async () => {
  await send(sMentor, USERS.student._id, 'second');
  await send(sMentor, USERS.student._id, 'third');

  const [row] = await conversations(USERS.student);
  assert.equal(row.unread, 3);
  assert.equal(row.lastText, 'third');
});

test('replying moves the preview but does not mark their messages read', async () => {
  await send(sStudent, USERS.mentor._id, 'yes please');

  const [row] = await conversations(USERS.student);
  assert.equal(row.lastFromMe, true);
  // Answering someone is not the same as having read what they sent.
  assert.equal(row.unread, 3);
});

test('mark-read tells two different audiences', async (t) => {
  await t.test('your own tabs, so the badge clears where you are not', async () => {
    const heard = once(sStudent, 'conversation-read', 2000);
    sStudent.emit('mark-read', { visitorId: USERS.student._id, peerId: USERS.mentor._id });
    const evt = await heard;

    assert.ok(evt, 'expected conversation-read');
    assert.equal(String(evt.peerId), USERS.mentor._id);
  });

  await t.test('and the count is actually cleared', async () => {
    await settle(250);
    const [row] = await conversations(USERS.student);
    assert.equal(row.unread, 0);
  });

  await t.test('the peer still gets their read receipt', async () => {
    await send(sMentor, USERS.student._id, 'one more');

    const receipt = once(sMentor, 'messages-read', 2000);
    sStudent.emit('mark-read', { visitorId: USERS.student._id, peerId: USERS.mentor._id });
    const got = await receipt;

    assert.ok(got, 'expected messages-read');
    assert.equal(String(got.byVisitor), USERS.student._id);
  });
});

test('conversations are ordered by recency and isolated per peer', async (t) => {
  await send(sStudent2, USERS.student._id, 'hi from the second student');
  const rows = await conversations(USERS.student);

  await t.test('two conversations, newest first', () => {
    assert.equal(rows.length, 2);
    assert.equal(String(rows[0].peerId), USERS.student2._id);
  });

  await t.test('reading one thread leaves the other alone', () => {
    const byPeer = Object.fromEntries(rows.map((r) => [String(r.peerId), r]));
    assert.equal(byPeer[USERS.student2._id].unread, 1);
    assert.equal(byPeer[USERS.mentor._id].unread, 0);
  });

  await t.test('a third party sees none of it', async () => {
    const mentorRows = await conversations(USERS.mentor);
    assert.ok(mentorRows.every((r) => String(r.peerId) !== USERS.student2._id));
  });
});

test('conversations need a token', async () => {
  const res = await api('/api/conversations');
  assert.equal(res.status, 401);
});
