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
const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const multer = require('multer');

// Import our models
const User = require('./models/User');
const Message = require('./models/Message');
const Group = require('./models/Group');
const GroupMessage = require('./models/GroupMessage');
const Announcement = require('./models/Announcement');
const Report = require('./models/Report');
const Mentorship = require('./models/Mentorship');
const Goal = require('./models/Goal');
const Session = require('./models/Session');
const GroupRead = require('./models/GroupRead');
const Feedback = require('./models/Feedback');
const Resource = require('./models/Resource');
const Assignment = require('./models/Assignment');
const Submission = require('./models/Submission');
const fileStore = require('./lib/fileStore');
// Tells the retrieval service which record changed - after the write, never
// awaited, never able to fail the request. See lib/indexSync.js.
const { syncSource, syncMentorship } = require('./lib/indexSync');

// The agent's per-turn capability token, and the checks for requests only the
// AI service on this machine may make. See the internal tool endpoint.
const agentToken = require('./lib/agentToken');
const { isLoopback, sameSecret } = require('./lib/internalRequest');
// The agent route's two guards of its own: synthetic databases only, and each
// person's share of the model calls.
const { agentDatabaseRefusal, AGENT_NOT_CONFIGURED } = require('./lib/agentDatabases');
const { ModelCallBudget } = require('./lib/agentBudget');

// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const {
  resolveMentorshipAccess,
  loadOwnAssignment,
  loadSubmission,
  canReadSubmissionFile,
  SESSION_POPULATE,
  serialiseSubmission,
  summarise,
  goalsFor,
  sessionsFor,
  resourcesFor,
  mentorshipWorkFor,
  assignmentOverviewFor,
  myWorkFor,
  myWorkCountsFor,
  upcomingSessionsFor
} = require('./lib/reads');
const agentTools = require('./lib/agentTools');
const agentProposal = require('./lib/agentProposal');
const agentWrites = require('./lib/agentWrites');
const { parseSharedUrl } = require('./lib/sharedUrl');
const AgentProposal = require('./models/AgentProposal');

// Authentication
const {
  requireAuth,
  requireToken,
  requireRole,
  socketAuth,
  devAuthEnabled
} = require('./middleware/auth');

// ============================================
// SERVER SETUP
// ============================================

const app = express();
const server = http.createServer(app);  // Create HTTP server from Express app

// Socket.IO setup with CORS (allows frontend on different port to connect)
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "http://localhost:3000"],  // Vite and CRA default ports
    methods: ["GET", "POST"],
    credentials: true
  }
});

const PORT = process.env.PORT || 3001;

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
app.use(cors({
  origin: true,
  credentials: true
}));

// Parse JSON bodies (when frontend sends JSON data)
app.use(express.json());

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

// ============================================
// REST API ENDPOINTS
// ============================================

/**
 * POST /api/auth/login
 * 
 * Called when user logs in with Google.
 * Creates a new user in our DB or returns existing one.
 * 
 * Why do we need this?
 * Firebase only handles AUTH (who is this person?).
 * Our MongoDB handles DATA (messages, online status, etc.)
 * This endpoint links the two.
 */
