/**
 * Server startup behaviour.
 *
 * Separate from the other files because it needs to control when the server
 * boots — the whole point is what happens to the database at that moment.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, seed, start, stop, db } = require('./helpers/harness');

test.after(() => stop());

test('stale presence is cleared at startup', async (t) => {
  // Seed first, then plant the flag, then boot — so the server meets a
  // database that claims somebody is online while no socket exists.
  await seed();

  await db()
    .collection('users')
    .updateOne({ email: USERS.mentor.email }, { $set: { isOnline: true } });

  await t.test('the flag is set before boot', async () => {
    const before = await db().collection('users').findOne({ email: USERS.mentor.email });
    assert.equal(before.isOnline, true);
  });

  const server = await start({ seedFirst: false });

  await t.test('booting clears it', async () => {
    const after = await db().collection('users').findOne({ email: USERS.mentor.email });
    assert.equal(
      after.isOnline,
      false,
      'sockets do not survive a restart, so nobody can be online at boot'
    );
  });

  await t.test('and it says so in the log', () => {
    assert.match(server.log(), /Cleared stale online status for 1 user/);
  });
});
