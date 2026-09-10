/**
 * Resource Model
 *
 * A link one party shares with the other, kept with the mentorship instead of
 * scrolling away in the chat. "That article you sent me" is the single most
 * common thing to lose in a conversation, and a transcript is a bad place to
 * store anything you intend to come back to.
 *
 * ## Links, not uploads
 *
 * Deliberately. File uploads mean storage, size limits, virus scanning, and a
 * bill — none of which this project has — and almost everything a mentor
 * actually shares already lives at a URL. A link is the whole feature at a
 * fraction of the cost, and it degrades honestly: a dead link is visibly
 * dead, whereas a missing upload looks like a bug.
 *
 * ## Either party may add
 *
 * Like sessions and unlike goals. A student finding something useful and
 * pinning it for their mentor is the same act as the reverse, and there is
 * nothing to approve.
 */

const mongoose = require('mongoose');

const resourceSchema = new mongoose.Schema(
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

    /**
     * Validated to http(s) here as well as in the route.
     *
     * The route's check is what returns a useful 400; this one is what stops
     * anything else in the codebase — a seed script, a migration, a future
     * endpoint — from writing a `javascript:` URL into a field the client
     * renders straight into an `href`. That is a stored XSS with a very short
     * path to the victim, so it is worth refusing in two places.
     */
    url: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
      validate: {
        validator: (v) => /^https?:\/\/\S+$/i.test(v),
        message: 'Only http and https links are allowed'
      }
    },

    // Why it is worth opening. Optional — a good title often says enough.
    note: {
      type: String,
      trim: true,
      maxlength: 500,
      default: ''
    },

    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    }
  },
  { timestamps: true }
);

/** The only query: this mentorship's resources, newest first. */
resourceSchema.index({ mentorship: 1, createdAt: -1 });

module.exports = mongoose.model('Resource', resourceSchema);