app.post('/api/auth/login', requireToken, async (req, res) => {
  try {
    // Identity comes from the VERIFIED token, never from the body. The body
    // is still consulted for display name and photo, which are cosmetic —
    // but uid and email decide WHICH ACCOUNT THIS IS, so letting the client
    // choose them meant anyone could sign in as anyone.
    const { uid: firebaseUid, email: tokenEmail, name, picture } = req.firebaseUser;

    const email = tokenEmail || req.body.email;
    const displayName = req.body.displayName || name;
    const photoURL = req.body.photoURL || picture;

    if (!firebaseUid || !email) {
      return res.status(400).json({ error: 'Token is missing uid or email' });
    }

    // findOneAndUpdate with upsert:true means:
    // - If user exists: UPDATE their info (name, photo might have changed)
    // - If user doesn't exist: CREATE new user
    // This is called an "upsert" (update + insert)
    // NOTE: `role` is intentionally NOT in the update below. This runs on
    // EVERY login, so setting role here would clobber the user's choice.
    // Role is set once via POST /api/users/:id/role and preserved thereafter.
    // `includeResultMetadata` makes Mongoose return the raw driver result, so
    // we can tell an INSERT from an UPDATE. We need that distinction: a
    // first-ever login should be announced to everyone else's user list, while
    // an ordinary repeat login should not (it would just duplicate a row).
    const update = {
      firebaseUid,
      email,
      displayName: displayName || email.split('@')[0],  // Fallback to email prefix
      photoURL: photoURL || '',
      lastSeen: new Date()
    };

    // NOTE: `isOnline` is deliberately NOT set here.
    //
    // Signing in is not the same as being connected. The socket may never
    // open — the tab is closed straight away, the connection is refused, the
    // network drops — and nothing would ever set the flag back, leaving a
    // green dot next to someone who left. Presence is owned entirely by the
    // socket lifecycle below: 'user-online' sets it, 'disconnect' clears it.

    // Applied on EVERY login, so the allowlist stays the source of truth:
    // adding an address promotes that person the next time they sign in.
    // Removing one does not automatically demote — an admin changes the
    // role from the dashboard — because demoting would need a read of the
    // current role before this upsert, and silently stripping access on a
    // config edit is worse than doing it explicitly.
    if (ADMIN_EMAILS.includes(email.toLowerCase())) {
      update.role = 'admin';
    }

    const result = await User.findOneAndUpdate(
      { firebaseUid },  // Find by Firebase UID
      update,
      {
        upsert: true,     // Create if doesn't exist
        new: true,        // Return the updated document
        setDefaultsOnInsert: true,  // Apply schema defaults on insert
        includeResultMetadata: true // Tell us whether this was an insert
      }
    );

    const user = result.value;
    const isNewUser = Boolean(result.lastErrorObject?.upserted);

    // Announce brand-new accounts so open user lists gain the row without a
    // manual refresh. Only on insert — see the comment above.
    if (isNewUser) {
      io.emit('user-added', user);
      console.log(`✨ New user registered: ${user.displayName}`);
    }

    console.log(`👤 User logged in: ${user.displayName}`);
    res.json(user);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/users
 * 
 * Get all users except the current user.
 * Used to show "who can I chat with?" list.
 * 
 * Query params:
 * - exclude: Firebase UID to exclude from results (the logged-in user)
 */
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const { exclude } = req.query;
    
    // Find all users except the one making the request
    const query = exclude ? { firebaseUid: { $ne: exclude } } : {};
    const users = await User.find(query)
      .select('-__v')  // Exclude Mongoose version key
      .sort({ displayName: 1 });  // Sort alphabetically
    
    res.json(users);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/conversations
 *
 * One row per person you have exchanged messages with: what was said last,
 * when, which way round, and how many of theirs you have not read.
 *
 * This is what makes the people list a *messages* list. Until now the page
 * showed everyone with "Online"/"Offline" underneath and no indication that
 * anyone had said anything — a message arrived and the only way to find out
 * was to open every conversation in turn.
 *
 * ## Why one aggregation instead of a query per person
 *
 * The obvious version loops the user list and runs two queries each — last
 * message, unread count. That is 2N round trips for a screen that renders
 * once. This is one pass: sort every message the caller is party to, newest
 * first, then `$group` on "the other person", taking `$first` for the last
 * message and summing the unread ones on the way through.
 *
 * *Tradeoff, stated plainly:* it touches all of the caller's messages, so it
 * grows with their history rather than with their contact count. The two
 * compound indexes on the collection serve the `$or` match, and at this
 * project's scale it is a single-digit-millisecond query — but a real
 * deployment with long histories would keep a denormalised conversation
 * document instead, updated on write.
 *
 * People you have never messaged do not appear at all. The client merges
 * these rows onto the user list rather than replacing it, so a fresh contact
 * still shows up — just without a preview.
 */
app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const me = req.authUser._id;

    const rows = await Message.aggregate([
      { $match: { $or: [{ sender: me }, { receiver: me }] } },

      // Newest first, so `$first` below means "most recent" rather than
      // "whichever the storage engine happened to return".
      { $sort: { timestamp: -1 } },

      {
        $group: {
          // The other party, whichever side of the message they were on.
          _id: {
            $cond: [{ $eq: ['$sender', me] }, '$receiver', '$sender']
          },
          lastText: { $first: '$text' },
          lastAt: { $first: '$timestamp' },
          lastFromMe: { $first: { $eq: ['$sender', me] } },
          unread: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$receiver', me] }, { $eq: ['$read', false] }] },
                1,
                0
              ]
            }
          }
        }
      },

      { $sort: { lastAt: -1 } }
    ]);

    res.json(
      rows.map((r) => ({
        peerId: r._id,
        lastText: r.lastText,
        lastAt: r.lastAt,
        lastFromMe: r.lastFromMe,
        unread: r.unread
      }))
    );
  } catch (err) {
    console.error('Error listing conversations:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/messages/:visitorId/:peerId
 * 
 * Get conversation history between two users.
 * 
 * Why two params?
 * - visitorId: The logged-in user's MongoDB _id
 * - peerId: The other user's MongoDB _id
 * 
 * We find messages where:
 * (sender=visitor AND receiver=peer) OR (sender=peer AND receiver=visitor)
 */
app.get('/api/messages/:visitorId/:peerId', requireAuth, async (req, res) => {
  try {
    // You may only read a conversation you are part of. Without this any
    // signed-in user could read anybody's messages given two ids.
    if (String(req.authUser._id) !== String(req.params.visitorId)) {
      return res.status(403).json({ error: 'You can only read your own conversations' });
    }

    const { visitorId, peerId } = req.params;
    const { limit = 50, before } = req.query;  // Optional pagination

    // Build query: messages between these two users
    let query = {
      $or: [
        { sender: visitorId, receiver: peerId },
        { sender: peerId, receiver: visitorId }
      ]
    };

    // If "before" timestamp provided, get older messages (for "load more")
    if (before) {
      query.timestamp = { $lt: new Date(before) };
    }

    const messages = await Message.find(query)
      .sort({ timestamp: 1 })  // Oldest first
      .limit(parseInt(limit))
      .populate('sender', 'displayName photoURL role')  // Include sender info
      .populate('receiver', 'displayName photoURL role');

    res.json(messages);
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/user/:visitorId
 * 
 * Get a single user by their MongoDB _id.
 * Used when opening a chat to get the other person's info.
 */
app.get('/api/user/:visitorId', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.visitorId).select('-__v');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/users/:id/role
 *
 * Set a user's role ('student' or 'mentor'). Used both by the first-login
 * picker and by the role switcher on the profile page — the operation is
 * identical either way, so there is no reason for a second endpoint.
 *
 * Kept separate from /api/auth/login on purpose: that endpoint upserts on
 * EVERY login, so putting role there would overwrite the user's choice each
 * time they sign in. Setting it only here preserves it.
 *
 * Demoting a mentor to student leaves the groups they already created
 * intact — the gate is on *creating* groups, not on owning them.
 */
app.post('/api/users/:id/role', requireAuth, async (req, res) => {
  try {
    const { role } = req.body;

    // You may only set your OWN role.
    if (String(req.authUser._id) !== String(req.params.id)) {
      return res.status(403).json({ error: 'You can only change your own role' });
    }

    // Only these two roles are valid
    if (!['student', 'mentor'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true }        // return the updated document
    ).select('-__v');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Announce the change so open user lists re-badge without a refresh.
    //
    // This matters most for brand-new accounts: `user-added` fires from
    // /api/auth/login, which happens BEFORE the first-login role picker, so
    // everyone else first sees the new person with no role at all. Without
    // this emit their badge would stay missing until someone refreshed.
    io.emit('user-updated', user);

    console.log(`🎓 Role set: ${user.displayName} -> ${role}`);
    res.json(user);
  } catch (err) {
    console.error('Error setting role:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/users/:id/profile
 *
 * Update a user's profile.
 * - `bio` applies to everyone.
 * - `expertise` and `availability` are MENTOR-ONLY. We check the role stored
 *   in the database (not anything the client sends), so a student cannot
 *   acquire mentor-only fields by crafting a request.
 *
 * NOTE: like every other endpoint here, there is no token check proving the
 * caller *is* this user. Consistent with the app's current trust model.
 */
app.put('/api/users/:id/profile', requireAuth, async (req, res) => {
  try {
    const { bio, expertise, availability } = req.body;

    // You may only edit your OWN profile. This is the gap Entry 8 recorded
    // as known and deliberately unfixed; it is fixed now.
    if (String(req.authUser._id) !== String(req.params.id)) {
      return res.status(403).json({ error: 'You can only edit your own profile' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Build the update from only the fields this user is allowed to set
    const updates = {};
    if (bio !== undefined) updates.bio = bio;

    if (['mentor', 'admin'].includes(user.role)) {
      if (expertise !== undefined) updates.expertise = expertise;
      if (availability !== undefined) updates.availability = availability;
    }

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }  // enforce maxlength etc.
    ).select('-__v');

    console.log(`📝 Profile updated: ${updated.displayName}`);
    res.json(updated);
  } catch (err) {
    console.error('Error updating profile:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// GROUP REST API ENDPOINTS
// ============================================

/**
 * POST /api/groups
 *
 * Create a new group chat.
 *
 * MENTOR-ONLY. Students can join and chat in any group, they just cannot
 * open new ones. Same principle as the profile endpoint: we read the
 * creator's role from the DATABASE, never from the request body, so a
 * student cannot promote themselves by editing the payload.
 *
 * Body:
 * - name: group display name
 * - createdBy: MongoDB _id of the creator
 * - memberIds: array of MongoDB _ids to add (the creator is added automatically)
 */
app.post('/api/groups', requireAuth, async (req, res) => {
  try {
    const { name, memberIds = [] } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // The creator is whoever is signed in, not whoever the body claims.
    const creator = req.authUser;
    const createdBy = creator._id;

    // AUTHORIZATION: mentors (and admins, who are a superset) may create
    // groups. Without the admin case an admin could not use the very
    // features they oversee.
    if (!['mentor', 'admin'].includes(creator.role)) {
      console.log(`⛔ Group create refused: ${creator.displayName} is not a mentor`);
      return res.status(403).json({ error: 'Only mentors can create groups' });
    }

    // Always include the creator in the members list, and de-duplicate.
    // (A Set of string ids removes accidental repeats before we store them.)
    const uniqueMembers = [...new Set([createdBy, ...memberIds].map(String))];

    const group = await Group.create({
      name: name.trim(),
      createdBy,
      members: uniqueMembers
    });

    // Return the group with member info populated (handy for the client)
    await group.populate('members', 'displayName photoURL role');

    console.log(`👥 Group created: ${group.name} (${uniqueMembers.length} members)`);
    res.json(group);
  } catch (err) {
    console.error('Error creating group:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/groups/:groupId/join
 *
 * Add a user to an existing group.
 *
 * Body:
 * - visitorId: MongoDB _id of the user joining
 *
 * We use $addToSet so joining twice does not create duplicate entries.
 */
app.post('/api/groups/:groupId/join', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.params;

    // You can only add YOURSELF to a group.
    const visitorId = req.authUser._id;

    const group = await Group.findByIdAndUpdate(
      groupId,
      { $addToSet: { members: visitorId } },  // add only if not already present
      { new: true }                           // return the updated group
    ).populate('members', 'displayName photoURL role');

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    console.log(`➕ User ${visitorId} joined group ${group.name}`);
    res.json(group);
  } catch (err) {
    console.error('Error joining group:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/groups?userId=<mongoId>
 *
 * List all groups a user belongs to (for their group list).
 * If no userId is provided, returns all groups.
 */
app.get('/api/groups', requireAuth, async (req, res) => {
  try {
    const { userId } = req.query;

    // If userId given, only groups where they are a member
    const query = userId ? { members: userId } : {};
    const groups = await Group.find(query)
      .populate('members', 'displayName photoURL role')
      .sort({ createdAt: -1 });  // newest groups first

    res.json(groups);
  } catch (err) {
    console.error('Error fetching groups:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/groups/conversations
 *
 * The group half of `/api/conversations`: per group, what was said last, by
 * whom, and how many messages you have not read.
 *
 * Kept as its own route rather than folded into the direct-message one
 * because the two answer different questions — that one is keyed by person,
 * this one by group — and a single endpoint returning two differently-shaped
 * lists would only have been a merge waiting to be undone on the client.
 *
 * ## Two aggregations, not one
 *
 * The preview is a straight `$group` with `$first` over a time sort. The
 * unread count cannot join it, because each group has its *own* cutoff — the
 * caller's high-water mark — and one pipeline would need a `$switch` over
 * every group to express that. An `$or` of `{ group, timestamp: { $gt } }`
 * clauses is both clearer and a better fit for the existing
 * `{ group: 1, timestamp: 1 }` index.
 *
 * Your own messages never count as unread, which is why `sender` is excluded
 * rather than the mark simply being moved on send.
 */
app.get('/api/groups/conversations', requireAuth, async (req, res) => {
  try {
    const me = req.authUser._id;

    const groups = await Group.find({ members: me }).select('_id');
    if (groups.length === 0) return res.json([]);

    const groupIds = groups.map((g) => g._id);

    const marks = await GroupRead.find({ user: me, group: { $in: groupIds } });
    const markBy = new Map(marks.map((m) => [String(m.group), m.lastReadAt]));

    // A member with no mark has never opened the group, so everything in it
    // is unread — epoch is the honest cutoff, not "now".
    const EPOCH = new Date(0);

    const [previews, unreads] = await Promise.all([
      GroupMessage.aggregate([
        { $match: { group: { $in: groupIds } } },
        { $sort: { timestamp: -1 } },
        {
          $group: {
            _id: '$group',
            lastText: { $first: '$text' },
            lastAt: { $first: '$timestamp' },
            lastSender: { $first: '$sender' }
          }
        }
      ]),
      GroupMessage.aggregate([
        {
          $match: {
            sender: { $ne: me },
            $or: groupIds.map((id) => ({
              group: id,
              timestamp: { $gt: markBy.get(String(id)) || EPOCH }
            }))
          }
        },
        { $group: { _id: '$group', unread: { $sum: 1 } } }
      ])
    ]);

    // The preview needs a name, not an id. One lookup for every sender that
    // actually appears, rather than a populate per row.
    const senderIds = [...new Set(previews.map((p) => String(p.lastSender)))];
    const senders = await User.find({ _id: { $in: senderIds } }).select('displayName');
    const nameBy = new Map(senders.map((u) => [String(u._id), u.displayName]));

    const unreadBy = new Map(unreads.map((u) => [String(u._id), u.unread]));

    res.json(
      previews.map((p) => ({
        groupId: p._id,
        lastText: p.lastText,
        lastAt: p.lastAt,
        lastSenderId: p.lastSender,
        lastSenderName: nameBy.get(String(p.lastSender)) || 'Someone',
        lastFromMe: String(p.lastSender) === String(me),
        unread: unreadBy.get(String(p._id)) || 0
      }))
    );
  } catch (err) {
    console.error('Error listing group conversations:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/groups/:groupId/reads
 *
 * Every member's high-water mark for one group — the raw material for read
 * receipts. The client turns it into "seen by" under the last message you
 * sent, because who has read *your* message is the only receipt anyone wants.
 *
 * Members only: how far other people have read is not public.
 */
app.get('/api/groups/:groupId/reads', requireAuth, async (req, res) => {
  try {
    const group = await Group.findById(req.params.groupId).select('members');
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const me = String(req.authUser._id);
    if (!group.members.some((m) => String(m) === me)) {
      return res.status(403).json({ error: 'You are not a member of that group' });
    }

    const reads = await GroupRead.find({ group: req.params.groupId })
      .populate('user', 'displayName photoURL');

    res.json(
      reads.map((r) => ({
        userId: r.user?._id || r.user,
        displayName: r.user?.displayName || 'Someone',
        photoURL: r.user?.photoURL || '',
        lastReadAt: r.lastReadAt
      }))
    );
  } catch (err) {
    console.error('Error listing group reads:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/groups/:groupId/messages
 *
 * Get a group's message history (oldest first).
 * Mirrors the 1-to-1 GET /api/messages endpoint.
 */
app.get('/api/groups/:groupId/messages', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.params;

    // MEMBERSHIP: only members can read a group's history.
    const membership = await Group.findById(groupId).select('members');
    if (!membership) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (!membership.members.some((m) => String(m) === String(req.authUser._id))) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }
    const { limit = 50, before } = req.query;  // optional pagination

    let query = { group: groupId };

    // "before" lets the client load older messages ("load more")
    if (before) {
      query.timestamp = { $lt: new Date(before) };
    }

    const messages = await GroupMessage.find(query)
      .sort({ timestamp: 1 })  // oldest first
      .limit(parseInt(limit))
      .populate('sender', 'displayName photoURL role');

    res.json(messages);
  } catch (err) {
    console.error('Error fetching group messages:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// ANNOUNCEMENT REST API ENDPOINTS
// ============================================

/**
 * GET /api/announcements
 *
 * The announcement feed, newest first. Readable by everyone — the whole
 * point is that students see what mentors post.
 *
 * `limit` caps the response (default 50) so the feed cannot grow into an
 * unbounded payload as the term goes on.
 */
app.get('/api/announcements', requireAuth, async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const announcements = await Announcement.find()
      .sort({ timestamp: -1 })                        // newest first
      .limit(parseInt(limit))
      .populate('author', 'displayName photoURL role');

    res.json(announcements);
  } catch (err) {
    console.error('Error fetching announcements:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/announcements
 *
 * MENTOR-ONLY. Same gate as group creation: the author's role is read from
 * the database, so the client cannot claim to be a mentor.
 *
 * Body:
 * - authorId: MongoDB _id of the poster
 * - text: the announcement body
 */
app.post('/api/announcements', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;

    if (!text?.trim()) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // The author is whoever is signed in.
    const author = req.authUser;
    const authorId = author._id;

    // AUTHORIZATION: mentors and admins may post.
    if (!['mentor', 'admin'].includes(author.role)) {
      console.log(`⛔ Announcement refused: ${author.displayName} is not a mentor`);
      return res.status(403).json({ error: 'Only mentors can post announcements' });
    }

    const announcement = await Announcement.create({
      author: authorId,
      text: text.trim(),
      timestamp: new Date()
    });

    await announcement.populate('author', 'displayName photoURL role');

    // Push it to everyone connected, so open feeds update without a refresh.
    // Announcements are public, so a plain io.emit is correct here — there is
    // no room to scope it to, unlike group messages.
    io.emit('new-announcement', announcement);

    console.log(`📢 Announcement by ${author.displayName}`);
    res.json(announcement);
  } catch (err) {
    console.error('Error posting announcement:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/announcements/:id
 *
 * Delete an announcement you posted. Two checks, both needed:
 * - the announcement must exist
 * - you must be its AUTHOR
 *
 * The ownership check is the interesting one — it's the app's first, as
 * opposed to a role check. Being a mentor lets you delete *your* own
 * announcements, not everyone's; a role check alone would let any mentor
 * wipe another mentor's notices.
 *
 * Body:
 * - visitorId: MongoDB _id of whoever is asking
 */
app.delete('/api/announcements/:id', requireAuth, async (req, res) => {
  try {
    const visitorId = req.authUser._id;

    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ error: 'Announcement not found' });
    }

    // Compare as strings: author is an ObjectId, visitorId arrives as text
    if (String(announcement.author) !== String(visitorId)) {
      return res.status(403).json({ error: 'You can only delete your own announcements' });
    }

    await announcement.deleteOne();

    // Tell open feeds to drop it
    io.emit('announcement-deleted', { _id: req.params.id });

    console.log(`🗑️ Announcement ${req.params.id} deleted`);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting announcement:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// ADMIN REST API ENDPOINTS
// ============================================
//
// Every route here is `requireAuth` + `requireRole('admin')`. The role is
// read from the database by requireAuth, and admin cannot be self-assigned
// (see ADMIN_EMAILS above), so there is no path from an ordinary account to
// any of this.

/**
 * GET /api/admin/stats
 *
 * Platform overview. Every number is counted live from MongoDB — there are no
 * placeholder figures here, because a dashboard showing invented numbers is
 * worse than no dashboard.
 *
 * The mentorship, goal and session counts were added late: this endpoint had
 * been counting users, groups and messages only, so the dashboard was blind
 * to the three largest features in the app. An overview that omits half the
 * product is its own kind of invented number.
 */
app.get('/api/admin/stats', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // countDocuments in parallel — they are independent
    const [
      users,
      students,
      mentors,
      admins,
      online,
      newThisWeek,
      groups,
      messages,
      groupMessages,
      announcements,
      mentorships,
      activeMentorships,
      goals,
      completedGoals,
      sessions,
      completedSessions
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: 'student' }),
      User.countDocuments({ role: 'mentor' }),
      User.countDocuments({ role: 'admin' }),
      User.countDocuments({ isOnline: true }),
      User.countDocuments({ createdAt: { $gte: weekAgo } }),
      Group.countDocuments(),
      Message.countDocuments(),
      GroupMessage.countDocuments(),
      Announcement.countDocuments(),
      Mentorship.countDocuments(),
      Mentorship.countDocuments({ status: 'active' }),
      Goal.countDocuments(),
      Goal.countDocuments({ status: 'completed' }),
      Session.countDocuments(),
      Session.countDocuments({ status: 'completed' })
    ]);

    res.json({
      users,
      students,
      mentors,
      admins,
      // A user who has signed in but never picked a role yet
      unassigned: users - students - mentors - admins,
      online,
      newThisWeek,
      groups,
      messages,
      groupMessages,
      announcements,
      mentorships,
      activeMentorships,
      goals,
      completedGoals,
      sessions,
      completedSessions
    });
  } catch (err) {
    console.error('Error building admin stats:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/admin/users
 *
 * Every user, newest first, for the management table.
 */
app.get('/api/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const users = await User.find()
      .select('-__v')
      .sort({ createdAt: -1 });

    res.json(users);
  } catch (err) {
    console.error('Error listing users for admin:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/admin/users/:id/role
 *
 * Change somebody else's role. Distinct from POST /api/users/:id/role, which
 * is self-service and refuses to touch anyone but the caller.
 *
 * Two guards worth stating:
 * - **'admin' is not assignable here.** Only the ADMIN_EMAILS allowlist
 *   grants it. If this endpoint could hand out admin, one compromised admin
 *   account would be enough to mint more.
 * - **You cannot change your own role here.** It would let an admin
 *   accidentally demote themselves out of the dashboard they are standing in.
 */
app.patch('/api/admin/users/:id/role', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { role } = req.body;

    if (!['student', 'mentor'].includes(role)) {
      return res.status(400).json({ error: 'Role must be student or mentor' });
    }

    if (String(req.authUser._id) === String(req.params.id)) {
      return res.status(400).json({
        error: 'Change your own role from the ADMIN_EMAILS allowlist, not here'
      });
    }

    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (target.role === 'admin') {
      return res.status(403).json({ error: 'Another admin cannot be demoted here' });
    }

    target.role = role;
    await target.save();

    const updated = await User.findById(target._id).select('-__v');

    // Same broadcast the self-service route uses, so open user lists re-badge
    io.emit('user-updated', updated);

    console.log(`\u{1F6E1} Admin ${req.authUser.displayName} set ${target.displayName} -> ${role}`);
    res.json(updated);
  } catch (err) {
    console.error('Error changing role as admin:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// VERIFICATION, SUSPENSION AND REPORTS
// ============================================

/**
 * POST /api/verification
 *
 * A mentor submits credentials for review. Mentors and admins only — there is
 * nothing for a student to be verified as.
 *
 * Re-submitting is allowed and overwrites the previous attempt, which is how
 * someone acts on a rejection note. Submitting while already approved is
 * refused, so an approved mentor cannot quietly swap the evidence behind
 * their badge.
 */
app.post('/api/verification', requireAuth, async (req, res) => {
  try {
    const user = req.authUser;

    if (!['mentor', 'admin'].includes(user.role)) {
      return res.status(403).json({ error: 'Only mentors can request verification' });
    }

    if (user.verification?.status === 'approved') {
      return res.status(400).json({ error: 'You are already verified' });
    }

    const { linkedinUrl = '', company = '', title = '', yearsExperience } = req.body;

    if (!company.trim() || !title.trim()) {
      return res.status(400).json({ error: 'Company and title are required' });
    }

    user.verification = {
      status: 'pending',
      linkedinUrl: linkedinUrl.trim(),
      company: company.trim(),
      title: title.trim(),
      yearsExperience:
        yearsExperience === undefined || yearsExperience === null
          ? null
          : Number(yearsExperience),
      submittedAt: new Date(),
      // Clear any previous decision — this is a fresh request, and leaving
      // the old reviewer attached would misattribute the next one.
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: ''
    };

    await user.save();

    console.log(`📋 Verification requested: ${user.displayName}`);
    res.json(await User.findById(user._id).select('-__v'));
  } catch (err) {
    console.error('Error requesting verification:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/admin/verifications
 *
 * The review queue. Defaults to pending; `?status=` widens it.
 */
app.get('/api/admin/verifications', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { status = 'pending' } = req.query;

    const users = await User.find({ 'verification.status': status })
      .select('-__v')
      .sort({ 'verification.submittedAt': 1 });  // oldest first — a queue

    res.json(users);
  } catch (err) {
    console.error('Error listing verifications:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/admin/verifications/:userId
 *
 * Approve or reject. `note` is shown to the mentor, so a rejection can say
 * what was missing rather than simply refusing.
 *
 * Only a PENDING request can be decided: without that, a second admin could
 * silently overturn the first, and the mentor would never know it had changed.
 */
app.patch('/api/admin/verifications/:userId', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { decision, note = '' } = req.body;

    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Decision must be approved or rejected' });
    }

    const target = await User.findById(req.params.userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (target.verification?.status !== 'pending') {
      return res.status(400).json({ error: 'That request is not awaiting review' });
    }

    target.verification.status = decision;
    target.verification.reviewedBy = req.authUser._id;
    target.verification.reviewedAt = new Date();
    target.verification.reviewNote = String(note).trim();
    await target.save();

    const updated = await User.findById(target._id).select('-__v');

    // The badge is visible to everyone, so everyone's copy should update.
    io.emit('user-updated', updated);

    console.log(`📋 Verification ${decision}: ${target.displayName}`);
    res.json(updated);
  } catch (err) {
    console.error('Error reviewing verification:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/admin/users/:id/suspend
 *
 * Suspend or restore an account. The lockout itself lives in requireAuth and
 * socketAuth — this only sets the flag.
 *
 * Guards mirror the role endpoint: not yourself (you would lock yourself out
 * of the dashboard you are standing in) and not another admin.
 */
app.patch('/api/admin/users/:id/suspend', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { suspended, reason = '' } = req.body;

    if (typeof suspended !== 'boolean') {
      return res.status(400).json({ error: 'suspended must be true or false' });
    }

    if (String(req.authUser._id) === String(req.params.id)) {
      return res.status(400).json({ error: 'You cannot suspend your own account' });
    }

    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (target.role === 'admin') {
      return res.status(403).json({ error: 'Another admin cannot be suspended here' });
    }

    target.suspended = suspended;
    target.suspendedAt = suspended ? new Date() : null;
    target.suspendedBy = suspended ? req.authUser._id : null;
    target.suspendedReason = suspended ? String(reason).trim() : '';
    await target.save();

    const updated = await User.findById(target._id).select('-__v');

    // Cut their live sockets immediately. The handshake check only runs on
    // connect, so an already-open socket would keep receiving messages until
    // the tab was closed — which is not what "suspended" should mean.
    if (suspended) {
      const sockets = onlineUsers.get(String(target._id));
      if (sockets) {
        for (const socketId of sockets) {
          io.sockets.sockets.get(socketId)?.disconnect(true);
        }
      }
    }

    io.emit('user-updated', updated);

    console.log(`${suspended ? '⛔ Suspended' : '✅ Restored'}: ${target.displayName}`);
    res.json(updated);
  } catch (err) {
    console.error('Error changing suspension:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/reports
 *
 * Flag a user or a piece of content. Open to any signed-in user.
 *
 * `targetSnapshot` copies the reported text as it is now, because acting on a
 * report usually means deleting the thing it points at — and an admin should
 * still be able to see what they are deciding about.
 */
app.post('/api/reports', requireAuth, async (req, res) => {
  try {
    const { targetType, targetId, reason, details = '' } = req.body;

    if (!['user', 'message', 'groupMessage', 'announcement'].includes(targetType)) {
      return res.status(400).json({ error: 'Unknown target type' });
    }
    if (!['spam', 'harassment', 'inappropriate', 'impersonation', 'other'].includes(reason)) {
      return res.status(400).json({ error: 'Unknown reason' });
    }
    if (!targetId) {
      return res.status(400).json({ error: 'Missing targetId' });
    }

    // You cannot report yourself — it is either a mistake or an attempt to
    // clutter the queue.
    if (targetType === 'user' && String(targetId) === String(req.authUser._id)) {
      return res.status(400).json({ error: 'You cannot report yourself' });
    }

    // One open report per person per target. Without this, a single user can
    // bury the queue by clicking the same button repeatedly.
    const existing = await Report.findOne({
      reporter: req.authUser._id,
      targetType,
      targetId,
      status: 'open'
    });

    if (existing) {
      return res.status(409).json({ error: 'You have already reported this' });
    }

    // Snapshot whatever the target currently says.
    const snapshot = await snapshotTarget(targetType, targetId);
    if (snapshot === null) {
      return res.status(404).json({ error: 'That content no longer exists' });
    }

    const report = await Report.create({
      reporter: req.authUser._id,
      targetType,
      targetId,
      targetSnapshot: snapshot,
      reason,
      details: String(details).trim()
    });

    console.log(`🚩 Report filed: ${reason} on a ${targetType}`);
    res.json(report);
  } catch (err) {
    console.error('Error filing report:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Read the reported thing and return a short text form of it, or null when it
 * does not exist. Keeps the four collection lookups out of the route body.
 */
async function snapshotTarget(targetType, targetId) {
  if (targetType === 'user') {
    const user = await User.findById(targetId).select('displayName email bio');
    return user ? `${user.displayName} <${user.email}> — ${user.bio || 'no bio'}` : null;
  }

  const Model =
    targetType === 'message' ? Message
      : targetType === 'groupMessage' ? GroupMessage
        : Announcement;

  const doc = await Model.findById(targetId).select('text');
  return doc ? doc.text : null;
}

/**
 * GET /api/admin/reports
 *
 * The moderation queue. Open reports newest-first by default.
 */
app.get('/api/admin/reports', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { status = 'open' } = req.query;

    const reports = await Report.find({ status })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('reporter', 'displayName photoURL role')
      .populate('reviewedBy', 'displayName');

    res.json(reports);
  } catch (err) {
    console.error('Error listing reports:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/admin/reports/:id
 *
 * Close a report as resolved (action taken) or dismissed (nothing to answer).
 *
 * Reports are never deleted — a moderation record that disappears cannot be
 * audited. Re-deciding a closed report is refused for the same reason.
 */
app.patch('/api/admin/reports/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { status, note = '' } = req.body;

    if (!['resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'Status must be resolved or dismissed' });
    }

    const report = await Report.findById(req.params.id);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    if (report.status !== 'open') {
      return res.status(400).json({ error: 'That report is already closed' });
    }

    report.status = status;
    report.reviewedBy = req.authUser._id;
    report.reviewedAt = new Date();
    report.resolutionNote = String(note).trim();
    await report.save();

    console.log(`🚩 Report ${status} by ${req.authUser.displayName}`);
    res.json(
      await Report.findById(report._id)
        .populate('reporter', 'displayName photoURL role')
        .populate('reviewedBy', 'displayName')
    );
  } catch (err) {
    console.error('Error reviewing report:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// MENTORSHIP REST API ENDPOINTS
// ============================================

/** The fields any mentorship response needs about a person. */
const MENTORSHIP_USER_FIELDS = 'displayName photoURL role verification.status';

/**
 * POST /api/mentorships
 *
 * Start a mentorship — from either direction, under deliberately different
 * rules.
 *
 * Body is one of:
 *   { mentorId, topic, message }   a STUDENT asking a mentor  → `pending`
 *   { studentId, topic, message }  a MENTOR adding a student  → `active`
 *
 * ## Why the two directions are not symmetric
 *
 * A student asking costs the mentor time they have not agreed to spend, so it
 * is a request and it waits. A mentor adding a student costs the mentor their
 * own time, which they have just volunteered — there is nobody left to ask.
 * Making them wait for an acceptance would be ceremony, and the mentor is
 * already the one with the standing to decide.
 *
 * The student is not trapped by that: they can ask to opt out (see the PATCH
 * route), and `initiatedBy` records that they never asked for this in the
 * first place, which is exactly the thing an opt-out needs to point at.
 */
app.post('/api/mentorships', requireAuth, async (req, res) => {
  try {
    const { mentorId, studentId, topic, message = '' } = req.body;

    if (!topic?.trim()) {
      return res.status(400).json({ error: 'A topic is required' });
    }

    // Exactly one direction. Both would be ambiguous about who is asking whom,
    // and neither is not a request at all.
    if (Boolean(mentorId) === Boolean(studentId)) {
      return res
        .status(400)
        .json({ error: 'Name either a mentor to ask or a student to add' });
    }

    const addingStudent = Boolean(studentId);
    const otherId = addingStudent ? studentId : mentorId;

    if (String(otherId) === String(req.authUser._id)) {
      return res.status(400).json({ error: 'You cannot mentor yourself' });
    }

    const other = await User.findById(otherId).select('role displayName suspended');
    if (!other) {
      return res.status(404).json({ error: 'That person no longer exists' });
    }

    if (other.suspended) {
      return res.status(400).json({
        error: addingStudent
          ? 'That account is suspended'
          : 'That mentor is not available'
      });
    }

    if (addingStudent) {
      // Only someone who can mentor may take a student on. The role check is
      // on the CALLER here, which is the mirror of the other branch.
      if (!['mentor', 'admin'].includes(req.authUser.role)) {
        return res.status(403).json({ error: 'Only mentors can take on a student' });
      }
      if (['mentor', 'admin'].includes(other.role)) {
        return res
          .status(400)
          .json({ error: 'That person is a mentor — ask them instead of adding them' });
      }
    } else if (!['mentor', 'admin'].includes(other.role)) {
      return res.status(400).json({ error: 'That person is not a mentor' });
    }

    const student = addingStudent ? otherId : req.authUser._id;
    const mentor = addingStudent ? req.authUser._id : otherId;

    // One live relationship per pair. See the note in the model for why this
    // is here rather than a partial unique index.
    const existing = await Mentorship.findOne({
      student,
      mentor,
      status: { $in: ['pending', 'active'] }
    });

    if (existing) {
      return res.status(409).json({
        error:
          existing.status === 'pending'
            ? addingStudent
              ? 'They already have a request waiting with you'
              : 'You already have a request waiting with this mentor'
            : addingStudent
              ? 'You are already mentoring this person'
              : 'You are already being mentored by this person'
      });
    }

    const mentorship = await Mentorship.create({
      student,
      mentor,
      topic: topic.trim(),
      message: String(message).trim(),
      initiatedBy: addingStudent ? 'mentor' : 'student',
      // A mentor adding someone has, by doing so, already answered.
      status: addingStudent ? 'active' : 'pending',
      respondedAt: addingStudent ? new Date() : null
    });

    const populated = await Mentorship.findById(mentorship._id)
      .populate('student', MENTORSHIP_USER_FIELDS)
      .populate('mentor', MENTORSHIP_USER_FIELDS);

    // Tell the other party, on every tab they have open.
    emitToUser(otherId, 'mentorship-updated', populated);

    console.log(
      addingStudent
        ? `🤝 Student added: ${req.authUser.displayName} → ${other.displayName}`
        : `🤝 Mentorship requested: ${req.authUser.displayName} → ${other.displayName}`
    );
    res.json(populated);
  } catch (err) {
    console.error('Error creating mentorship:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/mentorships
 *
 * Everything you are part of, on either side. `?status=` narrows it.
 *
 * Returns both directions in one call rather than making the client ask
 * twice: a person can be a student in one relationship and a mentor in
 * another, and the pages that read this want the whole picture.
 */
app.get('/api/mentorships', requireAuth, async (req, res) => {
  try {
    const { status } = req.query;

    const query = {
      $or: [{ student: req.authUser._id }, { mentor: req.authUser._id }]
    };
    if (status) query.status = status;

    const mentorships = await Mentorship.find(query)
      .sort({ requestedAt: -1 })
      .populate('student', MENTORSHIP_USER_FIELDS)
      .populate('mentor', MENTORSHIP_USER_FIELDS);

    res.json(mentorships);
  } catch (err) {
    console.error('Error listing mentorships:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/mentorships/:id
 *
 * Every move a mentorship can make. Body: `{ action, note }`.
 *
 *   accept / decline    MENTOR, on a pending request.
 *   end                 MENTOR, on an active mentorship — immediate.
 *                       Also the STUDENT, on a *pending* request they made:
 *                       withdrawing something nobody has answered yet is not
 *                       the same act as walking out of a live relationship.
 *   request-optout      STUDENT, on an active mentorship. Needs a reason.
 *   cancel-optout       STUDENT, withdrawing their own opt-out request.
 *   approve-optout      MENTOR — ends it.
 *   decline-optout      MENTOR — it stays active, and the student can see
 *                       they were answered rather than ignored.
 *
 * ## Why the student cannot simply end it
 *
 * Because a mentor can now add a student without being asked, the reverse
 * power has to be a conversation rather than a door: a student who vanishes
 * mid-topic leaves the mentor with goals and sessions attached to nobody, and
 * the reason for leaving is the one piece of information that would let the
 * mentor do better next time. So the student states a reason and the mentor
 * answers it.
 *
 * *This is a real tradeoff and worth naming:* a mentor who ignores an opt-out
 * leaves the student stuck in a mentorship they never asked for, which is the
 * exact situation the opt-out exists to fix. Nothing here expires or escalates
 * yet. The seam for that is `optOut.requestedAt` — a sweep, an admin action,
 * or an auto-approval after N days all hang off it — and it is deliberately
 * left rather than guessed at.
 */
app.patch('/api/mentorships/:id', requireAuth, async (req, res) => {
  try {
    const { action, note = '' } = req.body;

    const ACTIONS = [
      'accept',
      'decline',
      'end',
      'request-optout',
      'cancel-optout',
      'approve-optout',
      'decline-optout'
    ];

    if (!ACTIONS.includes(action)) {
      return res.status(400).json({ error: 'Unknown action' });
    }

    const mentorship = await Mentorship.findById(req.params.id);
    if (!mentorship) {
      return res.status(404).json({ error: 'Mentorship not found' });
    }

    const me = String(req.authUser._id);
    const isMentor = String(mentorship.mentor) === me;
    const isStudent = String(mentorship.student) === me;

    if (!isMentor && !isStudent) {
      return res.status(403).json({ error: 'This is not your mentorship' });
    }

    const trimmedNote = String(note).trim();
    const statusBefore = mentorship.status;

    if (action === 'accept' || action === 'decline') {
      if (!isMentor) {
        return res.status(403).json({ error: 'Only the mentor can answer a request' });
      }
      if (mentorship.status !== 'pending') {
        return res.status(400).json({ error: 'That request has already been answered' });
      }

      mentorship.status = action === 'accept' ? 'active' : 'declined';
      mentorship.respondedAt = new Date();
      mentorship.responseNote = trimmedNote;
    } else if (action === 'end') {
      // A student withdrawing their own unanswered request.
      if (isStudent && mentorship.status === 'pending') {
        mentorship.status = 'ended';
        mentorship.endedAt = new Date();
        mentorship.endedBy = req.authUser._id;
      } else if (isMentor && mentorship.status === 'active') {
        mentorship.status = 'ended';
        mentorship.endedAt = new Date();
        mentorship.endedBy = req.authUser._id;
      } else if (isStudent) {
        return res.status(403).json({
          error: 'Ask your mentor to end this — use the opt-out request'
        });
      } else {
        return res.status(400).json({ error: 'Only an active mentorship can be ended' });
      }
    } else if (action === 'request-optout') {
      if (!isStudent) {
        return res.status(403).json({ error: 'Only the student can ask to opt out' });
      }
      if (mentorship.status !== 'active') {
        return res.status(400).json({ error: 'This mentorship is not active' });
      }
      if (mentorship.optOut.status === 'pending') {
        return res.status(400).json({ error: 'You have already asked to opt out' });
      }
      // The reason is the point of the request, not a nicety: without it the
      // mentor has nothing to answer and nothing to learn from.
      if (!trimmedNote) {
        return res.status(400).json({ error: 'A reason is required' });
      }

      mentorship.optOut.status = 'pending';
      mentorship.optOut.reason = trimmedNote;
      mentorship.optOut.requestedAt = new Date();
      mentorship.optOut.responseNote = '';
      mentorship.optOut.respondedAt = null;
    } else if (action === 'cancel-optout') {
      if (!isStudent) {
        return res.status(403).json({ error: 'Only the student can withdraw this' });
      }
      if (mentorship.optOut.status !== 'pending') {
        return res.status(400).json({ error: 'There is no opt-out request to withdraw' });
      }

      mentorship.optOut.status = 'none';
      mentorship.optOut.reason = '';
      mentorship.optOut.requestedAt = null;
    } else {
      // approve-optout / decline-optout
      if (!isMentor) {
        return res.status(403).json({ error: 'Only the mentor can answer an opt-out' });
      }
      if (mentorship.optOut.status !== 'pending') {
        return res.status(400).json({ error: 'There is no opt-out request to answer' });
      }

      mentorship.optOut.respondedAt = new Date();
      mentorship.optOut.responseNote = trimmedNote;

      if (action === 'approve-optout') {
        mentorship.optOut.status = 'none';
        mentorship.status = 'ended';
        mentorship.endedAt = new Date();
        // The student asked; the mentor only agreed. Recording the mentor as
        // the one who ended it would misread the history later.
        mentorship.endedBy = mentorship.student;
      } else {
        mentorship.optOut.status = 'declined';
      }
    }

    await mentorship.save();

    // Whether a mentorship's material is searchable depends on its status, so
    // every status change - accepted, declined, ended - is one the index hears
    // about. Opt-out requests and answers that leave it active change nothing.
    if (mentorship.status !== statusBefore) syncMentorship(mentorship._id);

    const populated = await Mentorship.findById(mentorship._id)
      .populate('student', MENTORSHIP_USER_FIELDS)
      .populate('mentor', MENTORSHIP_USER_FIELDS);

    // Both sides care about every one of these transitions.
    emitToUser(mentorship.student, 'mentorship-updated', populated);
    emitToUser(mentorship.mentor, 'mentorship-updated', populated);

    console.log(`🤝 Mentorship ${action}: ${mentorship._id}`);
    res.json(populated);
  } catch (err) {
    console.error('Error updating mentorship:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// GOALS AND MILESTONES
// ============================================

// resolveMentorshipAccess lives in lib/reads.js, shared with the agent's tools.

/**
 * GET /api/mentorships/:id/goals
 *
 * Both parties see the same list. Archived goals are included — hiding them
 * would make a goal that was abandoned look like one that never existed.
 */
app.get('/api/mentorships/:id/goals', requireAuth, async (req, res) => {
  try {
    const read = await goalsFor(req.params.id, req.authUser);
    if (read.error) {
      return res.status(read.status).json({ error: read.error });
    }
    res.json(read.data);
  } catch (err) {
    console.error('Error listing goals:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/mentorships/:id/goals
 *
 * MENTOR ONLY, and only on an ACTIVE mentorship.
 *
 * The role split here is the point of the feature: the mentor decides what
 * the student is working towards, and the student reports progress against
 * it. Letting the student set their own goals would make the mentor's part
 * decorative.
 *
 * Body:
 * - title, description
 * - milestones: array of strings, or of `{ title }`
 */
app.post('/api/mentorships/:id/goals', requireAuth, async (req, res) => {
  try {
    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    if (!access.isMentor) {
      return res.status(403).json({ error: 'Only the mentor can set goals' });
    }

    if (access.mentorship.status !== 'active') {
      return res.status(400).json({
        error: 'Goals can only be set on an active mentorship'
      });
    }

    const { title, description = '', milestones = [] } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ error: 'A title is required' });
    }

    if (!Array.isArray(milestones)) {
      return res.status(400).json({ error: 'Milestones must be a list' });
    }

    // Accept either plain strings or objects, so the client can send the
    // simpler shape without the server caring which it chose.
    const cleanMilestones = milestones
      .map((m) => (typeof m === 'string' ? m : m?.title))
      .map((t) => String(t ?? '').trim())
      .filter(Boolean)
      .slice(0, 50)          // a goal with 50 steps is a plan, not a goal
      .map((t) => ({ title: t }));

    const goal = await Goal.create({
      mentorship: req.params.id,
      title: title.trim(),
      description: String(description).trim(),
      milestones: cleanMilestones,
      createdBy: req.authUser._id
    });

    const populated = await Goal.findById(goal._id).populate(
      'createdBy',
      'displayName photoURL'
    );

    // The student is the one who has to act on it.
    emitToUser(access.mentorship.student, 'goal-updated', populated);

    syncSource('goal', goal._id);
    console.log(`🎯 Goal set: "${goal.title}"`);
    res.json(populated);
  } catch (err) {
    console.error('Error creating goal:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/goals/:goalId/milestones/:milestoneId
 *
 * Tick a milestone off, or un-tick it. **Either party** may — the student
 * does the work and reports it, and the mentor can correct a mistake without
 * having to ask. `doneBy` records which of them it was, so "the student says
 * it is done" stays distinguishable from "the mentor confirmed it".
 *
 * The goal's `status` is recomputed here rather than stored independently,
 * so it can never disagree with the milestones it summarises.
 */
app.patch('/api/goals/:goalId/milestones/:milestoneId', requireAuth, async (req, res) => {
  try {
    const { done } = req.body;

    if (typeof done !== 'boolean') {
      return res.status(400).json({ error: 'done must be true or false' });
    }

    const goal = await Goal.findById(req.params.goalId);
    if (!goal) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    const access = await resolveMentorshipAccess(goal.mentorship, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    if (access.mentorship.status !== 'active') {
      return res.status(400).json({
        error: 'Milestones can only be changed on an active mentorship'
      });
    }

    if (goal.status === 'archived') {
      return res.status(400).json({ error: 'That goal is archived' });
    }

    const milestone = goal.milestones.id(req.params.milestoneId);
    if (!milestone) {
      return res.status(404).json({ error: 'Milestone not found' });
    }

    milestone.done = done;
    milestone.doneAt = done ? new Date() : null;
    milestone.doneBy = done ? req.authUser._id : null;

    goal.refreshStatus();
    await goal.save();
    syncSource('goal', goal._id);

    const populated = await Goal.findById(goal._id).populate(
      'createdBy',
      'displayName photoURL'
    );

    // Both sides are watching progress.
    emitToUser(access.mentorship.student, 'goal-updated', populated);
    emitToUser(access.mentorship.mentor, 'goal-updated', populated);

    res.json(populated);
  } catch (err) {
    console.error('Error toggling milestone:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/goals/:goalId
 *
 * Edit or archive a goal. MENTOR ONLY — same reasoning as creating one.
 *
 * Archiving is separate from the derived `active`/`completed` states: it is
 * the one status a person sets, because "we are not doing this any more" is
 * not something the milestones can imply.
 */
app.patch('/api/goals/:goalId', requireAuth, async (req, res) => {
  try {
    const goal = await Goal.findById(req.params.goalId);
    if (!goal) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    const access = await resolveMentorshipAccess(goal.mentorship, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    if (!access.isMentor) {
      return res.status(403).json({ error: 'Only the mentor can change a goal' });
    }

    const { title, description, archived } = req.body;

    if (title !== undefined) {
      if (!String(title).trim()) {
        return res.status(400).json({ error: 'A title is required' });
      }
      goal.title = String(title).trim();
    }

    if (description !== undefined) {
      goal.description = String(description).trim();
    }

    if (archived !== undefined) {
      if (archived) {
        goal.status = 'archived';
      } else {
        // Un-archiving hands the status back to the milestones rather than
        // guessing at 'active' — the goal may well be finished.
        goal.status = 'active';
        goal.refreshStatus();
      }
    }

    await goal.save();
    syncSource('goal', goal._id);

    const populated = await Goal.findById(goal._id).populate(
      'createdBy',
      'displayName photoURL'
    );

    emitToUser(access.mentorship.student, 'goal-updated', populated);
    emitToUser(access.mentorship.mentor, 'goal-updated', populated);

    res.json(populated);
  } catch (err) {
    console.error('Error updating goal:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// SESSIONS - SCHEDULED MEETINGS
// ============================================

// SESSION_POPULATE lives in lib/reads.js, shared with the agent's tools.

/**
 * Re-read a session with its references filled in, for the response and the
 * socket payload. The two have to be the same shape, or the tab that made a
 * change would render it differently from the tab that only watched.
 */
function loadSession(id) {
  return Session.findById(id).populate(SESSION_POPULATE);
}

/** Announce a session to both people in its mentorship. */
function broadcastSession(mentorship, session) {
  emitToUser(mentorship.student, 'session-updated', session);
  emitToUser(mentorship.mentor, 'session-updated', session);
}

/**
 * GET /api/sessions/upcoming
 *
 * The next few sessions across ALL of your mentorships, soonest first. This
 * is the one session query not scoped to a single relationship, and it exists
 * because "when am I next meeting anyone?" is the question people actually
 * have — answering it should not mean opening three pages and comparing.
 *
 * Cancelled and completed sessions are excluded: this is a list of
 * commitments, not history.
 */
app.get('/api/sessions/upcoming', requireAuth, async (req, res) => {
  try {
    res.json((await upcomingSessionsFor(req.authUser)).data);
  } catch (err) {
    console.error('Error listing upcoming sessions:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/mentorships/:id/sessions
 *
 * Every session in one mentorship, newest first. Cancelled ones are included:
 * a gap in the record would make a relationship where meetings kept falling
 * through look like one where nothing was ever arranged.
 *
 * The client splits this into upcoming and past. The server does not, because
 * "upcoming" depends on the clock at read time, and one sorted list is easier
 * to reason about than two that have to agree with each other.
 */
app.get('/api/mentorships/:id/sessions', requireAuth, async (req, res) => {
  try {
    const read = await sessionsFor(req.params.id, req.authUser);
    if (read.error) {
      return res.status(read.status).json({ error: read.error });
    }
    res.json(read.data);
  } catch (err) {
    console.error('Error listing sessions:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/mentorships/:id/sessions
 *
 * Propose a time. EITHER PARTY may, which is the deliberate opposite of the
 * goal routes: a goal is a directive and belongs to the mentor, but a session
 * is a request for time, and the student asking for it is the normal case.
 *
 * A proposal starts as `proposed` and the OTHER person confirms it, so nobody
 * can put a meeting in someone else's week unilaterally.
 *
 * Body: title, agenda, scheduledFor (ISO), durationMinutes
 */
app.post('/api/mentorships/:id/sessions', requireAuth, async (req, res) => {
  try {
    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    if (access.mentorship.status !== 'active') {
      return res.status(400).json({ error: 'That mentorship is not active' });
    }

    const { title, agenda = '', scheduledFor, durationMinutes } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'A title is required' });
    }

    const when = new Date(scheduledFor);
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ error: 'A valid date and time is required' });
    }

    // Refusing the past is a typo guard more than a rule: the wrong year is
    // the easiest thing to get wrong in a date field. A meeting that already
    // happened gets recorded by completing it, not by scheduling it.
    if (when.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Pick a time in the future' });
    }

    const duration = durationMinutes === undefined ? 30 : Number(durationMinutes);
    if (!Number.isInteger(duration) || duration < 5 || duration > 480) {
      return res
        .status(400)
        .json({ error: 'Duration must be between 5 and 480 minutes' });
    }

    const session = await Session.create({
      mentorship: access.mentorship._id,
      title: String(title).trim(),
      agenda: String(agenda).trim(),
      scheduledFor: when,
      durationMinutes: duration,
      proposedBy: req.authUser._id
    });

    const populated = await loadSession(session._id);
    broadcastSession(access.mentorship, populated);

    res.status(201).json(populated);
  } catch (err) {
    console.error('Error creating session:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/sessions/:sessionId
 *
 * One route for every move a session can make. They all share the same
 * permission check and the same broadcast, and four routes would have
 * duplicated both four times.
 *
 * Body: { action, reason, notes, scheduledFor, durationMinutes }
 *
 *   confirm     the other person agrees to the time. NOT the proposer:
 *               confirming your own proposal would make the handshake
 *               decorative.
 *   reschedule  move it. Sends the session back to `proposed` with the mover
 *               as proposer, so the other side has to agree again.
 *   cancel      either party, with an optional reason. Terminal.
 *   complete    either party, but only once the start time has passed.
 *
 * `notes` may be sent with `complete`, or on its own for a session that is
 * already completed. Notes written straight after a meeting usually need a
 * second pass, and there is no reason to make that a different endpoint.
 */
app.patch('/api/sessions/:sessionId', requireAuth, async (req, res) => {
  try {
    const session = await Session.findById(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const access = await resolveMentorshipAccess(session.mentorship, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    if (access.mentorship.status !== 'active') {
      return res.status(400).json({
        error: 'Sessions can only be changed on an active mentorship'
      });
    }

    const { action, reason = '', notes, scheduledFor, durationMinutes } = req.body;
    const me = String(req.authUser._id);

    if (action === 'confirm') {
      if (!session.canBecome('confirmed')) {
        return res
          .status(400)
          .json({ error: 'A ' + session.status + ' session cannot be confirmed' });
      }
      if (String(session.proposedBy) === me) {
        return res
          .status(403)
          .json({ error: 'You proposed this time — the other person confirms it' });
      }

      session.status = 'confirmed';
      session.confirmedAt = new Date();
    } else if (action === 'reschedule') {
      if (!['proposed', 'confirmed'].includes(session.status)) {
        return res
          .status(400)
          .json({ error: 'A ' + session.status + ' session cannot be moved' });
      }

      const when = new Date(scheduledFor);
      if (Number.isNaN(when.getTime())) {
        return res.status(400).json({ error: 'A valid date and time is required' });
      }
      if (when.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'Pick a time in the future' });
      }

      if (durationMinutes !== undefined) {
        const duration = Number(durationMinutes);
        if (!Number.isInteger(duration) || duration < 5 || duration > 480) {
          return res
            .status(400)
            .json({ error: 'Duration must be between 5 and 480 minutes' });
        }
        session.durationMinutes = duration;
      }

      session.scheduledFor = when;
      session.status = 'proposed';
      session.proposedBy = req.authUser._id;
      session.confirmedAt = null;
    } else if (action === 'cancel') {
      if (!session.canBecome('cancelled')) {
        return res
          .status(400)
          .json({ error: 'A ' + session.status + ' session cannot be cancelled' });
      }

      session.status = 'cancelled';
      session.cancelledBy = req.authUser._id;
      session.cancelledAt = new Date();
      session.cancelReason = String(reason).trim().slice(0, 500);
    } else if (action === 'complete') {
      if (!session.canBecome('completed')) {
        return res
          .status(400)
          .json({ error: 'A ' + session.status + ' session cannot be completed' });
      }
      // Marking a future meeting as done is always a mistake, and allowing it
      // would let the history claim things that have not happened.
      if (!session.hasStarted()) {
        return res.status(400).json({ error: 'That session has not started yet' });
      }

      session.status = 'completed';
      session.completedAt = new Date();
    } else if (action !== undefined) {
      return res.status(400).json({ error: 'Unknown action' });
    }

    if (notes !== undefined) {
      // Notes record what happened, so they only make sense once something
      // has. Before that, the agenda is the field for intent.
      if (session.status !== 'completed') {
        return res
          .status(400)
          .json({ error: 'Notes can only be added to a completed session' });
      }
      session.notes = String(notes).trim().slice(0, 2000);
    }

    await session.save();

    const populated = await loadSession(session._id);
    broadcastSession(access.mentorship, populated);

    res.json(populated);
  } catch (err) {
    console.error('Error updating session:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// RESOURCES - SHARED LINKS
// ============================================

/**
 * GET /api/mentorships/:id/resources
 *
 * Everything shared in one mentorship, newest first. Both parties see the
 * same list; there is no private half.
 */
app.get('/api/mentorships/:id/resources', requireAuth, async (req, res) => {
  try {
    const read = await resourcesFor(req.params.id, req.authUser);
    if (read.error) {
      return res.status(read.status).json({ error: read.error });
    }
    res.json(read.data);
  } catch (err) {
    console.error('Error listing resources:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/mentorships/:id/resources
 *
 * Share a link. EITHER PARTY, like sessions and unlike goals: a student
 * finding something useful and pinning it for their mentor is the same act as
 * the reverse, and there is nothing here to approve.
 *
 * Body: title, url, note
 */
app.post('/api/mentorships/:id/resources', requireAuth, async (req, res) => {
  try {
    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    if (access.mentorship.status !== 'active') {
      return res.status(400).json({ error: 'That mentorship is not active' });
    }

    const { title, note = '' } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'A title is required' });
    }

    const link = parseSharedUrl(req.body.url);
    if (link.error) {
      return res.status(400).json({ error: link.error });
    }

    const resource = await Resource.create({
      mentorship: access.mentorship._id,
      title: String(title).trim(),
      url: link.url,
      note: String(note).trim(),
      addedBy: req.authUser._id
    });

    const populated = await Resource.findById(resource._id).populate(
      'addedBy',
      'displayName photoURL'
    );

    syncSource('resource', resource._id);
    emitToUser(access.mentorship.student, 'resource-added', populated);
    emitToUser(access.mentorship.mentor, 'resource-added', populated);

    res.status(201).json(populated);
  } catch (err) {
    console.error('Error sharing resource:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/resources/:resourceId
 *
 * Remove a link. Whoever added it may, and so may the mentor — the mentor
 * because a mentorship's resource list is something they are answerable for,
 * and leaving them unable to take down a bad link would make that
 * responsibility unenforceable.
 *
 * A student cannot remove the mentor's links. That is not symmetry for its
 * own sake: deleting what someone else shared is the one action here with a
 * loser, and the mentor is the party with standing to decide.
 */
app.delete('/api/resources/:resourceId', requireAuth, async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.resourceId);
    if (!resource) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    const access = await resolveMentorshipAccess(resource.mentorship, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    const isOwner = String(resource.addedBy) === String(req.authUser._id);
    if (!isOwner && !access.isMentor) {
      return res.status(403).json({ error: 'Only the person who shared it, or the mentor, can remove it' });
    }

    await resource.deleteOne();
    syncSource('resource', resource._id);

    const payload = { _id: resource._id, mentorship: resource.mentorship };
    emitToUser(access.mentorship.student, 'resource-removed', payload);
    emitToUser(access.mentorship.mentor, 'resource-removed', payload);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error removing resource:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// FEEDBACK - RATING A SESSION
// ============================================

/**
 * PUT /api/sessions/:sessionId/feedback
 *
 * The student rates a session that has happened. PUT rather than POST because
 * it is idempotent by design: submitting again replaces your rating instead
 * of adding a second one, which is what the unique index on (session, from)
 * enforces underneath.
 *
 * Body: { rating: 1-5, comment }
 *
 * Only the student, and only once the session is `completed`. Rating a
 * meeting that has not happened would be rating an intention.
 */
app.put('/api/sessions/:sessionId/feedback', requireAuth, async (req, res) => {
  try {
    const session = await Session.findById(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const access = await resolveMentorshipAccess(session.mentorship, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    // The mentor is the one being rated, so they are not the one rating.
    if (access.isMentor) {
      return res.status(403).json({ error: 'Only the student rates a session' });
    }

    if (session.status !== 'completed') {
      return res.status(400).json({ error: 'That session has not happened yet' });
    }

    const { rating, comment = '' } = req.body;
    const value = Number(rating);

    if (!Number.isInteger(value) || value < 1 || value > 5) {
      return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5' });
    }

    const saved = await Feedback.findOneAndUpdate(
      { session: session._id, from: req.authUser._id },
      {
        $set: {
          mentorship: session.mentorship,
          to: access.mentorship.mentor,
          rating: value,
          comment: String(comment).trim()
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).populate('from', 'displayName photoURL');

    // The mentor should find out without refreshing — this is the one part of
    // a session that arrives after everyone has stopped looking at it.
    emitToUser(access.mentorship.mentor, 'feedback-updated', saved);
    emitToUser(access.mentorship.student, 'feedback-updated', saved);

    res.json(saved);
  } catch (err) {
    console.error('Error saving feedback:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/mentorships/:id/feedback
 *
 * Every rating in one mentorship, keyed by session so the client can hang
 * each one on the session it belongs to. Both parties see the same thing —
 * the mentor because it is about them, the student because it is theirs.
 */
app.get('/api/mentorships/:id/feedback', requireAuth, async (req, res) => {
  try {
    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    const rows = await Feedback.find({ mentorship: req.params.id })
      .populate('from', 'displayName photoURL');

    res.json(rows);
  } catch (err) {
    console.error('Error listing feedback:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/users/:id/feedback
 *
 * A mentor's rating, for their profile: how many, the average, and the most
 * recent comments.
 *
 * The average is rounded to one decimal on the way out. Two decimals would
 * imply a precision that five-point ratings from a handful of sessions do not
 * have, and a bare integer would hide the difference between 4.1 and 4.9.
 *
 * `count` is returned alongside it and the client shows both, because "5.0"
 * from one session and "4.6" from forty are not the same claim.
 */
app.get('/api/users/:id/feedback', requireAuth, async (req, res) => {
  try {
    const [summary] = await Feedback.aggregate([
      { $match: { to: new mongoose.Types.ObjectId(String(req.params.id)) } },
      { $group: { _id: null, count: { $sum: 1 }, average: { $avg: '$rating' } } }
    ]);

    // Comments only — a list of bare numbers tells a reader nothing, and the
    // average above already carries the scores.
    const recent = await Feedback.find({
      to: req.params.id,
      comment: { $ne: '' }
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('from', 'displayName photoURL');

    res.json({
      count: summary?.count || 0,
      average: summary ? Math.round(summary.average * 10) / 10 : null,
      recent
    });
  } catch (err) {
    console.error('Error building feedback summary:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// ASSIGNMENTS - SHARED, CLASSROOM-STYLE
// ============================================

// lateFor, serialiseSubmission and summarise live in lib/reads.js, shared with the agent's tools.

/**
 * Check that every mentorship in a recipient list is the caller's own, active
 * student — and turn the list into documents.
 *
 * Refuses the whole list if any one entry is wrong, rather than silently
 * sending to the valid ones. A mentor who ticked six students and reached
 * five would not know which one was missed.
 */
async function resolveRecipients(mentorshipIds, user) {
  const ids = [
    ...new Set((Array.isArray(mentorshipIds) ? mentorshipIds : []).map(String))
  ];

  if (ids.length === 0) {
    return { error: 'Pick at least one student', status: 400 };
  }

  if (!ids.every((id) => mongoose.isValidObjectId(id))) {
    return { error: 'One of those mentorships does not exist', status: 404 };
  }

  const found = await Mentorship.find({ _id: { $in: ids } });

  if (found.length !== ids.length) {
    return { error: 'One of those mentorships does not exist', status: 404 };
  }

  const me = String(user._id);

  // Only your own students. Setting work for someone else's student would let
  // any mentor put tasks in front of any student in the app.
  if (found.some((m) => String(m.mentor) !== me)) {
    return { error: 'You can only set work for your own students', status: 403 };
  }

  if (found.some((m) => m.status !== 'active')) {
    return { error: 'One of those mentorships is not active', status: 400 };
  }

  return { mentorships: found };
}

// loadOwnAssignment and loadSubmission live in lib/reads.js, shared with the agent's tools.

/** Re-read a submission the way every response shapes it. */
function loadSubmissionForResponse(id) {
  return Submission.findById(id)
    .populate({
      path: 'assignment',
      populate: { path: 'mentor', select: 'displayName photoURL' }
    })
    .populate('student', 'displayName photoURL');
}

/**
 * Tell everyone an assignment touches that it changed.
 *
 * The payload is just the id, and clients refetch. A mentor and a student want
 * differently-shaped answers from the same change — the mentor a summary of
 * six hand-ins, the student only their own — so a single pushed object would
 * be wrong for one of them, and pushing a different one to each would mean
 * duplicating every route's shaping logic inside the socket layer.
 */
function announceAssignment(assignmentId, mentorId, studentIds) {
  const payload = { assignmentId: String(assignmentId) };
  emitToUser(mentorId, 'assignment-changed', payload);
  for (const studentId of studentIds) {
    emitToUser(studentId, 'assignment-changed', payload);
  }
}

/**
 * A short, readable notice for the people it happened to.
 *
 * Separate from `assignment-changed`, which carries only an id and exists so
 * open screens refetch. This is the sentence a person reads, and it says where
 * to look.
 *
 * Nothing is stored. A notice missed while signed out is not something the app
 * owes anybody later — the count in the sidebar is what survives a reload, and
 * it is derived from the work itself rather than from a list of events.
 */
function notifyWork(userIds, text, to = '/assignments') {
  for (const id of userIds) {
    emitToUser(id, 'work-notice', { text, to, at: new Date().toISOString() });
  }
}

/**
 * POST /api/assignments
 *
 * Set work for one or several students at once. MENTOR ONLY, and only for
 * their own active students.
 *
 * One `Submission` row is created per recipient in the same request, with
 * status `assigned` — so "not handed in" is a real state from the first
 * moment, not the absence of a row.
 *
 * Body: title, instructions, dueAt, mentorshipIds[]
 */
app.post('/api/assignments', requireAuth, async (req, res) => {
  try {
    const { title, instructions = '', dueAt, mentorshipIds } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'A title is required' });
    }

    const due = new Date(dueAt);
    if (Number.isNaN(due.getTime())) {
      return res.status(400).json({ error: 'A valid due date is required' });
    }

    // A typo guard more than a rule: work that was overdue the moment it
    // appeared is nobody's intention, and the wrong year is the easiest thing
    // to mistype in a date field.
    if (due.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Pick a due date in the future' });
    }

    const recipients = await resolveRecipients(mentorshipIds, req.authUser);
    if (recipients.error) {
      return res.status(recipients.status).json({ error: recipients.error });
    }

    const assignment = await Assignment.create({
      mentor: req.authUser._id,
      mentorships: recipients.mentorships.map((m) => m._id),
      title: String(title).trim(),
      instructions: String(instructions).trim(),
      dueAt: due
    });

    const assignedAt = new Date();
    const submissions = await Submission.insertMany(
      recipients.mentorships.map((m) => ({
        assignment: assignment._id,
        mentorship: m._id,
        student: m.student,
        // Every history starts here, so the log answers "when was this set
        // for me" as well as everything after it.
        history: [{ type: 'assigned', at: assignedAt, by: req.authUser._id }]
      }))
    );

    // The brief, in each mentorship it was set to. Its hand-ins are empty
    // until a student writes something, so there is nothing more to index.
    syncSource('assignment', assignment._id);

    announceAssignment(
      assignment._id,
      req.authUser._id,
      recipients.mentorships.map((m) => m.student)
    );

    notifyWork(
      recipients.mentorships.map((m) => m.student),
      `${req.authUser.displayName} set new work: ${assignment.title}`
    );

    res.status(201).json({
      ...assignment.toObject(),
      summary: summarise(submissions, due)
    });
  } catch (err) {
    console.error('Error setting assignment:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/assignments
 *
 * Everything on your plate, from both sides of the desk:
 *
 *   set   assignments you set, each with its "4 of 6" summary
 *   mine  your own hand-ins, for work set for you
 *
 * Both are returned because one person can be on both sides — a mentor with
 * a mentor of their own is the ordinary case, not an edge one.
 */
app.get('/api/assignments', requireAuth, async (req, res) => {
  try {
    res.json((await myWorkFor(req.authUser)).data);
  } catch (err) {
    console.error('Error listing assignments:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/assignments/counts
 *
 * The two numbers the sidebar badge is made of, and nothing else: what you owe
 * as a student, and what is waiting on you as a mentor. One person can be
 * both, so both always come back.
 *
 * Declared BEFORE `/api/assignments/:id`, or Express reads "counts" as an id
 * and hands the request to that route instead.
 *
 * Deliberately not the full list. The shell draws this on every page, and a
 * badge is not worth shipping every assignment and hand-in to render.
 */
app.get('/api/assignments/counts', requireAuth, async (req, res) => {
  try {
    res.json((await myWorkCountsFor(req.authUser)).data);
  } catch (err) {
    console.error('Error counting assignments:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/assignments/:id
 *
 * The mentor's view of one assignment: the brief, the summary, and every
 * student's hand-in side by side.
 *
 * MENTOR ONLY — specifically the mentor who set it. A student never sees this
 * route, because it would show them their classmates' work and their
 * classmates' feedback, and neither is theirs to read.
 */
app.get('/api/assignments/:id', requireAuth, async (req, res) => {
  try {
    const read = await assignmentOverviewFor(req.params.id, req.authUser);
    if (read.error) {
      return res.status(read.status).json({ error: read.error });
    }
    res.json(read.data);
  } catch (err) {
    console.error('Error reading assignment:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/mentorships/:id/assignments
 *
 * The work inside one mentorship — one student's hand-ins, whether that
 * student is the one asking or their mentor is. Both parties of the
 * relationship may read it, and nobody else.
 */
app.get('/api/mentorships/:id/assignments', requireAuth, async (req, res) => {
  try {
    const read = await mentorshipWorkFor(req.params.id, req.authUser);
    if (read.error) {
      return res.status(read.status).json({ error: read.error });
    }
    res.json(read.data);
  } catch (err) {
    console.error('Error listing mentorship assignments:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/submissions/:id
 *
 * Save work, and optionally turn it in. ONLY the student it was set for — not
 * the mentor, and not a classmate.
 *
 *   { text, url }                 hand it in (the default)
 *   { text, url, turnIn: false }  save it as a draft: attached, not handed in
 *
 * A piece of work that is already handed in cannot be edited as a draft —
 * Unsubmit first. That keeps "they took it back to change it" an explicit,
 * logged event rather than something that happens silently inside a save,
 * which is the whole point of the history.
 *
 * PUT because it is idempotent: saving again replaces what was there.
 */
app.put('/api/submissions/:id', requireAuth, async (req, res) => {
  try {
    const loaded = await loadSubmission(req.params.id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const { submission } = loaded;

    if (String(submission.student) !== String(req.authUser._id)) {
      return res
        .status(403)
        .json({ error: 'Only the student it was set for can hand this in' });
    }

    const turnIn = req.body.turnIn !== false;

    if (submission.status === 'accepted') {
      return res.status(400).json({ error: 'That work has already been accepted' });
    }

    if (!turnIn && submission.status === 'submitted') {
      return res.status(400).json({ error: 'Unsubmit it first to edit it' });
    }

    if (!submission.canBecome(turnIn ? 'submitted' : 'draft')) {
      return res.status(400).json({ error: 'That is already handed in' });
    }

    const text = String(req.body.text || '').trim();
    const rawUrl = String(req.body.url || '').trim();

    // Files count as work: a hand-in can be a PDF and nothing else.
    if (!text && !rawUrl && submission.attachments.length === 0) {
      return res.status(400).json({ error: 'Write something, add a link or attach a file' });
    }

    let url = '';
    if (rawUrl) {
      // The same allow-list shared resources use. The mentor clicks this.
      const link = parseSharedUrl(rawUrl);
      if (link.error) {
        return res.status(400).json({ error: link.error });
      }
      url = link.url;
    }

    submission.text = text;
    submission.url = url;

    if (turnIn) {
      submission.status = 'submitted';
      submission.submittedAt = new Date();

      // A fresh hand-in is a fresh answer. Leaving the old "change this"
      // hanging over new work would read as a second rejection.
      submission.review.note = '';
      submission.review.reviewedAt = null;

      submission.log('submitted', req.authUser._id);
    } else {
      submission.status = 'draft';
      submission.draftSavedAt = new Date();

      // The review note is kept on a draft: a student editing after being
      // sent back still needs to see what they were asked to change.
      submission.log('draft-saved', req.authUser._id);
    }

    await submission.save();
    syncSource('submission', submission._id);

    // Only this student and the mentor care. A classmate's hand-in changes
    // nothing on anyone else's screen.
    announceAssignment(submission.assignment._id, submission.assignment.mentor, [
      submission.student
    ]);

    // Saving a draft is not news to anyone: the mentor can see it, but it is
    // not waiting on them.
    if (turnIn) {
      notifyWork(
        [submission.assignment.mentor],
        `${req.authUser.displayName} handed in: ${submission.assignment.title}`
      );
    }

    res.json(serialiseSubmission(await loadSubmissionForResponse(submission._id)));
  } catch (err) {
    console.error('Error handing in:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/submissions/:id/unsubmit
 *
 * Take a hand-in back to change it. STUDENT ONLY, and only while it is
 * `submitted`: once accepted it is a record, and letting it be pulled back
 * would let a student quietly rewrite something the mentor already signed
 * off.
 *
 * The work is kept and becomes a draft — unsubmitting is "let me change
 * this", not "throw it away". `submittedAt` is cleared, because after this it
 * is not handed in and lateness derives from it; the history keeps the record
 * of when it was.
 */
app.post('/api/submissions/:id/unsubmit', requireAuth, async (req, res) => {
  try {
    const loaded = await loadSubmission(req.params.id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const { submission } = loaded;

    if (String(submission.student) !== String(req.authUser._id)) {
      return res
        .status(403)
        .json({ error: 'Only the student who handed it in can take it back' });
    }

    if (submission.status !== 'submitted') {
      return res.status(400).json({
        error:
          submission.status === 'accepted'
            ? 'That work has been accepted — it is a record now'
            : 'That is not handed in'
      });
    }

    submission.status = 'draft';
    submission.submittedAt = null;
    submission.draftSavedAt = new Date();
    submission.log('unsubmitted', req.authUser._id);

    await submission.save();
    syncSource('submission', submission._id);

    announceAssignment(submission.assignment._id, submission.assignment.mentor, [
      submission.student
    ]);

    res.json(serialiseSubmission(await loadSubmissionForResponse(submission._id)));
  } catch (err) {
    console.error('Error unsubmitting:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/submissions/:id
 *
 * The mentor reviews ONE student's hand-in: `accept`, or `request-changes`
 * with a note. Only the mentor who set the assignment — being someone's
 * mentor for other work does not make you the reviewer of this.
 *
 * Asking for changes needs a note, because "do it again" with no reason is
 * not feedback and leaves the student guessing.
 */
app.patch('/api/submissions/:id', requireAuth, async (req, res) => {
  try {
    const loaded = await loadSubmission(req.params.id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const { submission } = loaded;

    if (String(submission.assignment.mentor) !== String(req.authUser._id)) {
      return res
        .status(403)
        .json({ error: 'Only the mentor who set this can review it' });
    }

    const { action, note = '' } = req.body;

    if (action !== 'accept' && action !== 'request-changes') {
      return res.status(400).json({ error: 'Unknown action' });
    }

    const next = action === 'accept' ? 'accepted' : 'changes-requested';

    if (!submission.canBecome(next)) {
      return res.status(400).json({
        error:
          submission.status === 'assigned'
            ? 'Nothing has been handed in yet'
            : `A ${submission.status} hand-in cannot be ${next}`
      });
    }

    if (action === 'request-changes' && !String(note).trim()) {
      return res.status(400).json({ error: 'Say what needs changing' });
    }

    submission.status = next;
    submission.review.note = String(note).trim();
    submission.review.reviewedAt = new Date();
    submission.log(next, req.authUser._id);
    await submission.save();
    syncSource('submission', submission._id);

    announceAssignment(submission.assignment._id, submission.assignment.mentor, [
      submission.student
    ]);

    notifyWork(
      [submission.student],
      action === 'accept'
        ? `${req.authUser.displayName} accepted your work: ${submission.assignment.title}`
        : `${req.authUser.displayName} asked for changes: ${submission.assignment.title}`
    );

    res.json(serialiseSubmission(await loadSubmissionForResponse(submission._id)));
  } catch (err) {
    console.error('Error reviewing hand-in:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/assignments/:id
 *
 * Edit the shared part — title, instructions, deadline — or send it to more
 * students. MENTOR ONLY.
 *
 * Editing the brief once changes it for everyone, which is the point of an
 * assignment being one document. Moving the deadline re-derives lateness for
 * every recipient, because late is always relative to the deadline as it now
 * stands; that is what "extend the deadline" means.
 *
 * `addMentorshipIds` covers the student who joins after the work was set:
 * without it, the mentor would have to recreate the assignment and lose every
 * hand-in already made against the original.
 */
app.patch('/api/assignments/:id', requireAuth, async (req, res) => {
  try {
    const own = await loadOwnAssignment(req.params.id, req.authUser);
    if (own.error) {
      return res.status(own.status).json({ error: own.error });
    }
    const { assignment } = own;

    const { title, instructions, dueAt, addMentorshipIds } = req.body;

    if (
      title === undefined &&
      instructions === undefined &&
      dueAt === undefined &&
      addMentorshipIds === undefined
    ) {
      return res.status(400).json({ error: 'Nothing to change' });
    }

    if (title !== undefined) {
      if (!String(title).trim()) {
        return res.status(400).json({ error: 'A title is required' });
      }
      assignment.title = String(title).trim();
    }

    if (instructions !== undefined) {
      assignment.instructions = String(instructions).trim();
    }

    if (dueAt !== undefined) {
      const due = new Date(dueAt);
      if (Number.isNaN(due.getTime())) {
        return res.status(400).json({ error: 'A valid due date is required' });
      }
      if (due.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'Pick a due date in the future' });
      }
      assignment.dueAt = due;
    }

    if (addMentorshipIds !== undefined) {
      const recipients = await resolveRecipients(addMentorshipIds, req.authUser);
      if (recipients.error) {
        return res.status(recipients.status).json({ error: recipients.error });
      }

      // Already-recipients are skipped rather than refused: ticking a student
      // who already has the work is a harmless no-op, not a mistake to report.
      const existing = new Set(assignment.mentorships.map(String));
      const fresh = recipients.mentorships.filter((m) => !existing.has(String(m._id)));

      if (fresh.length) {
        assignment.mentorships.push(...fresh.map((m) => m._id));
        const addedAt = new Date();
        await Submission.insertMany(
          fresh.map((m) => ({
            assignment: assignment._id,
            mentorship: m._id,
            student: m.student,
            // A student added later starts their history when THEY were
            // added, not when the assignment was first set.
            history: [{ type: 'assigned', at: addedAt, by: req.authUser._id }]
          }))
        );

        // Only the students just added. Everybody else already had it, and
        // being told twice about the same assignment is noise.
        notifyWork(
          fresh.map((m) => m.student),
          `${req.authUser.displayName} set new work: ${assignment.title}`
        );
      }
    }

    await assignment.save();
    // Its hand-ins take their title from it, so the service re-syncs them too.
    syncSource('assignment', assignment._id);

    const subs = await Submission.find({ assignment: assignment._id });
    announceAssignment(
      assignment._id,
      assignment.mentor,
      subs.map((s) => s.student)
    );

    res.json({ ...assignment.toObject(), summary: summarise(subs, assignment.dueAt) });
  } catch (err) {
    console.error('Error editing assignment:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/assignments/:id
 *
 * Withdraw work that should not have been set. MENTOR ONLY.
 *
 * Refused once ANY student's hand-in has been accepted: at that point part of
 * it is a record of something a student did, and withdrawing the assignment
 * would erase their work rather than the mentor's mistake.
 *
 * Everything handed in against it goes too, files included.
 */
app.delete('/api/assignments/:id', requireAuth, async (req, res) => {
  try {
    const own = await loadOwnAssignment(req.params.id, req.authUser);
    if (own.error) {
      return res.status(own.status).json({ error: own.error });
    }
    const { assignment } = own;

    const subs = await Submission.find({ assignment: assignment._id });

    if (subs.some((s) => s.status === 'accepted')) {
      return res.status(400).json({
        error: 'Some of this work has been accepted — it is a record now'
      });
    }

    await Submission.deleteMany({ assignment: assignment._id });
    await assignment.deleteOne();

    // The brief and every hand-in, each by name. The assignment's own sync
    // would find its hand-ins' chunks anyway; naming them costs nothing and
    // does not rely on that.
    syncSource('assignment', assignment._id);
    for (const s of subs) syncSource('submission', s._id);

    // Records first, then bytes: if this fails halfway, the worst case is an
    // orphaned file nobody can reach, never a hand-in pointing at nothing.
    const fileIds = subs.flatMap((s) => s.attachments.map((f) => f.fileId));
    await Promise.all(fileIds.map((id) => fileStore.removeFile(id)));

    announceAssignment(
      assignment._id,
      assignment.mentor,
      subs.map((s) => s.student)
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Error withdrawing assignment:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// ASSIGNMENT FILES
// ============================================

/**
 * Upload parsing. Held in memory rather than written to a temp folder: the
 * cap is 10 MB, the bytes go straight on to GridFS, and a hosted server's
 * disk is no place to keep anything anyway.
 *
 * `defParamCharset: 'utf8'` so a name like `résumé.pdf` arrives as itself,
 * not as the Latin-1 misreading of its bytes.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: fileStore.MAX_FILE_BYTES, files: 1, fields: 10 },
  defParamCharset: 'utf8'
});

/** Why a hand-in's files cannot change right now, or null if they can. */
function frozenReason(submission) {
  if (submission.status === 'submitted') return 'Unsubmit it first to change it';
  if (submission.status === 'accepted') return 'That work has already been accepted';
  return null;
}

/**
 * `attachment; filename=…` in the form every browser reads: an ASCII
 * fallback, plus the real name percent-encoded (RFC 6266) so `résumé.pdf`
 * downloads as itself.
 */
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Everything checked BEFORE the upload is read: who is asking, and whether
 * this hand-in can take another file. Someone who may not attach here is
 * turned away without the server buffering their 10 MB first.
 */
async function canAttach(req, res, next) {
  try {
    const loaded = await loadSubmission(req.params.id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const { submission } = loaded;

    if (String(submission.student) !== String(req.authUser._id)) {
      return res
        .status(403)
        .json({ error: 'Only the student it was set for can attach files' });
    }

    const frozen = frozenReason(submission);
    if (frozen) {
      return res.status(400).json({ error: frozen });
    }

    if (submission.attachments.length >= fileStore.MAX_FILES_PER_SUBMISSION) {
      return res.status(400).json({
        error: `Up to ${fileStore.MAX_FILES_PER_SUBMISSION} files per hand-in`
      });
    }

    req.submission = submission;
    next();
  } catch (err) {
    console.error('Error checking upload:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

/** Parse the one file, turning multer's errors into the app's JSON ones. */
function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `Files can be up to ${fileStore.MAX_FILE_BYTES / (1024 * 1024)} MB`
      });
    }

    // Anything else is a malformed request — a second file, a stray field.
    res.status(400).json({ error: 'Send one file, in a field called "file"' });
  });
}

/**
 * POST /api/submissions/:id/files
 *
 * Attach one file to your own work. STUDENT ONLY, and only while the work can
 * still change — handed-in work is frozen until it is unsubmitted, exactly as
 * its text is.
 *
 * Attaching IS saving a draft: the work becomes "attached, not handed in",
 * which the mentor can see. That is how Classroom behaves, and it is the very
 * state the mentor asked to be able to see.
 */
app.post(
  '/api/submissions/:id/files',
  requireAuth,
  canAttach,
  receiveFile,
  async (req, res) => {
    // Set once the bytes are stored and cleared once they are recorded, so a
    // failure in between can take back a file nothing points at.
    let unrecorded = null;

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Choose a file to attach' });
      }
      if (req.file.size === 0) {
        return res.status(400).json({ error: 'That file is empty' });
      }

      const checked = fileStore.checkFile(req.file.originalname);
      if (checked.error) {
        return res.status(400).json({ error: checked.error });
      }

      const { submission } = req;

      const fileId = await fileStore.saveFile(req.file.buffer, {
        name: checked.name,
        contentType: checked.contentType,
        metadata: { submission: submission._id, uploadedBy: req.authUser._id }
      });
      unrecorded = fileId;

      submission.attachments.push({
        fileId,
        name: checked.name,
        size: req.file.size,
        contentType: checked.contentType,
        uploadedAt: new Date()
      });
      submission.status = 'draft';
      submission.draftSavedAt = new Date();
      submission.log('file-attached', req.authUser._id, checked.name);

      await submission.save();
      unrecorded = null;
      syncSource('submission', submission._id);

      announceAssignment(submission.assignment._id, submission.assignment.mentor, [
        submission.student
      ]);

      res
        .status(201)
        .json(serialiseSubmission(await loadSubmissionForResponse(submission._id)));
    } catch (err) {
      console.error('Error attaching file:', err);
      if (unrecorded) await fileStore.removeFile(unrecorded).catch(() => {});
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * GET /api/submissions/:id/files/:fileId
 *
 * Download one file: the student it belongs to, and the mentor who set the
 * assignment — the same two people who can read the hand-in. The file is
 * found THROUGH the hand-in, so an id from anywhere else finds nothing.
 *
 * Served so that it can never run as part of this app, whatever is in it:
 *
 * - `Content-Disposition: attachment` — the browser saves it, never shows it
 * - a Content-Type the server chose from the extension at upload time
 * - `nosniff`, so the browser does not second-guess that type
 * - a CSP sandbox, in case anyone opens the URL directly anyway
 */
app.get('/api/submissions/:id/files/:fileId', requireAuth, async (req, res) => {
  try {
    const loaded = await loadSubmission(req.params.id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const { submission } = loaded;

    if (!canReadSubmissionFile(submission, req.authUser)) {
      return res
        .status(403)
        .json({ error: 'Only the student and the mentor who set this can open it' });
    }

    const attachment = submission.attachments.find(
      (f) => String(f.fileId) === String(req.params.fileId)
    );
    const file = attachment && (await fileStore.findFile(attachment.fileId));
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.setHeader('Content-Type', attachment.contentType);
    res.setHeader('Content-Length', String(file.length));
    res.setHeader('Content-Disposition', contentDisposition(attachment.name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');

    fileStore
      .openFile(attachment.fileId)
      .on('error', (err) => {
        console.error('Error streaming file:', err);
        res.destroy(err);
      })
      .pipe(res);
  } catch (err) {
    console.error('Error downloading file:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/submissions/:id/files/:fileId
 *
 * Remove a file from your own work, under the same rules as attaching:
 * student only, and not while it is handed in. The record goes first and the
 * bytes second — a failure between the two leaves an unreachable file, never
 * a hand-in listing a file that is gone.
 */
app.delete('/api/submissions/:id/files/:fileId', requireAuth, async (req, res) => {
  try {
    const loaded = await loadSubmission(req.params.id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const { submission } = loaded;

    if (String(submission.student) !== String(req.authUser._id)) {
      return res
        .status(403)
        .json({ error: 'Only the student it was set for can remove files' });
    }

    const frozen = frozenReason(submission);
    if (frozen) {
      return res.status(400).json({ error: frozen });
    }

    const index = submission.attachments.findIndex(
      (f) => String(f.fileId) === String(req.params.fileId)
    );
    if (index === -1) {
      return res.status(404).json({ error: 'File not found' });
    }

    const [removed] = submission.attachments.splice(index, 1);
    submission.status = 'draft';
    submission.draftSavedAt = new Date();
    submission.log('file-removed', req.authUser._id, removed.name);

    await submission.save();
    await fileStore.removeFile(removed.fileId);
    syncSource('submission', submission._id);

    announceAssignment(submission.assignment._id, submission.assignment.mentor, [
      submission.student
    ]);

    res.json(serialiseSubmission(await loadSubmissionForResponse(submission._id)));
  } catch (err) {
    console.error('Error removing file:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// MENTORSHIP COPILOT - RETRIEVAL
// ============================================

/**
 * Where the retrieval service lives, and the secret it expects.
 *
 * Unset by default: with no URL configured the route answers 503 rather than
 * failing obscurely, so a clone without the Python service still runs and
 * still passes its tests.
 */
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || '';
const AI_SERVICE_SECRET = process.env.AI_SERVICE_SECRET || '';

/**
 * The key agent capability tokens are signed with (lib/agentToken.js).
 *
 * Unset: the agent's tool endpoint answers 503 and nothing else changes. Set
 * but unusable (too short, or the same as AI_SERVICE_SECRET, which the AI
 * service holds and could therefore mint with): refuse to start, rather than
 * run with a key that does not do its job.
 */
const AGENT_TOKEN_SECRET = process.env.AGENT_TOKEN_SECRET || '';
if (AGENT_TOKEN_SECRET) {
  const problem = agentToken.secretProblem(AGENT_TOKEN_SECRET, AI_SERVICE_SECRET);
  if (problem) {
    console.error(`\n${problem}. See server/.env.example.\n`);
    process.exit(1);
  }
}

/**
 * The key the agent's write proposals are signed with (lib/agentProposal.js).
 * Only Express holds it. Unset, nothing can be proposed or claimed and every read
 * still works; set but unusable, the server refuses to start.
 */
const AGENT_PROPOSAL_SECRET = process.env.AGENT_PROPOSAL_SECRET || '';
if (AGENT_PROPOSAL_SECRET) {
  const problem = agentProposal.secretProblem(AGENT_PROPOSAL_SECRET, AI_SERVICE_SECRET, AGENT_TOKEN_SECRET);
  if (problem) {
    console.error(`\n${problem}. See server/.env.example.\n`);
    process.exit(1);
  }
}

/**
 * Whether the assistant works in this mentorship, and if not, what to say.
 *
 * Only active mentorships are indexed, so anywhere else it could only answer "I
 * couldn't find that" about material the user can still open. Product decision,
 * 2 Nov: refuse plainly instead (BUILD_NOTES Entry 75).
 *
 * 409 rather than 403 or 503: 403 already means "not your mentorship" and 503 a
 * broken service. The request is fine; this mentorship's state does not allow it.
 * Always checked after resolveMentorshipAccess, so an outsider gets the same
 * 403 whatever the status is, and learns nothing from it.
 */
function assistantRefusal(mentorship) {
  if (mentorship.status === 'active') return null;
  return mentorship.status === 'ended'
    ? "The assistant isn't available for ended mentorships."
    : 'The assistant is only available in active mentorships.';
}

/**
 * POST /api/mentorships/:id/copilot/search
 *
 * Ask a question about ONE mentorship's own material. Both parties may ask;
 * nobody else may, which is the entire point of this route existing.
 *
 * ## Why Express is in the middle
 *
 * The retrieval service trusts the `mentorshipId` and `viewerId` it is given.
 * It has to - it never sees a Firebase token and could not verify one. So the
 * membership check happens HERE, against the database, before the service is
 * called at all:
 *
 *   token -> requireAuth -> resolveMentorshipAccess -> retrieval
 *
 * The service is bound to localhost and requires a shared secret on top of
 * that. Neither of those is the access check; they are what stops anything
 * else on the machine from skipping it.
 *
 * The viewer id is taken from `req.authUser`, never from the body. A caller
 * cannot ask "what would somebody else be allowed to see".
 */
app.post('/api/mentorships/:id/copilot/search', requireAuth, async (req, res) => {
  try {
    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }
    const refusal = assistantRefusal(access.mentorship);
    if (refusal) {
      return res.status(409).json({ error: refusal });
    }

    const query = String(req.body?.query || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'Ask a question' });
    }
    if (query.length > 1000) {
      return res.status(400).json({ error: 'That question is too long' });
    }

    if (!AI_SERVICE_URL || !AI_SERVICE_SECRET) {
      return res.status(503).json({ error: 'The Copilot is not configured on this server' });
    }

    // A slow model must not hold an Express connection open indefinitely.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    let answer;
    try {
      const upstream = await fetch(`${AI_SERVICE_URL}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AI-Secret': AI_SERVICE_SECRET
        },
        body: JSON.stringify({
          mentorshipId: String(req.params.id),
          // From the verified identity, never from the request body.
          viewerId: String(req.authUser._id),
          // Four by default, matching the retrieval service's own default:
          // from S2 these chunks go into a prompt, where every extra one is
          // both more context and more chance of a distractor. Still clamped
          // to 1-10, so a caller cannot ask for the whole index.
          query,
          k: Math.min(Math.max(Number(req.body?.k) || 4, 1), 10)
        }),
        signal: controller.signal
      });

      if (!upstream.ok) {
        console.error('Retrieval service answered', upstream.status);
        return res.status(502).json({ error: 'The Copilot could not answer that' });
      }

      answer = await upstream.json();
    } finally {
      clearTimeout(timer);
    }

    res.json(answer);
  } catch (err) {
    // An aborted fetch and a service that is not running look the same to a
    // caller: the question was not answered, and it is not their fault.
    console.error('Error asking the Copilot:', err.name === 'AbortError' ? 'timed out' : err);
    res.status(502).json({ error: 'The Copilot could not answer that' });
  }
});

/**
 * How long Express waits for an answer, in milliseconds. Set from measured
 * latency (BUILD_NOTES Entry 67): the answering service gives the provider at
 * most 8 s (ai/config.py, ASK_BUDGET_S), about seven times the slowest of the
 * live calls measured before this route existed, with room for one retry;
 * search adds about half a second with the reranker on. Ten seconds covers both. This is NOT
 * search's 15 s stretched: it is shorter, because a turn that has not
 * answered in ten seconds is not going to.
 */
const COPILOT_ASK_TIMEOUT_MS = Number(process.env.COPILOT_ASK_TIMEOUT_MS) || 10000;

/**
 * Asks per person per minute. Every ask is a call on a free-tier quota the
 * whole app shares (15 a minute, 500 a day on Gemini), so one person must not
 * be able to spend it. In memory, per process: a restart forgets it, which at
 * this scale costs nothing, and the provider layer's own count is the limit
 * that actually protects the quota.
 */
const COPILOT_ASKS_PER_MINUTE = Number(process.env.COPILOT_ASKS_PER_MINUTE) || 5;
const askTimes = new Map(); // user id -> timestamps of their recent asks

function allowAsk(userId) {
  const now = Date.now();
  const recent = (askTimes.get(userId) || []).filter((t) => now - t < 60000);
  if (recent.length >= COPILOT_ASKS_PER_MINUTE) {
    askTimes.set(userId, recent);
    return false;
  }
  recent.push(now);
  askTimes.set(userId, recent);
  return true;
}

/**
 * POST /api/mentorships/:id/copilot/ask
 *
 * An answer about ONE mentorship's material, citing what it was built from.
 * Same boundary as /copilot/search, plus one more thing decided here and
 * nowhere else: **who is asking, in this mentorship**.
 *
 *   token -> requireAuth -> resolveMentorshipAccess -> role -> answer
 *
 * The role is the asker's position in the mentorship RECORD - its `mentor` or
 * its `student` - as resolveMentorshipAccess found it. Not the user's account
 * role (an admin who mentors one student is that student's mentor, and nobody
 * else's anything), and never anything in the request body or the question:
 * the body's `question` is the only field read, and anyone who is neither
 * party has already been refused before the service is called.
 *
 * Statuses: 200 for an answer or an abstention (both are the system working);
 * 400 for an empty or over-long question; 429 when this person has asked too
 * often, or the provider's limit is reached; 503 when generation is not
 * configured or unavailable; 502 for anything else that went wrong upstream,
 * a timeout included. Every error body is one plain sentence.
 *
 * A mentorship that is not active is refused with a 409, after the membership
 * check, so an outsider gets the same 403 whatever its status is
 * (assistantRefusal; BUILD_NOTES Entry 75).
 */
app.post('/api/mentorships/:id/copilot/ask', requireAuth, async (req, res) => {
  try {
    // Synthetic databases only, as for the agent. Before anything else is read.
    if (agentDatabaseRefusal(mongoose.connection.name)) {
      return res.status(503).json({ error: 'The Copilot is not configured on this server' });
    }

    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }
    const refusal = assistantRefusal(access.mentorship);
    if (refusal) {
      return res.status(409).json({ error: refusal });
    }
    // From the mentorship record. resolveMentorshipAccess has refused anyone
    // who is neither its mentor nor its student, so "not mentor" is "student".
    const role = access.isMentor ? 'mentor' : 'student';

    const question = String(req.body?.question || '').trim();
    if (!question) {
      return res.status(400).json({ error: 'Ask a question' });
    }
    if (question.length > 1000) {
      return res.status(400).json({ error: 'That question is too long' });
    }

    if (!AI_SERVICE_URL || !AI_SERVICE_SECRET) {
      return res.status(503).json({ error: 'The Copilot is not configured on this server' });
    }

    if (!allowAsk(String(req.authUser._id))) {
      return res
        .status(429)
        .json({ error: "You're asking faster than the Copilot can answer. Wait a minute and try again." });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COPILOT_ASK_TIMEOUT_MS);

    let upstream;
    let body;
    try {
      // The two parties' names, for a prompt that needs to know who a name refers
      // to: from their user records, by the ids on the mentorship, never the body.
      const parties = await User.find({
        _id: { $in: [access.mentorship.mentor, access.mentorship.student] }
      }).select('displayName');
      const nameOf = (id) =>
        String(parties.find((p) => String(p._id) === String(id))?.displayName || '').slice(0, 200);

      upstream = await fetch(`${AI_SERVICE_URL}/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AI-Secret': AI_SERVICE_SECRET
        },
        body: JSON.stringify({
          mentorshipId: String(req.params.id),
          // Both from the verified identity and the mentorship record, never
          // from the request body.
          viewerId: String(req.authUser._id),
          role,
          question,
          mentorName: nameOf(access.mentorship.mentor),
          studentName: nameOf(access.mentorship.student)
        }),
        signal: controller.signal
      });
      body = await upstream.json().catch(() => null);
    } finally {
      clearTimeout(timer);
    }

    if (upstream.ok && body) {
      return res.json(body);
    }
    // The service's own plain sentence for a provider problem it recognised;
    // anything else is one generic sentence, never the upstream's text.
    if ([429, 502, 503].includes(upstream.status) && typeof body?.message === 'string') {
      return res.status(upstream.status).json({ error: body.message, promptVersion: body.promptVersion });
    }
    console.error('Answering service answered', upstream.status);
    return res.status(502).json({ error: 'The Copilot could not answer that' });
  } catch (err) {
    console.error('Error asking the Copilot:', err.name === 'AbortError' ? 'timed out' : err);
    res.status(502).json({ error: 'The Copilot could not answer that' });
  }
});

// ============================================
// MENTORSHIP COPILOT - AGENT (S4)
// ============================================

/**
 * Whether the panel uses the agent rather than S2's answer. On unless the setting
 * says otherwise (S4's evaluation, BUILD_NOTES Entry 108). Any value that is not
 * on, 1 or true, a blank included, turns it off: the agent route then answers "not
 * configured" and the panel asks /copilot/ask, S2's path. Being on does not widen
 * where it runs: agentUnavailable still refuses any database not on the list.
 */
const COPILOT_AGENT = ['1', 'true', 'on'].includes(String(process.env.COPILOT_AGENT ?? 'on').trim().toLowerCase());

/**
 * How long Express waits for one agent turn, in milliseconds. The capability
 * token expires with it. Measured (BUILD_NOTES Entry 101): 12 turns on the demo,
 * median 2.5 s, slowest 10.4 s (a whole-file summary, 10 model calls). The AI
 * service gives a turn 30 s (AGENT_BUDGET_S, about three times that); this is
 * that plus room for the token, the tools' round trips and the response.
 */
const COPILOT_AGENT_TIMEOUT_MS = Number(process.env.COPILOT_AGENT_TIMEOUT_MS) || 35000;

/**
 * The most model calls one turn can make: the turn's own cap (4, ai/config.py
 * AGENT_MAX_MODEL_CALLS) plus one file summary's (6 sections and 1 to combine
 * them). What a turn reserves from the budget before it starts.
 */
const AGENT_TURN_MAX_CALLS = 11;

/**
 * Each person's share, in model calls (lib/agentBudget.js). 60 a day is an
 * eighth of the 480, and is the share that protects the allowance. 15 a minute
 * is Gemini's own limit for the whole app: the AI service's count enforces that
 * across everyone, and this only stops one person bursting past it. It was 12,
 * and measured (BUILD_NOTES Entry 101): with a turn reserving 11, a second turn
 * after a typical 2-call one needed 13, so each person could ask about once a
 * minute. At 15, about three typical turns a minute.
 */
const agentBudget = new ModelCallBudget({
  perMinute: Number(process.env.AGENT_CALLS_PER_MINUTE) || 15,
  perDay: Number(process.env.AGENT_CALLS_PER_DAY) || 60
});

const AGENT_LIMIT = {
  minute: "You're asking faster than the assistant can answer. Wait a minute and try again.",
  day: "You've reached today's limit for the assistant. It will be available again tomorrow."
};

/** Why the agent cannot run on this server, or null. Checked before anything else. */
function agentUnavailable() {
  if (!COPILOT_AGENT) return AGENT_NOT_CONFIGURED;
  if (!AI_SERVICE_URL || !AI_SERVICE_SECRET || !AGENT_TOKEN_SECRET) return AGENT_NOT_CONFIGURED;
  return agentDatabaseRefusal(mongoose.connection.name);
}

/**
 * GET /api/copilot/mode
 *
 * Which of the two the panel should use: `agent` only when the agent can run
 * here, otherwise `ask`. Says nothing about why.
 */
app.get('/api/copilot/mode', requireAuth, (req, res) => {
  res.json({ mode: agentUnavailable() ? 'ask' : 'agent' });
});

/**
 * POST /api/mentorships/:id/copilot/agent
 *
 * One agent turn about ONE mentorship: the agent may look things up with its
 * read tools, as the asker, and answers citing what it looked at.
 *
 *   token -> requireAuth -> agent may run here (setting, synthetic database)
 *     -> resolveMentorshipAccess -> active -> role -> question
 *     -> this person's share of the model calls -> capability token -> turn
 *
 * The role is the asker's position in the mentorship record, as for /ask. The
 * capability token names this user, this mentorship and that role, for this
 * turn only; it is sent to the AI service and to nothing else, and never
 * logged. Every tool call comes back through /internal/agent/tools with it,
 * where all of this is checked again.
 *
 * Statuses: 200 for every turn that ran (answered, abstained, stopped by a cap,
 * or refused partway; the body says which); 400 for an empty or over-long
 * question; 409 for a mentorship that is not active; 429 when this person's
 * share is used, or the provider's limit is reached; 503 when the agent is not
 * configured here, the database included; 502 for anything else upstream, a
 * timeout included. Every error body is one plain sentence.
 */
app.post('/api/mentorships/:id/copilot/agent', requireAuth, async (req, res) => {
  try {
    const unavailable = agentUnavailable();
    if (unavailable) {
      return res.status(503).json({ error: unavailable });
    }

    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }
    const refusal = assistantRefusal(access.mentorship);
    if (refusal) {
      return res.status(409).json({ error: refusal });
    }
    const role = access.isMentor ? 'mentor' : 'student';

    const question = String(req.body?.question || '').trim();
    if (!question) {
      return res.status(400).json({ error: 'Ask a question' });
    }
    if (question.length > 1000) {
      return res.status(400).json({ error: 'That question is too long' });
    }

    const reserved = agentBudget.reserve(String(req.authUser._id), AGENT_TURN_MAX_CALLS);
    if (reserved.limit) {
      return res.status(429).json({ error: AGENT_LIMIT[reserved.limit] });
    }

    const parties = await User.find({
      _id: { $in: [access.mentorship.mentor, access.mentorship.student] }
    }).select('displayName');
    const nameOf = (id) =>
      String(parties.find((p) => String(p._id) === String(id))?.displayName || '').slice(0, 200);

    // Also the proposal's id, if this turn makes one.
    const threadId = agentProposal.newProposalId();

    const { token } = agentToken.mintAgentToken(AGENT_TOKEN_SECRET, {
      userId: String(req.authUser._id),
      mentorshipId: String(access.mentorship._id),
      role,
      turnMs: COPILOT_AGENT_TIMEOUT_MS
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COPILOT_AGENT_TIMEOUT_MS);
    let upstream;
    let body;
    try {
      upstream = await fetch(`${AI_SERVICE_URL}/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AI-Secret': AI_SERVICE_SECRET },
        body: JSON.stringify({
          mentorshipId: String(access.mentorship._id),
          viewerId: String(req.authUser._id),
          role,
          question,
          token,
          threadId,
          mentorName: nameOf(access.mentorship.mentor),
          studentName: nameOf(access.mentorship.student)
        }),
        signal: controller.signal
      });
      body = await upstream.json().catch(() => null);
    } finally {
      clearTimeout(timer);
    }

    // What the turn spent, if it says; otherwise it keeps its reservation.
    if (body && Number.isFinite(body.modelCalls)) {
      agentBudget.settle(reserved.entry, body.modelCalls + (Number(body.summaryCalls) || 0));
    }
    // One line per turn: as what, how it ended, what it spent. Never the
    // question, the answer, the token or anyone's id.
    console.log(
      `agent turn as ${role}: ${upstream.status} ${body?.status || '-'}, ` +
        `${body?.modelCalls ?? '?'} model calls, ${body?.toolCalls ?? '?'} tool calls`
    );

    // A proposal never goes back as the service sent it: Express checks it, builds what a
    // person will be shown, signs it, and that token is all the browser receives.
    if (upstream.ok && body?.status === 'proposal') {
      return res.json(
        await proposalFromTurn({
          body,
          threadId,
          user: req.authUser,
          mentorship: access.mentorship,
          role,
          question,
          parties: { mentor: nameOf(access.mentorship.mentor), student: nameOf(access.mentorship.student) }
        })
      );
    }

    if (upstream.ok && body) {
      return res.json(body);
    }
    if ([429, 502, 503].includes(upstream.status) && typeof body?.message === 'string') {
      return res.status(upstream.status).json({ error: body.message });
    }
    return res.status(502).json({ error: 'The Copilot could not answer that' });
  } catch (err) {
    console.error('Error running an agent turn:', err.name === 'AbortError' ? 'timed out' : err.message);
    res.status(502).json({ error: 'The Copilot could not answer that' });
  }
});

// ============================================
// AGENT PROPOSALS (S5)
// ============================================

const PROPOSAL_EXPIRED = 'That proposal has expired. Ask again if you still want it.';
const PROPOSAL_USED = 'That proposal has already been used.';
/** What a turn spent, kept on a proposal or a refusal. Counts and names only. */
const TURN_FIGURES = ['modelCalls', 'toolCalls', 'inputTokens', 'summaryCalls', 'summaryInputTokens', 'promptVersion', 'provider', 'model', 'steps'];
const AGENT_THREAD_TIMEOUT_MS = 3000;

/** One short call to the AI service about a paused turn. Null if it did not answer properly. */
async function callPausedTurn(path, body) {
  try {
    const upstream = await fetch(`${AI_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AI-Secret': AI_SERVICE_SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AGENT_THREAD_TIMEOUT_MS)
    });
    return upstream.ok ? await upstream.json().catch(() => null) : null;
  } catch {
    return null;
  }
}

/** The names the dialog shows, from the mentorship record. */
async function partyNames(mentorship) {
  const people = await User.find({ _id: { $in: [mentorship.mentor, mentorship.student] } }).select('displayName');
  const nameOf = (id) => String(people.find((p) => String(p._id) === String(id))?.displayName || '').slice(0, 200);
  return { mentor: nameOf(mentorship.mentor), student: nameOf(mentorship.student) };
}

/**
 * A model's call to a write tool, made into something a person can approve, or refused.
 *
 *   the turn it came from -> a tool we list, for this role -> agentWrites.prepare
 *     -> signed -> recorded as pending
 *
 * The tool and its arguments come from the AI service, so they are checked as if they
 * came from anywhere. Who is asking, where, and in what role come from the route's own
 * checks. The browser is sent the token and the turn's figures, and nothing else.
 * A refusal says why with one of a fixed set of reasons, and ends the paused turn.
 */
async function proposalFromTurn({ body, threadId, user, mentorship, role, question, parties }) {
  const figures = Object.fromEntries(TURN_FIGURES.filter((k) => k in body).map((k) => [k, body[k]]));
  const decline = async (reason) => {
    await callPausedTurn('/agent/resume', { threadId, decision: 'dismissed' });
    return { ...figures, status: 'declined', reason };
  };

  if (!AGENT_PROPOSAL_SECRET || body.threadId !== threadId) return decline('unavailable');

  const built = await agentWrites.prepare(body.tool, { input: body.args, user, mentorship, role, parties });
  if (built.refuse) return decline(built.refuse);

  const { token, exp } = agentProposal.signProposal(AGENT_PROPOSAL_SECRET, {
    pid: threadId,
    tool: body.tool,
    args: built.args,
    heading: built.heading,
    fields: built.fields,
    asked: question,
    userId: user._id,
    mentorshipId: mentorship._id,
    role
  });
  await AgentProposal.create({
    _id: threadId,
    user: user._id,
    mentorship: mentorship._id,
    tool: body.tool,
    // Past the token's own expiry: this record must outlast anything that could use it.
    expiresAt: new Date((exp + 60) * 1000)
  });
  return { ...figures, status: 'proposal', proposal: token };
}

/**
 * POST /api/copilot/proposals/claim
 *
 * The person clicked Approve. This uses the proposal up BEFORE the browser runs
 * anything, so a double click, a retry or a replay cannot run it twice.
 *
 *   token -> requireAuth -> agent may run here -> proposal verified -> it is this
 *   person's -> resolveMentorshipAccess -> same role -> still active -> a tool we
 *   list, for that role -> it still says what they approved -> its turn is still
 *   paused -> atomically pending to claimed
 *
 * It writes nothing but the claim. The write is the real route, called next by the
 * browser with the person's own token, so it passes every check a manual one does.
 *
 * Statuses: 200 claimed; 410 expired, not a proposal we signed, or its paused turn
 * was lost to a restart (the same answer for all three); 403 not this person's, or
 * not their role; 409 already used (`reason: used`), the mentorship is no longer
 * active (`reason: ended`), or what it describes has changed since it was shown
 * (`reason: changed`); 503 not configured here, or the AI service did not say
 * the turn is waiting. A refusal before the last step leaves it unused.
 */
app.post('/api/copilot/proposals/claim', requireAuth, async (req, res) => {
  try {
    if (agentUnavailable() || !AGENT_PROPOSAL_SECRET) {
      return res.status(503).json({ error: AGENT_NOT_CONFIGURED });
    }

    let claims;
    try {
      claims = agentProposal.verifyProposal(AGENT_PROPOSAL_SECRET, req.body?.proposal);
    } catch {
      return res.status(410).json({ error: PROPOSAL_EXPIRED });
    }

    const me = String(req.authUser._id);
    if (claims.sub !== me) {
      return res.status(403).json({ error: 'That proposal is not yours' });
    }

    const access = await resolveMentorshipAccess(claims.mid, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }
    const refusal = assistantRefusal(access.mentorship);
    if (refusal) {
      return res.status(409).json({ error: refusal, reason: 'ended' });
    }
    const role = access.isMentor ? 'mentor' : 'student';
    if (role !== claims.role) {
      return res.status(403).json({ error: 'Your place in this mentorship has changed' });
    }

    const tool = agentWrites.writeTool(claims.tool);
    if (!tool || !tool.roles.includes(role)) {
      return res.status(403).json({ error: 'That is not something the assistant can do for you' });
    }

    // What the person approved must still be true: the deadline they saw, the session still open.
    const still = await agentWrites.recheck(claims, {
      user: req.authUser,
      mentorship: access.mentorship,
      role,
      parties: await partyNames(access.mentorship)
    });
    if (still.refuse) {
      return res.status(409).json({ error: 'That has changed since it was proposed', reason: 'changed' });
    }

    // Asked before the claim, so a service that is down costs nobody their proposal.
    const turn = await callPausedTurn('/agent/paused', { threadId: claims.jti });
    if (!turn) {
      return res.status(503).json({ error: AGENT_NOT_CONFIGURED });
    }
    if (turn.paused !== true) {
      return res.status(410).json({ error: PROPOSAL_EXPIRED });
    }

    const claimed = await AgentProposal.findOneAndUpdate(
      {
        _id: claims.jti,
        user: req.authUser._id,
        mentorship: claims.mid,
        tool: claims.tool,
        status: 'pending',
        expiresAt: { $gt: new Date() }
      },
      { $set: { status: 'claimed', claimedAt: new Date() } }
    );
    if (!claimed) {
      return res.status(409).json({ error: PROPOSAL_USED, reason: 'used' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error claiming a proposal:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/copilot/proposals/close
 *
 * The person dismissed it, or the browser has finished running it. Closing changes
 * no record but this one and grants nothing. In particular `decision` is not a claim
 * that anything happened, and nothing is kept about how the write went.
 *
 * `dismissed` closes one still pending. `approved` closes one already claimed.
 * An expired proposal may be closed: what ran a moment before it expired still has
 * to be finished with. Every other check on the token stands.
 *
 * This is also what ends the paused turn in the AI service. No model is called for
 * that, and what it is told is only which of the two decisions this was.
 */
app.post('/api/copilot/proposals/close', requireAuth, async (req, res) => {
  try {
    if (!AGENT_PROPOSAL_SECRET) {
      return res.status(503).json({ error: AGENT_NOT_CONFIGURED });
    }
    const from = { dismissed: 'pending', approved: 'claimed' };
    const decision = req.body?.decision;
    if (typeof decision !== 'string' || !Object.hasOwn(from, decision)) {
      return res.status(400).json({ error: 'Say whether this was approved or dismissed' });
    }

    let claims;
    try {
      claims = agentProposal.verifyProposal(AGENT_PROPOSAL_SECRET, req.body?.proposal, { allowExpired: true });
    } catch {
      return res.status(410).json({ error: PROPOSAL_EXPIRED });
    }
    if (claims.sub !== String(req.authUser._id)) {
      return res.status(403).json({ error: 'That proposal is not yours' });
    }

    const closed = await AgentProposal.findOneAndUpdate(
      { _id: claims.jti, user: req.authUser._id, status: from[decision] },
      { $set: { status: 'closed', closedAt: new Date() } }
    );
    if (!closed) {
      return res.status(409).json({ error: PROPOSAL_USED, reason: 'used' });
    }

    // Ends the paused turn. If this fails the turn expires by itself, and nothing depends on it.
    await callPausedTurn('/agent/resume', { threadId: claims.jti, decision });

    res.json({ ok: true });
  } catch (err) {
    console.error('Error closing a proposal:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// AGENT TOOLS (internal)
// ============================================

/**
 * Tool calls one turn may make, counted here as well as in the AI service, so
 * a service that loses count still cannot read without limit on one token.
 */
const AGENT_TOOL_CALLS_PER_TURN = Number(process.env.AGENT_TOOL_CALLS_PER_TURN) || 3;
const agentTurnCalls = new Map(); // token id -> { count, expiresAt }

function countAgentCall(jti, expiresAtMs) {
  const now = Date.now();
  for (const [id, turn] of agentTurnCalls) {
    if (turn.expiresAt <= now) agentTurnCalls.delete(id);
  }
  const turn = agentTurnCalls.get(jti) || { count: 0, expiresAt: expiresAtMs };
  if (turn.count >= AGENT_TOOL_CALLS_PER_TURN) return false;
  turn.count += 1;
  agentTurnCalls.set(jti, turn);
  return true;
}

/**
 * POST /internal/agent/tools/:name
 *
 * The AI service runs one of the agent's tools AS THE ASKER. Not a route for
 * browsers, and not one any user can reach with their own sign-in.
 *
 *   loopback -> no Origin -> X-AI-Secret -> capability token
 *     -> user reloaded -> resolveMentorshipAccess -> same role -> still active
 *     -> per-turn call cap -> the tool
 *
 * The secret says the caller is the AI service; the token says who the call
 * is for. Neither alone is enough, and the token's claims are checked against
 * the database again on every call: a user suspended mid-turn, or a mentorship
 * ended mid-turn, is refused at the next tool call, not at the next turn.
 *
 * Identity comes only from the token. The body carries the tool's arguments
 * and nothing about who is asking or where.
 *
 * Every refusal is one plain sentence the service can show the user. Refusals
 * of the turn itself (the checks above, and the cap) carry `endsTurn: true`: the
 * service stops and shows the sentence. A refused lookup (no such tool, a role
 * the tool does not list, bad arguments, or the tool's own refusal) does not:
 * the model is told, and may answer from what it has.
 */
app.post('/internal/agent/tools/:name', async (req, res) => {
  try {
    if (!isLoopback(req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'Not available from here', endsTurn: true });
    }
    // A browser always sends Origin on a cross-site POST; the AI service never
    // does. So a page open on this machine cannot use this route either.
    if (req.headers.origin) {
      return res.status(403).json({ error: 'Not available from here', endsTurn: true });
    }
    if (!sameSecret(req.headers['x-ai-secret'], AI_SERVICE_SECRET)) {
      return res.status(401).json({ error: 'Not available from here', endsTurn: true });
    }
    if (!AGENT_TOKEN_SECRET) {
      return res.status(503).json({ error: 'The agent is not configured on this server', endsTurn: true });
    }

    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    let claims;
    try {
      claims = agentToken.verifyAgentToken(AGENT_TOKEN_SECRET, bearer ? bearer[1] : '');
    } catch {
      return res.status(401).json({ error: 'This question has run out of time. Ask it again.', endsTurn: true });
    }

    const user = await User.findById(claims.sub);
    if (!user) {
      return res.status(403).json({ error: 'This account no longer exists', endsTurn: true });
    }
    if (user.suspended) {
      return res.status(403).json({ error: 'Your account has been suspended', endsTurn: true });
    }

    const access = await resolveMentorshipAccess(claims.mid, user);
    if (access.error) {
      return res.status(access.status).json({ error: access.error, endsTurn: true });
    }
    const role = access.isMentor ? 'mentor' : 'student';
    if (role !== claims.role) {
      return res.status(403).json({ error: 'Your role in this mentorship has changed. Ask again.', endsTurn: true });
    }
    const refusal = assistantRefusal(access.mentorship);
    if (refusal) {
      return res.status(409).json({ error: refusal, endsTurn: true });
    }

    const name = req.params.name;
    const tool = agentTools.toolNamed(name);
    if (!tool) {
      return res.status(404).json({ error: 'No such tool' });
    }
    // The second layer of the role filter (§4.2): the AI service never offers
    // this tool to this role, and if it is asked for anyway, it is refused here.
    if (!tool.roles.includes(role)) {
      return res.status(403).json({ error: "That isn't something I can look up for you" });
    }
    const args = req.body?.args;
    const problem = agentTools.argsProblem(tool, args);
    if (problem) {
      return res.status(400).json({ error: "I couldn't make sense of that lookup" });
    }

    if (!countAgentCall(claims.jti, claims.exp * 1000)) {
      return res
        .status(429)
        .json({
          error: `I can look things up at most ${AGENT_TOOL_CALLS_PER_TURN} times for one question.`,
          endsTurn: true
        });
    }

    const started = Date.now();
    const result = await tool.run({ user, mentorship: access.mentorship, role, args });
    // One line per call: which tool, as which role, how it went. Never the
    // arguments, the results or anyone's id.
    console.log(
      `agent tool ${name} as ${role}: ${result.error ? result.status : 200}, ` +
        `${result.records ? result.records.length : 0} records, ${Date.now() - started} ms`
    );
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.json(result);
  } catch (err) {
    console.error('Error running an agent tool:', err.message);
    res.status(500).json({ error: 'That lookup failed' });
  }
});

// ============================================
// ANALYTICS
// ============================================

/**
 * GET /api/analytics/me
 *
 * What your mentorships add up to. Goals and sessions have been accumulating
 * real data for a while now with nothing reading it back, and the question a
 * mentor with four students actually has is not "how many goals exist" — it is
 * **"which of them has gone quiet?"** That is what the per-mentorship rows are
 * for, and it is the reason this endpoint returns a list rather than a
 * scoreboard.
 *
 * ## Why aggregation rather than a loop
 *
 * Counting in JavaScript would mean pulling every goal — milestone arrays and
 * all — over the wire to look at a boolean on each one. `$group` with `$reduce`
 * does the counting where the data already is and returns one small row per
 * mentorship. At this project's scale either would be instant; the pipeline is
 * the one that stays instant.
 *
 * ## What is deliberately excluded
 *
 * - **Archived goals contribute no milestones.** A goal you gave up on would
 *   otherwise drag the completion figure down forever, and "we decided not to
 *   do this" is not the same as "this is unfinished".
 * - **Ended mentorships are counted in the totals but get no row.** The rows
 *   are a worklist; a finished relationship is not work.
 */
app.get('/api/analytics/me', requireAuth, async (req, res) => {
  try {
    const me = req.authUser._id;
    const now = new Date();

    const mentorships = await Mentorship.find({
      $or: [{ mentor: me }, { student: me }]
    })
      .populate('mentor', 'displayName photoURL role verified')
      .populate('student', 'displayName photoURL role verified');

    const activeIds = mentorships
      .filter((m) => m.status === 'active')
      .map((m) => m._id);

    // Nothing to aggregate over — return the shape anyway rather than a 404,
    // so the page renders its empty state instead of an error.
    const [goalRows, sessionRows] = activeIds.length
      ? await Promise.all([
          Goal.aggregate([
            { $match: { mentorship: { $in: activeIds } } },
            {
              $group: {
                _id: '$mentorship',
                goals: { $sum: 1 },
                completed: {
                  $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
                },
                archived: {
                  $sum: { $cond: [{ $eq: ['$status', 'archived'] }, 1, 0] }
                },
                milestonesTotal: {
                  $sum: {
                    $cond: [
                      { $ne: ['$status', 'archived'] },
                      { $size: '$milestones' },
                      0
                    ]
                  }
                },
                milestonesDone: {
                  $sum: {
                    $cond: [
                      { $ne: ['$status', 'archived'] },
                      {
                        $size: {
                          $filter: {
                            input: '$milestones',
                            cond: '$$this.done'
                          }
                        }
                      },
                      0
                    ]
                  }
                }
              }
            }
          ]),
          Session.aggregate([
            { $match: { mentorship: { $in: activeIds } } },
            {
              $group: {
                _id: '$mentorship',
                completed: {
                  $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
                },
                cancelled: {
                  $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] }
                },
                minutesMet: {
                  $sum: {
                    $cond: [
                      { $eq: ['$status', 'completed'] },
                      '$durationMinutes',
                      0
                    ]
                  }
                },
                // $min and $max ignore the nulls the $cond produces for rows
                // that do not qualify, which is exactly the behaviour wanted:
                // "the latest one that happened" and "the soonest one still to".
                lastMetAt: {
                  $max: {
                    $cond: [
                      { $eq: ['$status', 'completed'] },
                      '$scheduledFor',
                      null
                    ]
                  }
                },
                nextAt: {
                  $min: {
                    $cond: [
                      {
                        $and: [
                          { $in: ['$status', ['proposed', 'confirmed']] },
                          { $gte: ['$scheduledFor', now] }
                        ]
                      },
                      '$scheduledFor',
                      null
                    ]
                  }
                }
              }
            }
          ])
        ])
      : [[], []];

    const goalsBy = new Map(goalRows.map((r) => [String(r._id), r]));
    const sessionsBy = new Map(sessionRows.map((r) => [String(r._id), r]));

    const rows = mentorships
      .filter((m) => m.status === 'active')
      .map((m) => {
        const isMentor = String(m.mentor._id) === String(me);
        const g = goalsBy.get(String(m._id));
        const s = sessionsBy.get(String(m._id));

        return {
          _id: m._id,
          topic: m.topic,
          isMentor,
          startedAt: m.respondedAt || m.requestedAt,
          other: isMentor ? m.student : m.mentor,
          goals: { total: g?.goals || 0, completed: g?.completed || 0 },
          milestones: {
            done: g?.milestonesDone || 0,
            total: g?.milestonesTotal || 0
          },
          sessions: {
            completed: s?.completed || 0,
            cancelled: s?.cancelled || 0,
            minutesMet: s?.minutesMet || 0
          },
          lastMetAt: s?.lastMetAt || null,
          nextAt: s?.nextAt || null
        };
      })
      // Quietest first. The row you need to act on should not be the one you
      // have to scroll to find.
      .sort((a, b) => {
        const at = a.lastMetAt ? new Date(a.lastMetAt).getTime() : 0;
        const bt = b.lastMetAt ? new Date(b.lastMetAt).getTime() : 0;
        return at - bt;
      });

    /**
     * Two streaks, both about work handed in AS A STUDENT — a mentor who set
     * the work handed nothing in, and their figures stay at zero.
     *
     * `onTime` walks the assignments in deadline order and counts the run of
     * hand-ins that beat their deadline. A late one, or one whose deadline
     * passed with nothing handed in, breaks it. Work not yet due is skipped
     * rather than treated as a break: an assignment due next week is not yet
     * either a success or a failure, and counting it as one would make the
     * streak fall every time a mentor set something.
     *
     * `weeks` counts consecutive weeks holding at least one hand-in, late or
     * not — "did you keep showing up" rather than "were you punctual". This
     * week having nothing in it yet does not break the run; a whole empty
     * week does.
     */
    const submissions = await Submission.find({ student: me })
      .select('submittedAt assignment')
      .populate('assignment', 'dueAt');

    const decided = submissions
      .filter((x) => x.assignment)
      .map((x) => ({
        due: new Date(x.assignment.dueAt).getTime(),
        at: x.submittedAt ? new Date(x.submittedAt).getTime() : null
      }))
      // Not handed in and not yet due: no verdict, so it takes no part.
      .filter((x) => x.at !== null || x.due < now.getTime())
      .sort((a, b) => a.due - b.due);

    let onTimeCurrent = 0;
    let onTimeBest = 0;
    for (const x of decided) {
      if (x.at !== null && x.at <= x.due) {
        onTimeCurrent += 1;
        onTimeBest = Math.max(onTimeBest, onTimeCurrent);
      } else {
        onTimeCurrent = 0;
      }
    }

    // Weeks run Monday to Sunday in UTC, so the figure does not shift with
    // the reader's timezone the way a local midnight boundary would.
    const WEEK = 7 * 86400000;
    const weekOf = (ms) => {
      const d = new Date(ms);
      const sinceMonday = (d.getUTCDay() + 6) % 7;
      return (
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
        sinceMonday * 86400000
      );
    };

    const weeksHandedIn = new Set(
      submissions
        .filter((x) => x.submittedAt)
        .map((x) => weekOf(new Date(x.submittedAt).getTime()))
    );

    const thisWeek = weekOf(now.getTime());
    let weeks = 0;
    let cursor = weeksHandedIn.has(thisWeek) ? thisWeek : thisWeek - WEEK;
    while (weeksHandedIn.has(cursor)) {
      weeks += 1;
      cursor -= WEEK;
    }

    const sum = (list, pick) => list.reduce((n, x) => n + pick(x), 0);

    res.json({
      totals: {
        mentorships: {
          active: activeIds.length,
          ended: mentorships.filter((m) => m.status === 'ended').length,
          asMentor: mentorships.filter(
            (m) => m.status === 'active' && String(m.mentor._id) === String(me)
          ).length,
          asStudent: mentorships.filter(
            (m) => m.status === 'active' && String(m.student._id) === String(me)
          ).length
        },
        goals: {
          total: sum(rows, (r) => r.goals.total),
          completed: sum(rows, (r) => r.goals.completed)
        },
        milestones: {
          done: sum(rows, (r) => r.milestones.done),
          total: sum(rows, (r) => r.milestones.total)
        },
        sessions: {
          completed: sum(rows, (r) => r.sessions.completed),
          cancelled: sum(rows, (r) => r.sessions.cancelled),
          minutesMet: sum(rows, (r) => r.sessions.minutesMet)
        }
      },
      // Derived on read, like everything else here. Nothing about a streak is
      // stored, so none of it can drift out of step with the hand-ins.
      streaks: {
        handedIn: submissions.filter((x) => x.submittedAt).length,
        onTime: { current: onTimeCurrent, best: onTimeBest },
        weeks
      },
      mentorships: rows
    });
  } catch (err) {
    console.error('Error building analytics:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================
// SOCKET.IO - REAL-TIME EVENTS
// ============================================

/**
 * Socket.IO Connection Handler
 * 
 * This runs when a client connects via WebSocket.
 * Each connected client has a unique socket.id
 * 
 * Events we handle:
 * - 'user-online': User just logged in, track their socket
 * - 'send-message': User wants to send a message
 * - 'typing': User is typing
 * - 'stop-typing': User stopped typing
 * - 'disconnect': User closed the app/tab
 */
// Every socket must prove who it is BEFORE any handler runs. Handlers
// then read the identity from socket.data.user rather than trusting a
// senderId in the event payload.
io.use(socketAuth);

io.on('connection', (socket) => {
  console.log(`🔌 New socket connection: ${socket.id}`);

  /**
   * USER-ONLINE Event
   * 
   * When user logs in, frontend sends their MongoDB _id.
   * We store the mapping: visitorId -> socketId
   * Then broadcast to everyone that this user is online.
   */
  socket.on('user-online', async () => {
    try {
      // Identity comes from the authenticated handshake, not the payload.
      const visitorId = String(socket.data.user._id);

      // Register this tab. Tells us whether they were already online.
      const cameOnline = addUserSocket(visitorId, socket.id);

      // Store visitorId on the socket for later use (disconnect)
      socket.visitorId = visitorId;

      // Write and broadcast only on the FIRST tab. A second tab does not
      // change whether the person is online, and re-announcing it would make
      // every other client redraw for nothing.
      if (cameOnline) {
        await User.findByIdAndUpdate(visitorId, {
          isOnline: true,
          lastSeen: new Date()
        });

        io.emit('user-status-change', { visitorId, isOnline: true });
      }

      // Send the new user a list of who's currently online
      socket.emit('online-users', Array.from(onlineUsers.keys()));

      console.log(`👤 User online: ${visitorId}`);
    } catch (err) {
      console.error('Error in user-online:', err);
    }
  });

  /**
   * SEND-MESSAGE Event
   * 
   * The heart of the chat app!
   * 
   * Flow:
   * 1. Receive message from sender
   * 2. Save to MongoDB (permanent storage)
   * 3. Send to receiver if they're online
   * 4. Confirm to sender that message was sent
   */
  socket.on('send-message', async (data) => {
    try {
      const { receiverId, text } = data;

      // The sender is the authenticated socket. A client can no longer
      // send messages as somebody else by changing a field.
      const senderId = String(socket.data.user._id);

      // Validate
      if (!receiverId || !text?.trim()) {
        socket.emit('error', { message: 'Invalid message data' });
        return;
      }

      // Create message in database
      const message = await Message.create({
        sender: senderId,
        receiver: receiverId,
        text: text.trim(),
        timestamp: new Date()
      });

      // Populate sender info for the response
      await message.populate('sender', 'displayName photoURL role');
      await message.populate('receiver', 'displayName photoURL role');

      // Prepare message object to send to clients
      const messageToSend = {
        _id: message._id,
        sender: message.sender,
        receiver: message.receiver,
        text: message.text,
        timestamp: message.timestamp,
        read: message.read
      };

      // Send to every tab the RECEIVER has open
      emitToUser(receiverId, 'new-message', messageToSend);

      // Confirm to the SENDER — also on every tab, so a message typed in one
      // window shows up in the others instead of only where it was sent.
      emitToUser(senderId, 'message-sent', messageToSend);

      console.log(`✉️ Message sent: ${senderId} -> ${receiverId}`);
    } catch (err) {
      console.error('Error sending message:', err);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  /**
   * TYPING Event
   * 
   * When user starts typing, notify the other person.
   * Creates that "John is typing..." indicator.
   */
  socket.on('typing', (data) => {
    const { receiverId } = data;
    const senderId = String(socket.data.user._id);

    emitToUser(receiverId, 'user-typing', { senderId });
  });

  /**
   * STOP-TYPING Event
   * 
   * When user stops typing (or sends message), clear the indicator.
   */
  socket.on('stop-typing', (data) => {
    const { receiverId } = data;
    const senderId = String(socket.data.user._id);

    emitToUser(receiverId, 'user-stop-typing', { senderId });
  });

  /**
   * MARK-READ Event
   * 
   * Mark messages as read (for read receipts).
   */
  socket.on('mark-read', async (data) => {
    try {
      const { peerId } = data;
      const visitorId = String(socket.data.user._id);
      
      // Mark all messages from peer to visitor as read
      await Message.updateMany(
        { sender: peerId, receiver: visitorId, read: false },
        { read: true }
      );

      // Two different facts, two different audiences.
      //
      // The PEER learns "they read what you sent" — that is a receipt, and it
      // drives the "Seen" line under their message.
      //
      // The READER's own other tabs learn "you have read these" — that is
      // what clears the unread badge on the messages list. Without it, a
      // conversation opened in one tab left the count sitting there in
      // another until a reload, which is the sort of thing that teaches
      // people not to trust the number.
      emitToUser(peerId, 'messages-read', { byVisitor: visitorId });
      emitToUser(visitorId, 'conversation-read', { peerId });
    } catch (err) {
      console.error('Error marking messages as read:', err);
    }
  });

  /**
   * MARK-GROUP-READ Event
   *
   * The group twin of 'mark-read'. Moves this member's high-water mark to
   * now, which is what both the unread badge and everyone else's read
   * receipts are computed from.
   *
   * Upserted rather than created: a member opens a group many times, and the
   * unique (group, user) index means a second insert would fail rather than
   * advance the mark.
   */
  socket.on('mark-group-read', async (data) => {
    try {
      const { groupId } = data;
      const userId = String(socket.data.user._id);
      if (!groupId) return;

      // Membership re-checked, as everywhere else in the group handlers: a
      // read marker for a group you are not in would leak into its receipts.
      const group = await Group.findById(groupId).select('members');
      if (!group?.members?.some((m) => String(m) === userId)) return;

      const lastReadAt = new Date();
      await GroupRead.updateOne(
        { group: groupId, user: userId },
        { $set: { lastReadAt } },
        { upsert: true }
      );

      // Your own tabs, so the badge clears in the window you left on the list.
      emitToUser(userId, 'group-read', { groupId: String(groupId) });

      // And the room, so anyone watching sees their message become seen.
      io.to(`group:${groupId}`).emit('group-receipt', {
        groupId: String(groupId),
        userId,
        lastReadAt
      });
    } catch (err) {
      console.error('Error marking group read:', err);
    }
  });

  // ------------------------------------------
  // GROUP CHAT EVENTS (Socket.IO rooms)
  //
  // Unlike 1-to-1 chat (which targets a single socketId), groups use
  // Socket.IO "rooms". A room is just a named channel: sockets that
  // join 'group:<groupId>' all receive anything broadcast to it.
  // ------------------------------------------

  /**
   * JOIN-GROUP Event
   *
   * Client calls this when it opens a group chat.
   * The socket joins that group's room so it receives live messages.
   */
  socket.on('join-group', async (groupId) => {
    if (!groupId) return;

    // MEMBERSHIP: a socket may only join the room of a group it belongs
    // to. Without this, any client could join any group by id and receive
    // every message posted to it. This is the gap deferred in Entry 2 — it
    // could not be closed before the socket had a verified identity.
    const group = await Group.findById(groupId).select('members');
    if (!group?.members?.some((m) => String(m) === String(socket.data.user._id))) {
      socket.emit('error', { message: 'You are not a member of that group' });
      return;
    }

    socket.join(`group:${groupId}`);
    console.log(`👥 Socket ${socket.id} joined room group:${groupId}`);
  });

  /**
   * LEAVE-GROUP Event
   *
   * Client calls this when it leaves/closes a group chat.
   */
  socket.on('leave-group', (groupId) => {
    if (!groupId) return;
    socket.leave(`group:${groupId}`);
    console.log(`👋 Socket ${socket.id} left room group:${groupId}`);
  });

  /**
   * SEND-GROUP-MESSAGE Event
   *
   * Flow (parallels 1-to-1 send-message):
   * 1. Receive message from sender
   * 2. Save to MongoDB (GroupMessage collection)
   * 3. Broadcast to everyone currently in the group's room
   *
   * We broadcast to the whole room INCLUDING the sender, so the sender's
   * own UI adds the confirmed, DB-saved message the same way everyone
   * else receives it (no separate confirmation event needed).
   */
  socket.on('send-group-message', async (data) => {
    try {
      const { groupId, text } = data;

      // Sender is the authenticated socket, as in 1-to-1 chat.
      const senderId = String(socket.data.user._id);

      // Validate
      if (!groupId || !text?.trim()) {
        socket.emit('error', { message: 'Invalid group message data' });
        return;
      }

      // MEMBERSHIP re-checked here, not just in 'join-group': a client can
      // emit this event without ever having joined the room.
      const group = await Group.findById(groupId).select('members name');
      if (!group?.members?.some((m) => String(m) === String(senderId))) {
        socket.emit('error', { message: 'You are not a member of that group' });
        return;
      }

      // Save to database
      const message = await GroupMessage.create({
        group: groupId,
        sender: senderId,
        text: text.trim(),
        timestamp: new Date()
      });

      // Populate sender info for the clients
      await message.populate('sender', 'displayName photoURL role');

      const messageToSend = {
        _id: message._id,
        group: message.group,
        sender: message.sender,
        text: message.text,
        timestamp: message.timestamp
      };

      // Broadcast to every socket in this group's room (sender included)
      io.to(`group:${groupId}`).emit('new-group-message', messageToSend);

      /**
       * And separately, to every MEMBER — room or no room.
       *
       * The room only contains people with the group open. Everyone else is
       * exactly who the unread badge is for: they are not in the room, so the
       * broadcast above never reaches them, and without this their count
       * would only move on a page load. Two events rather than one because
       * they answer different questions — the room gets a message to render,
       * members get "something happened in this group".
       */
      const activity = {
        groupId: String(groupId),
        groupName: group.name,
        text: message.text,
        timestamp: message.timestamp,
        senderId,
        senderName: message.sender.displayName
      };

      group.members.forEach((memberId) => {
        emitToUser(memberId, 'group-activity', activity);
      });

      console.log(`✉️ Group message: ${senderId} -> group ${groupId}`);
    } catch (err) {
      console.error('Error sending group message:', err);
      socket.emit('error', { message: 'Failed to send group message' });
    }
  });

  /**
   * GROUP-TYPING / GROUP-STOP-TYPING Events
   *
   * Relay typing indicators to the rest of the room.
   * socket.to(room) sends to everyone in the room EXCEPT the sender.
   */
  socket.on('group-typing', ({ groupId }) => {
    if (!groupId) return;
    const senderId = String(socket.data.user._id);
    socket.to(`group:${groupId}`).emit('group-user-typing', { groupId, senderId });
  });

  socket.on('group-stop-typing', ({ groupId }) => {
    if (!groupId) return;
    const senderId = String(socket.data.user._id);
    socket.to(`group:${groupId}`).emit('group-user-stop-typing', { groupId, senderId });
  });

  /**
   * DISCONNECT Event
   *
   * When socket disconnects (user closed tab, lost internet, etc.)
   * Update their status to offline.
   */
  socket.on('disconnect', async () => {
    try {
      const visitorId = socket.visitorId;
      
      if (visitorId) {
        // Only go offline when the LAST tab closes.
        const wentOffline = removeUserSocket(visitorId, socket.id);

        if (wentOffline) {
          await User.findByIdAndUpdate(visitorId, {
            isOnline: false,
            lastSeen: new Date()
          });

          io.emit('user-status-change', { visitorId, isOnline: false });
          console.log(`👋 User offline: ${visitorId}`);
        } else {
          console.log(`👋 Tab closed for ${visitorId}, still open elsewhere`);
        }
      }
    } catch (err) {
      console.error('Error in disconnect:', err);
    }
  });
});

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