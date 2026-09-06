/**
 * Session Model
 *
 * A scheduled meeting between the two people in a mentorship. Goals say what
 * someone is working towards; sessions are when the work actually gets
 * talked about. Together they are the two halves of "this is a mentorship,
 * not a chat thread".
 *
 * ## On the name
 *
 * "Session" usually means a login session, and normally that collision would
 * be a reason to pick another word. It is free here: authentication in this
 * app is stateless — a Firebase ID token verified per request — so there is
 * no server-side login session for this to be confused with. "Session" is
 * what mentors and students actually call these, so it wins.
 *
 * ## Either party may propose
 *
 * This is deliberately the opposite of goals. A goal is a directive, so only
 * the mentor sets one. A session is a request for time, and a student asking
 * "can we meet Thursday?" is the normal case — probably the most common one.
 * So anyone in the mentorship can propose, and the OTHER one confirms.
 *
 * ## Rescheduling un-confirms
 *
 * Moving a session sends it back to `proposed` and makes the person who moved
 * it the proposer, so the other side has to agree to the new time. A confirmed
 * session whose time silently changed would be worse than useless: both people
 * would believe they had agreed on something, and only one of them would be
 * right.
 */

const mongoose = require('mongoose');

/**
 * Transitions, written out rather than checked ad hoc at each call site.
 *
 * `completed` and `cancelled` are terminal. There is no un-cancel: the record
 * that a meeting was called off is worth keeping, and proposing a new time is
 * both easy and more honest than editing history.
 */
const ALLOWED_TRANSITIONS = {
  proposed: ['confirmed', 'completed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
};

const sessionSchema = new mongoose.Schema(
  {
    mentorship: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Mentorship',
      required: true
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },

    // What you want to cover. Optional, because "weekly check-in" often needs
    // no more explanation than that.
    agenda: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: ''
    },

    scheduledFor: {
      type: Date,
      required: true
    },

    // Minutes rather than an end time. The two are equivalent, but a duration
    // survives a reschedule without having to be recalculated, and "30 min"
    // is how people pick a slot in the first place.
    durationMinutes: {
      type: Number,
      default: 30,
      min: 5,
      max: 480
    },

    status: {
      type: String,
      enum: ['proposed', 'confirmed', 'completed', 'cancelled'],
      default: 'proposed'
    },

    // Whoever asked for this time. Reset on a reschedule, because after a move
    // the person who moved it is the one waiting on an answer.
    proposedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    confirmedAt: { type: Date, default: null },

    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, trim: true, maxlength: 500, default: '' },

    completedAt: { type: Date, default: null },

    // What actually happened. Written after the fact by either party, and
    // editable afterwards — notes taken in a hurry usually need a second pass.
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: ''
    }
  },
  { timestamps: true }
);

/**
 * The one index this collection needs.
 *
 * It serves both reads: the per-mentorship list (equality on the prefix), and
 * "my upcoming sessions" (an `$in` over my mentorship ids plus a range on the
 * date), which can use the same prefix. A separate index on `scheduledFor`
 * alone would only pay off for a cross-user sweep, and nothing does that.
 */
sessionSchema.index({ mentorship: 1, scheduledFor: -1 });

/** Whether `next` is reachable from where this session is now. */
sessionSchema.methods.canBecome = function canBecome(next) {
  return ALLOWED_TRANSITIONS[this.status].includes(next);
};

/** True once the start time has passed. Used to gate "mark as done". */
sessionSchema.methods.hasStarted = function hasStarted() {
  return this.scheduledFor.getTime() <= Date.now();
};

module.exports = mongoose.model('Session', sessionSchema);
