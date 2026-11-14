/**
 * CHAT SERVER - Express + Socket.IO + MongoDB
 * 
 * This is the backend for our 1-to-1 chat application.
 * 
 * How it works:
 * 1. User logs in with Google (handled by Firebase Auth on frontend)
 * 2. Frontend sends user info to our server
 * 3. We save/update user in MongoDB
 * 4. User connects to Socket.IO for real-time messaging
 * 5. When user sends a message, we save to MongoDB AND broadcast to receiver
 * 
 * Key concepts:
 * - REST API (Express): For getting data (users list, message history)
 * - WebSocket (Socket.IO): For real-time events (new messages, typing indicators)
 */

// The private file first: neither overrides what the environment sets, so the order
// is the environment, then server.env outside the repository, then server/.env.
const { loadServerEnv } = require('./lib/privateEnv');
const privateEnvProblem = loadServerEnv();
require('dotenv').config();
if (privateEnvProblem) {
  console.error(`\n${privateEnvProblem}\n`);
  process.exit(1);
}

// Everything below needs the environment loaded above, so these come after it.
const mongoose = require('mongoose');
// Import our models
const User = require('./models/User');
const { app, server, PORT } = require('./app');

// ============================================
// DATABASE CONNECTION
// ============================================

// NOTE: 127.0.0.1, not localhost — deliberately.
// On Windows, `localhost` resolves to IPv6 (::1) first, but a default local
// MongoDB install listens only on IPv4. Using `localhost` here fails with
// `ECONNREFUSED ::1:27017` on a fresh clone, which looks like MongoDB isn't
// running when it is.
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/chatapp';

/**
 * Connect, clear stale presence, and only THEN start listening.
 *
 * Listening first left a gap: after a restart, Socket.IO clients reconnect
 * within moments, and one that reconnected before the reset below had run
 * would be marked online and then wiped by it — shown offline while
 * connected. If Mongo cannot be reached the process exits, rather than serve
 * requests it has no database to answer.
 */
mongoose.connect(mongoUri)
  .then(async () => {
    console.log('✅ Connected to MongoDB');

    // Clear stale presence.
    //
    // Sockets do not survive a restart, so at boot nobody is connected by
    // definition. Any `isOnline: true` still in the database was written
    // before a crash or a kill, and without this it would show a green dot
    // next to that person forever.
    const stale = await User.updateMany({ isOnline: true }, { isOnline: false });
    if (stale.modifiedCount > 0) {
      console.log(`🧹 Cleared stale online status for ${stale.modifiedCount} user(s)`);
    }

    startServer();
  })
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// ============================================
// ROUTES
// ============================================
//
// One file per area, in routes/. The order is the order the sections had when
// this was one file, and it is the order Express tries routes in, so it matters
// where two paths could both match (/api/groups/conversations before
// /api/groups/:groupId/...).

require('./routes/aiService');
require('./routes/users');
require('./routes/groups');
require('./routes/announcements');
require('./routes/admin');
require('./routes/moderation');
require('./routes/mentorships');
require('./routes/goals');
require('./routes/sessions');
require('./routes/resources');
require('./routes/feedback');
require('./routes/assignments');
require('./routes/submissionFiles');
require('./routes/assignmentFiles');
require('./routes/criteria');
require('./routes/coverageReports');
require('./routes/copilot');
require('./routes/agent');
require('./routes/proposals');
require('./routes/internalTools');
require('./routes/analytics');

// ============================================
// LAST: WHAT NO ROUTE ANSWERED, AND WHAT A ROUTE THREW
// ============================================
//
// After every route. Express's own fallbacks answer in HTML and replace the
// Content-Security-Policy set at the top; these answer in JSON like everything
// else here and leave the headers as they are.

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Four arguments: that is how Express knows this is the error handler. Each
// route still catches its own errors; this is for what happens before a route
// runs (a body that is not JSON, or is too large) and for anything a route misses.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return res.destroy();
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'That request body is not valid JSON' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That request is too large' });
  }
  console.error('Unhandled error:', err && err.message);
  res.status(500).json({ error: 'Server error' });
});

// ============================================
// SOCKET.IO - REAL-TIME EVENTS
// ============================================

require('./realtime');

// ============================================
// START SERVER
// ============================================

/** Called once the database is ready — see the connect block at the top. */
function startServer() {
  server.listen(PORT, () => {
    console.log(`
  🚀 Server running on http://localhost:${PORT}
  📡 Socket.IO ready for connections
  💾 MongoDB: ${mongoUri}
  `);
  });
}
