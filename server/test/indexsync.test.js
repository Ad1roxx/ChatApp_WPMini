/**
 * Telling the retrieval index what changed (lib/indexSync.js).
 *
 * The retrieval service is replaced by a stub: a plain node:http server on a
 * random port that records every request it is sent and answers however the
 * test asks — accepted, slowly, with an error, or not at all. No Python, no
 * container, no new dependency; the real Express server is spawned against it
 * exactly as it runs in production.
 *
 * Four things are asserted:
 *   - every route in the S1.5 inventory sends the right identifiers, after a
 *     write that succeeded;
 *   - nothing is sent after a write that failed or was refused;
 *   - the user's request succeeds whatever the service does — slow, failing,
 *     or not there at all;
 *   - the shared secret is sent, and nothing but identifiers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { USERS, BASE, start, stop, api } = require('./helpers/harness');

const SECRET = 'stub-secret';

// ---------------------------------------------------------------------------
// The stub retrieval service
// ---------------------------------------------------------------------------
let mode = 'accept'; // accept | slow | error
let received = [];
let stubPort;

const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    received.push({
      path: req.url,
      method: req.method,
      secret: req.headers['x-ai-secret'],
      body: raw ? JSON.parse(raw) : null
    });
    if (mode === 'slow') {
      // Far beyond the notifier's timeout: the request must not wait for it.
      setTimeout(() => res.writeHead(202).end('{}'), 5000);
    } else if (mode === 'error') {
      res.writeHead(500).end();
    } else {
      res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"queued":true}');
    }
  });
});

let server; // the spawned app, for its log

test.before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  stubPort = stub.address().port;
  server = await start({
    extraEnv: { AI_SERVICE_URL: `http://127.0.0.1:${stubPort}`, AI_SERVICE_SECRET: SECRET }
  });
});

test.after(async () => {
  await stop();
  stub.closeAllConnections();
  await new Promise((r) => stub.close(r));
});

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `act`, then collect what the stub received because of it. Waits until
 * `expect` notices have arrived (or a second has passed), then a little more,
 * so a stray extra notice is caught rather than missed.
 */
async function noticesFrom(act, expect = 1) {
  received = [];
  const res = await act();
  const deadline = Date.now() + 1000;
  while (received.length < expect && Date.now() < deadline) await settle(20);
  await settle(150);
  return { res, notices: received.map((r) => r.body) };
}

const json = (r) => r.json();
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

function upload(as, subId, name, content, type) {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  return fetch(`${BASE}/api/submissions/${subId}/files`, {
    method: 'POST',
    headers: { 'X-Dev-User-Id': as._id },
    body: form
  });
}

function uploadToBrief(as, assignmentId, name, content, type) {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  return fetch(`${BASE}/api/assignments/${assignmentId}/files`, {
    method: 'POST',
    headers: { 'X-Dev-User-Id': as._id },
    body: form
  });
}

let mine; // mentor -> student
let theirs; // admin -> student2
let assignment;
let submission;

async function mySubmission() {
  const subs = await api(`/api/mentorships/${mine._id}/assignments`, { as: USERS.student }).then(json);
  return subs.find((s) => String(s.assignment._id) === String(assignment._id));
}

