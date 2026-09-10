/**
 * Feedback Model
 *
 * A student's rating of one completed session, and the note that goes with
 * it. This is the missing end of the session lifecycle: a session is
 * proposed, confirmed, met — and until now, nothing came of it.
 *
 * ## Per session, not per mentorship
 *
 * A single rating at the end of a mentorship would arrive months after the
 * thing it describes, when the details are gone and only the last impression
 * is left. A session that just finished is the one moment when the person
 * actually remembers how it went, and rating each one gives the mentor a
 * trend rather than a verdict.
 *
 * ## Only the student rates
 *
 * The mentor does not rate the student back, and that asymmetry is
 * deliberate. A rating that follows a mentor around is a record of a service
 * they offered; a score attached to a *student* is a record of a person being
 * judged while they are trying to learn, which is a different and worse
 * thing. A mentor who wants to record how someone is doing has session notes
 * and goal progress, both of which describe work rather than worth.
 *
 * ## It cannot be anonymous, so it does not pretend to be
 *
 * A mentorship has exactly two people in it. Whatever the UI said, the mentor
 * would know who left the rating — so `from` is stored plainly and the
 * student is told, at the point of submitting, that their name is attached.
 * A promise of anonymity that the arithmetic breaks is worse than no promise.
 */

const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema(
  {
    session: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      required: true
    },

    // Denormalised from the session so "every rating in this mentorship" and
    // "this mentor's average" do not need a join through Session to answer.
    mentorship: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Mentorship',
      required: true
    },

    from: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    // Who it is *about* — the mentor. Stored rather than derived so the
    // profile aggregate is a single indexed query.
    to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    /**
     * Five points, integers only. A wider scale invites false precision:
     * nobody can tell a 73 from a 76, and the average of a hundred of them
     * looks authoritative while meaning nothing.
     */
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: {
        validator: Number.isInteger,
        message: 'Rating must be a whole number from 1 to 5'
      }
    },

    // What the number leaves out. Optional, because forcing a sentence out of
    // someone who only wanted to press four stars produces filler.
    comment: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: ''
    }
  },
  { timestamps: true }
);

/**
 * One rating per person per session, enforced rather than checked in the
 * route: a double submit from a slow connection would otherwise quietly
 * double-count in the mentor's average.
 *
 * Editing is allowed — the route upserts — but that replaces the rating
 * rather than adding a second one.
 */
feedbackSchema.index({ session: 1, from: 1 }, { unique: true });

/** The profile aggregate: every rating a mentor has received, newest first. */
feedbackSchema.index({ to: 1, createdAt: -1 });

module.exports = mongoose.model('Feedback', feedbackSchema);
