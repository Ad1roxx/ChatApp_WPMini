/**
 * The Copilot: search, and the answer from search.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const mongoose = require('mongoose');
// Import our models
const User = require('../models/User');
// The agent route's two guards of its own: synthetic databases only, and each
// person's share of the model calls.
const { agentDatabaseRefusal } = require('../lib/agentDatabases');
// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const { resolveMentorshipAccess } = require('../lib/reads');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app } = require('../app');
const { AI_SERVICE_URL, AI_SERVICE_SECRET, assistantRefusal } = require('./aiService');

// ============================================
// MENTORSHIP COPILOT - RETRIEVAL
// ============================================

/**
 * POST /api/mentorships/:id/copilot/search
 *
 * Ask a question about ONE mentorship's own material. Both parties may ask;
 * nobody else may, which is the entire point of this route existing.
 *
 * ## Why Express is in the middle
 *
 * The retrieval service trusts the `mentorshipId` and `viewerId` it is given.
 * It has to - it never sees a Firebase token and could not verify one. So the
 * membership check happens HERE, against the database, before the service is
 * called at all:
 *
 *   token -> requireAuth -> resolveMentorshipAccess -> retrieval
 *
 * The service is bound to localhost and requires a shared secret on top of
 * that. Neither of those is the access check; they are what stops anything
 * else on the machine from skipping it.
 *
 * The viewer id is taken from `req.authUser`, never from the body. A caller
 * cannot ask "what would somebody else be allowed to see".
 */
