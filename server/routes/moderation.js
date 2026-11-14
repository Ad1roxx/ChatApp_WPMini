/**
 * Mentor verification, suspension, and reports.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const mongoose = require('mongoose');
// Import our models
const User = require('../models/User');
const Message = require('../models/Message');
const Group = require('../models/Group');
const GroupMessage = require('../models/GroupMessage');
const Announcement = require('../models/Announcement');
const Report = require('../models/Report');
const { parseSharedUrl } = require('../lib/sharedUrl');
const { publicUser } = require('../lib/publicUser');
const { limited } = require('../lib/rateLimit');
// Authentication
const { requireAuth, requireRole } = require('../middleware/auth');
const { app, io, reportLimiter, onlineUsers } = require('../app');

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

    const { yearsExperience } = req.body || {};
    const company = typeof req.body?.company === 'string' ? req.body.company : '';
    const title = typeof req.body?.title === 'string' ? req.body.title : '';
    const rawLink = typeof req.body?.linkedinUrl === 'string' ? req.body.linkedinUrl.trim() : '';

    if (!company.trim() || !title.trim()) {
      return res.status(400).json({ error: 'Company and title are required' });
    }

    // The admin opens this link from the review queue, so it must be a web
    // address: a `javascript:` one would run in the admin's page (the audit, F4).
    let linkedinUrl = '';
    if (rawLink) {
      const link = parseSharedUrl(rawLink);
      if (link.error) {
        return res.status(400).json({ error: 'The profile link must be an http or https address' });
      }
      linkedinUrl = link.url;
    }

    user.verification = {
      status: 'pending',
      linkedinUrl,
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

    // The badge is visible to everyone, so everyone's copy should update:
    // the status, not the evidence or the review note (lib/publicUser.js).
    io.emit('user-updated', publicUser(updated));

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

    io.emit('user-updated', publicUser(updated));

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
app.post('/api/reports', requireAuth, limited(reportLimiter, 'Too many reports. Try again later.'), async (req, res) => {
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
    // Before any query reads it: an id that is not one is content that does not exist.
    if (typeof targetId !== 'string' || !mongoose.isValidObjectId(targetId)) {
      return res.status(404).json({ error: 'That content no longer exists' });
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

    // Snapshot whatever the target currently says, if the reporter can see it.
    // Without that check, and with the snapshot in the response, a report was a
    // way to read any message by its id (the audit, F3). A target the reporter
    // cannot see gets the same answer as one that does not exist.
    const snapshot = await snapshotTarget(targetType, targetId, req.authUser._id);
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
    // The snapshot is for the admin's queue. The reporter gets the rest.
    const filed = report.toObject();
    delete filed.targetSnapshot;
    res.json(filed);
  } catch (err) {
    console.error('Error filing report:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Read the reported thing and return a short text form of it, or null when it
 * does not exist OR the reporter could not have seen it. Keeps the four
 * collection lookups out of the route body.
 *
 * Who can see what: a user and an announcement, anyone signed in; a message,
 * its sender and its receiver; a group message, the group's members.
 */
async function snapshotTarget(targetType, targetId, reporterId) {
  const me = String(reporterId);

  if (targetType === 'user') {
    const user = await User.findById(targetId).select('displayName email bio');
    return user ? `${user.displayName} <${user.email}> — ${user.bio || 'no bio'}` : null;
  }

  if (targetType === 'message') {
    const doc = await Message.findById(targetId).select('text sender receiver');
    if (!doc) return null;
    return String(doc.sender) === me || String(doc.receiver) === me ? doc.text : null;
  }

  if (targetType === 'groupMessage') {
    const doc = await GroupMessage.findById(targetId).select('text group');
    if (!doc) return null;
    const member = await Group.exists({ _id: doc.group, members: reporterId });
    return member ? doc.text : null;
  }

  const doc = await Announcement.findById(targetId).select('text');
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
