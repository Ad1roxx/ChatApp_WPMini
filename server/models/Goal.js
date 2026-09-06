/**
 * Goal Model
 *
 * What a mentorship is actually *for*, broken into milestones you can tick
 * off. This is the first thing in the app that produces progress — a number
 * that means something — and every later feature that reports on how someone
 * is doing reads from here.
 *
 * A goal belongs to a **mentorship**, not to a user. That is the whole reason
 * the relationship had to exist first: "Aditya's goals" is ambiguous the
 * moment he has two mentors, whereas "the goals of this mentorship" never is.
 *
 * ## Milestones are embedded, not their own collection
 *
 * They are only ever read as part of their goal, they are few, and they have
 * no independent life — a milestone without its goal is meaningless. Mongoose
 * gives each subdocument an `_id`, so they can still be addressed individually
 * by the toggle route.
 *
 * *Tradeoff:* you cannot query across all milestones ("everything due this
 * week") without unwinding. Nothing needs that yet; if scheduling later does,
 * this becomes a separate collection.
 */

const mongoose = require('mongoose');

const milestoneSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },

  done: {
    type: Boolean,
    default: false
  },

  // Who ticked it and when. Either party may, so recording which one did is
  // the only way to tell "the student says it's done" from "the mentor
  // confirmed it".
  doneAt: { type: Date, default: null },
  doneBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

const goalSchema = new mongoose.Schema({
  mentorship: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mentorship',
    required: true,
    index: true
  },

  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },

  description: {
    type: String,
    trim: true,
    maxlength: 1000,
    default: ''
  },

  milestones: [milestoneSchema],

  /**
   * `active` and `completed` are DERIVED — the server flips between them
   * whenever a milestone is toggled, so the status can never disagree with
   * the milestones underneath it. `archived` is the only one a person sets,
   * because "we are not doing this any more" is not something the data can
   * work out for itself.
   */
  status: {
    type: String,
    enum: ['active', 'completed', 'archived'],
    default: 'active',
    index: true
  },

  completedAt: { type: Date, default: null },

  // The mentor, in practice — only they can create goals.
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

// The only query the app makes: this mentorship's goals, newest first.
goalSchema.index({ mentorship: 1, createdAt: -1 });

/**
 * Recompute `status` from the milestones.
 *
 * Called after every milestone change. Kept as a method rather than a `pre`
 * hook so it is obvious at the call site that the status is being derived —
 * a hook doing this invisibly is how a status ends up disagreeing with the
 * data it summarises.
 *
 * An archived goal is left alone: archiving is a human decision and ticking
 * a milestone should not silently un-archive it.
 */
goalSchema.methods.refreshStatus = function refreshStatus() {
  if (this.status === 'archived') return;

  const total = this.milestones.length;
  const done = this.milestones.filter((m) => m.done).length;

  // A goal with no milestones is never "complete" — there is nothing to have
  // completed, and 0 of 0 reading as 100% would be a lie.
  const complete = total > 0 && done === total;

  this.status = complete ? 'completed' : 'active';
  this.completedAt = complete ? this.completedAt || new Date() : null;
};

const Goal = mongoose.model('Goal', goalSchema);

module.exports = Goal;
