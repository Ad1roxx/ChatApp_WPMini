/**
 * Every Socket.IO handler: presence, messages, typing, read marks, group rooms.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js
 * after the routes.
 */

const mongoose = require('mongoose');
// Import our models
const User = require('./models/User');
const Message = require('./models/Message');
const Group = require('./models/Group');
const GroupMessage = require('./models/GroupMessage');
const GroupRead = require('./models/GroupRead');
const { guardedOn } = require('./lib/socketGuard');
// Authentication
const { socketAuth } = require('./middleware/auth');
const {
  io,
  messageLimiter,
  TOO_FAST,
  onlineUsers,
  addUserSocket,
  removeUserSocket,
  emitToUser
} = require('./app');

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

  // Every handler below is registered through the guard: a payload it can
  // always destructure, and nothing it throws reaches the process (lib/socketGuard.js).
  const on = guardedOn(socket);

  /**
   * USER-ONLINE Event
   * 
   * When user logs in, frontend sends their MongoDB _id.
   * We store the mapping: visitorId -> socketId
   * Then broadcast to everyone that this user is online.
   */
  on('user-online', async () => {
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
  on('send-message', async (data) => {
    try {
      const { receiverId, text } = data;

      // The sender is the authenticated socket. A client can no longer
      // send messages as somebody else by changing a field.
      const senderId = String(socket.data.user._id);

      // Validate
      if (!mongoose.isValidObjectId(receiverId) || typeof text !== 'string' || !text.trim()) {
        socket.emit('error', { message: 'Invalid message data' });
        return;
      }
      if (!messageLimiter.allow(senderId)) {
        // The refused text goes back with the refusal, so the page can return
        // exactly that message to the box (src/lib/notSent.js).
        socket.emit('error', { message: TOO_FAST, tooFast: true, text: text.trim() });
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
  on('typing', (data) => {
    const { receiverId } = data;
    const senderId = String(socket.data.user._id);

    emitToUser(receiverId, 'user-typing', { senderId });
  });

  /**
   * STOP-TYPING Event
   * 
   * When user stops typing (or sends message), clear the indicator.
   */
  on('stop-typing', (data) => {
    const { receiverId } = data;
    const senderId = String(socket.data.user._id);

    emitToUser(receiverId, 'user-stop-typing', { senderId });
  });

  /**
   * MARK-READ Event
   * 
   * Mark messages as read (for read receipts).
   */
  on('mark-read', async (data) => {
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
  on('mark-group-read', async (data) => {
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
  on('join-group', async (groupId) => {
    // Not an id at all: the same answer as a group you are not in, and no query.
    if (!mongoose.isValidObjectId(groupId)) {
      socket.emit('error', { message: 'You are not a member of that group' });
      return;
    }

    // MEMBERSHIP: a socket may only join the room of a group it belongs
    // to. Without this, any client could join any group by id and receive
    // every message posted to it. This is the gap deferred in Entry 2 — it
    // could not be closed before the socket had a verified identity.
    // Members, and admins, who may see any group (lib/groupAccess.js). The
    // role is read again, not taken from the handshake: an account can stop
    // being an admin while its socket stays open.
    const allowedNow = async () => {
      const group = await Group.findById(groupId).select('members');
      const me = group && (await User.findById(socket.data.user._id).select('role suspended'));
      return Boolean(me && !me.suspended &&
        (group.members.some((m) => String(m) === String(me._id)) || me.role === 'admin'));
    };

    if (!(await allowedNow())) {
      socket.emit('error', { message: 'You are not a member of that group' });
      return;
    }

    socket.join(`group:${groupId}`);

    // Asked again AFTER joining. A removal that landed between the check above
    // and the join had nothing to take out of the room yet, and would have left
    // this socket in it for good. Checked after, either this sees the removal and
    // leaves, or the removal comes later and finds the socket in the room.
    if (!(await allowedNow())) {
      socket.leave(`group:${groupId}`);
      socket.emit('error', { message: 'You are not a member of that group' });
      return;
    }
    console.log(`👥 Socket ${socket.id} joined room group:${groupId}`);
  }, { id: true });

  /**
   * LEAVE-GROUP Event
   *
   * Client calls this when it leaves/closes a group chat.
   */
  on('leave-group', (groupId) => {
    if (!groupId) return;
    socket.leave(`group:${groupId}`);
    console.log(`👋 Socket ${socket.id} left room group:${groupId}`);
  }, { id: true });

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
  on('send-group-message', async (data) => {
    try {
      const { groupId, text } = data;

      // Sender is the authenticated socket, as in 1-to-1 chat.
      const senderId = String(socket.data.user._id);

      // Validate
      if (!mongoose.isValidObjectId(groupId) || typeof text !== 'string' || !text.trim()) {
        socket.emit('error', { message: 'Invalid group message data' });
        return;
      }
      // One allowance for both kinds of message: it is the account that is limited.
      if (!messageLimiter.allow(senderId)) {
        socket.emit('error', { message: TOO_FAST, tooFast: true, text: text.trim() });
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
  // Only a socket that is IN the room may send into it: `socket.to(room)`
  // reaches a room whether or not the sender is in it, so without this anyone
  // could put a typing notice in any group.
  const inRoom = (groupId) => typeof groupId === 'string' && socket.rooms.has(`group:${groupId}`);

  on('group-typing', ({ groupId }) => {
    if (!inRoom(groupId)) return;
    const senderId = String(socket.data.user._id);
    socket.to(`group:${groupId}`).emit('group-user-typing', { groupId, senderId });
  });

  on('group-stop-typing', ({ groupId }) => {
    if (!inRoom(groupId)) return;
    const senderId = String(socket.data.user._id);
    socket.to(`group:${groupId}`).emit('group-user-stop-typing', { groupId, senderId });
  });

  /**
   * DISCONNECT Event
   *
   * When socket disconnects (user closed tab, lost internet, etc.)
   * Update their status to offline.
   */
  on('disconnect', async () => {
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
