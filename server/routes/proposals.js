/**
 * The agent's write proposals (S5): made, claimed, closed.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

// Import our models
const User = require('../models/User');
// The agent route's two guards of its own: synthetic databases only, and each
// person's share of the model calls.
const { AGENT_NOT_CONFIGURED } = require('../lib/agentDatabases');
// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const { resolveMentorshipAccess } = require('../lib/reads');
const agentProposal = require('../lib/agentProposal');
const agentWrites = require('../lib/agentWrites');
const AgentProposal = require('../models/AgentProposal');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app } = require('../app');
const { AI_SERVICE_URL, AI_SERVICE_SECRET, AGENT_PROPOSAL_SECRET, assistantRefusal } = require('./aiService');
const { agentUnavailable } = require('./agent');

// ============================================
// AGENT PROPOSALS (S5)
// ============================================

const PROPOSAL_EXPIRED = 'That proposal has expired. Ask again if you still want it.';
const PROPOSAL_USED = 'That proposal has already been used.';
/** What a turn spent, kept on a proposal or a refusal. Counts and names only. */
const TURN_FIGURES = ['modelCalls', 'toolCalls', 'inputTokens', 'summaryCalls', 'summaryInputTokens', 'promptVersion', 'provider', 'model', 'steps'];
const AGENT_THREAD_TIMEOUT_MS = 3000;

