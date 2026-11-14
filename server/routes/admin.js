/**
 * The admin dashboard: figures, the user table, changing a role.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

// Import our models
const User = require('../models/User');
const Message = require('../models/Message');
const Group = require('../models/Group');
const GroupMessage = require('../models/GroupMessage');
const Announcement = require('../models/Announcement');
const Mentorship = require('../models/Mentorship');
const Goal = require('../models/Goal');
const Session = require('../models/Session');
const { publicUser } = require('../lib/publicUser');
// Authentication
const { requireAuth, requireRole } = require('../middleware/auth');
const { app, io } = require('../app');

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
    io.emit('user-updated', publicUser(updated));

    console.log(`\u{1F6E1} Admin ${req.authUser.displayName} set ${target.displayName} -> ${role}`);
    res.json(updated);
  } catch (err) {
    console.error('Error changing role as admin:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
