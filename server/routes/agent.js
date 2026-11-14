/**
 * The Copilot agent (S4): one turn.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const mongoose = require('mongoose');
// Import our models
const User = require('../models/User');
// The agent's per-turn capability token, and the checks for requests only the
// AI service on this machine may make. See the internal tool endpoint.
const agentToken = require('../lib/agentToken');
// The agent route's two guards of its own: synthetic databases only, and each
// person's share of the model calls.
const { agentDatabaseRefusal, AGENT_NOT_CONFIGURED } = require('../lib/agentDatabases');
const { ModelCallBudget } = require('../lib/agentBudget');
// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const { resolveMentorshipAccess } = require('../lib/reads');
const agentProposal = require('../lib/agentProposal');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app } = require('../app');
const { AI_SERVICE_URL, AI_SERVICE_SECRET, AGENT_TOKEN_SECRET, assistantRefusal } = require('./aiService');

// proposals.js needs this file too, so it is loaded when first used, not here.
const proposalFromTurn = (...args) => require('./proposals').proposalFromTurn(...args);

// ============================================
// MENTORSHIP COPILOT - AGENT (S4)
// ============================================

/**
 * Whether the panel uses the agent rather than S2's answer. On unless the setting
 * says otherwise (S4's evaluation, BUILD_NOTES Entry 108). Any value that is not
 * on, 1 or true, a blank included, turns it off: the agent route then answers "not
 * configured" and the panel asks /copilot/ask, S2's path. Being on does not widen
 * where it runs: agentUnavailable still refuses any database not on the list.
 */
const COPILOT_AGENT = ['1', 'true', 'on'].includes(String(process.env.COPILOT_AGENT ?? 'on').trim().toLowerCase());

/**
 * How long Express waits for one agent turn, in milliseconds. The capability
 * token expires with it. Measured (BUILD_NOTES Entry 101): 12 turns on the demo,
 * median 2.5 s, slowest 10.4 s (a whole-file summary, 10 model calls). The AI
 * service gives a turn 30 s (AGENT_BUDGET_S, about three times that); this is
 * that plus room for the token, the tools' round trips and the response.
 */
const COPILOT_AGENT_TIMEOUT_MS = Number(process.env.COPILOT_AGENT_TIMEOUT_MS) || 35000;

/**
 * The most model calls one turn can make: the turn's own cap (4, ai/config.py
 * AGENT_MAX_MODEL_CALLS) plus one file summary's (6 sections and 1 to combine
 * them). What a turn reserves from the budget before it starts.
 */
const AGENT_TURN_MAX_CALLS = 11;

/**
 * Each person's share, in model calls (lib/agentBudget.js). 60 a day is an
 * eighth of the 480, and is the share that protects the allowance. 15 a minute
 * is Gemini's own limit for the whole app: the AI service's count enforces that
 * across everyone, and this only stops one person bursting past it. It was 12,
 * and measured (BUILD_NOTES Entry 101): with a turn reserving 11, a second turn
 * after a typical 2-call one needed 13, so each person could ask about once a
 * minute. At 15, about three typical turns a minute.
 */
const agentBudget = new ModelCallBudget({
  perMinute: Number(process.env.AGENT_CALLS_PER_MINUTE) || 15,
  perDay: Number(process.env.AGENT_CALLS_PER_DAY) || 60
});

const AGENT_LIMIT = {
  minute: "You're asking faster than the assistant can answer. Wait a minute and try again.",
  day: "You've reached today's limit for the assistant. It will be available again tomorrow."
};

/** Why the agent cannot run on this server, or null. Checked before anything else. */
function agentUnavailable() {
  if (!COPILOT_AGENT) return AGENT_NOT_CONFIGURED;
  if (!AI_SERVICE_URL || !AI_SERVICE_SECRET || !AGENT_TOKEN_SECRET) return AGENT_NOT_CONFIGURED;
  return agentDatabaseRefusal(mongoose.connection.name);
}

/**
 * GET /api/copilot/mode
 *
 * Which of the two the panel should use: `agent` only when the agent can run
 * here, otherwise `ask`. Says nothing about why.
 */
app.get('/api/copilot/mode', requireAuth, (req, res) => {
  res.json({ mode: agentUnavailable() ? 'ask' : 'agent' });
});

