/**
 * The assistant works only in active mentorships (BUILD_NOTES Entry 75).
 *
 * The index holds only active ones, so anywhere else the assistant could only
 * say it found nothing about material the user can still open. Both Copilot
 * routes refuse before the service is called, and after the membership check,
 * so an outsider cannot use the difference to learn a mentorship's status.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { USERS, start, stop, api, mongoose } = require('./helpers/harness');

let received = [];
const stub = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    received.push(req.url);
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ status: 'answered', answer: 'Yes [1].', citations: [], chunks: [] }));
  });
});

const ENDED = "The assistant isn't available for ended mentorships.";
const NOT_ACTIVE = 'The assistant is only available in active mentorships.';
let mine;

test.before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  await start({
    extraEnv: {
      AI_SERVICE_URL: `http://127.0.0.1:${stub.address().port}`,
      AI_SERVICE_SECRET: 'stub-secret',
      COPILOT_ASKS_PER_MINUTE: '1000'
    }
  });
  mine = await api('/api/mentorships', {
    as: USERS.mentor,
    method: 'POST',
    body: { studentId: USERS.student._id, topic: 'Backend interviews' }
  }).then((r) => r.json());
});

test.after(async () => {
  await stop();
  stub.closeAllConnections();
  await new Promise((r) => stub.close(r));
});

test.beforeEach(() => {
  received = [];
});

const setStatus = (status) =>
  mongoose.connection.db
    .collection('mentorships')
    .updateOne({ _id: new mongoose.Types.ObjectId(mine._id) }, { $set: { status } });

const ROUTES = {
  ask: { question: 'How many retries?' },
  search: { query: 'How many retries?' }
};
const call = (as, route, id = mine._id) =>
  api(`/api/mentorships/${id}/copilot/${route}`, { as, method: 'POST', body: ROUTES[route] });

for (const route of Object.keys(ROUTES)) {
  for (const [status, message] of [
    ['ended', ENDED],
    ['declined', NOT_ACTIVE],
    ['pending', NOT_ACTIVE]
  ]) {
    test(`${route}: a ${status} mentorship is refused and the service hears nothing`, async () => {
      await setStatus(status);
      for (const as of [USERS.student, USERS.mentor]) {
        const res = await call(as, route);
        assert.equal(res.status, 409);
        assert.deepEqual(await res.json(), { error: message });
      }
      assert.deepEqual(received, []);
    });

    test(`${route}: an outsider gets the same answer as for an active one when it is ${status}`, async () => {
      await setStatus('active');
      const active = await call(USERS.student2, route);
      await setStatus(status);
      const other = await call(USERS.student2, route);

      assert.equal(active.status, 403);
      assert.equal(other.status, 403);
      assert.deepEqual(await other.json(), await active.json());
      assert.deepEqual(received, []);
    });
  }

  test(`${route}: an active mentorship still reaches the service`, async () => {
    await setStatus('active');
    const res = await call(USERS.student, route);
    assert.equal(res.status, 200);
    assert.deepEqual(received, [`/${route}`]);
  });

  test(`${route}: a mentorship that does not exist is still a 404`, async () => {
    assert.equal((await call(USERS.student, route, '0000000000000000000000ff')).status, 404);
  });

  test(`${route}: signed out is still a 401, whatever the status`, async () => {
    await setStatus('ended');
    assert.equal((await call(null, route)).status, 401);
  });
}
