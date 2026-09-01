/**
 * Announcement Model
 *
 * A one-to-many broadcast: a mentor posts, every user reads. This is the
 * opposite shape to Message (one sender, one receiver) and GroupMessage
 * (one sender, one group) — there is no recipient field at all, because
 * the audience is "everyone".
 *
 * Only mentors can create these; the check lives in the POST route, since
 * the author's role is looked up from the database at write time rather
 * than duplicated onto the announcement itself. Storing a copy of the role
 * here would go stale the moment someone switches role.
 */

const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  // Who posted it (reference to User — always a mentor at time of posting)
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true          // for "announcements by this mentor" / author checks
  },

  // The announcement body
  text: {
    type: String,
    required: true,
    trim: true,
    maxlength: 2000      // shorter than a chat message; these are notices
  },

  // When it was posted
  timestamp: {
    type: Date,
    default: Date.now,
    index: true          // the feed is sorted newest-first on this
  }
});

const Announcement = mongoose.model('Announcement', announcementSchema);

module.exports = Announcement;
