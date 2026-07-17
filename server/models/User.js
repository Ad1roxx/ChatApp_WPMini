/**
 * User Model
 * 
 * This defines what a "User" looks like in our database.
 * When someone signs in with Google, we save their info here.
 * 
 * Fields:
 * - firebaseUid: The unique ID from Firebase Auth (links Firebase user to our DB)
 * - email: User's email (from Google)
 * - displayName: User's name (from Google)
 * - photoURL: Profile picture URL (from Google)
 * - isOnline: Are they currently connected to our chat?
 * - lastSeen: When were they last active?
 */

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // Firebase UID - this is how we link Firebase Auth to our database
  // Every Firebase user has a unique ID like "abc123xyz"
  firebaseUid: {
    type: String,
    required: true,      // Must have this field
    unique: true,        // No two users can have the same UID
    index: true          // Makes searching by UID faster
  },

  // Email from Google account
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true      // Automatically convert to lowercase
  },

  // Display name from Google account (e.g., "John Doe")
  displayName: {
    type: String,
    required: true
  },

  // Profile photo URL from Google
  photoURL: {
    type: String,
    default: ''          // Empty string if no photo
  },

  // Is the user currently online?
  // We update this when they connect/disconnect from Socket.IO
  isOnline: {
    type: Boolean,
    default: false
  },

  // When was the user last seen?
  // Updated when they disconnect
  lastSeen: {
    type: Date,
    default: Date.now
  },

  // When was this user record created?
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create the model from the schema
// "User" will create a "users" collection in MongoDB (lowercase + plural)
const User = mongoose.model('User', userSchema);

module.exports = User;
