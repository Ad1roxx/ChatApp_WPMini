/**
 * The agent's tool endpoint, for the AI service only.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

// Import our models
const User = require('../models/User');
// The agent's per-turn capability token, and the checks for requests only the
// AI service on this machine may make. See the internal tool endpoint.
const agentToken = require('../lib/agentToken');
const { isLoopback, sameSecret } = require('../lib/internalRequest');
// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const { resolveMentorshipAccess } = require('../lib/reads');
const agentTools = require('../lib/agentTools');
const { app } = require('../app');
const { AI_SERVICE_SECRET, AGENT_TOKEN_SECRET, assistantRefusal } = require('./aiService');

// ============================================
// AGENT TOOLS (internal)
// ============================================

/**
 * Tool calls one turn may make, counted here as well as in the AI service, so
 * a service that loses count still cannot read without limit on one token.
 */
const AGENT_TOOL_CALLS_PER_TURN = Number(process.env.AGENT_TOOL_CALLS_PER_TURN) || 3;
const agentTurnCalls = new Map(); // token id -> { count, expiresAt }

function countAgentCall(jti, expiresAtMs) {
  const now = Date.now();
  for (const [id, turn] of agentTurnCalls) {
    if (turn.expiresAt <= now) agentTurnCalls.delete(id);
  }
  const turn = agentTurnCalls.get(jti) || { count: 0, expiresAt: expiresAtMs };
  if (turn.count >= AGENT_TOOL_CALLS_PER_TURN) return false;
  turn.count += 1;
  agentTurnCalls.set(jti, turn);
  return true;
}

/**
 * POST /internal/agent/tools/:name
 *
 * The AI service runs one of the agent's tools AS THE ASKER. Not a route for
 * browsers, and not one any user can reach with their own sign-in.
 *
 *   loopback -> no Origin -> X-AI-Secret -> capability token
 *     -> user reloaded -> resolveMentorshipAccess -> same role -> still active
 *     -> per-turn call cap -> the tool
 *
 * The secret says the caller is the AI service; the token says who the call
 * is for. Neither alone is enough, and the token's claims are checked against
 * the database again on every call: a user suspended mid-turn, or a mentorship
 * ended mid-turn, is refused at the next tool call, not at the next turn.
 *
 * Identity comes only from the token. The body carries the tool's arguments
 * and nothing about who is asking or where.
 *
 * Every refusal is one plain sentence the service can show the user. Refusals
 * of the turn itself (the checks above, and the cap) carry `endsTurn: true`: the
 * service stops and shows the sentence. A refused lookup (no such tool, a role
 * the tool does not list, bad arguments, or the tool's own refusal) does not:
 * the model is told, and may answer from what it has.
 */
app.post('/internal/agent/tools/:name', async (req, res) => {
  try {
    if (!isLoopback(req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'Not available from here', endsTurn: true });
    }
    // A browser always sends Origin on a cross-site POST; the AI service never
    // does. So a page open on this machine cannot use this route either.
    if (req.headers.origin) {
      return res.status(403).json({ error: 'Not available from here', endsTurn: true });
    }
    if (!sameSecret(req.headers['x-ai-secret'], AI_SERVICE_SECRET)) {
      return res.status(401).json({ error: 'Not available from here', endsTurn: true });
    }
    if (!AGENT_TOKEN_SECRET) {
      return res.status(503).json({ error: 'The agent is not configured on this server', endsTurn: true });
    }

    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    let claims;
    try {
      claims = agentToken.verifyAgentToken(AGENT_TOKEN_SECRET, bearer ? bearer[1] : '');
    } catch {
      return res.status(401).json({ error: 'This question has run out of time. Ask it again.', endsTurn: true });
    }

    const user = await User.findById(claims.sub);
    if (!user) {
      return res.status(403).json({ error: 'This account no longer exists', endsTurn: true });
    }
    if (user.suspended) {
      return res.status(403).json({ error: 'Your account has been suspended', endsTurn: true });
    }

    const access = await resolveMentorshipAccess(claims.mid, user);
    if (access.error) {
      return res.status(access.status).json({ error: access.error, endsTurn: true });
    }
    const role = access.isMentor ? 'mentor' : 'student';
    if (role !== claims.role) {
      return res.status(403).json({ error: 'Your role in this mentorship has changed. Ask again.', endsTurn: true });
    }
    const refusal = assistantRefusal(access.mentorship);
    if (refusal) {
      return res.status(409).json({ error: refusal, endsTurn: true });
    }

    const name = req.params.name;
    const tool = agentTools.toolNamed(name);
    if (!tool) {
      return res.status(404).json({ error: 'No such tool' });
    }
    // The second layer of the role filter (§4.2): the AI service never offers
    // this tool to this role, and if it is asked for anyway, it is refused here.
    if (!tool.roles.includes(role)) {
      return res.status(403).json({ error: "That isn't something I can look up for you" });
    }
    const args = req.body?.args;
    const problem = agentTools.argsProblem(tool, args);
    if (problem) {
      return res.status(400).json({ error: "I couldn't make sense of that lookup" });
    }

    if (!countAgentCall(claims.jti, claims.exp * 1000)) {
      return res
        .status(429)
        .json({
          error: `I can look things up at most ${AGENT_TOOL_CALLS_PER_TURN} times for one question.`,
          endsTurn: true
        });
    }

    const started = Date.now();
    const result = await tool.run({ user, mentorship: access.mentorship, role, args });
    // One line per call: which tool, as which role, how it went. Never the
    // arguments, the results or anyone's id.
    console.log(
      `agent tool ${name} as ${role}: ${result.error ? result.status : 200}, ` +
        `${result.records ? result.records.length : 0} records, ${Date.now() - started} ms`
    );
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.json(result);
  } catch (err) {
    console.error('Error running an agent tool:', err.message);
    res.status(500).json({ error: 'That lookup failed' });
  }
});
