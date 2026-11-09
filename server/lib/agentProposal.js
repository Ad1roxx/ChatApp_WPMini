/**
 * The agent's signed write proposals (AGENT_PLAN §2.4, S5 Step 0 protocol).
 *
 * The agent never writes. It proposes; a person approves; the BROWSER then calls
 * the app's real route with that person's own sign-in. This file is the object
 * that carries a proposal from Express to the browser and back.
 *
 * ## One token is the whole proposal
 *
 * The browser reads this token for both the dialog and the request, and the
 * claim route verifies this same token before the browser runs anything. There
 * is no second copy that could differ from what was shown.
 *
 * ## What a signature does and does not do
 *
 * It stops a proposal being forged or altered: by the model, by text in a
 * hand-in, by the AI service, or by anything between Express and the browser.
 * It does not stop the person themselves, who can always call their own routes
 * by hand. That is fine: such a call is exactly what these are, and passes the
 * same checks.
 *
 * A signature cannot be single-use on its own. The AgentProposal record is what
 * makes it so (see the claim route in index.js).
 *
 * ## Its own key
 *
 * `AGENT_PROPOSAL_SECRET` is held only by Express, and must differ from both
 * `AI_SERVICE_SECRET` (the AI service holds that one, and a key it holds is a
 * key it could sign with) and `AGENT_TOKEN_SECRET`. The audience differs as
 * well, so a capability token can never pass for a proposal, nor the reverse.
 *
 * Pure functions, the secret passed in, so the tests can sign with the same key
 * the spawned server verifies with.
 */
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const AUDIENCE = 'agent-proposal';
const ISSUER = 'mentorconnect';
const ALGORITHM = 'HS256';
/** How long a person has to approve one: five minutes (the human, 2026-11-10). */
const PROPOSAL_TTL_S = 300;
const MIN_SECRET_LENGTH = 32;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const PROPOSAL_ID = /^[0-9a-f]{32}$/;
const ROLES = new Set(['mentor', 'student']);

/** Why this secret cannot be used, or null if it can. */
function secretProblem(secret, aiServiceSecret, agentTokenSecret) {
  if (!secret) return 'AGENT_PROPOSAL_SECRET is not set';
  if (secret.length < MIN_SECRET_LENGTH) {
    return `AGENT_PROPOSAL_SECRET must be at least ${MIN_SECRET_LENGTH} characters`;
  }
  if (aiServiceSecret && secret === aiServiceSecret) {
    return 'AGENT_PROPOSAL_SECRET must not be the same as AI_SERVICE_SECRET';
  }
  if (agentTokenSecret && secret === agentTokenSecret) {
    return 'AGENT_PROPOSAL_SECRET must not be the same as AGENT_TOKEN_SECRET';
  }
  return null;
}

function newProposalId() {
  return crypto.randomBytes(16).toString('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The claims a proposal must carry, checked the same way on signing and on verifying. */
function checkClaims({ sub, mid, role, jti, tool, args, heading, fields, asked }) {
  if (!OBJECT_ID.test(String(sub))) throw new Error('bad subject');
  if (!OBJECT_ID.test(String(mid))) throw new Error('bad mentorship');
  if (!ROLES.has(role)) throw new Error('bad role');
  if (typeof jti !== 'string' || !PROPOSAL_ID.test(jti)) throw new Error('bad proposal id');
  if (typeof tool !== 'string' || !tool) throw new Error('bad tool');
  if (!isPlainObject(args)) throw new Error('bad args');
  if (typeof heading !== 'string' || !heading) throw new Error('bad heading');
  if (typeof asked !== 'string') throw new Error('bad question');
  if (!Array.isArray(fields) || fields.length === 0) throw new Error('bad fields');
  for (const f of fields) {
    if (!isPlainObject(f) || typeof f.label !== 'string' || typeof f.value !== 'string' || typeof f.arg !== 'string') {
      throw new Error('bad field');
    }
  }
}

/**
 * Sign a proposal. `role` must come from the mentorship record, `args` and
 * `fields` from lib/agentWrites.js, and `asked` is the person's own question.
 * Returns `{ token, exp }`, exp in seconds since the epoch.
 */
function signProposal(secret, { pid, tool, args, heading, fields, asked, userId, mentorshipId, role, ttlSeconds = PROPOSAL_TTL_S }) {
  const claims = { sub: String(userId), mid: String(mentorshipId), role, jti: pid, tool, args, heading, fields, asked };
  checkClaims(claims);
  const expiresIn = Math.min(ttlSeconds, PROPOSAL_TTL_S);
  const token = jwt.sign(
    { mid: claims.mid, role, tool, args, heading, fields, asked },
    secret,
    { algorithm: ALGORITHM, subject: claims.sub, jwtid: pid, audience: AUDIENCE, issuer: ISSUER, expiresIn }
  );
  return { token, exp: jwt.decode(token).exp };
}

/**
 * The proposal's claims, or a thrown error. Callers answer every failure the same
 * way: which check failed is for the log, never for whoever presented it.
 *
 * `allowExpired` is for closing one only: what was approved a moment before it ran
 * out still has to be closable, and closing runs nothing.
 */
function verifyProposal(secret, token, { allowExpired = false } = {}) {
  const payload = jwt.verify(String(token ?? ''), secret, {
    algorithms: [ALGORITHM],
    audience: AUDIENCE,
    issuer: ISSUER,
    ignoreExpiration: allowExpired,
    ...(allowExpired ? {} : { maxAge: `${PROPOSAL_TTL_S}s` })
  });
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') throw new Error('no expiry');
  if (payload.exp - payload.iat > PROPOSAL_TTL_S) throw new Error('lives too long');
  const claims = {
    sub: payload.sub,
    mid: payload.mid,
    role: payload.role,
    jti: payload.jti,
    tool: payload.tool,
    args: payload.args,
    heading: payload.heading,
    fields: payload.fields,
    asked: payload.asked
  };
  checkClaims(claims);
  return { ...claims, exp: payload.exp };
}

module.exports = {
  signProposal,
  verifyProposal,
  secretProblem,
  newProposalId,
  AUDIENCE,
  ISSUER,
  PROPOSAL_TTL_S,
  MIN_SECRET_LENGTH
};
