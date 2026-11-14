/**
 * A mentor's verification link is a web address or nothing (the audit, F4), and
 * sign-in takes its email from the token, never the request body (F5).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { USERS, start, stop, api, db } = require('./helpers/harness');

test.before(() => start());
test.after(() => stop());

const submit = (body) => api('/api/verification', { as: USERS.mentor, method: 'POST', body });
const stored = async () => (await db().collection('users').findOne({ email: USERS.mentor.email })).verification;

test('the profile link on a verification request', async (t) => {
  const BAD = [
    'javascript:alert(document.cookie)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'linkedin.com/in/someone',
    '//evil.example/x'
  ];
  for (const link of BAD) {
    await t.test(`${JSON.stringify(link)} is refused and nothing is stored`, async () => {
      const res = await submit({ company: 'Acme', title: 'Engineer', linkedinUrl: link });
      assert.equal(res.status, 400);
      assert.notEqual((await stored())?.status, 'pending');
    });
  }

  for (const notText of [{ $ne: null }, ['https://a.example'], 7]) {
    await t.test(`a link that is ${JSON.stringify(notText)} is treated as none, not a server error`, async () => {
      const res = await submit({ company: 'Acme', title: 'Engineer', linkedinUrl: notText });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).verification.linkedinUrl, '');
    });
  }

  await t.test('company or title that is not text is a 400, not a server error', async () => {
    assert.equal((await submit({ company: { a: 1 }, title: 'Engineer' })).status, 400);
    assert.equal((await submit({ company: 'Acme', title: ['x'] })).status, 400);
  });

  await t.test('an https link is stored', async () => {
    const res = await submit({ company: 'Acme', title: 'Engineer', linkedinUrl: 'https://linkedin.com/in/someone' });
    assert.equal(res.status, 200);
    assert.equal((await stored()).linkedinUrl, 'https://linkedin.com/in/someone');
  });

  await t.test('no link at all is allowed', async () => {
    const res = await submit({ company: 'Acme', title: 'Engineer' });
    assert.equal(res.status, 200);
    assert.equal((await stored()).linkedinUrl, '');
  });
});

test('sign-in ignores an email in the request body', async () => {
  const res = await api('/api/auth/login', {
    as: USERS.student,
    method: 'POST',
    body: { email: USERS.admin.email, displayName: { $ne: null }, photoURL: 7 }
  });
  assert.equal(res.status, 200);
  const user = await res.json();
  assert.equal(user.email, USERS.student.email);
  assert.equal(user.role, 'student');
  assert.equal(user.displayName, USERS.student.displayName, 'a name that is not text is ignored');
});
