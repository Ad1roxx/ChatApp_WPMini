/**
 * Group chats: create, join, list, previews, read marks and history.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const mongoose = require('mongoose');
// Import our models
const User = require('../models/User');
const Group = require('../models/Group');
const GroupMessage = require('../models/GroupMessage');
const GroupRead = require('../models/GroupRead');
const { parsePage, historyPage } = require('../lib/history');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app, MAX_GROUP_MEMBERS } = require('../app');

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
 * (The creator is whoever is signed in; a `createdBy` in the body is not read.)
 * - memberIds: array of MongoDB _ids to add (the creator is added automatically)
 */
app.post('/api/groups', requireAuth, async (req, res) => {
  try {
    const { name, memberIds = [] } = req.body || {};

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // The members are a list of ids of people who exist. Unchecked, anything
    // in the list reached the database: something that is not an id was a 500,
    // and an id of nobody was stored as a member (the audit, H9).
    if (
      !Array.isArray(memberIds) ||
      memberIds.length > MAX_GROUP_MEMBERS ||
      !memberIds.every((id) => typeof id === 'string' && mongoose.isValidObjectId(id))
    ) {
      return res.status(400).json({ error: 'Members must be a list of people' });
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

    const known = await User.countDocuments({ _id: { $in: uniqueMembers } });
    if (known !== uniqueMembers.length) {
      return res.status(400).json({ error: 'One of those people does not exist' });
    }

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
 * (none: the user joining is whoever is signed in)
 *
 * We use $addToSet so joining twice does not create duplicate entries.
 */
app.post('/api/groups/:groupId/join', requireAuth, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!mongoose.isValidObjectId(groupId)) {
      return res.status(404).json({ error: 'Group not found' });
    }

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
    if (userId !== undefined && (typeof userId !== 'string' || !mongoose.isValidObjectId(userId))) {
      return res.status(400).json({ error: 'userId must be a user id' });
    }

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
    const page = parsePage(req.query);
    if (page.error) {
      return res.status(400).json({ error: page.error });
    }

    const messages = await historyPage(GroupMessage, { group: groupId }, page, [
      ['sender', 'displayName photoURL role']
    ]);

    res.json(messages);
  } catch (err) {
    console.error('Error fetching group messages:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
