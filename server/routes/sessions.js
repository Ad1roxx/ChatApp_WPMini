/**
 * Scheduled sessions.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const Session = require('../models/Session');
// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const { resolveMentorshipAccess, SESSION_POPULATE, sessionsFor, upcomingSessionsFor } = require('../lib/reads');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app, emitToUser } = require('../app');

// ============================================
// SESSIONS - SCHEDULED MEETINGS
// ============================================

// SESSION_POPULATE lives in lib/reads.js, shared with the agent's tools.

/**
 * Re-read a session with its references filled in, for the response and the
 * socket payload. The two have to be the same shape, or the tab that made a
 * change would render it differently from the tab that only watched.
 */
function loadSession(id) {
  return Session.findById(id).populate(SESSION_POPULATE);
}

/** Announce a session to both people in its mentorship. */
function broadcastSession(mentorship, session) {
  emitToUser(mentorship.student, 'session-updated', session);
  emitToUser(mentorship.mentor, 'session-updated', session);
}

/**
 * GET /api/sessions/upcoming
 *
 * The next few sessions across ALL of your mentorships, soonest first. This
 * is the one session query not scoped to a single relationship, and it exists
 * because "when am I next meeting anyone?" is the question people actually
 * have — answering it should not mean opening three pages and comparing.
 *
 * Cancelled and completed sessions are excluded: this is a list of
 * commitments, not history.
 */
