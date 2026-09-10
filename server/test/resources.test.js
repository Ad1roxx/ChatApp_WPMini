/**
 * Shared resources.
 *
 * The tests that matter most are the URL ones. The client renders `url`
 * straight into an `href`, so a stored `javascript:` link is stored XSS with
 * a one-click path to the other party. Allow-listing http(s) is what stops
 * it, and these assertions are what stop someone loosening that later without
 * noticing what it was for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api } = require('./helpers/harness');

let mentorship;
let ended;

test.before(async () => {
  await start();

  mentorship = await (await api('/api/mentorships', {
    as: USERS.mentor,
    method: 'POST',
    body: { studentId: USERS.student._id, topic: 'Backend interviews' }
  })).json();

  ended = await (await api('/api/mentorships', {
    as: USERS.mentor,
    method: 'POST',
    body: { studentId: USERS.student2._id, topic: 'Finished' }
  })).json();

  await api(`/api/mentorships/${ended._id}`, {
    as: USERS.mentor,
    method: 'PATCH',
    body: { action: 'end' }
  });
});

test.after(() => stop());

const share = (as, body, id = mentorship._id) =>
  api(`/api/mentorships/${id}/resources`, { as, method: 'POST', body });

const list = (as, id = mentorship._id) =>
  api(`/api/mentorships/${id}/resources`, { as }).then((r) => r.json());

test('either party may share a link', async (t) => {
  await t.test('the mentor can', async () => {
    const res = await share(USERS.mentor, {
      title: 'Consistent hashing',
      url: 'https://example.com/hashing',
      note: 'Read the first half.'
    });
    const r = await res.json();

    assert.equal(res.status, 201);
    assert.equal(r.title, 'Consistent hashing');
    assert.equal(String(r.addedBy._id), USERS.mentor._id);
  });

  await t.test('and so can the student — nothing here needs approving', async () => {
    const res = await share(USERS.student, {
      title: 'A talk I found',
      url: 'http://example.org/talk'
    });
    assert.equal(res.status, 201);
  });

  await t.test('but not an outsider', async () => {
    const res = await share(USERS.admin, { title: 'No', url: 'https://example.com' });
    assert.equal(res.status, 403);
  });

  await t.test('and not on a mentorship that has ended', async () => {
    const res = await share(
      USERS.student2,
      { title: 'Too late', url: 'https://example.com' },
      ended._id
    );
    assert.equal(res.status, 400);
  });
});

test('only http and https can be shared', async (t) => {
  // The client puts this straight into an href. A javascript: URL here is
  // stored XSS aimed at the other party.
  const dangerous = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com/x'
  ];

  for (const url of dangerous) {
    await t.test(`${url.slice(0, 28)} is refused`, async () => {
      const res = await share(USERS.mentor, { title: 'Bad', url });
      assert.equal(res.status, 400);
    });
  }

  await t.test('and so is something that is not a URL at all', async () => {
    const res = await share(USERS.mentor, { title: 'Bad', url: 'not a link' });
    assert.equal(res.status, 400);
  });

  await t.test('none of them were stored', async () => {
    const rows = await list(USERS.mentor);
    assert.ok(rows.every((r) => /^https?:\/\//i.test(r.url)));
  });
});

test('a title and a link are both required', async (t) => {
  await t.test('no title', async () => {
    const res = await share(USERS.mentor, { title: '   ', url: 'https://example.com' });
    assert.equal(res.status, 400);
  });

  await t.test('no link', async () => {
    const res = await share(USERS.mentor, { title: 'Titled' });
    assert.equal(res.status, 400);
  });
});

test('both parties see the same list, newest first', async (t) => {
  await t.test('the student sees what the mentor shared', async () => {
    const rows = await list(USERS.student);
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.title === 'Consistent hashing'));
  });

  await t.test('newest first', async () => {
    const rows = await list(USERS.mentor);
    const times = rows.map((r) => new Date(r.createdAt).getTime());
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i - 1] >= times[i]);
    }
  });

  await t.test('an outsider sees none of it', async () => {
    const res = await api(`/api/mentorships/${mentorship._id}/resources`, {
      as: USERS.admin
    });
    assert.equal(res.status, 403);
  });
});

test('removing is for the person who shared it, or the mentor', async (t) => {
  const rows = await list(USERS.mentor);
  const mentorLink = rows.find((r) => String(r.addedBy._id) === USERS.mentor._id);
  const studentLink = rows.find((r) => String(r.addedBy._id) === USERS.student._id);

  await t.test('a student cannot take down the mentor\'s link', async () => {
    // Deleting what someone else shared is the one action here with a loser,
    // and the mentor is the party with standing to decide.
    const res = await api(`/api/resources/${mentorLink._id}`, {
      as: USERS.student,
      method: 'DELETE'
    });
    assert.equal(res.status, 403);
  });

  await t.test('an outsider cannot either', async () => {
    const res = await api(`/api/resources/${studentLink._id}`, {
      as: USERS.admin,
      method: 'DELETE'
    });
    assert.equal(res.status, 403);
  });

  await t.test('a student can remove their own', async () => {
    const res = await api(`/api/resources/${studentLink._id}`, {
      as: USERS.student,
      method: 'DELETE'
    });
    assert.equal(res.status, 200);
  });

  await t.test('and the mentor can remove anything in the mentorship', async () => {
    const res = await api(`/api/resources/${mentorLink._id}`, {
      as: USERS.mentor,
      method: 'DELETE'
    });
    assert.equal(res.status, 200);

    const rows2 = await list(USERS.mentor);
    assert.equal(rows2.length, 0);
  });
});

test('the usual refusals', async (t) => {
  await t.test('a missing resource', async () => {
    const res = await api('/api/resources/0000000000000000000000ff', {
      as: USERS.mentor,
      method: 'DELETE'
    });
    assert.equal(res.status, 404);
  });

  await t.test('no token on listing', async () => {
    const res = await api(`/api/mentorships/${mentorship._id}/resources`);
    assert.equal(res.status, 401);
  });

  await t.test('no token on sharing', async () => {
    const res = await api(`/api/mentorships/${mentorship._id}/resources`, {
      method: 'POST',
      body: { title: 'x', url: 'https://example.com' }
    });
    assert.equal(res.status, 401);
  });
});
