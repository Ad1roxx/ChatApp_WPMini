/**
 * Assignment Model
 *
 * One specific piece of work, set by the mentor, due by a date, handed in by
 * the student and reviewed.
 *
 * ## Why this is not a Goal
 *
 * A goal is a checklist of progress over weeks — *"Be ready for backend
 * interviews"* with four topics under it — and either party may tick a
 * milestone off. Nothing about it has a deadline, and nothing is handed in.
 *
 * An assignment is *"submit your resume by Friday"*. It has a due date, the
 * student produces something, and the mentor answers it. Bolting those onto
 * milestones would have made both muddier: a milestone is a topic, not a
 * task, and most goals have no sensible deadline at all.
 *
 * ## The submission is embedded
 *
 * A mentorship has exactly one student, so an assignment has exactly one
 * submission. It is never read without its assignment, and there is no query
 * that wants one on its own — the same reasoning as milestones inside a goal.
 *
 * Resubmission overwrites rather than appending. A history of drafts would be
 * a different feature, and pretending to keep one while only ever showing the
 * latest would be worse than not keeping it.
 *
 * ## Lateness is derived, never stored
 *
 * `isLate()` compares the submission time against the due date, and an
 * unsubmitted assignment is late once the date has passed. A stored `late`
 * flag would be a second source of truth that drifts the moment a mentor
 * extends a deadline — the same reason goal status is recomputed rather than
 * saved.
 */

const mongoose = require('mongoose');

/**
 * Where an assignment can go next.
 *
 * `changes-requested` returns to `submitted` rather than to `assigned`,
 * because the student has already handed something in — sending it back to
 * "not started" would lose that and misrepresent what happened.
 */
const ALLOWED_TRANSITIONS = {
  assigned: ['submitted'],
  submitted: ['accepted', 'changes-requested'],
  'changes-requested': ['submitted'],
  accepted: []
};

const assignmentSchema = new mongoose.Schema(
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

    // What to actually do. Optional in the schema, because a clear title is
    // sometimes the whole brief.
    instructions: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: ''
    },

    /**
     * Required. A task without a date is a goal, and this model exists
     * precisely to be the thing that has one.
     */
    dueAt: {
      type: Date,
      required: true
    },

    status: {
      type: String,
      enum: ['assigned', 'submitted', 'changes-requested', 'accepted'],
      default: 'assigned'
    },

    // The mentor. Stored rather than derived so a future "everything I set"
    // query does not have to walk every mentorship first.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    /**
     * What the student handed in.
     *
     * Text or a link or both — the same allow-listed http(s) rule the shared
     * resources use, for the same reason: the client renders this into an
     * `href`, and a `javascript:` URL there is stored XSS aimed at the mentor.
     */
    submission: {
      text: { type: String, trim: true, maxlength: 5000, default: '' },
      url: {
        type: String,
        trim: true,
        maxlength: 2000,
        default: '',
        validate: {
          validator: (v) => v === '' || /^https?:\/\/\S+$/i.test(v),
          message: 'Only http and https links are allowed'
        }
      },
      submittedAt: { type: Date, default: null }
    },

    // The mentor's answer. `note` carries the "what to change" on a
    // changes-requested, and the "nice work" on an accepted.
    review: {
      note: { type: String, trim: true, maxlength: 2000, default: '' },
      reviewedAt: { type: Date, default: null }
    }
  },
  { timestamps: true }
);

/** The list query: this mentorship's assignments, soonest deadline first. */
assignmentSchema.index({ mentorship: 1, dueAt: 1 });

/** Whether `next` is reachable from where this assignment is now. */
assignmentSchema.methods.canBecome = function canBecome(next) {
  return ALLOWED_TRANSITIONS[this.status].includes(next);
};

/**
 * Late means one of two different things, so both are handled here rather
 * than in whichever route happened to need it first:
 *
 * - handed in after the deadline
 * - not handed in, and the deadline has passed
 *
 * An accepted assignment that was submitted on time is never late, even if
 * the mentor reviewed it a week afterwards — the student's part was done.
 */
assignmentSchema.methods.isLate = function isLate() {
  const due = this.dueAt.getTime();

  if (this.submission.submittedAt) {
    return this.submission.submittedAt.getTime() > due;
  }

  return Date.now() > due;
};

module.exports = mongoose.model('Assignment', assignmentSchema);
