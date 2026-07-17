/**
 * Group Model
 *
 * Represents a group chat (many users in one conversation).
 * Mirrors the style of User.js / Message.js.
 *
 * A group has:
 * - a name (what members see in their group list)
 * - a members array (the User _ids allowed to read/post)
 * - createdBy (who made the group)
 *
 * Group messages live in their own collection (see GroupMessage.js),
 * each pointing back to a Group via its _id. This keeps the 1-to-1
 * Message model completely separate and unchanged.
 */

const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
  // Display name of the group (e.g. "Study Group")
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },

  // Users who belong to this group.
  // We store MongoDB _ids that reference the User collection.
  members: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],

  // Who created the group (also included in members)
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // When the group was created
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index on members so "find all groups for user X" is fast
groupSchema.index({ members: 1 });

const Group = mongoose.model('Group', groupSchema);

module.exports = Group;
