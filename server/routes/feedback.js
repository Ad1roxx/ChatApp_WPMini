/**
 * Rating a session.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const mongoose = require('mongoose');
const Session = require('../models/Session');
const Feedback = require('../models/Feedback');
// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const { resolveMentorshipAccess } = require('../lib/reads');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app, emitToUser } = require('../app');

// ============================================
// FEEDBACK - RATING A SESSION
// ============================================

/**
 * PUT /api/sessions/:sessionId/feedback
 *
 * The student rates a session that has happened. PUT rather than POST because
 * it is idempotent by design: submitting again replaces your rating instead
 * of adding a second one, which is what the unique index on (session, from)
 * enforces underneath.
 *
 * Body: { rating: 1-5, comment }
 *
 * Only the student, and only once the session is `completed`. Rating a
 * meeting that has not happened would be rating an intention.
 */
app.put('/api/sessions/:sessionId/feedback', requireAuth, async (req, res) => {
  try {
    const session = await Session.findById(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const access = await resolveMentorshipAccess(session.mentorship, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    // The mentor is the one being rated, so they are not the one rating.
    if (access.isMentor) {
      return res.status(403).json({ error: 'Only the student rates a session' });
    }

    if (session.status !== 'completed') {
      return res.status(400).json({ error: 'That session has not happened yet' });
    }

    const { rating, comment = '' } = req.body;
    const value = Number(rating);

    if (!Number.isInteger(value) || value < 1 || value > 5) {
      return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5' });
    }

    const saved = await Feedback.findOneAndUpdate(
      { session: session._id, from: req.authUser._id },
      {
        $set: {
          mentorship: session.mentorship,
          to: access.mentorship.mentor,
          rating: value,
          comment: String(comment).trim()
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).populate('from', 'displayName photoURL');

    // The mentor should find out without refreshing — this is the one part of
    // a session that arrives after everyone has stopped looking at it.
    emitToUser(access.mentorship.mentor, 'feedback-updated', saved);
    emitToUser(access.mentorship.student, 'feedback-updated', saved);

    res.json(saved);
  } catch (err) {
    console.error('Error saving feedback:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/mentorships/:id/feedback
 *
 * Every rating in one mentorship, keyed by session so the client can hang
 * each one on the session it belongs to. Both parties see the same thing —
 * the mentor because it is about them, the student because it is theirs.
 */
app.get('/api/mentorships/:id/feedback', requireAuth, async (req, res) => {
  try {
    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    const rows = await Feedback.find({ mentorship: req.params.id })
      .populate('from', 'displayName photoURL');

    res.json(rows);
  } catch (err) {
    console.error('Error listing feedback:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/users/:id/feedback
 *
 * A mentor's rating, for their profile: how many, the average, and the most
 * recent comments.
 *
 * The average is rounded to one decimal on the way out. Two decimals would
 * imply a precision that five-point ratings from a handful of sessions do not
 * have, and a bare integer would hide the difference between 4.1 and 4.9.
 *
 * `count` is returned alongside it and the client shows both, because "5.0"
 * from one session and "4.6" from forty are not the same claim.
 */
app.get('/api/users/:id/feedback', requireAuth, async (req, res) => {
  try {
    const [summary] = await Feedback.aggregate([
      { $match: { to: new mongoose.Types.ObjectId(String(req.params.id)) } },
      { $group: { _id: null, count: { $sum: 1 }, average: { $avg: '$rating' } } }
    ]);

    // Comments only — a list of bare numbers tells a reader nothing, and the
    // average above already carries the scores.
    const recent = await Feedback.find({
      to: req.params.id,
      comment: { $ne: '' }
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('from', 'displayName photoURL');

    res.json({
      count: summary?.count || 0,
      average: summary ? Math.round(summary.average * 10) / 10 : null,
      recent
    });
  } catch (err) {
    console.error('Error building feedback summary:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
