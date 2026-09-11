/**
 * Assignment Model
 *
 * One piece of work, set by a mentor, due by a date, sent to one or several
 * of their students — the way a Google Classroom assignment is posted to a
 * class rather than to each pupil separately.
 *
 * ## Why this is not a Goal
 *
 * A goal is a checklist of progress over weeks, and either party ticks a
 * milestone off. It has no date field at all and nothing is handed in. An
 * assignment is *"solve five array problems by Friday"*: a deadline, something
 * produced, and a mentor who answers it. Bolting those onto milestones would
 * have made both worse — a milestone is a topic, not a task.
 *
 * ## Why the work and the hand-ins are separate documents
 *
 * The first version embedded one submission inside each assignment, which was
 * right while an assignment belonged to a single mentorship: one assignment,
 * one student, one submission, never read apart. Sending the same work to six
 * students broke that — there are now six hand-ins, each with its own status,
 * and the mentor's most important view is "4 of 6 handed in".
 *
 * So the assignment holds only what is *shared* — the brief and the deadline —
 * and each student's side lives in a `Submission`. Editing the brief once
 * changes it for everybody; one student's hand-in never touches another's.
 *
 * ## Recipients are mentorships, not users
 *
 * Every other feature in the app — goals, sessions, resources — is anchored to
 * the relationship, and access is checked against it. Storing mentorship ids
 * keeps assignments on the same footing: a student sees work because they are
 * in an active mentorship with the mentor who set it, not because their id
 * happens to be on a list.
 */

const mongoose = require('mongoose');

const assignmentSchema = new mongoose.Schema(
  {
    // Whoever set it. The only person who may edit, review or withdraw it.
    mentor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    /**
     * Who it was sent to. Never empty: work set for nobody is not work.
     *
     * The route guarantees each of these is an active mentorship belonging to
     * `mentor`; the schema only guarantees there is at least one.
     */
    mentorships: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Mentorship' }],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'An assignment needs at least one student'
      }
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },

    // What to actually do. Optional, because a clear title is sometimes the
    // whole brief.
    instructions: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: ''
    },

    /**
     * Shared by every recipient. There is no per-student extension: that is a
     * real feature, but a second deadline per student is a second source of
     * truth for "is this late", and it can be added later without disturbing
     * this one.
     */
    dueAt: {
      type: Date,
      required: true
    }
  },
  { timestamps: true }
);

/** "Everything I have set", soonest deadline first. */
assignmentSchema.index({ mentor: 1, dueAt: 1 });

/** "Everything sent into this mentorship" — a multikey index over the array. */
assignmentSchema.index({ mentorships: 1 });

module.exports = mongoose.model('Assignment', assignmentSchema);
