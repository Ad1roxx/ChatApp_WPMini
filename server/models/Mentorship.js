/**
 * Mentorship Model
 *
 * The relationship the app was missing. Until now "mentor" was an adjective
 * on a user; there was no way to say *this person mentors that person*. Goals,
 * sessions, progress and every dashboard need an owner, and this is it.
 *
 * ## Lifecycle
 *
 *   pending ──accept──▶ active ──end──▶ ended
 *      │
 *      └──decline──▶ declined
 *
 * Transitions are one-way. A declined or ended relationship is never revived;
 * the pair simply start a new one, which keeps the old record intact as
 * history rather than overwriting what happened.
 *
 * ## Who is who
 *
 * `student` is whoever *asked*, `mentor` is whoever was asked — regardless of
 * either party's `role`. A mentor who wants mentoring in a different subject
 * is a perfectly ordinary case, and forcing `role === 'student'` on the asking
 * side would forbid it for no reason. The only requirement is that the person
 * being asked can actually mentor.
 */

const mongoose = require('mongoose');

const mentorshipSchema = new mongoose.Schema({
  // Whoever asked
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Whoever was asked
  mentor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  status: {
    type: String,
    enum: ['pending', 'active', 'declined', 'ended'],
    default: 'pending',
    index: true
  },

  /**
   * What the student wants help with. Required, and deliberately so — a
   * request with no stated purpose gives the mentor nothing to decide on,
   * and this is the field goals will later be grouped under.
   */
  topic: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120
  },

  // The student's opening note
  message: {
    type: String,
    trim: true,
    maxlength: 1000,
    default: ''
  },

  requestedAt: {
    type: Date,
    default: Date.now,
    index: true          // queues are newest-first
  },

  // Set when the mentor accepts or declines
  respondedAt: { type: Date, default: null },
  responseNote: { type: String, trim: true, maxlength: 500, default: '' },

  // Set when either party ends an active mentorship
  endedAt: { type: Date, default: null },
  endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

/**
 * The two queries the app actually makes: "requests waiting on me" and "my
 * mentorships", both filtered by status.
 */
mentorshipSchema.index({ mentor: 1, status: 1, requestedAt: -1 });
mentorshipSchema.index({ student: 1, status: 1, requestedAt: -1 });

/**
 * NOTE: the "one live relationship per pair" rule is enforced in the route,
 * not by a unique index.
 *
 * The natural expression would be a partial unique index on
 * `{ student, mentor }` filtered to `status: { $in: ['pending', 'active'] }` —
 * but `partialFilterExpression` does not support `$in`, only equality and
 * range operators. Two separate partial indexes (one per status) would not
 * compose into the rule either, since they would allow one pending *and* one
 * active for the same pair.
 *
 * So the check lives in `POST /api/mentorships`. The tradeoff is honest:
 * under genuinely concurrent duplicate requests two rows could slip through.
 * At this scale that is a nuisance, not a defect, and the alternative is a
 * transaction for something a person clicks once.
 */

const Mentorship = mongoose.model('Mentorship', mentorshipSchema);

module.exports = Mentorship;