/**
 * POST /api/mentorships/:id/copilot/agent
 *
 * One agent turn about ONE mentorship: the agent may look things up with its
 * read tools, as the asker, and answers citing what it looked at.
 *
 *   token -> requireAuth -> agent may run here (setting, synthetic database)
 *     -> resolveMentorshipAccess -> active -> role -> question
 *     -> this person's share of the model calls -> capability token -> turn
 *
 * The role is the asker's position in the mentorship record, as for /ask. The
 * capability token names this user, this mentorship and that role, for this
 * turn only; it is sent to the AI service and to nothing else, and never
 * logged. Every tool call comes back through /internal/agent/tools with it,
 * where all of this is checked again.
 *
 * Statuses: 200 for every turn that ran (answered, abstained, stopped by a cap,
 * or refused partway; the body says which); 400 for an empty or over-long
 * question; 409 for a mentorship that is not active; 429 when this person's
 * share is used, or the provider's limit is reached; 503 when the agent is not
 * configured here, the database included; 502 for anything else upstream, a
 * timeout included. Every error body is one plain sentence.
 */
app.post('/api/mentorships/:id/copilot/agent', requireAuth, async (req, res) => {
  try {
    const unavailable = agentUnavailable();
    if (unavailable) {
      return res.status(503).json({ error: unavailable });
    }

    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }
    const refusal = assistantRefusal(access.mentorship);
    if (refusal) {
      return res.status(409).json({ error: refusal });
    }
    const role = access.isMentor ? 'mentor' : 'student';

    const question = String(req.body?.question || '').trim();
    if (!question) {
      return res.status(400).json({ error: 'Ask a question' });
    }
    if (question.length > 1000) {
      return res.status(400).json({ error: 'That question is too long' });
    }

    const reserved = agentBudget.reserve(String(req.authUser._id), AGENT_TURN_MAX_CALLS);
    if (reserved.limit) {
      return res.status(429).json({ error: AGENT_LIMIT[reserved.limit] });
    }

    const parties = await User.find({
      _id: { $in: [access.mentorship.mentor, access.mentorship.student] }
    }).select('displayName');
    const nameOf = (id) =>
      String(parties.find((p) => String(p._id) === String(id))?.displayName || '').slice(0, 200);

    // Also the proposal's id, if this turn makes one.
    const threadId = agentProposal.newProposalId();

    const { token } = agentToken.mintAgentToken(AGENT_TOKEN_SECRET, {
      userId: String(req.authUser._id),
      mentorshipId: String(access.mentorship._id),
      role,
      turnMs: COPILOT_AGENT_TIMEOUT_MS
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COPILOT_AGENT_TIMEOUT_MS);
    let upstream;
    let body;
    try {
      upstream = await fetch(`${AI_SERVICE_URL}/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AI-Secret': AI_SERVICE_SECRET },
        body: JSON.stringify({
          mentorshipId: String(access.mentorship._id),
          viewerId: String(req.authUser._id),
          role,
          question,
          token,
          threadId,
          mentorName: nameOf(access.mentorship.mentor),
          studentName: nameOf(access.mentorship.student)
        }),
        signal: controller.signal
      });
      body = await upstream.json().catch(() => null);
    } finally {
      clearTimeout(timer);
    }

    // What the turn spent, if it says; otherwise it keeps its reservation.
    if (body && Number.isFinite(body.modelCalls)) {
      agentBudget.settle(reserved.entry, body.modelCalls + (Number(body.summaryCalls) || 0));
    }
    // One line per turn: as what, how it ended, what it spent. Never the
    // question, the answer, the token or anyone's id.
    console.log(
      `agent turn as ${role}: ${upstream.status} ${body?.status || '-'}, ` +
        `${body?.modelCalls ?? '?'} model calls, ${body?.toolCalls ?? '?'} tool calls`
    );

    // A proposal never goes back as the service sent it: Express checks it, builds what a
    // person will be shown, signs it, and that token is all the browser receives.
    if (upstream.ok && body?.status === 'proposal') {
      return res.json(
        await proposalFromTurn({
          body,
          threadId,
          user: req.authUser,
          mentorship: access.mentorship,
          role,
          question,
          parties: { mentor: nameOf(access.mentorship.mentor), student: nameOf(access.mentorship.student) }
        })
      );
    }

    if (upstream.ok && body) {
      return res.json(body);
    }
    if ([429, 502, 503].includes(upstream.status) && typeof body?.message === 'string') {
      return res.status(upstream.status).json({ error: body.message });
    }
    return res.status(502).json({ error: 'The Copilot could not answer that' });
  } catch (err) {
    console.error('Error running an agent turn:', err.name === 'AbortError' ? 'timed out' : err.message);
    res.status(502).json({ error: 'The Copilot could not answer that' });
  }
});

module.exports = { agentUnavailable };