app.get('/api/sessions/upcoming', requireAuth, async (req, res) => {
  try {
    res.json((await upcomingSessionsFor(req.authUser)).data);
  } catch (err) {
    console.error('Error listing upcoming sessions:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/mentorships/:id/sessions
 *
 * Every session in one mentorship, newest first. Cancelled ones are included:
 * a gap in the record would make a relationship where meetings kept falling
 * through look like one where nothing was ever arranged.
 *
 * The client splits this into upcoming and past. The server does not, because
 * "upcoming" depends on the clock at read time, and one sorted list is easier
 * to reason about than two that have to agree with each other.
 */
app.get('/api/mentorships/:id/sessions', requireAuth, async (req, res) => {
  try {
    const read = await sessionsFor(req.params.id, req.authUser);
    if (read.error) {
      return res.status(read.status).json({ error: read.error });
    }
    res.json(read.data);
  } catch (err) {
    console.error('Error listing sessions:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/mentorships/:id/sessions
 *
 * Propose a time. EITHER PARTY may, which is the deliberate opposite of the
 * goal routes: a goal is a directive and belongs to the mentor, but a session
 * is a request for time, and the student asking for it is the normal case.
 *
 * A proposal starts as `proposed` and the OTHER person confirms it, so nobody
 * can put a meeting in someone else's week unilaterally.
 *
 * Body: title, agenda, scheduledFor (ISO), durationMinutes
 */
app.post('/api/mentorships/:id/sessions', requireAuth, async (req, res) => {
  try {
    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    if (access.mentorship.status !== 'active') {
      return res.status(400).json({ error: 'That mentorship is not active' });
    }

    const { title, agenda = '', scheduledFor, durationMinutes } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'A title is required' });
    }

    const when = new Date(scheduledFor);
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ error: 'A valid date and time is required' });
    }

    // Refusing the past is a typo guard more than a rule: the wrong year is
    // the easiest thing to get wrong in a date field. A meeting that already
    // happened gets recorded by completing it, not by scheduling it.
    if (when.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Pick a time in the future' });
    }

    const duration = durationMinutes === undefined ? 30 : Number(durationMinutes);
    if (!Number.isInteger(duration) || duration < 5 || duration > 480) {
      return res
        .status(400)
        .json({ error: 'Duration must be between 5 and 480 minutes' });
    }

    const session = await Session.create({
      mentorship: access.mentorship._id,
      title: String(title).trim(),
      agenda: String(agenda).trim(),
      scheduledFor: when,
      durationMinutes: duration,
      proposedBy: req.authUser._id
    });

    const populated = await loadSession(session._id);
    broadcastSession(access.mentorship, populated);

    res.status(201).json(populated);
  } catch (err) {
    console.error('Error creating session:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/sessions/:sessionId
 *
 * One route for every move a session can make. They all share the same
 * permission check and the same broadcast, and four routes would have
 * duplicated both four times.
 *
 * Body: { action, reason, notes, scheduledFor, durationMinutes }
 *
 *   confirm     the other person agrees to the time. NOT the proposer:
 *               confirming your own proposal would make the handshake
 *               decorative.
 *   reschedule  move it. Sends the session back to `proposed` with the mover
 *               as proposer, so the other side has to agree again.
 *   cancel      either party, with an optional reason. Terminal.
 *   complete    either party, but only once the start time has passed.
 *
 * `notes` may be sent with `complete`, or on its own for a session that is
 * already completed. Notes written straight after a meeting usually need a
 * second pass, and there is no reason to make that a different endpoint.
 */
app.patch('/api/sessions/:sessionId', requireAuth, async (req, res) => {
  try {
    const session = await Session.findById(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const access = await resolveMentorshipAccess(session.mentorship, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    if (access.mentorship.status !== 'active') {
      return res.status(400).json({
        error: 'Sessions can only be changed on an active mentorship'
      });
    }

    const { action, reason = '', notes, scheduledFor, durationMinutes } = req.body;
    const me = String(req.authUser._id);

    if (action === 'confirm') {
      if (!session.canBecome('confirmed')) {
        return res
          .status(400)
          .json({ error: 'A ' + session.status + ' session cannot be confirmed' });
      }
      if (String(session.proposedBy) === me) {
        return res
          .status(403)
          .json({ error: 'You proposed this time — the other person confirms it' });
      }

      session.status = 'confirmed';
      session.confirmedAt = new Date();
    } else if (action === 'reschedule') {
      if (!['proposed', 'confirmed'].includes(session.status)) {
        return res
          .status(400)
          .json({ error: 'A ' + session.status + ' session cannot be moved' });
      }

      const when = new Date(scheduledFor);
      if (Number.isNaN(when.getTime())) {
        return res.status(400).json({ error: 'A valid date and time is required' });
      }
      if (when.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'Pick a time in the future' });
      }

      if (durationMinutes !== undefined) {
        const duration = Number(durationMinutes);
        if (!Number.isInteger(duration) || duration < 5 || duration > 480) {
          return res
            .status(400)
            .json({ error: 'Duration must be between 5 and 480 minutes' });
        }
        session.durationMinutes = duration;
      }

      session.scheduledFor = when;
      session.status = 'proposed';
      session.proposedBy = req.authUser._id;
      session.confirmedAt = null;
    } else if (action === 'cancel') {
      if (!session.canBecome('cancelled')) {
        return res
          .status(400)
          .json({ error: 'A ' + session.status + ' session cannot be cancelled' });
      }

      session.status = 'cancelled';
      session.cancelledBy = req.authUser._id;
      session.cancelledAt = new Date();
      session.cancelReason = String(reason).trim().slice(0, 500);
    } else if (action === 'complete') {
      if (!session.canBecome('completed')) {
        return res
          .status(400)
          .json({ error: 'A ' + session.status + ' session cannot be completed' });
      }
      // Marking a future meeting as done is always a mistake, and allowing it
      // would let the history claim things that have not happened.
      if (!session.hasStarted()) {
        return res.status(400).json({ error: 'That session has not started yet' });
      }

      session.status = 'completed';
      session.completedAt = new Date();
    } else if (action !== undefined) {
      return res.status(400).json({ error: 'Unknown action' });
    }

    if (notes !== undefined) {
      // Notes record what happened, so they only make sense once something
      // has. Before that, the agenda is the field for intent.
      if (session.status !== 'completed') {
        return res
          .status(400)
          .json({ error: 'Notes can only be added to a completed session' });
      }
      session.notes = String(notes).trim().slice(0, 2000);
    }

    await session.save();

    const populated = await loadSession(session._id);
    broadcastSession(access.mentorship, populated);

    res.json(populated);
  } catch (err) {
    console.error('Error updating session:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
