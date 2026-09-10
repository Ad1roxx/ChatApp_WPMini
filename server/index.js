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
const Goal = require('./models/Goal');
const Session = require('./models/Session');
const GroupRead = require('./models/GroupRead');

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

/**
 * Load a mentorship and work out how the caller relates to it.
 *
 * Every goal route needs the same three answers — does it exist, am I part of
 * it, and am I the mentor — so they are worked out once here rather than
 * repeated four times with slightly different wording.
 *
 * Returns `{ error, status }` on failure so the caller can `return` it
 * directly, or `{ mentorship, isMentor }` on success.
 */
async function resolveMentorshipAccess(mentorshipId, user) {
  const mentorship = await Mentorship.findById(mentorshipId);
  if (!mentorship) {
    return { error: 'Mentorship not found', status: 404 };
  }

  const me = String(user._id);
  const isMentor = String(mentorship.mentor) === me;
  const isStudent = String(mentorship.student) === me;

  if (!isMentor && !isStudent) {
    return { error: 'This is not your mentorship', status: 403 };
  }

  return { mentorship, isMentor };
}

/**
 * GET /api/mentorships/:id/goals
 *
 * Both parties see the same list. Archived goals are included — hiding them
 * would make a goal that was abandoned look like one that never existed.
 */
app.get('/api/mentorships/:id/goals', requireAuth, async (req, res) => {
  try {
    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    const goals = await Goal.find({ mentorship: req.params.id })
      .sort({ createdAt: -1 })
      .populate('createdBy', 'displayName photoURL');

    res.json(goals);
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

/**
 * Everything a session list needs to render: who asked for the time, and who
 * called it off. Both are display-only, so only the display fields come back.
 */
const SESSION_POPULATE = [
  { path: 'proposedBy', select: 'displayName photoURL' },
  { path: 'cancelledBy', select: 'displayName photoURL' }
];

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
    // Only ACTIVE mentorships. A session left over from a relationship that
    // has since ended is not something either person still owes.
    const mine = await Mentorship.find({
      status: 'active',
      $or: [{ mentor: req.authUser._id }, { student: req.authUser._id }]
    }).select('_id');

    if (mine.length === 0) return res.json([]);

    const sessions = await Session.find({
      mentorship: { $in: mine.map((m) => m._id) },
      status: { $in: ['proposed', 'confirmed'] },
      scheduledFor: { $gte: new Date() }
    })
      .sort({ scheduledFor: 1 })
      .limit(10)
      .populate(SESSION_POPULATE)
      .populate({
        path: 'mentorship',
        select: 'topic mentor student',
        populate: [
          { path: 'mentor', select: 'displayName photoURL' },
          { path: 'student', select: 'displayName photoURL' }
        ]
      });

    res.json(sessions);
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
    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }

    const sessions = await Session.find({ mentorship: req.params.id })
      .sort({ scheduledFor: -1 })
      .populate(SESSION_POPULATE);

    res.json(sessions);
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

server.listen(PORT, () => {
  console.log(`
  🚀 Server running on http://localhost:${PORT}
  📡 Socket.IO ready for connections
  💾 MongoDB: ${mongoUri}
  `);
});