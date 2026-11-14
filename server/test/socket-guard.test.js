/**
 * A malformed socket event must not stop the server (lib/socketGuard.js).
 *
 * Before the guard, `typing` with no payload and `join-group` with something
 * that is not an id each ended the process: one signed-in client could stop the
 * server for everyone. Each case here sends one such event and then proves the
 * server is still answering.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, connect, once, settle } = require('./helpers/harness');
const { guardedOn, objectPayload, idPayload } = require('../lib/socketGuard');

test.before(() => start());
test.after(() => stop());

const alive = async () => {
  const res = await api('/api/users', { as: USERS.student });
  assert.equal(res.status, 200, 'the server should still be answering');
};

const MALFORMED = [
  ['typing', undefined],
  ['typing', null],
  ['typing', 'a string'],
  ['stop-typing', undefined],
  ['group-typing', undefined],
  ['group-stop-typing', null],
  ['send-message', undefined],
  ['send-message', { receiverId: 'not-an-id', text: 'hello' }],
  ['send-message', { receiverId: USERS.mentor._id, text: { not: 'text' } }],
  ['mark-read', undefined],
  ['mark-read', { peerId: 'not-an-id' }],
  ['mark-group-read', { groupId: 'not-an-id' }],
  ['join-group', 'not-an-id'],
  ['join-group', { an: 'object' }],
  ['join-group', undefined],
  ['leave-group', { an: 'object' }],
  ['send-group-message', { groupId: 'not-an-id', text: 'hello' }],
  ['send-group-message', undefined]
];

test('a malformed socket event does not stop the server', async (t) => {
  for (const [event, payload] of MALFORMED) {
    await t.test(`${event} with ${JSON.stringify(payload)}`, async () => {
      const socket = await connect(USERS.student);
      if (payload === undefined) socket.emit(event);
      else socket.emit(event, payload);
      await settle();
      await alive();
      socket.close();
    });
  }
});

test('join-group with something that is not an id is refused, not ignored', async () => {
  const socket = await connect(USERS.student);
  socket.emit('join-group', 'not-an-id');
  const err = await once(socket, 'error');
  assert.equal(err.message, 'You are not a member of that group');
  socket.close();
});

test('the guard itself', async (t) => {
  const fake = () => {
    const handlers = {};
    const emitted = [];
    return {
      handlers, emitted,
      on: (event, fn) => { handlers[event] = fn; },
      emit: (event, payload) => emitted.push([event, payload])
    };
  };

  await t.test('a handler that throws is caught and answered', async () => {
    const socket = fake();
    const logged = [];
    guardedOn(socket, (...a) => logged.push(a))('x', () => { throw new Error('boom'); });
    await socket.handlers.x({});
    assert.deepEqual(socket.emitted, [['error', { message: 'That did not work' }]]);
    assert.equal(logged[0][1], 'boom');
  });

  await t.test('an async handler that rejects is caught and answered', async () => {
    const socket = fake();
    guardedOn(socket, () => {})('x', async () => { throw new Error('later'); });
    await socket.handlers.x({});
    assert.equal(socket.emitted.length, 1);
  });

  await t.test('a handler that succeeds emits nothing', async () => {
    const socket = fake();
    let got;
    guardedOn(socket, () => {})('x', (data) => { got = data; });
    await socket.handlers.x({ a: 1 });
    assert.deepEqual(got, { a: 1 });
    assert.deepEqual(socket.emitted, []);
  });

  await t.test('an object payload is an object, whatever was sent', () => {
    for (const bad of [undefined, null, 'text', 7, true, ['a']]) assert.deepEqual(objectPayload(bad), {});
    assert.deepEqual(objectPayload({ a: 1 }), { a: 1 });
  });

  await t.test('an id payload is a string, whatever was sent', async () => {
    for (const bad of [undefined, null, 7, { a: 1 }, ['a']]) assert.equal(idPayload(bad), '');
    assert.equal(idPayload('abc'), 'abc');
    const socket = fake();
    let got;
    guardedOn(socket, () => {})('x', (data) => { got = data; }, { id: true });
    await socket.handlers.x({ $ne: null });
    assert.equal(got, '');
  });
});
