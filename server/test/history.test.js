/**
 * Chat history is the NEWEST page, oldest first (lib/history.js).
 *
 * Both routes used to return the first 50 messages ever sent, so a conversation
 * past 50 never showed its newest messages after a reload (the audit, F2).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, db, mongoose } = require('./helpers/harness');
const { parsePage, DEFAULT_PAGE, MAX_PAGE } = require('../lib/history');

const id = (hex) => new mongoose.Types.ObjectId(hex);
const T0 = Date.UTC(2026, 0, 1);
const at = (i) => new Date(T0 + i * 60000);
const GROUP = '0000000000000000000000c1';
const TOTAL = 120;

test.before(async () => {
  await start();
  const student = id(USERS.student._id);
  const mentor = id(USERS.mentor._id);

  await db().collection('messages').insertMany(
    Array.from({ length: TOTAL }, (_, i) => ({
      sender: i % 2 ? student : mentor,
      receiver: i % 2 ? mentor : student,
      text: `dm ${i}`,
      timestamp: at(i),
      read: true
    }))
  );
  const SAME = new Date(T0 - 3600000);
  await db().collection('messages').insertMany(
    [0, 1, 2].map((i) => ({ sender: mentor, receiver: student, text: `dm same ${i}`, timestamp: SAME, read: true }))
  );
  await db().collection('groupmessages').insertMany(
    [0, 1, 2].map((i) => ({ group: id(GROUP), sender: mentor, text: `gm same ${i}`, timestamp: SAME }))
  );
  await db().collection('groups').insertOne({
    _id: id(GROUP), name: 'History', createdBy: mentor, members: [mentor, student], createdAt: new Date()
  });
  await db().collection('groupmessages').insertMany(
    Array.from({ length: TOTAL }, (_, i) => ({ group: id(GROUP), sender: mentor, text: `gm ${i}`, timestamp: at(i) }))
  );
});
test.after(() => stop());

const ROUTES = [
  ['1-to-1', `/api/messages/${USERS.student._id}/${USERS.mentor._id}`, 'dm'],
  ['group', `/api/groups/${GROUP}/messages`, 'gm']
];

for (const [name, path, tag] of ROUTES) {
  test(`${name} history`, async (t) => {
    const get = async (query = '') => {
      const res = await api(path + query, { as: USERS.student });
      return { status: res.status, body: await res.json() };
    };
    const texts = (body) => body.map((m) => m.text);
    const range = (from, to) => Array.from({ length: to - from }, (_, i) => `${tag} ${from + i}`);

    await t.test('the default page is the newest 50, oldest first', async () => {
      const { status, body } = await get();
      assert.equal(status, 200);
      assert.deepEqual(texts(body), range(TOTAL - DEFAULT_PAGE, TOTAL));
    });

    await t.test('before gives the page that ends just before it', async () => {
      const first = (await get()).body;
      const { body } = await get(`?before=${encodeURIComponent(first[0].timestamp)}&beforeId=${first[0]._id}`);
      assert.deepEqual(texts(body), range(TOTAL - 2 * DEFAULT_PAGE, TOTAL - DEFAULT_PAGE));
    });

    await t.test('paging back reaches the first message, then a short page', async () => {
      const { body } = await get(`?before=${encodeURIComponent(at(20).toISOString())}`);
      assert.deepEqual(texts(body).slice(-20), range(0, 20));
      assert.equal(body.length, 23, 'the 20 before it and the three older ones');
    });

    await t.test('limit is honoured', async () => {
      assert.deepEqual(texts((await get('?limit=3')).body), range(TOTAL - 3, TOTAL));
    });

    await t.test(`limit is capped at ${MAX_PAGE}`, async () => {
      assert.equal((await get('?limit=100000')).body.length, MAX_PAGE);
    });

    await t.test('messages sent in the same millisecond are not skipped between pages', async () => {
      // Three messages share one timestamp, before everything else. Paging two at a
      // time from the end must still reach all three, once each.
      const seen = [];
      let page = (await get(`?limit=2&before=${encodeURIComponent(at(0).toISOString())}`)).body;
      while (page.length) {
        seen.unshift(...texts(page));
        page = (await get(`?limit=2&before=${encodeURIComponent(page[0].timestamp)}&beforeId=${page[0]._id}`)).body;
      }
      assert.deepEqual(seen.sort(), [`${tag} same 0`, `${tag} same 1`, `${tag} same 2`]);
    });

    for (const bad of ['beforeId=0000000000000000000000aa', 'before=2026-01-01&beforeId=nope', 'limit=0', 'limit=-1', 'limit=abc', 'limit=1.5', 'limit=1&limit=2', 'before=yesterday', 'before=']) {
      await t.test(`?${bad} is refused`, async () => {
        assert.equal((await get(`?${bad}`)).status, 400);
      });
    }
  });
}

test('a peer id that is not an id is a 404, not a server error', async () => {
  const res = await api(`/api/messages/${USERS.student._id}/not-an-id`, { as: USERS.student });
  assert.equal(res.status, 404);
});

test('parsePage', () => {
  assert.deepEqual(parsePage({}), { limit: DEFAULT_PAGE, before: null, beforeId: null });
  assert.deepEqual(parsePage({ limit: '7' }), { limit: 7, before: null, beforeId: null });
  assert.equal(parsePage({ limit: '1000' }).limit, MAX_PAGE);
  assert.ok(parsePage({ limit: ['1', '2'] }).error);
  assert.ok(parsePage({ before: ['2026-01-01'] }).error);
  assert.equal(parsePage({ before: '2026-01-01T00:00:00Z' }).before.getTime(), Date.UTC(2026, 0, 1));
});