app.post('/api/mentorships/:id/copilot/search', requireAuth, async (req, res) => {
  try {
    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }
    const refusal = assistantRefusal(access.mentorship);
    if (refusal) {
      return res.status(409).json({ error: refusal });
    }

    const query = String(req.body?.query || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'Ask a question' });
    }
    if (query.length > 1000) {
      return res.status(400).json({ error: 'That question is too long' });
    }

    if (!AI_SERVICE_URL || !AI_SERVICE_SECRET) {
      return res.status(503).json({ error: 'The Copilot is not configured on this server' });
    }

    // A slow model must not hold an Express connection open indefinitely.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    let answer;
    try {
      const upstream = await fetch(`${AI_SERVICE_URL}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AI-Secret': AI_SERVICE_SECRET
        },
        body: JSON.stringify({
          mentorshipId: String(req.params.id),
          // From the verified identity, never from the request body.
          viewerId: String(req.authUser._id),
          // Four by default, matching the retrieval service's own default:
          // from S2 these chunks go into a prompt, where every extra one is
          // both more context and more chance of a distractor. Still clamped
          // to 1-10, so a caller cannot ask for the whole index.
          query,
          k: Math.min(Math.max(Number(req.body?.k) || 4, 1), 10)
        }),
        signal: controller.signal
      });

      if (!upstream.ok) {
        console.error('Retrieval service answered', upstream.status);
        return res.status(502).json({ error: 'The Copilot could not answer that' });
      }

      answer = await upstream.json();
    } finally {
      clearTimeout(timer);
    }

    res.json(answer);
  } catch (err) {
    // An aborted fetch and a service that is not running look the same to a
    // caller: the question was not answered, and it is not their fault.
    console.error('Error asking the Copilot:', err.name === 'AbortError' ? 'timed out' : err);
    res.status(502).json({ error: 'The Copilot could not answer that' });
  }
});

/**
 * How long Express waits for an answer, in milliseconds. Set from measured
 * latency (BUILD_NOTES Entry 67): the answering service gives the provider at
 * most 8 s (ai/config.py, ASK_BUDGET_S), about seven times the slowest of the
 * live calls measured before this route existed, with room for one retry;
 * search adds about half a second with the reranker on. Ten seconds covers both. This is NOT
 * search's 15 s stretched: it is shorter, because a turn that has not
 * answered in ten seconds is not going to.
 */
const COPILOT_ASK_TIMEOUT_MS = Number(process.env.COPILOT_ASK_TIMEOUT_MS) || 10000;

/**
 * Asks per person per minute. Every ask is a call on a free-tier quota the
 * whole app shares (15 a minute, 500 a day on Gemini), so one person must not
 * be able to spend it. In memory, per process: a restart forgets it, which at
 * this scale costs nothing, and the provider layer's own count is the limit
 * that actually protects the quota.
 */
const COPILOT_ASKS_PER_MINUTE = Number(process.env.COPILOT_ASKS_PER_MINUTE) || 5;
const askTimes = new Map(); // user id -> timestamps of their recent asks

function allowAsk(userId) {
  const now = Date.now();
  const recent = (askTimes.get(userId) || []).filter((t) => now - t < 60000);
  if (recent.length >= COPILOT_ASKS_PER_MINUTE) {
    askTimes.set(userId, recent);
    return false;
  }
  recent.push(now);
  askTimes.set(userId, recent);
  return true;
}

/**
 * POST /api/mentorships/:id/copilot/ask
 *
 * An answer about ONE mentorship's material, citing what it was built from.
 * Same boundary as /copilot/search, plus one more thing decided here and
 * nowhere else: **who is asking, in this mentorship**.
 *
 *   token -> requireAuth -> resolveMentorshipAccess -> role -> answer
 *
 * The role is the asker's position in the mentorship RECORD - its `mentor` or
 * its `student` - as resolveMentorshipAccess found it. Not the user's account
 * role (an admin who mentors one student is that student's mentor, and nobody
 * else's anything), and never anything in the request body or the question:
 * the body's `question` is the only field read, and anyone who is neither
 * party has already been refused before the service is called.
 *
 * Statuses: 200 for an answer or an abstention (both are the system working);
 * 400 for an empty or over-long question; 429 when this person has asked too
 * often, or the provider's limit is reached; 503 when generation is not
 * configured or unavailable; 502 for anything else that went wrong upstream,
 * a timeout included. Every error body is one plain sentence.
 *
 * A mentorship that is not active is refused with a 409, after the membership
 * check, so an outsider gets the same 403 whatever its status is
 * (assistantRefusal; BUILD_NOTES Entry 75).
 */
app.post('/api/mentorships/:id/copilot/ask', requireAuth, async (req, res) => {
  try {
    // Synthetic databases only, as for the agent. Before anything else is read.
    if (agentDatabaseRefusal(mongoose.connection.name)) {
      return res.status(503).json({ error: 'The Copilot is not configured on this server' });
    }

    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }
    const refusal = assistantRefusal(access.mentorship);
    if (refusal) {
      return res.status(409).json({ error: refusal });
    }
    // From the mentorship record. resolveMentorshipAccess has refused anyone
    // who is neither its mentor nor its student, so "not mentor" is "student".
    const role = access.isMentor ? 'mentor' : 'student';

    const question = String(req.body?.question || '').trim();
    if (!question) {
      return res.status(400).json({ error: 'Ask a question' });
    }
    if (question.length > 1000) {
      return res.status(400).json({ error: 'That question is too long' });
    }

    if (!AI_SERVICE_URL || !AI_SERVICE_SECRET) {
      return res.status(503).json({ error: 'The Copilot is not configured on this server' });
    }

    if (!allowAsk(String(req.authUser._id))) {
      return res
        .status(429)
        .json({ error: "You're asking faster than the Copilot can answer. Wait a minute and try again." });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COPILOT_ASK_TIMEOUT_MS);

    let upstream;
    let body;
    try {
      // The two parties' names, for a prompt that needs to know who a name refers
      // to: from their user records, by the ids on the mentorship, never the body.
      const parties = await User.find({
        _id: { $in: [access.mentorship.mentor, access.mentorship.student] }
      }).select('displayName');
      const nameOf = (id) =>
        String(parties.find((p) => String(p._id) === String(id))?.displayName || '').slice(0, 200);

      upstream = await fetch(`${AI_SERVICE_URL}/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AI-Secret': AI_SERVICE_SECRET
        },
        body: JSON.stringify({
          mentorshipId: String(req.params.id),
          // Both from the verified identity and the mentorship record, never
          // from the request body.
          viewerId: String(req.authUser._id),
          role,
          question,
          mentorName: nameOf(access.mentorship.mentor),
          studentName: nameOf(access.mentorship.student)
        }),
        signal: controller.signal
      });
      body = await upstream.json().catch(() => null);
    } finally {
      clearTimeout(timer);
    }

    if (upstream.ok && body) {
      return res.json(body);
    }
    // The service's own plain sentence for a provider problem it recognised;
    // anything else is one generic sentence, never the upstream's text.
    if ([429, 502, 503].includes(upstream.status) && typeof body?.message === 'string') {
      return res.status(upstream.status).json({ error: body.message, promptVersion: body.promptVersion });
    }
    console.error('Answering service answered', upstream.status);
    return res.status(502).json({ error: 'The Copilot could not answer that' });
  } catch (err) {
    console.error('Error asking the Copilot:', err.name === 'AbortError' ? 'timed out' : err);
    res.status(502).json({ error: 'The Copilot could not answer that' });
  }
});
