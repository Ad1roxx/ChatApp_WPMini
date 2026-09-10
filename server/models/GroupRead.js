/**
 * GroupRead Model
 *
 * How far each member has read in each group: one row per (group, member),
 * holding the timestamp of the last message they have seen.
 *
 * ## Why not a `read` flag, like 1-to-1 messages have
 *
 * A direct message has exactly one reader, so `read: true` on the message is
 * the whole truth. A group message has as many readers as the group has
 * members, so the equivalent would be a `readBy` array on every message —
 * which grows with members × messages, is rewritten on every read by every
 * member, and has to be scanned to answer "how many have I not read".
 *
 * A high-water mark is one row per member per group, written once when they
 * open the group, and it answers both questions the app actually asks:
 *
 * - **unread count** — messages in this group newer than my mark
 * - **read receipts** — who else's mark is at or past this message
 *
 * *Tradeoff:* it cannot express "read message 5 but not message 3". Nothing
 * needs that; chat is read in order, and a per-message record would be a much
 * larger price for a distinction nobody makes.
 *
 * A member with no row has never opened the group, which reads correctly as
 * "everything is unread" without needing a row to say so.
 */

const mongoose = require('mongoose');

const groupReadSchema = new mongoose.Schema({
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    required: true
  },

  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  /**
   * The timestamp of the newest message this member has seen — stored as the
   * moment they opened the group, not as a message id. A message id would
   * have to be resolved to a time before it could be compared, and would go
   * dangling if that message were ever removed.
   */
  lastReadAt: {
    type: Date,
    default: Date.now
  }
});

/**
 * One row per member per group, enforced rather than assumed: the mark is
 * upserted on every open, and a duplicate would silently split a member's
 * history in two.
 */
groupReadSchema.index({ group: 1, user: 1 }, { unique: true });

/** "Every mark I hold", for building the unread counts across all my groups. */
groupReadSchema.index({ user: 1 });

module.exports = mongoose.model('GroupRead', groupReadSchema);