// ---------------------------------------------------------------------------
// Every route, the right identifiers, after the write
// ---------------------------------------------------------------------------
test('every route tells the index which record changed', async (t) => {
  mine = await api('/api/mentorships', {
    as: USERS.mentor,
    method: 'POST',
    body: { studentId: USERS.student._id, topic: 'Caching' }
  }).then(json);
  theirs = await api('/api/mentorships', {
    as: USERS.admin,
    method: 'POST',
    body: { studentId: USERS.student2._id, topic: 'Something else' }
  }).then(json);

  await t.test('setting an assignment sends the assignment', async () => {
    const { res, notices } = await noticesFrom(() =>
      api('/api/assignments', {
        as: USERS.mentor,
        method: 'POST',
        body: { title: 'Caching exercise', dueAt: inDays(7), mentorshipIds: [mine._id] }
      })
    );
    assert.equal(res.status, 201);
    assignment = await res.json();
    assert.deepEqual(notices, [{ sourceType: 'assignment', sourceId: String(assignment._id) }]);
    submission = await mySubmission();
  });

  await t.test('editing it sends the assignment', async () => {
    const { res, notices } = await noticesFrom(() =>
      api(`/api/assignments/${assignment._id}`, {
        as: USERS.mentor,
        method: 'PATCH',
        body: { title: 'Caching exercise, revised' }
      })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(notices, [{ sourceType: 'assignment', sourceId: String(assignment._id) }]);
  });

  const handIn = { sourceType: 'submission', sourceId: () => String(submission._id) };
  const expectHandIn = (notices) =>
    assert.deepEqual(notices, [{ sourceType: handIn.sourceType, sourceId: handIn.sourceId() }]);

  let fileId;
  await t.test('attaching a file sends the hand-in', async () => {
    const { res, notices } = await noticesFrom(() =>
      upload(USERS.student, submission._id, 'notes.pdf', '%PDF-1.4 notes', 'application/pdf')
    );
    assert.equal(res.status, 201);
    fileId = (await res.json()).attachments.at(-1).fileId;
    expectHandIn(notices);
  });

  await t.test('removing a file sends the hand-in', async () => {
    const { res, notices } = await noticesFrom(() =>
      api(`/api/submissions/${submission._id}/files/${fileId}`, {
        as: USERS.student,
        method: 'DELETE'
      })
    );
    assert.equal(res.status, 200);
    expectHandIn(notices);
  });

  const expectBrief = (notices) =>
    assert.deepEqual(notices, [{ sourceType: 'assignment', sourceId: String(assignment._id) }]);

  let briefFileId;
  await t.test('attaching a file to the brief sends the assignment', async () => {
    const { res, notices } = await noticesFrom(() =>
      uploadToBrief(USERS.mentor, assignment._id, 'brief.pdf', '%PDF-1.4 brief', 'application/pdf')
    );
    assert.equal(res.status, 201);
    briefFileId = (await res.json()).attachments.at(-1).fileId;
    expectBrief(notices);
  });

  await t.test('marking a brief file as the rubric, and sharing it, each send the assignment', async () => {
    for (const body of [{ rubric: true }, { shared: true }, { shared: false }, { rubric: false }, { rubric: true }]) {
      const { res, notices } = await noticesFrom(() =>
        api(`/api/assignments/${assignment._id}/files/${briefFileId}`, { as: USERS.mentor, method: 'PATCH', body })
      );
      assert.equal(res.status, 200, JSON.stringify(body));
      expectBrief(notices);
    }
  });

  await t.test('removing a file from the brief sends the assignment', async () => {
    const { res, notices } = await noticesFrom(() =>
      api(`/api/assignments/${assignment._id}/files/${briefFileId}`, { as: USERS.mentor, method: 'DELETE' })
    );
    assert.equal(res.status, 200);
    expectBrief(notices);
  });

  await t.test('handing in sends the hand-in', async () => {
    const { res, notices } = await noticesFrom(() =>
      api(`/api/submissions/${submission._id}`, {
        as: USERS.student,
        method: 'PUT',
        body: { text: 'My invalidation rule.' }
      })
    );
    assert.equal(res.status, 200);
    expectHandIn(notices);
  });

  await t.test('unsubmitting sends the hand-in', async () => {
    const { res, notices } = await noticesFrom(() =>
      api(`/api/submissions/${submission._id}/unsubmit`, { as: USERS.student, method: 'POST' })
    );
    assert.equal(res.status, 200);
    expectHandIn(notices);
  });

  await t.test('a review sends the hand-in', async () => {
    await api(`/api/submissions/${submission._id}`, {
      as: USERS.student,
      method: 'PUT',
      body: { text: 'Handed in again.' }
    });
    const { res, notices } = await noticesFrom(() =>
      api(`/api/submissions/${submission._id}`, {
        as: USERS.mentor,
        method: 'PATCH',
        body: { action: 'request-changes', note: 'Explain the herd.' }
      })
    );
    assert.equal(res.status, 200);
    expectHandIn(notices);
  });

  let goal;
  await t.test('setting, ticking and editing a goal each send the goal', async () => {
    const created = await noticesFrom(() =>
      api(`/api/mentorships/${mine._id}/goals`, {
        as: USERS.mentor,
        method: 'POST',
        body: { title: 'Interviews', milestones: ['Caching'] }
      })
    );
    assert.equal(created.res.status, 200);
    goal = await created.res.json();
    const asGoal = [{ sourceType: 'goal', sourceId: String(goal._id) }];
    assert.deepEqual(created.notices, asGoal);

    const ticked = await noticesFrom(() =>
      api(`/api/goals/${goal._id}/milestones/${goal.milestones[0]._id}`, {
        as: USERS.student,
        method: 'PATCH',
        body: { done: true }
      })
    );
    assert.equal(ticked.res.status, 200);
    assert.deepEqual(ticked.notices, asGoal);

    const edited = await noticesFrom(() =>
      api(`/api/goals/${goal._id}`, { as: USERS.mentor, method: 'PATCH', body: { title: 'Jobs' } })
    );
    assert.equal(edited.res.status, 200);
    assert.deepEqual(edited.notices, asGoal);
  });

  await t.test('sharing and removing a resource each send the resource', async () => {
    const shared = await noticesFrom(() =>
      api(`/api/mentorships/${mine._id}/resources`, {
        as: USERS.mentor,
        method: 'POST',
        body: { title: 'Use The Index, Luke', url: 'https://use-the-index-luke.com/', note: 'B-trees' }
      })
    );
    assert.equal(shared.res.status, 201);
    const resource = await shared.res.json();
    const asResource = [{ sourceType: 'resource', sourceId: String(resource._id) }];
    assert.deepEqual(shared.notices, asResource);

    const removed = await noticesFrom(() =>
      api(`/api/resources/${resource._id}`, { as: USERS.mentor, method: 'DELETE' })
    );
    assert.equal(removed.res.status, 200);
    assert.deepEqual(removed.notices, asResource);
  });

  await t.test('deleting an assignment sends it and every hand-in', async () => {
    const { res, notices } = await noticesFrom(
      () => api(`/api/assignments/${assignment._id}`, { as: USERS.mentor, method: 'DELETE' }),
      2
    );
    assert.equal(res.status, 200);
    assert.deepEqual(
      new Set(notices.map((n) => JSON.stringify(n))),
      new Set([
        JSON.stringify({ sourceType: 'assignment', sourceId: String(assignment._id) }),
        JSON.stringify({ sourceType: 'submission', sourceId: String(submission._id) })
      ])
    );
  });

  await t.test('ending a mentorship sends the mentorship', async () => {
    const { res, notices } = await noticesFrom(() =>
      api(`/api/mentorships/${theirs._id}`, { as: USERS.admin, method: 'PATCH', body: { action: 'end' } })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(notices, [{ mentorshipId: String(theirs._id) }]);
  });
});

// ---------------------------------------------------------------------------
// Nothing after a failed or refused write
// ---------------------------------------------------------------------------
test('nothing is sent when the write fails or is refused', async (t) => {
  const work = await api('/api/assignments', {
    as: USERS.mentor,
    method: 'POST',
    body: { title: 'Second exercise', dueAt: inDays(7), mentorshipIds: [mine._id] }
  }).then(json);
  assignment = work;
  submission = await mySubmission();

  const refusals = [
    ['a student editing a brief (403)', () =>
      api(`/api/assignments/${work._id}`, { as: USERS.student, method: 'PATCH', body: { title: 'x' } }), 403],
    ['someone else\'s mentor deleting it (403)', () =>
      api(`/api/assignments/${work._id}`, { as: USERS.admin, method: 'DELETE' }), 403],
    ['an empty hand-in (400)', () =>
      api(`/api/submissions/${submission._id}`, { as: USERS.student, method: 'PUT', body: { text: '' } }), 400],
    ['the mentor handing in for the student (403)', () =>
      api(`/api/submissions/${submission._id}`, { as: USERS.mentor, method: 'PUT', body: { text: 'x' } }), 403],
    ['a student setting a goal (403)', () =>
      api(`/api/mentorships/${mine._id}/goals`, { as: USERS.student, method: 'POST', body: { title: 'x' } }), 403],
    ['an outsider sharing a resource (403)', () =>
      api(`/api/mentorships/${mine._id}/resources`, {
        as: USERS.student2,
        method: 'POST',
        body: { title: 'x', url: 'https://example.com/' }
      }), 403],
    ['a student ending an active mentorship (403)', () =>
      api(`/api/mentorships/${mine._id}`, { as: USERS.student, method: 'PATCH', body: { action: 'end' } }), 403],
    ['a student attaching a file to the brief (403)', () =>
      uploadToBrief(USERS.student, work._id, 'x.pdf', '%PDF-1.4 x', 'application/pdf'), 403],
    ['another mentor removing a file from the brief (403)', () =>
      api(`/api/assignments/${work._id}/files/0000000000000000000000ff`, { as: USERS.admin, method: 'DELETE' }), 403],
    ['a student marking a brief file as the rubric (403)', () =>
      api(`/api/assignments/${work._id}/files/0000000000000000000000ff`, { as: USERS.student, method: 'PATCH', body: { rubric: true } }), 403],
    ['a malformed rubric mark (400)', () =>
      api(`/api/assignments/${work._id}/files/0000000000000000000000ff`, { as: USERS.mentor, method: 'PATCH', body: { rubric: 'yes' } }), 400],
    ['a missing assignment (404)', () =>
      api('/api/assignments/0000000000000000000000ff', { as: USERS.mentor, method: 'DELETE' }), 404]
  ];

  for (const [name, act, status] of refusals) {
    await t.test(name, async () => {
      const { res, notices } = await noticesFrom(act, 1);
      assert.equal(res.status, status);
      assert.deepEqual(notices, []);
    });
  }

  await t.test('a second rubric on one assignment (409)', async () => {
    const upload = (name) => uploadToBrief(USERS.mentor, work._id, name, '%PDF-1.4 x', 'application/pdf')
      .then((r) => r.json()).then((body) => body.attachments.find((f) => f.name === name));
    const first = await upload('first.pdf');
    const second = await upload('second.pdf');
    const flag = (f) => api(`/api/assignments/${work._id}/files/${f.fileId}`, { as: USERS.mentor, method: 'PATCH', body: { rubric: true } });
    assert.equal((await flag(first)).status, 200);
    const { res, notices } = await noticesFrom(() => flag(second), 1);
    assert.equal(res.status, 409);
    assert.deepEqual(notices, []);
  });

  await t.test('an opt-out request, which leaves the mentorship active', async () => {
    const { res, notices } = await noticesFrom(() =>
      api(`/api/mentorships/${mine._id}`, {
        as: USERS.student,
        method: 'PATCH',
        body: { action: 'request-optout', note: 'Changing focus' }
      })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(notices, []);
  });
});

// ---------------------------------------------------------------------------
// The secret, and nothing but identifiers
// ---------------------------------------------------------------------------
test('each notice carries the shared secret and nothing but identifiers', async () => {
  received = [];
  const res = await api(`/api/submissions/${submission._id}`, {
    as: USERS.student,
    method: 'PUT',
    body: { text: 'A hand-in whose text must never travel to the index from here.' }
  });
  assert.equal(res.status, 200);
  const deadline = Date.now() + 1000;
  while (received.length < 1 && Date.now() < deadline) await settle(20);

  const [notice] = received;
  assert.equal(notice.method, 'POST');
  assert.equal(notice.path, '/index/sync');
  assert.equal(notice.secret, SECRET);
  assert.deepEqual(Object.keys(notice.body).sort(), ['sourceId', 'sourceType']);
  assert.ok(!JSON.stringify(notice.body).includes('must never travel'));
});

// ---------------------------------------------------------------------------
// The service misbehaving never fails the user's request
// ---------------------------------------------------------------------------
test('the request succeeds whatever the retrieval service does', async (t) => {
  const handIn = (text) =>
    api(`/api/submissions/${submission._id}`, { as: USERS.student, method: 'PUT', body: { text } });
  // Turned in each time, then taken back so the next save is allowed.
  const takeBack = () =>
    api(`/api/submissions/${submission._id}/unsubmit`, { as: USERS.student, method: 'POST' });

  await t.test('slow: the request does not wait for it', async () => {
    mode = 'slow';
    await takeBack();
    const started = Date.now();
    const res = await handIn('Handed in while the index is slow.');
    const took = Date.now() - started;
    assert.equal(res.status, 200);
    // The stub would hold the notice for five seconds; the request is not held.
    assert.ok(took < 1000, `the request took ${took} ms`);
    await settle(1800); // past the notifier's 1.5 s timeout, so it is logged
    assert.match(server.log(), /Index not told about submission \w+: no answer in 1500 ms/);
  });

  await t.test('failing: the request succeeds and the failure is logged', async () => {
    mode = 'error';
    await takeBack();
    const res = await handIn('Handed in while the index is failing.');
    assert.equal(res.status, 200);
    await settle(300);
    assert.match(server.log(), /Index not told about submission \w+: the service answered 500/);
  });

  await t.test('down: the request succeeds and the failure is logged', async () => {
    mode = 'accept';
    stub.closeAllConnections();
    await new Promise((r) => stub.close(r));
    try {
      await takeBack();
      const res = await handIn('Handed in while the index is down.');
      assert.equal(res.status, 200);
      await settle(300);
      assert.match(server.log(), /Index not told about submission \w+: fetch failed/);
    } finally {
      await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r));
    }
  });
});
