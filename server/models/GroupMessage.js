/**
 * GroupMessage Model
 *
 * A message sent to a Group (as opposed to the 1-to-1 Message model,
 * which has a single sender + receiver).
 *
 * For a group message we store:
 * - WHICH group it belongs to (group)
 * - WHO sent it (sender)
 * - WHAT they said (text)
 * - WHEN they sent it (timestamp)
 *
 * To load a group's history, we find all GroupMessages where group = <groupId>,
 * sorted oldest-first — the same pattern the 1-to-1 history endpoint uses.
 */

const mongoose = require('mongoose');

const groupMessageSchema = new mongoose.Schema({
  // Which group this message was posted to
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    required: true,
    index: true          // fast lookups of a single group's messages
  },

  // Who sent the message (reference to User)
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // The message content
  text: {
    type: String,
    required: true,
    trim: true,
    maxlength: 5000      // same cap as the 1-to-1 Message model
  },

  // When it was sent
  timestamp: {
    type: Date,
    default: Date.now,
    index: true          // for sorting by time
  }
});

// Compound index: fetch a group's messages in time order efficiently
groupMessageSchema.index({ group: 1, timestamp: 1 });

const GroupMessage = mongoose.model('GroupMessage', groupMessageSchema);

module.exports = GroupMessage;
