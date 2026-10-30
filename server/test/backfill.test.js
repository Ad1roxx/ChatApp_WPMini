/**
 * The one-off goal backfill (scripts/backfill-goal-timestamps.cjs).
 *
 * Run against its own throwaway database, never `chatapp`: the script is meant
 * to be pointed at the dev database by hand, which is exactly why its test
 * must not be.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { backfill } = require('../../scripts/backfill-goal-timestamps.cjs');

const FIXTURE = 'mongodb://127.0.0.1:27017/chatapp_backfill_test';

let conn;
let goals;

const day = (n) => new Date(Date.UTC(2026, 0, n));
const oid = () => new mongoose.Types.ObjectId();

const OLD = oid(); // predates S1.5: createdAt only
const OLDER = oid(); // also predates it
const CURRENT = oid(); // already has both - must not be touched
const UNDATED = oid(); // neither field: cannot be dated honestly

test.before(async () => {
  conn = await mongoose.createConnection(FIXTURE).asPromise();
  assert.equal(conn.db.databaseName, 'chatapp_backfill_test');
  await conn.db.dropDatabase();
  goals = conn.db.collection('goals');
  await goals.insertMany([
    { _id: OLD, title: 'old', createdAt: day(3) },
    { _id: OLDER, title: 'older', createdAt: day(1) },
    { _id: CURRENT, title: 'current', createdAt: day(2), updatedAt: day(9) },
    { _id: UNDATED, title: 'undated' }
  ]);
});

test.after(async () => {
  await conn.db.dropDatabase();
  await conn.close();
});

test('the goal backfill', async (t) => {
  await t.test('a dry run counts and changes nothing', async () => {
    const result = await backfill(conn.db, { dryRun: true });
    assert.deepEqual(result, { found: 3, updated: 0, undatable: 1 });
    assert.equal(await goals.countDocuments({ updatedAt: { $exists: true } }), 1);
  });

  await t.test('updatedAt becomes each goal\'s own createdAt', async () => {
    const result = await backfill(conn.db);
    assert.deepEqual(result, { found: 3, updated: 2, undatable: 1 });

    assert.deepEqual((await goals.findOne({ _id: OLD })).updatedAt, day(3));
    assert.deepEqual((await goals.findOne({ _id: OLDER })).updatedAt, day(1));
  });

  await t.test('a goal that already had one is left alone', async () => {
    assert.deepEqual((await goals.findOne({ _id: CURRENT })).updatedAt, day(9));
  });

  await t.test('a goal with no createdAt is not given an invented date', async () => {
    assert.equal((await goals.findOne({ _id: UNDATED })).updatedAt, undefined);
  });

  await t.test('running it again changes nothing', async () => {
    const before = await goals.find().sort({ _id: 1 }).toArray();
    const result = await backfill(conn.db);
    assert.deepEqual(result, { found: 1, updated: 0, undatable: 1 });
    assert.deepEqual(await goals.find().sort({ _id: 1 }).toArray(), before);
  });
});
