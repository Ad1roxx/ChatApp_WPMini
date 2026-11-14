/**
 * Where the AI service is and the secrets shared with it, checked at start-up.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

// The agent's per-turn capability token, and the checks for requests only the
// AI service on this machine may make. See the internal tool endpoint.
const agentToken = require('../lib/agentToken');
const agentProposal = require('../lib/agentProposal');

// ============================================
// MENTORSHIP COPILOT - RETRIEVAL
// ============================================

/**
 * Where the retrieval service lives, and the secret it expects.
 *
 * Unset by default: with no URL configured the route answers 503 rather than
 * failing obscurely, so a clone without the Python service still runs and
 * still passes its tests.
 */
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || '';
const AI_SERVICE_SECRET = process.env.AI_SERVICE_SECRET || '';

/**
 * The key agent capability tokens are signed with (lib/agentToken.js).
 *
 * Unset: the agent's tool endpoint answers 503 and nothing else changes. Set
 * but unusable (too short, or the same as AI_SERVICE_SECRET, which the AI
 * service holds and could therefore mint with): refuse to start, rather than
 * run with a key that does not do its job.
 */
const AGENT_TOKEN_SECRET = process.env.AGENT_TOKEN_SECRET || '';
if (AGENT_TOKEN_SECRET) {
  const problem = agentToken.secretProblem(AGENT_TOKEN_SECRET, AI_SERVICE_SECRET);
  if (problem) {
    console.error(`\n${problem}. See server/.env.example.\n`);
    process.exit(1);
  }
}

/**
 * The key the agent's write proposals are signed with (lib/agentProposal.js).
 * Only Express holds it. Unset, nothing can be proposed or claimed and every read
 * still works; set but unusable, the server refuses to start.
 */
const AGENT_PROPOSAL_SECRET = process.env.AGENT_PROPOSAL_SECRET || '';
if (AGENT_PROPOSAL_SECRET) {
  const problem = agentProposal.secretProblem(AGENT_PROPOSAL_SECRET, AI_SERVICE_SECRET, AGENT_TOKEN_SECRET);
  if (problem) {
    console.error(`\n${problem}. See server/.env.example.\n`);
    process.exit(1);
  }
}

/**
 * Whether the assistant works in this mentorship, and if not, what to say.
 *
 * Only active mentorships are indexed, so anywhere else it could only answer "I
 * couldn't find that" about material the user can still open. Product decision,
 * 2 Nov: refuse plainly instead (BUILD_NOTES Entry 75).
 *
 * 409 rather than 403 or 503: 403 already means "not your mentorship" and 503 a
 * broken service. The request is fine; this mentorship's state does not allow it.
 * Always checked after resolveMentorshipAccess, so an outsider gets the same
 * 403 whatever the status is, and learns nothing from it.
 */
function assistantRefusal(mentorship) {
  if (mentorship.status === 'active') return null;
  return mentorship.status === 'ended'
    ? "The assistant isn't available for ended mentorships."
    : 'The assistant is only available in active mentorships.';
}

module.exports = {
  AI_SERVICE_URL,
  AI_SERVICE_SECRET,
  AGENT_TOKEN_SECRET,
  AGENT_PROPOSAL_SECRET,
  assistantRefusal
};
