/**
 * One mentorship's lists hold that mentorship's records, and the counts are
 * the caller's own: through the page routes, with a second mentorship that has
 * records of its own.
 *
 * Added in S4 Step 2, when these reads moved to lib/reads.js and became shared
 * with the agent's tools. The mutation check found that no route test had a
 * second mentorship with goals, sessions or resources in it, so a query that
 * read every mentorship's records would have passed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api } = require('./helpers/harness');

let mine; // mentor -> student
let other; // mentor -> student2

const post = (as, path, body, method = 'POST') =>
  api(path, { as, method, body }).then(async (r) => {
    const json = await r.json();
    assert.ok(r.ok, `${method} ${path}: ${r.status} ${JSON.stringify(json)}`);
    return json;
  });
const get = (as, path) => api(path, { as }).then((r) => r.json());
const future = (days) => new Date(Date.now() + days * 86400000).toISOString();

test.before(async () => {
  await start();
  mine = await post(USERS.mentor, '/api/mentorships', { studentId: USERS.student._id, topic: 'Mine' });
  other = await post(USERS.mentor, '/api/mentorships', { studentId: USERS.student2._id, topic: 'Other' });
  for (const [m, tag] of [[mine, 'mine'], [other, 'other']]) {
    await post(USERS.mentor, `/api/mentorships/${m._id}/goals`, { title: `Goal ${tag}` });
    await post(USERS.mentor, `/api/mentorships/${m._id}/sessions`, {
      title: `Session ${tag}`, scheduledFor: future(3), durationMinutes: 30
    });
    await post(USERS.mentor, `/api/mentorships/${m._id}/resources`, {
      title: `Resource ${tag}`, url: `https://example.com/${tag}`
    });
    await post(USERS.mentor, '/api/assignments', {
      title: `Work ${tag}`, dueAt: future(7), mentorshipIds: [m._id]
    });
  }
});

test.after(() => stop());

test('a mentorship\'s lists hold only its own records', async (t) => {
  for (const [what, path, field] of [
    ['goals', 'goals', 'title'],
    ['sessions', 'sessions', 'title'],
    ['resources', 'resources', 'title']
  ]) {
    await t.test(what, async () => {
      const titles = (await get(USERS.mentor, `/api/mentorships/${mine._id}/${path}`)).map((r) => r[field]);
      assert.equal(titles.length, 1, JSON.stringify(titles));
      assert.match(titles[0], /mine$/);
    });
  }
  await t.test('hand-ins', async () => {
    const subs = await get(USERS.mentor, `/api/mentorships/${mine._id}/assignments`);
    assert.deepEqual(subs.map((s) => s.assignment.title), ['Work mine']);
  });
});

test('the counts are the caller\'s own', async (t) => {
  await t.test('the student owes their one piece of work, not the other student\'s', async () => {
    assert.deepEqual(await get(USERS.student, '/api/assignments/counts'), { owed: 1, toReview: 0 });
  });
  await t.test('the mentor owes nothing', async () => {
    assert.deepEqual(await get(USERS.mentor, '/api/assignments/counts'), { owed: 0, toReview: 0 });
  });
});