/** One short call to the AI service about a paused turn. Null if it did not answer properly. */
async function callPausedTurn(path, body) {
  try {
    const upstream = await fetch(`${AI_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AI-Secret': AI_SERVICE_SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AGENT_THREAD_TIMEOUT_MS)
    });
    return upstream.ok ? await upstream.json().catch(() => null) : null;
  } catch {
    return null;
  }
}

/** The names the dialog shows, from the mentorship record. */
async function partyNames(mentorship) {
  const people = await User.find({ _id: { $in: [mentorship.mentor, mentorship.student] } }).select('displayName');
  const nameOf = (id) => String(people.find((p) => String(p._id) === String(id))?.displayName || '').slice(0, 200);
  return { mentor: nameOf(mentorship.mentor), student: nameOf(mentorship.student) };
}

/**
 * A model's call to a write tool, made into something a person can approve, or refused.
 *
 *   the turn it came from -> a tool we list, for this role -> agentWrites.prepare
 *     -> signed -> recorded as pending
 *
 * The tool and its arguments come from the AI service, so they are checked as if they
 * came from anywhere. Who is asking, where, and in what role come from the route's own
 * checks. The browser is sent the token and the turn's figures, and nothing else.
 * A refusal says why with one of a fixed set of reasons, and ends the paused turn.
 */
async function proposalFromTurn({ body, threadId, user, mentorship, role, question, parties }) {
  const figures = Object.fromEntries(TURN_FIGURES.filter((k) => k in body).map((k) => [k, body[k]]));
  const decline = async (reason) => {
    await callPausedTurn('/agent/resume', { threadId, decision: 'dismissed' });
    return { ...figures, status: 'declined', reason };
  };

  if (!AGENT_PROPOSAL_SECRET || body.threadId !== threadId) return decline('unavailable');

  const built = await agentWrites.prepare(body.tool, { input: body.args, user, mentorship, role, parties });
  if (built.refuse) return decline(built.refuse);

  const { token, exp } = agentProposal.signProposal(AGENT_PROPOSAL_SECRET, {
    pid: threadId,
    tool: body.tool,
    args: built.args,
    heading: built.heading,
    fields: built.fields,
    asked: question,
    userId: user._id,
    mentorshipId: mentorship._id,
    role
  });
  await AgentProposal.create({
    _id: threadId,
    user: user._id,
    mentorship: mentorship._id,
    tool: body.tool,
    // Past the token's own expiry: this record must outlast anything that could use it.
    expiresAt: new Date((exp + 60) * 1000)
  });
  return { ...figures, status: 'proposal', proposal: token };
}

/**
 * POST /api/copilot/proposals/claim
 *
 * The person clicked Approve. This uses the proposal up BEFORE the browser runs
 * anything, so a double click, a retry or a replay cannot run it twice.
 *
 *   token -> requireAuth -> agent may run here -> proposal verified -> it is this
 *   person's -> resolveMentorshipAccess -> same role -> still active -> a tool we
 *   list, for that role -> it still says what they approved -> its turn is still
 *   paused -> atomically pending to claimed
 *
 * It writes nothing but the claim. The write is the real route, called next by the
 * browser with the person's own token, so it passes every check a manual one does.
 *
 * Statuses: 200 claimed; 410 expired, not a proposal we signed, or its paused turn
 * was lost to a restart (the same answer for all three); 403 not this person's, or
 * not their role; 409 already used (`reason: used`), the mentorship is no longer
 * active (`reason: ended`), or what it describes has changed since it was shown
 * (`reason: changed`); 503 not configured here, or the AI service did not say
 * the turn is waiting. A refusal before the last step leaves it unused.
 */
app.post('/api/copilot/proposals/claim', requireAuth, async (req, res) => {
  try {
    if (agentUnavailable() || !AGENT_PROPOSAL_SECRET) {
      return res.status(503).json({ error: AGENT_NOT_CONFIGURED });
    }

    let claims;
    try {
      claims = agentProposal.verifyProposal(AGENT_PROPOSAL_SECRET, req.body?.proposal);
    } catch {
      return res.status(410).json({ error: PROPOSAL_EXPIRED });
    }

    const me = String(req.authUser._id);
    if (claims.sub !== me) {
      return res.status(403).json({ error: 'That proposal is not yours' });
    }

    const access = await resolveMentorshipAccess(claims.mid, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }
    const refusal = assistantRefusal(access.mentorship);
    if (refusal) {
      return res.status(409).json({ error: refusal, reason: 'ended' });
    }
    const role = access.isMentor ? 'mentor' : 'student';
    if (role !== claims.role) {
      return res.status(403).json({ error: 'Your place in this mentorship has changed' });
    }

    const tool = agentWrites.writeTool(claims.tool);
    if (!tool || !tool.roles.includes(role)) {
      return res.status(403).json({ error: 'That is not something the assistant can do for you' });
    }

    // What the person approved must still be true: the deadline they saw, the session still open.
    const still = await agentWrites.recheck(claims, {
      user: req.authUser,
      mentorship: access.mentorship,
      role,
      parties: await partyNames(access.mentorship)
    });
    if (still.refuse) {
      return res.status(409).json({ error: 'That has changed since it was proposed', reason: 'changed' });
    }

    // Asked before the claim, so a service that is down costs nobody their proposal.
    const turn = await callPausedTurn('/agent/paused', { threadId: claims.jti });
    if (!turn) {
      return res.status(503).json({ error: AGENT_NOT_CONFIGURED });
    }
    if (turn.paused !== true) {
      return res.status(410).json({ error: PROPOSAL_EXPIRED });
    }

    const claimed = await AgentProposal.findOneAndUpdate(
      {
        _id: claims.jti,
        user: req.authUser._id,
        mentorship: claims.mid,
        tool: claims.tool,
        status: 'pending',
        expiresAt: { $gt: new Date() }
      },
      { $set: { status: 'claimed', claimedAt: new Date() } }
    );
    if (!claimed) {
      return res.status(409).json({ error: PROPOSAL_USED, reason: 'used' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error claiming a proposal:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/copilot/proposals/close
 *
 * The person dismissed it, or the browser has finished running it. Closing changes
 * no record but this one and grants nothing. In particular `decision` is not a claim
 * that anything happened, and nothing is kept about how the write went.
 *
 * `dismissed` closes one still pending. `approved` closes one already claimed.
 * An expired proposal may be closed: what ran a moment before it expired still has
 * to be finished with. Every other check on the token stands.
 *
 * This is also what ends the paused turn in the AI service. No model is called for
 * that, and what it is told is only which of the two decisions this was.
 */
app.post('/api/copilot/proposals/close', requireAuth, async (req, res) => {
  try {
    if (!AGENT_PROPOSAL_SECRET) {
      return res.status(503).json({ error: AGENT_NOT_CONFIGURED });
    }
    const from = { dismissed: 'pending', approved: 'claimed' };
    const decision = req.body?.decision;
    if (typeof decision !== 'string' || !Object.hasOwn(from, decision)) {
      return res.status(400).json({ error: 'Say whether this was approved or dismissed' });
    }

    let claims;
    try {
      claims = agentProposal.verifyProposal(AGENT_PROPOSAL_SECRET, req.body?.proposal, { allowExpired: true });
    } catch {
      return res.status(410).json({ error: PROPOSAL_EXPIRED });
    }
    if (claims.sub !== String(req.authUser._id)) {
      return res.status(403).json({ error: 'That proposal is not yours' });
    }

    const closed = await AgentProposal.findOneAndUpdate(
      { _id: claims.jti, user: req.authUser._id, status: from[decision] },
      { $set: { status: 'closed', closedAt: new Date() } }
    );
    if (!closed) {
      return res.status(409).json({ error: PROPOSAL_USED, reason: 'used' });
    }

    // Ends the paused turn. If this fails the turn expires by itself, and nothing depends on it.
    await callPausedTurn('/agent/resume', { threadId: claims.jti, decision });

    res.json({ ok: true });
  } catch (err) {
    console.error('Error closing a proposal:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { proposalFromTurn };
