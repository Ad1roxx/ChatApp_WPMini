/**
 * The agent's per-turn capability token (AGENT_PLAN S4, Step 0 decisions).
 *
 * When a user asks the agent something, Express mints one of these and hands
 * it to the AI service with the turn. The service presents it back on every
 * tool call it makes to `/internal/agent/tools/:name`, and Express answers as
 * the user named in it, in the mentorship named in it, and nobody else.
 *
 * ## Why a token, and not just the shared secret
 *
 * `X-AI-Secret` proves the caller is the AI service. On its own it would let
 * that service name any user and any mentorship in a request body, so anything
 * that learned the secret could read as anyone. The token is what binds a tool
 * call to ONE asker, ONE mentorship and ONE role, for ONE turn:
 *
 * - **Signed with its own key**, `AGENT_TOKEN_SECRET`, which only Express
 *   holds. The AI service never sees it, so it can carry a token but never
 *   mint one. A leaked `AI_SERVICE_SECRET` mints nothing.
 * - **HS256 only.** The algorithm is pinned on verify, so a token claiming
 *   `none` or any other algorithm is refused rather than trusted.
 * - **Short-lived.** It expires with the turn, plus a few seconds; verify also
 *   refuses anything issued more than MAX_AGE_S ago, whatever its `exp` says.
 * - **Read-only by construction.** The tool endpoint it opens has read tools
 *   only. Writes stay in the browser, with the user's own sign-in (§2.4).
 *
 * Every claim is re-checked against the database on every tool call (see the
 * endpoint in index.js); the token says who the call is FOR, not that they are
 * still allowed.
 *
 * Pure functions, the secret passed in, so the tests can mint with the same
 * key the spawned server verifies with.
 */
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const AUDIENCE = 'agent-tools';
const ISSUER = 'mentorconnect';
const ALGORITHM = 'HS256';
const EXPIRY_SLACK_S = 5;
/** No token outlives this, whatever the turn budget is set to. */
const MAX_AGE_S = 120;
const MIN_SECRET_LENGTH = 32;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const ROLES = new Set(['mentor', 'student']);

/**
 * Why this secret cannot be used, or null if it can.
 *
 * It must be long enough not to be guessed, and must not be the AI service's
 * secret: that one is in ai/.env, and a key the service holds is a key the
 * service can mint with.
 */
function secretProblem(secret, aiServiceSecret) {
  if (!secret) return 'AGENT_TOKEN_SECRET is not set';
  if (secret.length < MIN_SECRET_LENGTH) {
    return `AGENT_TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`;
  }
  if (aiServiceSecret && secret === aiServiceSecret) {
    return 'AGENT_TOKEN_SECRET must not be the same as AI_SERVICE_SECRET';
  }
  return null;
}

/** The claims a token may carry, checked the same way on mint and on verify. */
function checkClaims({ sub, mid, role, jti }) {
  if (!OBJECT_ID.test(String(sub))) throw new Error('bad subject');
  if (!OBJECT_ID.test(String(mid))) throw new Error('bad mentorship');
  if (!ROLES.has(role)) throw new Error('bad role');
  if (typeof jti !== 'string' || jti.length < 16) throw new Error('bad token id');
}

/**
 * A token for one turn: this user, this mentorship, this role.
 *
 * `role` must come from the mentorship record (resolveMentorshipAccess), never
 * from the request.
 */
function mintAgentToken(secret, { userId, mentorshipId, role, turnMs }) {
  const claims = {
    sub: String(userId),
    mid: String(mentorshipId),
    role,
    jti: crypto.randomBytes(16).toString('hex')
  };
  checkClaims(claims);
  const expiresIn = Math.min(Math.ceil(turnMs / 1000) + EXPIRY_SLACK_S, MAX_AGE_S);
  const token = jwt.sign(
    { mid: claims.mid, role: claims.role },
    secret,
    {
      algorithm: ALGORITHM,
      subject: claims.sub,
      jwtid: claims.jti,
      audience: AUDIENCE,
      issuer: ISSUER,
      expiresIn
    }
  );
  return { token, jti: claims.jti };
}

/**
 * The token's claims, `{ sub, mid, role, jti, exp }`, or a thrown error.
 *
 * Callers answer every failure the same way (401, one sentence): which check
 * failed is for the log, not the caller.
 */
function verifyAgentToken(secret, token) {
  const payload = jwt.verify(token, secret, {
    algorithms: [ALGORITHM],
    audience: AUDIENCE,
    issuer: ISSUER,
    maxAge: `${MAX_AGE_S}s`
  });
  if (typeof payload.exp !== 'number') throw new Error('no expiry');
  const claims = { sub: payload.sub, mid: payload.mid, role: payload.role, jti: payload.jti };
  checkClaims(claims);
  return { ...claims, exp: payload.exp };
}

module.exports = {
  mintAgentToken,
  verifyAgentToken,
  secretProblem,
  AUDIENCE,
  ISSUER,
  MAX_AGE_S,
  MIN_SECRET_LENGTH
};
