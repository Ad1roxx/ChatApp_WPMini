/**
 * Mentorships: request, add, answer, end, opt out.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

// Import our models
const User = require('../models/User');
const Mentorship = require('../models/Mentorship');
// Tells the retrieval service which record changed - after the write, never
// awaited, never able to fail the request. See lib/indexSync.js.
const { syncMentorship } = require('../lib/indexSync');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app, emitToUser } = require('../app');

// ============================================
// MENTORSHIP REST API ENDPOINTS
// ============================================

/** The fields any mentorship response needs about a person. */
const MENTORSHIP_USER_FIELDS = 'displayName photoURL role verification.status';

/**
 * POST /api/mentorships
 *
 * Start a mentorship — from either direction, under deliberately different
 * rules.
 *
 * Body is one of:
 *   { mentorId, topic, message }   a STUDENT asking a mentor  → `pending`
 *   { studentId, topic, message }  a MENTOR adding a student  → `active`
 *
 * ## Why the two directions are not symmetric
 *
 * A student asking costs the mentor time they have not agreed to spend, so it
 * is a request and it waits. A mentor adding a student costs the mentor their
 * own time, which they have just volunteered — there is nobody left to ask.
 * Making them wait for an acceptance would be ceremony, and the mentor is
 * already the one with the standing to decide.
 *
 * The student is not trapped by that: they can ask to opt out (see the PATCH
 * route), and `initiatedBy` records that they never asked for this in the
 * first place, which is exactly the thing an opt-out needs to point at.
 */
