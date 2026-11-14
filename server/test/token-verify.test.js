/**
 * The real sign-in path: a Firebase ID token checked against a signing key.
 *
 * Every other test signs in through the dev header, which never reaches
 * `verifyIdToken`, so until now nothing tested the function that decides who a
 * caller is. Here the key is made in the test and handed to it in place of
 * Google's, and each thing it claims to check is broken in turn. No database and
 * no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'unit-project';
const { verifyIdToken, firebaseUserFrom } = require('../middleware/auth');
const { loginIdentity, cosmetic } = require('../lib/loginIdentity');

const PROJECT = 'unit-project';
const ISSUER = `https://securetoken.google.com/${PROJECT}`;
const pair = () => crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const ours = pair();
const theirs = pair();
const certs = { k1: ours.publicKey };
const getCerts = async () => certs;
const never = () => 0; // a clock on which the forced refetch is never due

const sign = (claims = {}, options = {}, key = ours.privateKey) =>
  jwt.sign({ email: 'someone@test.local', email_verified: true, ...claims }, key, {
    algorithm: 'RS256', keyid: 'k1', audience: PROJECT, issuer: ISSUER, subject: 'uid-1', expiresIn: 600, ...options
  });
const verify = (token, extra = {}) => verifyIdToken(token, { getCerts, projectId: PROJECT, now: never, ...extra });

/** A token with a header and payload of our choosing and a signature made by `signer`. */
const handMade = (header, payload, signer = () => '') => {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${part(header)}.${part(payload)}`;
  return `${body}.${signer(body)}`;
};
const goodPayload = { sub: 'uid-1', aud: PROJECT, iss: ISSUER, exp: 9999999999 };

test('a token signed by the known key, for this project, is accepted', async () => {
  const payload = await verify(sign());
  assert.equal(payload.sub, 'uid-1');
  assert.equal(payload.email, 'someone@test.local');
});

test('each thing the check is for', async (t) => {
  const refused = [
    ['a token for another project (audience)', sign({}, { audience: 'another-project' })],
    ['a token from another issuer', sign({}, { issuer: 'https://securetoken.google.com/another-project' })],
    ['an expired token', sign({}, { expiresIn: -10 })],
    ['a token signed by a different key under the same key id', sign({}, {}, theirs.privateKey)],
    ['a key id that is not known', sign({}, { keyid: 'k9' })],
    ['a key id that is a property of every object', sign({}, { keyid: 'constructor' })],
    ['a token with no key id', jwt.sign({}, ours.privateKey, { algorithm: 'RS256', audience: PROJECT, issuer: ISSUER, subject: 'uid-1' })],
    ['a token with no subject', jwt.sign({}, ours.privateKey, { algorithm: 'RS256', keyid: 'k1', audience: PROJECT, issuer: ISSUER })],
    ['an HS256 token signed with the public key as its secret',
      handMade({ alg: 'HS256', typ: 'JWT', kid: 'k1' }, goodPayload,
        (body) => crypto.createHmac('sha256', ours.publicKey).update(body).digest('base64url'))],
    ['an unsigned token', handMade({ alg: 'none', typ: 'JWT', kid: 'k1' }, goodPayload)],
    ['something that is not a token', 'not.a.token'],
    ['an altered payload', (() => {
      const [h, , s] = sign().split('.');
      const p = Buffer.from(JSON.stringify({ ...goodPayload, sub: 'uid-2' })).toString('base64url');
      return `${h}.${p}.${s}`;
    })()]
  ];
  for (const [name, token] of refused) {
    await t.test(`${name} is refused`, async () => {
      await assert.rejects(() => verify(token));
    });
  }

  await t.test('with no project configured, nothing is accepted', async () => {
    await assert.rejects(() => verify(sign(), { projectId: '' }), /FIREBASE_PROJECT_ID/);
  });
});

test('an unknown key id fetches the keys again, once, and not on every forged token', async () => {
  let clock = 10 * 60000;
  const calls = [];
  const rotated = { k2: ours.publicKey };
  const rotating = async ({ force = false } = {}) => {
    calls.push(force);
    return force ? rotated : {};
  };
  const options = () => ({ getCerts: rotating, projectId: PROJECT, now: () => clock });

  // Google rotated: the cached set lacks k2, the forced fetch has it.
  const payload = await verifyIdToken(sign({}, { keyid: 'k2' }), options());
  assert.equal(payload.sub, 'uid-1');
  assert.deepEqual(calls, [false, true]);

  // A forged key id straight after: no second forced fetch inside the interval.
  calls.length = 0;
  clock += 1000;
  await assert.rejects(() => verifyIdToken(sign({}, { keyid: 'forged' }), options()));
  assert.deepEqual(calls, [false]);

  // After the interval it may look again.
  calls.length = 0;
  clock += 61000;
  await assert.rejects(() => verifyIdToken(sign({}, { keyid: 'forged' }), options()));
  assert.deepEqual(calls, [false, true]);
});

test('what sign-in takes from a verified token', async (t) => {
  await t.test('email_verified must be exactly true', () => {
    assert.equal(firebaseUserFrom({ sub: 'u', email: 'a@b.c', email_verified: true }).emailVerified, true);
    for (const v of [false, undefined, 'true', 1]) {
      assert.equal(firebaseUserFrom({ sub: 'u', email: 'a@b.c', email_verified: v }).emailVerified, false);
    }
  });

  await t.test('an email that is not a string is no email', () => {
    assert.equal(firebaseUserFrom({ sub: 'u', email: { $ne: null } }).email, '');
  });
});

test('who a sign-in is (lib/loginIdentity.js)', async (t) => {
  const admins = ['boss@test.local'];
  const user = (over = {}) => ({ uid: 'u1', email: 'someone@test.local', emailVerified: true, ...over });

  await t.test('a verified email signs in, and is not an admin', () => {
    assert.deepEqual(loginIdentity(user(), admins), { firebaseUid: 'u1', email: 'someone@test.local', admin: false });
  });

  await t.test('an allowlisted, verified email is an admin, whatever its case', () => {
    assert.equal(loginIdentity(user({ email: 'Boss@Test.Local' }), admins).admin, true);
  });

  await t.test('an allowlisted email that is NOT verified does not sign in at all', () => {
    const got = loginIdentity(user({ email: 'boss@test.local', emailVerified: false }), admins);
    assert.equal(got.status, 403);
    assert.equal(got.admin, undefined);
  });

  await t.test('a token with no email does not sign in: there is no body to fall back on', () => {
    assert.equal(loginIdentity(user({ email: '' }), admins).status, 400);
    assert.equal(loginIdentity(user({ email: undefined }), admins).status, 400);
    assert.equal(loginIdentity.length, 1, 'the token and the allowlist are its only inputs');
  });

  await t.test('no uid, or nothing at all, does not sign in', () => {
    assert.equal(loginIdentity(user({ uid: '' }), admins).status, 400);
    assert.equal(loginIdentity(null, admins).status, 400);
  });

  await t.test('a name or photo is a bounded string or nothing', () => {
    assert.equal(cosmetic('  Asha  ', 200), 'Asha');
    assert.equal(cosmetic('x'.repeat(500), 200).length, 200);
    for (const bad of [undefined, null, 7, { $ne: 1 }, ['a']]) assert.equal(cosmetic(bad, 200), '');
  });
});
