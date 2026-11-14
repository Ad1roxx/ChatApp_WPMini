/**
 * Goals and their milestones.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const Goal = require('../models/Goal');
// Tells the retrieval service which record changed - after the write, never
// awaited, never able to fail the request. See lib/indexSync.js.
const { syncSource } = require('../lib/indexSync');
// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const { resolveMentorshipAccess, goalsFor } = require('../lib/reads');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app, emitToUser } = require('../app');

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
