/**
 * Report Model
 *
 * Someone flags a user or a piece of content for an administrator to look at.
 *
 * Two design points worth stating:
 *
 * **The target is stored as a type plus an id, not a Mongoose `ref`.** A
 * report can point at a User, a Message, a GroupMessage or an Announcement,
 * and a single `ref` cannot span four collections. `refPath` could, but it
 * would break the moment the reported thing is deleted — which is exactly what
 * happens when a moderator acts on it. Storing the type and id loosely means a
 * report survives its target, and `targetSnapshot` keeps enough of the
 * original for the queue to stay readable after the content is gone.
 *
 * **Reports are never deleted, only resolved or dismissed.** A moderation
 * record that disappears is a moderation record you cannot audit.
 */

const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  // Who raised it
  reporter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // What was reported
  targetType: {
    type: String,
    enum: ['user', 'message', 'groupMessage', 'announcement'],
    required: true
  },

  targetId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },

  /**
   * A copy of the reported content as it was when reported.
   *
   * Without this, deleting the offending message would leave an admin looking
   * at a report with nothing in it — and deleting it is the usual outcome.
   */
  targetSnapshot: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: ''
  },

  reason: {
    type: String,
    enum: ['spam', 'harassment', 'inappropriate', 'impersonation', 'other'],
    required: true
  },

  // Optional free text from the reporter
  details: {
    type: String,
    trim: true,
    maxlength: 1000,
    default: ''
  },

  status: {
    type: String,
    enum: ['open', 'resolved', 'dismissed'],
    default: 'open',
    index: true          // the queue filters on this
  },

  // Who closed it, when, and what they decided
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  reviewedAt: { type: Date, default: null },
  resolutionNote: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },

  createdAt: {
    type: Date,
    default: Date.now,
    index: true          // the queue is newest-first
  }
});

// The queue's default view: open reports, newest first.
reportSchema.index({ status: 1, createdAt: -1 });

// Stops one person filing the same complaint repeatedly — see the POST route.
reportSchema.index({ reporter: 1, targetType: 1, targetId: 1 });

const Report = mongoose.model('Report', reportSchema);

module.exports = Report;
