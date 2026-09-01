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
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

// ============================================
// TRACK ONLINE USERS
// ============================================

/**
 * Map to track which socket belongs to which user
 * Key: visitorId (from MongoDB User._id)
 * Value: socket.id
 * 
 * When user A wants to send message to user B:
 * 1. Look up B's socket.id from this map
 * 2. If found, B is online - send message directly
 * 3. If not found, B is offline - message is still saved to DB
 */
const onlineUsers = new Map();  // visitorId -> socketId

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
app.post('/api/auth/login', async (req, res) => {
  try {
    const { firebaseUid, email, displayName, photoURL } = req.body;

    // Validate required fields
    if (!firebaseUid || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // findOneAndUpdate with upsert:true means:
    // - If user exists: UPDATE their info (name, photo might have changed)
    // - If user doesn't exist: CREATE new user
    // This is called an "upsert" (update + insert)
    // NOTE: `role` is intentionally NOT in the update below. This runs on
    // EVERY login, so setting role here would clobber the user's choice.
    // Role is set once via POST /api/users/:id/role and preserved thereafter.
    const user = await User.findOneAndUpdate(
      { firebaseUid },  // Find by Firebase UID
      { 
        firebaseUid,
        email,
        displayName: displayName || email.split('@')[0],  // Fallback to email prefix
        photoURL: photoURL || '',
        isOnline: true,
        lastSeen: new Date()
      },
      { 
        upsert: true,     // Create if doesn't exist
        new: true,        // Return the updated document
        setDefaultsOnInsert: true  // Apply schema defaults on insert
      }
    );

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
app.get('/api/users', async (req, res) => {
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
app.get('/api/messages/:visitorId/:peerId', async (req, res) => {
  try {
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
app.get('/api/user/:visitorId', async (req, res) => {
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
app.post('/api/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;

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
app.put('/api/users/:id/profile', async (req, res) => {
  try {
    const { bio, expertise, availability } = req.body;

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Build the update from only the fields this user is allowed to set
    const updates = {};
    if (bio !== undefined) updates.bio = bio;

    if (user.role === 'mentor') {
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
app.post('/api/groups', async (req, res) => {
  try {
    const { name, createdBy, memberIds = [] } = req.body;

    // Validate required fields
    if (!name?.trim() || !createdBy) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // AUTHORIZATION: only mentors may create groups.
    const creator = await User.findById(createdBy).select('role displayName');
    if (!creator) {
      return res.status(404).json({ error: 'Creator not found' });
    }
    if (creator.role !== 'mentor') {
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
app.post('/api/groups/:groupId/join', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { visitorId } = req.body;

    if (!visitorId) {
      return res.status(400).json({ error: 'Missing visitorId' });
    }

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
app.get('/api/groups', async (req, res) => {
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
app.get('/api/groups/:groupId/messages', async (req, res) => {
  try {
    const { groupId } = req.params;
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
app.get('/api/announcements', async (req, res) => {
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
app.post('/api/announcements', async (req, res) => {
  try {
    const { authorId, text } = req.body;

    if (!authorId || !text?.trim()) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // AUTHORIZATION: only mentors may post.
    const author = await User.findById(authorId).select('role displayName');
    if (!author) {
      return res.status(404).json({ error: 'Author not found' });
    }
    if (author.role !== 'mentor') {
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
app.delete('/api/announcements/:id', async (req, res) => {
  try {
    const { visitorId } = req.body;

    if (!visitorId) {
      return res.status(400).json({ error: 'Missing visitorId' });
    }

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
io.on('connection', (socket) => {
  console.log(`🔌 New socket connection: ${socket.id}`);

  /**
   * USER-ONLINE Event
   * 
   * When user logs in, frontend sends their MongoDB _id.
   * We store the mapping: visitorId -> socketId
   * Then broadcast to everyone that this user is online.
   */
  socket.on('user-online', async (visitorId) => {
    try {
      // Store the mapping
      onlineUsers.set(visitorId, socket.id);
      
      // Store visitorId on the socket for later use (disconnect)
      socket.visitorId = visitorId;

      // Update user's online status in DB
      await User.findByIdAndUpdate(visitorId, { 
        isOnline: true, 
        lastSeen: new Date() 
      });

      // Broadcast to ALL connected clients that this user is online
      // Everyone can update their UI to show green dot
      io.emit('user-status-change', { 
        visitorId, 
        isOnline: true 
      });

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
      const { senderId, receiverId, text } = data;

      // Validate
      if (!senderId || !receiverId || !text?.trim()) {
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

      // Send to RECEIVER if online
      const receiverSocketId = onlineUsers.get(receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('new-message', messageToSend);
      }

      // Confirm to SENDER
      socket.emit('message-sent', messageToSend);

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
    const { senderId, receiverId } = data;
    const receiverSocketId = onlineUsers.get(receiverId);
    
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('user-typing', { senderId });
    }
  });

  /**
   * STOP-TYPING Event
   * 
   * When user stops typing (or sends message), clear the indicator.
   */
  socket.on('stop-typing', (data) => {
    const { senderId, receiverId } = data;
    const receiverSocketId = onlineUsers.get(receiverId);
    
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('user-stop-typing', { senderId });
    }
  });

  /**
   * MARK-READ Event
   * 
   * Mark messages as read (for read receipts).
   */
  socket.on('mark-read', async (data) => {
    try {
      const { visitorId, peerId } = data;
      
      // Mark all messages from peer to visitor as read
      await Message.updateMany(
        { sender: peerId, receiver: visitorId, read: false },
        { read: true }
      );

      // Notify the peer that their messages were read
      const peerSocketId = onlineUsers.get(peerId);
      if (peerSocketId) {
        io.to(peerSocketId).emit('messages-read', { byVisitor: visitorId });
      }
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
  socket.on('join-group', (groupId) => {
    if (!groupId) return;
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
      const { groupId, senderId, text } = data;

      // Validate
      if (!groupId || !senderId || !text?.trim()) {
        socket.emit('error', { message: 'Invalid group message data' });
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
  socket.on('group-typing', ({ groupId, senderId }) => {
    if (!groupId) return;
    socket.to(`group:${groupId}`).emit('group-user-typing', { groupId, senderId });
  });

  socket.on('group-stop-typing', ({ groupId, senderId }) => {
    if (!groupId) return;
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
        // Remove from online users map
        onlineUsers.delete(visitorId);

        // Update database
        await User.findByIdAndUpdate(visitorId, { 
          isOnline: false, 
          lastSeen: new Date() 
        });

        // Broadcast to everyone that this user is offline
        io.emit('user-status-change', { 
          visitorId, 
          isOnline: false 
        });

        console.log(`👋 User disconnected: ${visitorId}`);
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