app.post('/api/mentorships', requireAuth, async (req, res) => {
  try {
    const { mentorId, studentId, topic, message = '' } = req.body;

    if (!topic?.trim()) {
      return res.status(400).json({ error: 'A topic is required' });
    }

    // Exactly one direction. Both would be ambiguous about who is asking whom,
    // and neither is not a request at all.
    if (Boolean(mentorId) === Boolean(studentId)) {
      return res
        .status(400)
        .json({ error: 'Name either a mentor to ask or a student to add' });
    }

    const addingStudent = Boolean(studentId);
    const otherId = addingStudent ? studentId : mentorId;

    if (String(otherId) === String(req.authUser._id)) {
      return res.status(400).json({ error: 'You cannot mentor yourself' });
    }

    const other = await User.findById(otherId).select('role displayName suspended');
    if (!other) {
      return res.status(404).json({ error: 'That person no longer exists' });
    }

    if (other.suspended) {
      return res.status(400).json({
        error: addingStudent
          ? 'That account is suspended'
          : 'That mentor is not available'
      });
    }

    if (addingStudent) {
      // Only someone who can mentor may take a student on. The role check is
      // on the CALLER here, which is the mirror of the other branch.
      if (!['mentor', 'admin'].includes(req.authUser.role)) {
        return res.status(403).json({ error: 'Only mentors can take on a student' });
      }
      if (['mentor', 'admin'].includes(other.role)) {
        return res
          .status(400)
          .json({ error: 'That person is a mentor — ask them instead of adding them' });
      }
    } else if (!['mentor', 'admin'].includes(other.role)) {
      return res.status(400).json({ error: 'That person is not a mentor' });
    }

    const student = addingStudent ? otherId : req.authUser._id;
    const mentor = addingStudent ? req.authUser._id : otherId;

    // One live relationship per pair. See the note in the model for why this
    // is here rather than a partial unique index.
    const existing = await Mentorship.findOne({
      student,
      mentor,
      status: { $in: ['pending', 'active'] }
    });

    if (existing) {
      return res.status(409).json({
        error:
          existing.status === 'pending'
            ? addingStudent
              ? 'They already have a request waiting with you'
              : 'You already have a request waiting with this mentor'
            : addingStudent
              ? 'You are already mentoring this person'
              : 'You are already being mentored by this person'
      });
    }

    const mentorship = await Mentorship.create({
      student,
      mentor,
      topic: topic.trim(),
      message: String(message).trim(),
      initiatedBy: addingStudent ? 'mentor' : 'student',
      // A mentor adding someone has, by doing so, already answered.
      status: addingStudent ? 'active' : 'pending',
      respondedAt: addingStudent ? new Date() : null
    });

    const populated = await Mentorship.findById(mentorship._id)
      .populate('student', MENTORSHIP_USER_FIELDS)
      .populate('mentor', MENTORSHIP_USER_FIELDS);

    // Tell the other party, on every tab they have open.
    emitToUser(otherId, 'mentorship-updated', populated);

    console.log(
      addingStudent
        ? `🤝 Student added: ${req.authUser.displayName} → ${other.displayName}`
        : `🤝 Mentorship requested: ${req.authUser.displayName} → ${other.displayName}`
    );
    res.json(populated);
  } catch (err) {
    console.error('Error creating mentorship:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/mentorships
 *
 * Everything you are part of, on either side. `?status=` narrows it.
 *
 * Returns both directions in one call rather than making the client ask
 * twice: a person can be a student in one relationship and a mentor in
 * another, and the pages that read this want the whole picture.
 */
app.get('/api/mentorships', requireAuth, async (req, res) => {
  try {
    const { status } = req.query;

    const query = {
      $or: [{ student: req.authUser._id }, { mentor: req.authUser._id }]
    };
    if (status) query.status = status;

    const mentorships = await Mentorship.find(query)
      .sort({ requestedAt: -1 })
      .populate('student', MENTORSHIP_USER_FIELDS)
      .populate('mentor', MENTORSHIP_USER_FIELDS);

    res.json(mentorships);
  } catch (err) {
    console.error('Error listing mentorships:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/mentorships/:id
 *
 * Every move a mentorship can make. Body: `{ action, note }`.
 *
 *   accept / decline    MENTOR, on a pending request.
 *   end                 MENTOR, on an active mentorship — immediate.
 *                       Also the STUDENT, on a *pending* request they made:
 *                       withdrawing something nobody has answered yet is not
 *                       the same act as walking out of a live relationship.
 *   request-optout      STUDENT, on an active mentorship. Needs a reason.
 *   cancel-optout       STUDENT, withdrawing their own opt-out request.
 *   approve-optout      MENTOR — ends it.
 *   decline-optout      MENTOR — it stays active, and the student can see
 *                       they were answered rather than ignored.
 *
 * ## Why the student cannot simply end it
 *
 * Because a mentor can now add a student without being asked, the reverse
 * power has to be a conversation rather than a door: a student who vanishes
 * mid-topic leaves the mentor with goals and sessions attached to nobody, and
 * the reason for leaving is the one piece of information that would let the
 * mentor do better next time. So the student states a reason and the mentor
 * answers it.
 *
 * *This is a real tradeoff and worth naming:* a mentor who ignores an opt-out
 * leaves the student stuck in a mentorship they never asked for, which is the
 * exact situation the opt-out exists to fix. Nothing here expires or escalates
 * yet. The seam for that is `optOut.requestedAt` — a sweep, an admin action,
 * or an auto-approval after N days all hang off it — and it is deliberately
 * left rather than guessed at.
 */
app.patch('/api/mentorships/:id', requireAuth, async (req, res) => {
  try {
    const { action, note = '' } = req.body;

    const ACTIONS = [
      'accept',
      'decline',
      'end',
      'request-optout',
      'cancel-optout',
      'approve-optout',
      'decline-optout'
    ];

    if (!ACTIONS.includes(action)) {
      return res.status(400).json({ error: 'Unknown action' });
    }

    const mentorship = await Mentorship.findById(req.params.id);
    if (!mentorship) {
      return res.status(404).json({ error: 'Mentorship not found' });
    }

    const me = String(req.authUser._id);
    const isMentor = String(mentorship.mentor) === me;
    const isStudent = String(mentorship.student) === me;

    if (!isMentor && !isStudent) {
      return res.status(403).json({ error: 'This is not your mentorship' });
    }

    const trimmedNote = String(note).trim();
    const statusBefore = mentorship.status;

    if (action === 'accept' || action === 'decline') {
      if (!isMentor) {
        return res.status(403).json({ error: 'Only the mentor can answer a request' });
      }
      if (mentorship.status !== 'pending') {
        return res.status(400).json({ error: 'That request has already been answered' });
      }

      mentorship.status = action === 'accept' ? 'active' : 'declined';
      mentorship.respondedAt = new Date();
      mentorship.responseNote = trimmedNote;
    } else if (action === 'end') {
      // A student withdrawing their own unanswered request.
      if (isStudent && mentorship.status === 'pending') {
        mentorship.status = 'ended';
        mentorship.endedAt = new Date();
        mentorship.endedBy = req.authUser._id;
      } else if (isMentor && mentorship.status === 'active') {
        mentorship.status = 'ended';
        mentorship.endedAt = new Date();
        mentorship.endedBy = req.authUser._id;
      } else if (isStudent) {
        return res.status(403).json({
          error: 'Ask your mentor to end this — use the opt-out request'
        });
      } else {
        return res.status(400).json({ error: 'Only an active mentorship can be ended' });
      }
    } else if (action === 'request-optout') {
      if (!isStudent) {
        return res.status(403).json({ error: 'Only the student can ask to opt out' });
      }
      if (mentorship.status !== 'active') {
        return res.status(400).json({ error: 'This mentorship is not active' });
      }
      if (mentorship.optOut.status === 'pending') {
        return res.status(400).json({ error: 'You have already asked to opt out' });
      }
      // The reason is the point of the request, not a nicety: without it the
      // mentor has nothing to answer and nothing to learn from.
      if (!trimmedNote) {
        return res.status(400).json({ error: 'A reason is required' });
      }

      mentorship.optOut.status = 'pending';
      mentorship.optOut.reason = trimmedNote;
      mentorship.optOut.requestedAt = new Date();
      mentorship.optOut.responseNote = '';
      mentorship.optOut.respondedAt = null;
    } else if (action === 'cancel-optout') {
      if (!isStudent) {
        return res.status(403).json({ error: 'Only the student can withdraw this' });
      }
      if (mentorship.optOut.status !== 'pending') {
        return res.status(400).json({ error: 'There is no opt-out request to withdraw' });
      }

      mentorship.optOut.status = 'none';
      mentorship.optOut.reason = '';
      mentorship.optOut.requestedAt = null;
    } else {
      // approve-optout / decline-optout
      if (!isMentor) {
        return res.status(403).json({ error: 'Only the mentor can answer an opt-out' });
      }
      if (mentorship.optOut.status !== 'pending') {
        return res.status(400).json({ error: 'There is no opt-out request to answer' });
      }

      mentorship.optOut.respondedAt = new Date();
      mentorship.optOut.responseNote = trimmedNote;

      if (action === 'approve-optout') {
        mentorship.optOut.status = 'none';
        mentorship.status = 'ended';
        mentorship.endedAt = new Date();
        // The student asked; the mentor only agreed. Recording the mentor as
        // the one who ended it would misread the history later.
        mentorship.endedBy = mentorship.student;
      } else {
        mentorship.optOut.status = 'declined';
      }
    }

    await mentorship.save();

    // Whether a mentorship's material is searchable depends on its status, so
    // every status change - accepted, declined, ended - is one the index hears
    // about. Opt-out requests and answers that leave it active change nothing.
    if (mentorship.status !== statusBefore) syncMentorship(mentorship._id);

    const populated = await Mentorship.findById(mentorship._id)
      .populate('student', MENTORSHIP_USER_FIELDS)
      .populate('mentor', MENTORSHIP_USER_FIELDS);

    // Both sides care about every one of these transitions.
    emitToUser(mentorship.student, 'mentorship-updated', populated);
    emitToUser(mentorship.mentor, 'mentorship-updated', populated);

    console.log(`🤝 Mentorship ${action}: ${mentorship._id}`);
    res.json(populated);
  } catch (err) {
    console.error('Error updating mentorship:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
