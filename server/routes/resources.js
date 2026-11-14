/**
 * Shared links.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const Resource = require('../models/Resource');
// Tells the retrieval service which record changed - after the write, never
// awaited, never able to fail the request. See lib/indexSync.js.
const { syncSource } = require('../lib/indexSync');
// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const { resolveMentorshipAccess, resourcesFor } = require('../lib/reads');
const { parseSharedUrl } = require('../lib/sharedUrl');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app, emitToUser } = require('../app');

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
