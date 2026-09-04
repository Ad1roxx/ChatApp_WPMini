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

  // Role in the mentor-student platform: 'student' or 'mentor'.
  // No default on purpose — a freshly created user has NO role until they
  // pick one on first login (Google sign-in gives us nowhere to ask, and
  // there is no registration form). The enum still validates any value set.
  // 'student' | 'mentor' | 'admin'
  //
  // No default, deliberately: an absent role is how "hasn't chosen yet" is
  // detected, which is what triggers the first-login picker.
  //
  // 'admin' is NOT selectable. The picker and the profile switcher only ever
  // offer student and mentor; admin is granted by the server from the
  // ADMIN_EMAILS allowlist at login. If a role could be self-assigned, anyone
  // could make themselves an admin by editing a request.
  role: {
    type: String,
    enum: ['student', 'mentor', 'admin']
  },

  // ---- Profile fields ----

  // Short "about me". Every user has one, student or mentor.
  bio: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },

  // MENTOR-ONLY: subject / area of expertise (e.g. "Data Structures, DBMS").
  // Stays empty for students — PUT /api/users/:id/profile refuses to set this
  // unless the user's stored role is 'mentor'.
  expertise: {
    type: String,
    trim: true,
    maxlength: 200,
    default: ''
  },

  // MENTOR-ONLY: short free-text availability note
  // (e.g. "Weekday evenings, 6-9pm").
  availability: {
    type: String,
    trim: true,
    maxlength: 200,
    default: ''
  },

  // ---- Mentor verification ----
  //
  // Embedded rather than a separate collection: a user has exactly one
  // verification state, the badge is read on every profile view, and a
  // separate model would mean a join to answer "is this mentor verified?".
  // The queue is just `find({ 'verification.status': 'pending' })`.
  //
  // *Tradeoff:* no history. Re-submitting after a rejection overwrites the
  // previous attempt. If an audit trail is ever needed — who rejected whom,
  // and how often someone re-applied — this has to move to its own model.
  //
  // The badge means "an administrator checked the evidence below", nothing
  // more. It is deliberately NOT self-service: a ✓ that anyone can award
  // themselves certifies nothing.
  verification: {
    status: {
      type: String,
      enum: ['unverified', 'pending', 'approved', 'rejected'],
      default: 'unverified',
      index: true          // the admin queue filters on this
    },

    // Evidence the mentor submits. Free text — nothing here is validated
    // against an external service, and the reviewing admin is told so.
    linkedinUrl: { type: String, trim: true, maxlength: 300, default: '' },
    company: { type: String, trim: true, maxlength: 120, default: '' },
    title: { type: String, trim: true, maxlength: 120, default: '' },
    yearsExperience: { type: Number, min: 0, max: 60, default: null },

    submittedAt: { type: Date, default: null },

    // Who decided, when, and why. `reviewNote` is shown to the mentor, so a
    // rejection can explain what was missing rather than just refusing.
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, trim: true, maxlength: 500, default: '' }
  },

  // ---- Suspension ----
  //
  // Enforced in requireAuth and socketAuth rather than per-route, so a
  // suspended account is locked out of REST and sockets alike by one check.
  // Anything less would leave whichever route was forgotten still open.
  suspended: {
    type: Boolean,
    default: false,
    index: true
  },
  suspendedAt: { type: Date, default: null },
  suspendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  suspendedReason: { type: String, trim: true, maxlength: 500, default: '' },

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
