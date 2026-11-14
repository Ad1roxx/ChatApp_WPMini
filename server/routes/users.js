/**
 * Sign-in, the user list, 1-to-1 conversations and history, roles and profiles.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const mongoose = require('mongoose');
// Import our models
const User = require('../models/User');
const Message = require('../models/Message');
const { loginIdentity, cosmetic } = require('../lib/loginIdentity');
const { PUBLIC_SELECT, publicUser } = require('../lib/publicUser');
const { limited } = require('../lib/rateLimit');
const { parsePage, historyPage } = require('../lib/history');
// Authentication
const { requireAuth, requireToken } = require('../middleware/auth');
const { app, io, loginLimiter, ADMIN_EMAILS } = require('../app');

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
app.post(
  '/api/auth/login',
  requireToken,
  limited(loginLimiter, 'Too many sign-ins. Wait a minute and try again.', (req) => req.firebaseUser?.uid),
  async (req, res) => {
  try {
    // Identity comes from the VERIFIED token, never from the body. The body
    // is still consulted for display name and photo, which are cosmetic —
    // but uid and email decide WHICH ACCOUNT THIS IS, so letting the client
    // choose them meant anyone could sign in as anyone.
    // The email decides which account this is, and whether it is an admin, so
    // it comes from the token and nowhere else, and only when the token says
    // the address was verified (lib/loginIdentity.js). The body's name and
    // photo are cosmetic.
    const identity = loginIdentity(req.firebaseUser, ADMIN_EMAILS);
    if (identity.error) {
      return res.status(identity.status).json({ error: identity.error });
    }
    const { firebaseUid, email } = identity;
    const { name, picture } = req.firebaseUser;
    const displayName = cosmetic(req.body?.displayName, 200) || cosmetic(name, 200);
    const photoURL = cosmetic(req.body?.photoURL, 2000) || cosmetic(picture, 2000);

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
    if (identity.admin) {
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
      io.emit('user-added', publicUser(user));
      console.log(`✨ New user registered: ${user.displayName}`);
    }

    console.log(`👤 User logged in: ${user.displayName}`);
    res.json(user);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
  }
);

/**
 * GET /api/users
 * 
 * Get all users except the current user.
 * Used to show "who can I chat with?" list.
 * 
 * Query params:
 * - exclude: present, with any value, to leave the caller out of the list.
 *   (It used to be the caller's Firebase uid, matched in the query; who the
 *   caller is comes from the token, so the value is no longer read.)
 *
 * Each row is the PUBLIC view of a user (lib/publicUser.js), not the document.
 */
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const leaveMeOut = req.query.exclude !== undefined;
    
    // Find all users except the one making the request
    const query = leaveMeOut ? { _id: { $ne: req.authUser._id } } : {};
    const users = await User.find(query)
      .select(PUBLIC_SELECT)
      .sort({ displayName: 1 });  // Sort alphabetically
    
    res.json(users.map(publicUser));
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
    if (!mongoose.isValidObjectId(peerId)) {
      return res.status(404).json({ error: 'User not found' });
    }

    // The latest page, or the page before `before` ("earlier messages"),
    // oldest first either way (lib/history.js).
    const page = parsePage(req.query);
    if (page.error) {
      return res.status(400).json({ error: page.error });
    }

    const messages = await historyPage(
      Message,
      {
        $or: [
          { sender: visitorId, receiver: peerId },
          { sender: peerId, receiver: visitorId }
        ]
      },
      page,
      [['sender', 'displayName photoURL role'], ['receiver', 'displayName photoURL role']]
    );

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
    if (!mongoose.isValidObjectId(req.params.visitorId)) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = await User.findById(req.params.visitorId).select('-__v');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Your own record in full; anyone else's public view (lib/publicUser.js).
    const own = String(user._id) === String(req.authUser._id);
    res.json(own ? user : publicUser(user));
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
    io.emit('user-updated', publicUser(user));

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
 * The caller is whoever the token says, and may only edit their own profile.
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
