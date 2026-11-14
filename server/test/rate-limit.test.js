/**
 * How often one account may do one thing (lib/rateLimit.js).
 *
 * The server here runs with small limits so that each can be reached in a few
 * requests. The defaults are generous, and the rest of the suite runs under them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, BASE, start, stop, api, db, connect, once, settle } = require('./helpers/harness');
const { createLimiter, limitFrom } = require('../lib/rateLimit');

test.before(() => start({
  extraEnv: { MESSAGES_PER_10S: '3', REPORTS_PER_HOUR: '2', UPLOADS_PER_10MIN: '2', LOGINS_PER_MINUTE: '3' }
}));
test.after(() => stop());

test('messages: the account is limited across both kinds, and a refused one is not stored', async () => {
  const student = await connect(USERS.student);
  const mentor = await connect(USERS.mentor);
  // Delivery goes to sockets that have said they are online.
  student.emit('user-online');
  mentor.emit('user-online');
  await settle();

  for (let i = 0; i < 3; i++) student.emit('send-message', { receiverId: USERS.mentor._id, text: `allowed ${i}` });
  await settle();

  const refused = once(student, 'error');
  student.emit('send-message', { receiverId: USERS.mentor._id, text: 'one too many' });
  const err = await refused;
  assert.equal(err.tooFast, true);
  assert.match(err.message, /too quickly/);

  // The same allowance covers group messages.
  const refusedGroup = once(student, 'error');
  student.emit('send-group-message', { groupId: '0000000000000000000000c9', text: 'also too many' });
  assert.equal((await refusedGroup).tooFast, true);

  await settle();
  const texts = (await db().collection('messages').find({}).toArray()).map((m) => m.text).sort();
  assert.deepEqual(texts, ['allowed 0', 'allowed 1', 'allowed 2']);

  // Another account is not affected by this one's limit.
  const delivered = once(student, 'new-message');
  mentor.emit('send-message', { receiverId: USERS.student._id, text: 'from the mentor' });
  assert.equal((await delivered).text, 'from the mentor');

  student.close();
  mentor.close();
});

test('a malformed message does not use up the allowance', async () => {
  const student2 = await connect(USERS.student2);
  student2.emit('user-online');
  await settle();
  for (let i = 0; i < 10; i++) student2.emit('send-message', { receiverId: 'not-an-id', text: 'x' });
  await settle();
  const delivered = once(student2, 'message-sent');
  student2.emit('send-message', { receiverId: USERS.mentor._id, text: 'still allowed' });
  assert.equal((await delivered).text, 'still allowed');
  student2.close();
});

test('reports: 429 with Retry-After once over the limit', async () => {
  const file = (targetId) => api('/api/reports', {
    as: USERS.student, method: 'POST', body: { targetType: 'user', targetId, reason: 'spam' }
  });
  assert.equal((await file(USERS.student2._id)).status, 200);
  assert.equal((await file(USERS.mentor._id)).status, 200);

  const res = await file(USERS.admin._id);
  assert.equal(res.status, 429);
  const wait = Number(res.headers.get('retry-after'));
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 3600, `Retry-After was ${res.headers.get('retry-after')}`);
  assert.equal(await db().collection('reports').countDocuments({}), 2, 'the refused report is not stored');

  // Someone else can still report.
  const other = await api('/api/reports', {
    as: USERS.mentor, method: 'POST', body: { targetType: 'user', targetId: USERS.student._id, reason: 'spam' }
  });
  assert.equal(other.status, 200);
});

test('uploads: limited before the file is read', async () => {
  const upload = () => {
    const form = new FormData();
    form.append('file', new Blob(['hello']), 'note.txt');
    return fetch(`${BASE}/api/submissions/0000000000000000000000e1/files`, {
      method: 'POST', headers: { 'X-Dev-User-Id': USERS.student._id }, body: form
    });
  };
  assert.equal((await upload()).status, 404, 'no such hand-in: the route ran');
  assert.equal((await upload()).status, 404);
  const res = await upload();
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
});

test('sign-in: limited per account', async () => {
  const login = (as) => api('/api/auth/login', { as, method: 'POST', body: {} });
  for (let i = 0; i < 3; i++) assert.equal((await login(USERS.mentor)).status, 200);
  assert.equal((await login(USERS.mentor)).status, 429);
  assert.equal((await login(USERS.student2)).status, 200, 'another account signs in');
});

test('createLimiter', async (t) => {
  await t.test('allows max calls in a window, then none, then again as the window moves', () => {
    let clock = 0;
    const limiter = createLimiter({ max: 2, windowMs: 1000, now: () => clock });
    assert.equal(limiter.allow('a'), true);
    clock = 400;
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('a'), false);
    assert.equal(limiter.retryAfter('a'), 1);
    clock = 999;
    assert.equal(limiter.allow('a'), false);
    clock = 1000; // the first call has left the window
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('a'), false);
  });

  await t.test('a refused call does not extend the wait', () => {
    let clock = 0;
    const limiter = createLimiter({ max: 1, windowMs: 1000, now: () => clock });
    limiter.allow('a');
    for (clock = 100; clock < 1000; clock += 100) assert.equal(limiter.allow('a'), false);
    clock = 1000;
    assert.equal(limiter.allow('a'), true);
  });

  await t.test('keys are separate, and an id and its string are the same key', () => {
    const limiter = createLimiter({ max: 1, windowMs: 1000, now: () => 0 });
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('b'), true);
    assert.equal(limiter.allow({ toString: () => 'a' }), false);
  });

  await t.test('retryAfter is 0 while calls remain', () => {
    const limiter = createLimiter({ max: 2, windowMs: 1000, now: () => 0 });
    limiter.allow('a');
    assert.equal(limiter.retryAfter('a'), 0);
    assert.equal(limiter.retryAfter('never-seen'), 0);
  });

  await t.test('keys that have gone quiet are forgotten', () => {
    let clock = 0;
    const limiter = createLimiter({ max: 5, windowMs: 1000, now: () => clock });
    for (let i = 0; i < 100; i++) limiter.allow(`user-${i}`);
    assert.equal(limiter.size(), 100);
    clock = 5000;
    limiter.allow('someone-new');
    assert.equal(limiter.size(), 1);
  });

  await t.test('a limit from the environment is a whole number of at least 1, or the default', () => {
    assert.equal(limitFrom('7', 30), 7);
    for (const bad of [undefined, '', '0', '-1', '1.5', 'abc', 'Infinity']) assert.equal(limitFrom(bad, 30), 30);
  });
});
