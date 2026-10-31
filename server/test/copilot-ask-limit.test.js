/**
 * The ask route's per-person limit, in a file of its own: the server is
 * started with a limit of three a minute, which would starve every other
 * test in copilot-ask.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { USERS, start, stop, api } = require('./helpers/harness');

let received = 0;
const stub = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    received += 1;
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ status: 'answered', answer: 'Yes [1].', citations: [], promptVersion: 's2-v2' }));
  });
});

let mine;

test.before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  await start({
    extraEnv: {
      AI_SERVICE_URL: `http://127.0.0.1:${stub.address().port}`,
      AI_SERVICE_SECRET: 'stub-secret',
      COPILOT_ASKS_PER_MINUTE: '3'
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

const ask = (as) =>
  api(`/api/mentorships/${mine._id}/copilot/ask`, { as, method: 'POST', body: { question: 'Anything?' } });

test('a fourth ask in a minute is a plain 429, and the service is not called', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await ask(USERS.student)).status, 200);
  assert.equal(received, 3);

  const res = await ask(USERS.student);
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /Wait a minute and try again/);
  assert.equal(received, 3);
});

test('the limit is per person: the other party can still ask', async () => {
  assert.equal((await ask(USERS.mentor)).status, 200);
});

test('a refused or invalid ask does not use up the limit', async () => {
  // The limit is checked after access and validation, so these cost nothing.
  for (let i = 0; i < 5; i++) {
    const res = await api(`/api/mentorships/${mine._id}/copilot/ask`, {
      as: USERS.admin,
      method: 'POST',
      body: { question: 'Anything?' }
    });
    assert.equal(res.status, 403);
  }
  assert.equal((await ask(USERS.mentor)).status, 200);
});
