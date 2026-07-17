/**
 * Message Model
 * 
 * This defines what a "Message" looks like in our database.
 * Each message has a sender, receiver, and the text content.
 * 
 * For 1-to-1 chat, we store:
 * - WHO sent it (sender)
 * - WHO receives it (receiver)  
 * - WHAT they said (text)
 * - WHEN they sent it (timestamp)
 * 
 * To get a conversation between User A and User B, we find all messages where:
 * (sender=A AND receiver=B) OR (sender=B AND receiver=A)
 */

const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  // Who sent this message (reference to User model)
  // We store the MongoDB _id of the sender
  sender: {
    type: mongoose.Schema.Types.ObjectId,  // Special type that references another document
    ref: 'User',                           // Which collection to reference
    required: true
  },

  // Who receives this message
  receiver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // The actual message content
  text: {
    type: String,
    required: true,
    trim: true,           // Remove whitespace from start/end
    maxlength: 5000       // Prevent super long messages
  },

  // When was this message sent?
  timestamp: {
    type: Date,
    default: Date.now,
    index: true           // Index for faster sorting by time
  },

  // Has the receiver read this message?
  // Useful for "seen" indicators (blue ticks like WhatsApp)
  read: {
    type: Boolean,
    default: false
  }
});

// Compound index: makes finding conversations between two users FAST
// Without this, MongoDB would scan ALL messages to find a conversation
messageSchema.index({ sender: 1, receiver: 1 });
messageSchema.index({ receiver: 1, sender: 1 });

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;
