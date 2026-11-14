/**
 * The Express app, the HTTP server and the Socket.IO server, with the middleware every
 * request passes and the state the routes share: who is online, the limits, the origins.
 *
 * Made once, here, and required by index.js and by every file in routes/. It used to be the
 * top of index.js, which held every route as well (docs/AUDIT.md, H7; BUILD_NOTES Entry 155).
 * index.js loads the environment before it requires this file.
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { allowedOrigins, originGate, allowSocketRequest, securityHeaders } = require('./lib/httpGuards');
const { createLimiter, limitFrom } = require('./lib/rateLimit');
// Authentication
const { devAuthEnabled } = require('./middleware/auth');

// ============================================
// SERVER SETUP
// ============================================

const app = express();
const server = http.createServer(app);  // Create HTTP server from Express app

// The browser origins that may call this server: CORS_ORIGINS, or the two local
// front-end addresses. One list for REST and for Socket.IO (lib/httpGuards.js).
const ALLOWED_ORIGINS = allowedOrigins(process.env.CORS_ORIGINS);

// Socket.IO setup with CORS (allows frontend on different port to connect).
// `allowRequest` as well as `cors`: a WebSocket handshake is not subject to
// CORS, so the list is applied to it directly.
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true
  },
  allowRequest: allowSocketRequest(ALLOWED_ORIGINS)
});

const PORT = process.env.PORT || 3001;

// How often one account may do one thing (lib/rateLimit.js). Generous: these stop
// a script, not a person.
const messageLimiter = createLimiter({
  max: limitFrom(process.env.MESSAGES_PER_10S, 30),
  windowMs: 10000
});
const reportLimiter = createLimiter({
  max: limitFrom(process.env.REPORTS_PER_HOUR, 20),
  windowMs: 60 * 60000
});
const uploadLimiter = createLimiter({
  max: limitFrom(process.env.UPLOADS_PER_10MIN, 30),
  windowMs: 10 * 60000
});
const loginLimiter = createLimiter({
  max: limitFrom(process.env.LOGINS_PER_MINUTE, 30),
  windowMs: 60000
});
const TOO_FAST = 'You are sending messages too quickly. Wait a few seconds.';

// The most people a group can be created with. A bound, so the list in a request is one.
const MAX_GROUP_MEMBERS = 200;

// Fail fast rather than starting a server that will 401 every request.
if (!process.env.FIREBASE_PROJECT_ID) {
  console.error(
    '\nFIREBASE_PROJECT_ID is not set. The server cannot verify sign-ins ' +
    'without it.\nSee server/.env.example.\n'
  );
  process.exit(1);
}

/**
 * The ONLY way to become an admin.
 *
 * Admin is deliberately not selectable: the first-login picker and the
 * profile switcher offer student and mentor only, and POST
 * /api/users/:id/role rejects anything else. If a role could be
 * self-assigned, anyone could make themselves an admin by editing a
 * request. Granting it from server config instead means the list of
 * admins lives somewhere a user cannot reach.
 */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

if (ADMIN_EMAILS.length > 0) {
  console.log(`\u{1F512} Admin allowlist: ${ADMIN_EMAILS.length} address(es)`);
}

// Loud, because this switch turns authentication off.
if (devAuthEnabled()) {
  console.warn(
    '\n*** ALLOW_DEV_AUTH is on: an X-Dev-User-Id header can stand in for ' +
    'a real sign-in.\n*** Never enable this on a deployed server.\n'
  );
}

// ============================================
// MIDDLEWARE
// ============================================

// CORS - allows frontend to make requests to this server
app.disable('x-powered-by');

// Headers every response carries. First, so they are on refusals and errors too;
// a route that sets its own (the file downloads' CSP) replaces these.
app.use(securityHeaders);

// A request from an origin that is not on the list is refused, not merely left
// without a CORS header (lib/httpGuards.js says why). No more reflecting any origin.
app.use(originGate(ALLOWED_ORIGINS));
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true
}));

// Parse JSON bodies (when frontend sends JSON data)
app.use(express.json());

// ============================================
// TRACK ONLINE USERS
// ============================================

/**
 * visitorId (MongoDB User._id) -> Set of that user's open socket ids.
 *
 * To reach user B, look up their set and emit to each socket in it. An empty
 * or absent set means B is offline; the message is still saved either way.
 *
 * A Set rather than a single id because one person routinely has several
 * tabs open. Storing one socket meant the newest tab silently replaced the
 * older one, which broke two things at once: closing either tab marked the
 * user offline while they were still sitting in the other, and only the
 * most recent tab received messages, typing indicators and read receipts.
 */
const onlineUsers = new Map();  // visitorId -> Set<socketId>

/**
 * Register a socket. Returns true when it is the user's FIRST — i.e. they
 * have just come online, as opposed to opening another tab.
 */
function addUserSocket(visitorId, socketId) {
  const sockets = onlineUsers.get(visitorId);

  if (sockets) {
    sockets.add(socketId);
    return false;
  }

  onlineUsers.set(visitorId, new Set([socketId]));
  return true;
}

/**
 * Unregister a socket. Returns true when it was the user's LAST — i.e. they
 * have actually gone offline, rather than just closed one of several tabs.
 */
function removeUserSocket(visitorId, socketId) {
  const sockets = onlineUsers.get(visitorId);
  if (!sockets) return false;

  sockets.delete(socketId);
  if (sockets.size > 0) return false;

  onlineUsers.delete(visitorId);
  return true;
}

/** Emit to every tab a user has open, so their windows stay in step. */
function emitToUser(visitorId, event, payload) {
  const sockets = onlineUsers.get(String(visitorId));
  if (!sockets) return;

  for (const socketId of sockets) {
    io.to(socketId).emit(event, payload);
  }
}

module.exports = {
  app,
  io,
  messageLimiter,
  reportLimiter,
  uploadLimiter,
  loginLimiter,
  TOO_FAST,
  MAX_GROUP_MEMBERS,
  ADMIN_EMAILS,
  onlineUsers,
  addUserSocket,
  removeUserSocket,
  emitToUser,
  server,
  PORT
};
