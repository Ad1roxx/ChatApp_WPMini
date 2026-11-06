/**
 * The agent's capability token, and the internal-request checks, as pure
 * functions. No server, no database.
 *
 * The property: only a holder of AGENT_TOKEN_SECRET can make a token the
 * endpoint will take, and a token says exactly one user, one mentorship, one
 * role, for a short time. Each test below is one way of breaking that.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const {
  mintAgentToken,
  verifyAgentToken,
  secretProblem,
  AUDIENCE,
  ISSUER,
  MAX_AGE_S
} = require('../lib/agentToken');
const { isLoopback, sameSecret } = require('../lib/internalRequest');

const SECRET = crypto.randomBytes(24).toString('hex');
const USER = '0000000000000000000000a1';
const MENTORSHIP = '0000000000000000000000b1';
const TURN = { userId: USER, mentorshipId: MENTORSHIP, role: 'student', turnMs: 30000 };

/** A token signed however a test likes, with valid claims unless overridden. */
function forge(payload = {}, options = {}, secret = SECRET) {
  const merged = {
    algorithm: 'HS256',
    subject: USER,
    jwtid: crypto.randomBytes(16).toString('hex'),
    audience: AUDIENCE,
    issuer: ISSUER,
    expiresIn: 30,
    ...options
  };
  // An option set to undefined means "leave this claim out".
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  const body = { mid: MENTORSHIP, role: 'student', ...payload };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return jwt.sign(body, secret, merged);
}

const refused = (token) => assert.throws(() => verifyAgentToken(SECRET, token));

test('a minted token verifies to the claims it was minted with', () => {
  const { token, jti } = mintAgentToken(SECRET, TURN);
  const claims = verifyAgentToken(SECRET, token);
  assert.equal(claims.sub, USER);
  assert.equal(claims.mid, MENTORSHIP);
  assert.equal(claims.role, 'student');
  assert.equal(claims.jti, jti);
});

test('each turn gets its own token id', () => {
  assert.notEqual(mintAgentToken(SECRET, TURN).jti, mintAgentToken(SECRET, TURN).jti);
});

test('it lasts the turn plus a few seconds, and never more than the cap', () => {
  const life = (turnMs) => {
    const p = jwt.decode(mintAgentToken(SECRET, { ...TURN, turnMs }).token);
    return p.exp - p.iat;
  };
  assert.equal(life(30000), 35);
  assert.equal(life(10 * 60 * 1000), MAX_AGE_S);
});

test('a token is refused when', async (t) => {
  await t.test('it was signed with another key, such as the AI service\'s secret', () => {
    refused(forge({}, {}, 'stub-secret-the-ai-service-also-holds'));
  });
  await t.test('it claims no algorithm', () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const body = {
      sub: USER, mid: MENTORSHIP, role: 'student', jti: 'a'.repeat(32),
      aud: AUDIENCE, iss: ISSUER, iat: now, exp: now + 30
    };
    refused(`${enc({ alg: 'none', typ: 'JWT' })}.${enc(body)}.`);
  });
  await t.test('it uses another algorithm, even with the right key', () => {
    refused(forge({}, { algorithm: 'HS512' }));
  });
  await t.test('it is for another audience', () => {
    refused(forge({}, { audience: 'something-else' }));
  });
  await t.test('it is from another issuer', () => {
    refused(forge({}, { issuer: 'someone-else' }));
  });
  await t.test('it has expired', () => {
    refused(forge({}, { expiresIn: -1 }));
  });
  await t.test('it was issued too long ago, whatever its expiry says', () => {
    const now = Math.floor(Date.now() / 1000);
    refused(forge({ iat: now - MAX_AGE_S - 10, exp: now + 60 }, { expiresIn: undefined }));
  });
  await t.test('it has no expiry', () => {
    refused(forge({}, { expiresIn: undefined }));
  });
  await t.test('its role is not mentor or student', () => {
    refused(forge({ role: 'admin' }));
  });
  await t.test('it names no mentorship, or not an id', () => {
    refused(forge({ mid: undefined }));
    refused(forge({ mid: { $ne: null } }));
  });
  await t.test('its subject is not an id', () => {
    refused(forge({}, { subject: 'anyone' }));
  });
  await t.test('it has no token id', () => {
    refused(forge({}, { jwtid: undefined }));
  });
  await t.test('it has been tampered with', () => {
    const [h, , s] = forge().split('.');
    const body = Buffer.from(JSON.stringify({ ...jwt.decode(forge()), role: 'mentor' })).toString('base64url');
    refused(`${h}.${body}.${s}`);
  });
});

test('minting refuses claims a token may not carry', () => {
  assert.throws(() => mintAgentToken(SECRET, { ...TURN, role: 'admin' }));
  assert.throws(() => mintAgentToken(SECRET, { ...TURN, mentorshipId: 'x' }));
  assert.throws(() => mintAgentToken(SECRET, { ...TURN, userId: '' }));
});

test('the signing key must be long, and not the AI service\'s', () => {
  assert.match(secretProblem('', 'x'), /not set/);
  assert.match(secretProblem('short', 'x'), /at least/);
  assert.match(secretProblem(SECRET, SECRET), /same as AI_SERVICE_SECRET/);
  assert.equal(secretProblem(SECRET, 'stub-secret'), null);
});

test('only this machine counts as loopback', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(a), true, a);
  for (const a of ['10.0.0.5', '::ffff:10.0.0.5', '192.168.1.2', '', undefined, null]) {
    assert.equal(isLoopback(a), false, String(a));
  }
});

test('the shared secret must match exactly', () => {
  assert.equal(sameSecret('stub-secret', 'stub-secret'), true);
  for (const p of ['stub-secre', 'stub-secret ', 'STUB-SECRET', '', undefined, ['stub-secret']]) {
    assert.equal(sameSecret(p, 'stub-secret'), false, String(p));
  }
  assert.equal(sameSecret('anything', ''), false, 'an unset secret matches nothing');
});
