/**
 * Assignments and hand-ins.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const mongoose = require('mongoose');
const Mentorship = require('../models/Mentorship');
const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');
const CriteriaSet = require('../models/CriteriaSet');
const fileStore = require('../lib/fileStore');
// Tells the retrieval service which record changed - after the write, never
// awaited, never able to fail the request. See lib/indexSync.js.
const { syncSource } = require('../lib/indexSync');
// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const {
  loadOwnAssignment,
  loadSubmission,
  serialiseSubmission,
  summarise,
  mentorshipWorkFor,
  assignmentOverviewFor,
  myWorkFor,
  myWorkCountsFor
} = require('../lib/reads');
const { parseSharedUrl } = require('../lib/sharedUrl');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app, emitToUser } = require('../app');

// ============================================
// ASSIGNMENTS - SHARED, CLASSROOM-STYLE
// ============================================

// lateFor, serialiseSubmission and summarise live in lib/reads.js, shared with the agent's tools.

/**
 * Check that every mentorship in a recipient list is the caller's own, active
 * student — and turn the list into documents.
 *
 * Refuses the whole list if any one entry is wrong, rather than silently
 * sending to the valid ones. A mentor who ticked six students and reached
 * five would not know which one was missed.
 */
async function resolveRecipients(mentorshipIds, user) {
  const ids = [
    ...new Set((Array.isArray(mentorshipIds) ? mentorshipIds : []).map(String))
  ];

  if (ids.length === 0) {
    return { error: 'Pick at least one student', status: 400 };
  }

  if (!ids.every((id) => mongoose.isValidObjectId(id))) {
    return { error: 'One of those mentorships does not exist', status: 404 };
  }

  const found = await Mentorship.find({ _id: { $in: ids } });

  if (found.length !== ids.length) {
    return { error: 'One of those mentorships does not exist', status: 404 };
  }

  const me = String(user._id);

  // Only your own students. Setting work for someone else's student would let
  // any mentor put tasks in front of any student in the app.
  if (found.some((m) => String(m.mentor) !== me)) {
    return { error: 'You can only set work for your own students', status: 403 };
  }

  if (found.some((m) => m.status !== 'active')) {
    return { error: 'One of those mentorships is not active', status: 400 };
  }

  return { mentorships: found };
}

// loadOwnAssignment and loadSubmission live in lib/reads.js, shared with the agent's tools.

/** Re-read a submission the way every response shapes it. */
function loadSubmissionForResponse(id) {
  return Submission.findById(id)
    .populate({
      path: 'assignment',
      populate: { path: 'mentor', select: 'displayName photoURL' }
    })
    .populate('student', 'displayName photoURL');
}

/**
 * Tell everyone an assignment touches that it changed.
 *
 * The payload is just the id, and clients refetch. A mentor and a student want
 * differently-shaped answers from the same change — the mentor a summary of
 * six hand-ins, the student only their own — so a single pushed object would
 * be wrong for one of them, and pushing a different one to each would mean
 * duplicating every route's shaping logic inside the socket layer.
 */
function announceAssignment(assignmentId, mentorId, studentIds) {
  const payload = { assignmentId: String(assignmentId) };
  emitToUser(mentorId, 'assignment-changed', payload);
  for (const studentId of studentIds) {
    emitToUser(studentId, 'assignment-changed', payload);
  }
}

/**
 * A short, readable notice for the people it happened to.
 *
 * Separate from `assignment-changed`, which carries only an id and exists so
 * open screens refetch. This is the sentence a person reads, and it says where
 * to look.
 *
 * Nothing is stored. A notice missed while signed out is not something the app
 * owes anybody later — the count in the sidebar is what survives a reload, and
 * it is derived from the work itself rather than from a list of events.
 */
function notifyWork(userIds, text, to = '/assignments') {
  for (const id of userIds) {
    emitToUser(id, 'work-notice', { text, to, at: new Date().toISOString() });
  }
}

