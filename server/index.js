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

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

// Import our models
const User = require('./models/User');
const Message = require('./models/Message');
const Group = require('./models/Group');
const GroupMessage = require('./models/GroupMessage');
const Announcement = require('./models/Announcement');
const Report = require('./models/Report');
const Mentorship = require('./models/Mentorship');

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
  })
  .catch((err) => console.error('❌ MongoDB connection error:', err));

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
      announcements
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
      Announcement.countDocuments()
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
      announcements
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
 * Ask someone to mentor you.
 *
 * The requester is always the `student` side, whatever their own role — a
 * mentor seeking mentoring in another subject is an ordinary case. What is
 * required is that the person being asked can actually mentor.
 *
 * Body:
 * - mentorId: who to ask
 * - topic: what you want help with (required — see the model)
 * - message: optional opening note
 */
app.post('/api/mentorships', requireAuth, async (req, res) => {
  try {
    const { mentorId, topic, message = '' } = req.body;

    if (!mentorId || !topic?.trim()) {
      return res.status(400).json({ error: 'A mentor and a topic are required' });
    }

    if (String(mentorId) === String(req.authUser._id)) {
      return res.status(400).json({ error: 'You cannot mentor yourself' });
    }

    const mentor = await User.findById(mentorId).select('role displayName suspended');
    if (!mentor) {
      return res.status(404).json({ error: 'That person no longer exists' });
    }

    if (!['mentor', 'admin'].includes(mentor.role)) {
      return res.status(400).json({ error: 'That person is not a mentor' });
    }

    // Asking a suspended account would produce a request nobody can answer.
    if (mentor.suspended) {
      return res.status(400).json({ error: 'That mentor is not available' });
    }

    // One live relationship per pair. See the note in the model for why this
    // is here rather than a partial unique index.
    const existing = await Mentorship.findOne({
      student: req.authUser._id,
      mentor: mentorId,
      status: { $in: ['pending', 'active'] }
    });

    if (existing) {
      return res.status(409).json({
        error:
          existing.status === 'pending'
            ? 'You already have a request waiting with this mentor'
            : 'You are already being mentored by this person'
      });
    }

    const mentorship = await Mentorship.create({
      student: req.authUser._id,
      mentor: mentorId,
      topic: topic.trim(),
      message: String(message).trim()
    });

    const populated = await Mentorship.findById(mentorship._id)
      .populate('student', MENTORSHIP_USER_FIELDS)
      .populate('mentor', MENTORSHIP_USER_FIELDS);

    // Tell the mentor, on every tab they have open.
    emitToUser(mentorId, 'mentorship-updated', populated);

    console.log(`🤝 Mentorship requested: ${req.authUser.displayName} → ${mentor.displayName}`);
    res.json(populated);
  } catch (err) {
    console.error('Error requesting mentorship:', err);
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
 * Move a mentorship along. Three moves, three different rules about who may
 * make them:
 *
 * - `accept` / `decline` — the MENTOR only, and only from `pending`. The
 *   student cannot accept on the mentor's behalf.
 * - `end` — EITHER party, and only from `active`. Both sides can walk away;
 *   neither needs the other's agreement.
 *
 * Transitions are one-way, so a declined or ended relationship stays as
 * history. Starting again means a new request, not reviving this row.
 */
app.patch('/api/mentorships/:id', requireAuth, async (req, res) => {
  try {
    const { action, note = '' } = req.body;

    if (!['accept', 'decline', 'end'].includes(action)) {
      return res.status(400).json({ error: 'Action must be accept, decline or end' });
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

    if (action === 'accept' || action === 'decline') {
      if (!isMentor) {
        return res.status(403).json({ error: 'Only the mentor can answer a request' });
      }
      if (mentorship.status !== 'pending') {
        return res.status(400).json({ error: 'That request has already been answered' });
      }

      mentorship.status = action === 'accept' ? 'active' : 'declined';
      mentorship.respondedAt = new Date();
      mentorship.responseNote = String(note).trim();
    } else {
      if (mentorship.status !== 'active') {
        return res.status(400).json({ error: 'Only an active mentorship can be ended' });
      }

      mentorship.status = 'ended';
      mentorship.endedAt = new Date();
      mentorship.endedBy = req.authUser._id;
    }

    await mentorship.save();

    const populated = await Mentorship.findById(mentorship._id)
      .populate('student', MENTORSHIP_USER_FIELDS)
      .populate('mentor', MENTORSHIP_USER_FIELDS);

    // Both sides care about every one of these transitions.
    emitToUser(mentorship.student, 'mentorship-updated', populated);
    emitToUser(mentorship.mentor, 'mentorship-updated', populated);

    console.log(`🤝 Mentorship ${action}ed: ${mentorship._id}`);
    res.json(populated);
  } catch (err) {
    console.error('Error updating mentorship:', err);
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

      // Notify the peer, on every tab they have open
      emitToUser(peerId, 'messages-read', { byVisitor: visitorId });
    } catch (err) {
      console.error('Error marking messages as read:', err);
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
      const group = await Group.findById(groupId).select('members');
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

server.listen(PORT, () => {
  console.log(`
  🚀 Server running on http://localhost:${PORT}
  📡 Socket.IO ready for connections
  💾 MongoDB: ${mongoUri}
  `);
});