/**
 * POST /api/assignments
 *
 * Set work for one or several students at once. MENTOR ONLY, and only for
 * their own active students.
 *
 * One `Submission` row is created per recipient in the same request, with
 * status `assigned` — so "not handed in" is a real state from the first
 * moment, not the absence of a row.
 *
 * Body: title, instructions, dueAt, mentorshipIds[]
 */
app.post('/api/assignments', requireAuth, async (req, res) => {
  try {
    const { title, instructions = '', dueAt, mentorshipIds } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'A title is required' });
    }

    const due = new Date(dueAt);
    if (Number.isNaN(due.getTime())) {
      return res.status(400).json({ error: 'A valid due date is required' });
    }

    // A typo guard more than a rule: work that was overdue the moment it
    // appeared is nobody's intention, and the wrong year is the easiest thing
    // to mistype in a date field.
    if (due.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Pick a due date in the future' });
    }

    const recipients = await resolveRecipients(mentorshipIds, req.authUser);
    if (recipients.error) {
      return res.status(recipients.status).json({ error: recipients.error });
    }

    const assignment = await Assignment.create({
      mentor: req.authUser._id,
      mentorships: recipients.mentorships.map((m) => m._id),
      title: String(title).trim(),
      instructions: String(instructions).trim(),
      dueAt: due
    });

    const assignedAt = new Date();
    const submissions = await Submission.insertMany(
      recipients.mentorships.map((m) => ({
        assignment: assignment._id,
        mentorship: m._id,
        student: m.student,
        // Every history starts here, so the log answers "when was this set
        // for me" as well as everything after it.
        history: [{ type: 'assigned', at: assignedAt, by: req.authUser._id }]
      }))
    );

    // The brief, in each mentorship it was set to. Its hand-ins are empty
    // until a student writes something, so there is nothing more to index.
    syncSource('assignment', assignment._id);

    announceAssignment(
      assignment._id,
      req.authUser._id,
      recipients.mentorships.map((m) => m.student)
    );

    notifyWork(
      recipients.mentorships.map((m) => m.student),
      `${req.authUser.displayName} set new work: ${assignment.title}`
    );

    res.status(201).json({
      ...assignment.toObject(),
      summary: summarise(submissions, due)
    });
  } catch (err) {
    console.error('Error setting assignment:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/assignments
 *
 * Everything on your plate, from both sides of the desk:
 *
 *   set   assignments you set, each with its "4 of 6" summary
 *   mine  your own hand-ins, for work set for you
 *
 * Both are returned because one person can be on both sides — a mentor with
 * a mentor of their own is the ordinary case, not an edge one.
 */
app.get('/api/assignments', requireAuth, async (req, res) => {
  try {
    res.json((await myWorkFor(req.authUser)).data);
  } catch (err) {
    console.error('Error listing assignments:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/assignments/counts
 *
 * The two numbers the sidebar badge is made of, and nothing else: what you owe
 * as a student, and what is waiting on you as a mentor. One person can be
 * both, so both always come back.
 *
 * Declared BEFORE `/api/assignments/:id`, or Express reads "counts" as an id
 * and hands the request to that route instead.
 *
 * Deliberately not the full list. The shell draws this on every page, and a
 * badge is not worth shipping every assignment and hand-in to render.
 */
app.get('/api/assignments/counts', requireAuth, async (req, res) => {
  try {
    res.json((await myWorkCountsFor(req.authUser)).data);
  } catch (err) {
    console.error('Error counting assignments:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/assignments/:id
 *
 * The mentor's view of one assignment: the brief, the summary, and every
 * student's hand-in side by side.
 *
 * MENTOR ONLY — specifically the mentor who set it. A student never sees this
 * route, because it would show them their classmates' work and their
 * classmates' feedback, and neither is theirs to read.
 */
app.get('/api/assignments/:id', requireAuth, async (req, res) => {
  try {
    const read = await assignmentOverviewFor(req.params.id, req.authUser);
    if (read.error) {
      return res.status(read.status).json({ error: read.error });
    }
    res.json(read.data);
  } catch (err) {
    console.error('Error reading assignment:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/mentorships/:id/assignments
 *
 * The work inside one mentorship — one student's hand-ins, whether that
 * student is the one asking or their mentor is. Both parties of the
 * relationship may read it, and nobody else.
 */
app.get('/api/mentorships/:id/assignments', requireAuth, async (req, res) => {
  try {
    const read = await mentorshipWorkFor(req.params.id, req.authUser);
    if (read.error) {
      return res.status(read.status).json({ error: read.error });
    }
    res.json(read.data);
  } catch (err) {
    console.error('Error listing mentorship assignments:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/submissions/:id
 *
 * Save work, and optionally turn it in. ONLY the student it was set for — not
 * the mentor, and not a classmate.
 *
 *   { text, url }                 hand it in (the default)
 *   { text, url, turnIn: false }  save it as a draft: attached, not handed in
 *
 * A piece of work that is already handed in cannot be edited as a draft —
 * Unsubmit first. That keeps "they took it back to change it" an explicit,
 * logged event rather than something that happens silently inside a save,
 * which is the whole point of the history.
 *
 * PUT because it is idempotent: saving again replaces what was there.
 */
app.put('/api/submissions/:id', requireAuth, async (req, res) => {
  try {
    const loaded = await loadSubmission(req.params.id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const { submission } = loaded;

    if (String(submission.student) !== String(req.authUser._id)) {
      return res
        .status(403)
        .json({ error: 'Only the student it was set for can hand this in' });
    }

    const turnIn = req.body.turnIn !== false;

    if (submission.status === 'accepted') {
      return res.status(400).json({ error: 'That work has already been accepted' });
    }

    if (!turnIn && submission.status === 'submitted') {
      return res.status(400).json({ error: 'Unsubmit it first to edit it' });
    }

    if (!submission.canBecome(turnIn ? 'submitted' : 'draft')) {
      return res.status(400).json({ error: 'That is already handed in' });
    }

    const text = String(req.body.text || '').trim();
    const rawUrl = String(req.body.url || '').trim();

    // Files count as work: a hand-in can be a PDF and nothing else.
    if (!text && !rawUrl && submission.attachments.length === 0) {
      return res.status(400).json({ error: 'Write something, add a link or attach a file' });
    }

    let url = '';
    if (rawUrl) {
      // The same allow-list shared resources use. The mentor clicks this.
      const link = parseSharedUrl(rawUrl);
      if (link.error) {
        return res.status(400).json({ error: link.error });
      }
      url = link.url;
    }

    submission.text = text;
    submission.url = url;

    if (turnIn) {
      submission.status = 'submitted';
      submission.submittedAt = new Date();

      // A fresh hand-in is a fresh answer. Leaving the old "change this"
      // hanging over new work would read as a second rejection.
      submission.review.note = '';
      submission.review.reviewedAt = null;

      submission.log('submitted', req.authUser._id);
    } else {
      submission.status = 'draft';
      submission.draftSavedAt = new Date();

      // The review note is kept on a draft: a student editing after being
      // sent back still needs to see what they were asked to change.
      submission.log('draft-saved', req.authUser._id);
    }

    await submission.save();
    syncSource('submission', submission._id);

    // Only this student and the mentor care. A classmate's hand-in changes
    // nothing on anyone else's screen.
    announceAssignment(submission.assignment._id, submission.assignment.mentor, [
      submission.student
    ]);

    // Saving a draft is not news to anyone: the mentor can see it, but it is
    // not waiting on them.
    if (turnIn) {
      notifyWork(
        [submission.assignment.mentor],
        `${req.authUser.displayName} handed in: ${submission.assignment.title}`
      );
    }

    res.json(serialiseSubmission(await loadSubmissionForResponse(submission._id), undefined, req.authUser));
  } catch (err) {
    console.error('Error handing in:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/submissions/:id/unsubmit
 *
 * Take a hand-in back to change it. STUDENT ONLY, and only while it is
 * `submitted`: once accepted it is a record, and letting it be pulled back
 * would let a student quietly rewrite something the mentor already signed
 * off.
 *
 * The work is kept and becomes a draft — unsubmitting is "let me change
 * this", not "throw it away". `submittedAt` is cleared, because after this it
 * is not handed in and lateness derives from it; the history keeps the record
 * of when it was.
 */
app.post('/api/submissions/:id/unsubmit', requireAuth, async (req, res) => {
  try {
    const loaded = await loadSubmission(req.params.id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const { submission } = loaded;

    if (String(submission.student) !== String(req.authUser._id)) {
      return res
        .status(403)
        .json({ error: 'Only the student who handed it in can take it back' });
    }

    if (submission.status !== 'submitted') {
      return res.status(400).json({
        error:
          submission.status === 'accepted'
            ? 'That work has been accepted — it is a record now'
            : 'That is not handed in'
      });
    }

    submission.status = 'draft';
    submission.submittedAt = null;
    submission.draftSavedAt = new Date();
    submission.log('unsubmitted', req.authUser._id);

    await submission.save();
    syncSource('submission', submission._id);

    announceAssignment(submission.assignment._id, submission.assignment.mentor, [
      submission.student
    ]);

    res.json(serialiseSubmission(await loadSubmissionForResponse(submission._id), undefined, req.authUser));
  } catch (err) {
    console.error('Error unsubmitting:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/submissions/:id
 *
 * The mentor reviews ONE student's hand-in: `accept`, or `request-changes`
 * with a note. Only the mentor who set the assignment — being someone's
 * mentor for other work does not make you the reviewer of this.
 *
 * Asking for changes needs a note, because "do it again" with no reason is
 * not feedback and leaves the student guessing.
 */
app.patch('/api/submissions/:id', requireAuth, async (req, res) => {
  try {
    const loaded = await loadSubmission(req.params.id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const { submission } = loaded;

    if (String(submission.assignment.mentor) !== String(req.authUser._id)) {
      return res
        .status(403)
        .json({ error: 'Only the mentor who set this can review it' });
    }

    const { action, note = '' } = req.body;

    if (action !== 'accept' && action !== 'request-changes') {
      return res.status(400).json({ error: 'Unknown action' });
    }

    const next = action === 'accept' ? 'accepted' : 'changes-requested';

    if (!submission.canBecome(next)) {
      return res.status(400).json({
        error:
          submission.status === 'assigned'
            ? 'Nothing has been handed in yet'
            : `A ${submission.status} hand-in cannot be ${next}`
      });
    }

    if (action === 'request-changes' && !String(note).trim()) {
      return res.status(400).json({ error: 'Say what needs changing' });
    }

    submission.status = next;
    submission.review.note = String(note).trim();
    submission.review.reviewedAt = new Date();
    submission.log(next, req.authUser._id);
    await submission.save();
    syncSource('submission', submission._id);

    announceAssignment(submission.assignment._id, submission.assignment.mentor, [
      submission.student
    ]);

    notifyWork(
      [submission.student],
      action === 'accept'
        ? `${req.authUser.displayName} accepted your work: ${submission.assignment.title}`
        : `${req.authUser.displayName} asked for changes: ${submission.assignment.title}`
    );

    res.json(serialiseSubmission(await loadSubmissionForResponse(submission._id), undefined, req.authUser));
  } catch (err) {
    console.error('Error reviewing hand-in:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/assignments/:id
 *
 * Edit the shared part — title, instructions, deadline — or send it to more
 * students. MENTOR ONLY.
 *
 * Editing the brief once changes it for everyone, which is the point of an
 * assignment being one document. Moving the deadline re-derives lateness for
 * every recipient, because late is always relative to the deadline as it now
 * stands; that is what "extend the deadline" means.
 *
 * `addMentorshipIds` covers the student who joins after the work was set:
 * without it, the mentor would have to recreate the assignment and lose every
 * hand-in already made against the original.
 */
app.patch('/api/assignments/:id', requireAuth, async (req, res) => {
  try {
    const own = await loadOwnAssignment(req.params.id, req.authUser);
    if (own.error) {
      return res.status(own.status).json({ error: own.error });
    }
    const { assignment } = own;

    const { title, instructions, dueAt, addMentorshipIds } = req.body;

    if (
      title === undefined &&
      instructions === undefined &&
      dueAt === undefined &&
      addMentorshipIds === undefined
    ) {
      return res.status(400).json({ error: 'Nothing to change' });
    }

    if (title !== undefined) {
      if (!String(title).trim()) {
        return res.status(400).json({ error: 'A title is required' });
      }
      assignment.title = String(title).trim();
    }

    if (instructions !== undefined) {
      assignment.instructions = String(instructions).trim();
    }

    if (dueAt !== undefined) {
      const due = new Date(dueAt);
      if (Number.isNaN(due.getTime())) {
        return res.status(400).json({ error: 'A valid due date is required' });
      }
      if (due.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'Pick a due date in the future' });
      }
      assignment.dueAt = due;
    }

    if (addMentorshipIds !== undefined) {
      const recipients = await resolveRecipients(addMentorshipIds, req.authUser);
      if (recipients.error) {
        return res.status(recipients.status).json({ error: recipients.error });
      }

      // Already-recipients are skipped rather than refused: ticking a student
      // who already has the work is a harmless no-op, not a mistake to report.
      const existing = new Set(assignment.mentorships.map(String));
      const fresh = recipients.mentorships.filter((m) => !existing.has(String(m._id)));

      if (fresh.length) {
        assignment.mentorships.push(...fresh.map((m) => m._id));
        const addedAt = new Date();
        await Submission.insertMany(
          fresh.map((m) => ({
            assignment: assignment._id,
            mentorship: m._id,
            student: m.student,
            // A student added later starts their history when THEY were
            // added, not when the assignment was first set.
            history: [{ type: 'assigned', at: addedAt, by: req.authUser._id }]
          }))
        );

        // Only the students just added. Everybody else already had it, and
        // being told twice about the same assignment is noise.
        notifyWork(
          fresh.map((m) => m.student),
          `${req.authUser.displayName} set new work: ${assignment.title}`
        );
      }
    }

    await assignment.save();
    // Its hand-ins take their title from it, so the service re-syncs them too.
    syncSource('assignment', assignment._id);

    const subs = await Submission.find({ assignment: assignment._id });
    announceAssignment(
      assignment._id,
      assignment.mentor,
      subs.map((s) => s.student)
    );

    res.json({ ...assignment.toObject(), summary: summarise(subs, assignment.dueAt) });
  } catch (err) {
    console.error('Error editing assignment:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/assignments/:id
 *
 * Withdraw work that should not have been set. MENTOR ONLY.
 *
 * Refused once ANY student's hand-in has been accepted: at that point part of
 * it is a record of something a student did, and withdrawing the assignment
 * would erase their work rather than the mentor's mistake.
 *
 * Everything handed in against it goes too, files included.
 */
app.delete('/api/assignments/:id', requireAuth, async (req, res) => {
  try {
    const own = await loadOwnAssignment(req.params.id, req.authUser);
    if (own.error) {
      return res.status(own.status).json({ error: own.error });
    }
    const { assignment } = own;

    const subs = await Submission.find({ assignment: assignment._id });

    if (subs.some((s) => s.status === 'accepted')) {
      return res.status(400).json({
        error: 'Some of this work has been accepted — it is a record now'
      });
    }

    await Submission.deleteMany({ assignment: assignment._id });
    await CriteriaSet.deleteMany({ assignment: assignment._id });
    await assignment.deleteOne();

    // The brief and every hand-in, each by name. The assignment's own sync
    // would find its hand-ins' chunks anyway; naming them costs nothing and
    // does not rely on that.
    syncSource('assignment', assignment._id);
    for (const s of subs) syncSource('submission', s._id);

    // Records first, then bytes: if this fails halfway, the worst case is an
    // orphaned file nobody can reach, never a hand-in pointing at nothing.
    const fileIds = [
      ...assignment.attachments.map((f) => f.fileId),
      ...subs.flatMap((s) => s.attachments.map((f) => f.fileId))
    ];
    await Promise.all(fileIds.map((id) => fileStore.removeFile(id)));

    announceAssignment(
      assignment._id,
      assignment.mentor,
      subs.map((s) => s.student)
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Error withdrawing assignment:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { loadSubmissionForResponse, announceAssignment };
