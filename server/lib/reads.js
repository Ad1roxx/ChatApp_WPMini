/**
 * Reads, each with its permission check, in ONE place (AGENT_PLAN S4 Step 0).
 *
 * The page routes in index.js and the agent's tools (lib/agentTools.js) both
 * call these. A check written once cannot drift between the two, and a tool
 * can never see more than the page that shows the same thing: it is the same
 * function.
 *
 * Every loader returns `{ error, status }` when the caller may not read, so a
 * route can answer with it directly, or `{ data, ... }` when they may. What
 * goes back to a browser and what goes to the model is shaped by the caller;
 * what may be READ is decided here.
 */
const mongoose = require('mongoose');
const Mentorship = require('../models/Mentorship');
const Goal = require('../models/Goal');
const Session = require('../models/Session');
const Resource = require('../models/Resource');
const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

/**
 * Does the mentorship exist, is the user part of it, and are they the mentor?
 *
 * Every per-mentorship route needs the same three answers, so they are worked
 * out once here rather than repeated with slightly different wording.
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

/** Load an assignment the caller set, or say why not. */
async function loadOwnAssignment(id, user) {
  if (!mongoose.isValidObjectId(id)) {
    return { error: 'Assignment not found', status: 404 };
  }

  const assignment = await Assignment.findById(id);
  if (!assignment) {
    return { error: 'Assignment not found', status: 404 };
  }

  if (String(assignment.mentor) !== String(user._id)) {
    return { error: 'Only the mentor who set this can do that', status: 403 };
  }

  return { assignment };
}

/** Load a submission with its assignment, or say why not. */
async function loadSubmission(id) {
  if (!mongoose.isValidObjectId(id)) {
    return { error: 'Submission not found', status: 404 };
  }

  const submission = await Submission.findById(id).populate('assignment');
  if (!submission || !submission.assignment) {
    return { error: 'Submission not found', status: 404 };
  }

  return { submission };
}

// ---------------------------------------------------------------------------
// Shaping helpers the reads share
// ---------------------------------------------------------------------------

const SESSION_POPULATE = [
  { path: 'proposedBy', select: 'displayName photoURL' },
  { path: 'cancelledBy', select: 'displayName photoURL' }
];

/**
 * Whether one hand-in is late against its assignment's deadline.
 *
 * Takes plain objects as well as documents, because the list routes read
 * with `.lean()`-shaped data after populating. Mirrors
 * `Submission.methods.isLate`, which is the version the model owns.
 */
function lateFor(sub, dueAt) {
  const due = new Date(dueAt).getTime();
  if (sub.submittedAt) return new Date(sub.submittedAt).getTime() > due;
  return Date.now() > due;
}

/**
 * A submission as the client wants it: with `late` worked out, since the rule
 * for that lives here and not in two React components.
 *
 * `assignment` is passed explicitly when the submission was loaded without it
 * populated — inside the mentor's per-assignment view, where it is the page.
 */
function serialiseSubmission(sub, assignment) {
  const s = sub.toObject ? sub.toObject() : sub;
  const a = assignment || s.assignment;
  return { ...s, late: a ? lateFor(s, a.dueAt) : false };
}

/**
 * The numbers behind "4 of 6 handed in".
 *
 * `handedIn` counts work that is currently in and not bounced back:
 * `submitted` and `accepted`. A `changes-requested` hand-in is not counted —
 * the student owes something again, and counting it as done would make the
 * headline number flatter than the truth.
 *
 * `drafts` is work attached but not turned in — the thing a mentor chasing a
 * deadline most wants to know about, and not the same as "not started".
 *
 * `overdue` is work not handed in with the deadline gone, drafts included: a
 * draft is not handed in. It is the figure a mentor actually chases.
 */
function summarise(subs, dueAt) {
  const pastDue = Date.now() > new Date(dueAt).getTime();
  const out = {
    total: subs.length,
    handedIn: 0,
    toReview: 0,
    accepted: 0,
    changesRequested: 0,
    drafts: 0,
    overdue: 0
  };

  for (const s of subs) {
    if (s.status === 'submitted' || s.status === 'accepted') out.handedIn += 1;
    if (s.status === 'submitted') out.toReview += 1;
    if (s.status === 'accepted') out.accepted += 1;
    if (s.status === 'changes-requested') out.changesRequested += 1;
    if (s.status === 'draft') out.drafts += 1;
    if ((s.status === 'assigned' || s.status === 'draft') && pastDue) out.overdue += 1;
  }

  return out;
}

// ---------------------------------------------------------------------------
// One mentorship: either party, nobody else
// ---------------------------------------------------------------------------

/** GET /api/mentorships/:id/goals. Archived goals included. */
async function goalsFor(mentorshipId, user) {
  const access = await resolveMentorshipAccess(mentorshipId, user);
  if (access.error) return access;

  const data = await Goal.find({ mentorship: mentorshipId })
    .sort({ createdAt: -1 })
    .populate('createdBy', 'displayName photoURL');
  return { ...access, data };
}

/** GET /api/mentorships/:id/sessions. Newest first, cancelled included. */
async function sessionsFor(mentorshipId, user) {
  const access = await resolveMentorshipAccess(mentorshipId, user);
  if (access.error) return access;

  const data = await Session.find({ mentorship: mentorshipId })
    .sort({ scheduledFor: -1 })
    .populate(SESSION_POPULATE);
  return { ...access, data };
}

/** GET /api/mentorships/:id/resources. Newest first. */
async function resourcesFor(mentorshipId, user) {
  const access = await resolveMentorshipAccess(mentorshipId, user);
  if (access.error) return access;

  const data = await Resource.find({ mentorship: mentorshipId })
    .sort({ createdAt: -1 })
    .populate('addedBy', 'displayName photoURL');
  return { ...access, data };
}

/** GET /api/mentorships/:id/assignments: this mentorship's hand-ins, soonest due first. */
async function mentorshipWorkFor(mentorshipId, user) {
  const access = await resolveMentorshipAccess(mentorshipId, user);
  if (access.error) return access;

  const subs = await Submission.find({ mentorship: mentorshipId })
    .populate({
      path: 'assignment',
      populate: { path: 'mentor', select: 'displayName photoURL' }
    })
    .populate('student', 'displayName photoURL');

  const data = subs
    .filter((s) => s.assignment)
    .map((s) => serialiseSubmission(s))
    .sort((a, b) => new Date(a.assignment.dueAt) - new Date(b.assignment.dueAt));
  return { ...access, data };
}

// ---------------------------------------------------------------------------
// One assignment: the mentor who set it, nobody else
// ---------------------------------------------------------------------------

/** GET /api/assignments/:id: the brief, the summary, every hand-in. */
async function assignmentOverviewFor(assignmentId, user) {
  const own = await loadOwnAssignment(assignmentId, user);
  if (own.error) return own;

  const subs = await Submission.find({ assignment: own.assignment._id }).populate(
    'student',
    'displayName photoURL'
  );
  subs.sort((a, b) =>
    (a.student?.displayName || '').localeCompare(b.student?.displayName || '')
  );

  return {
    assignment: own.assignment,
    data: {
      ...own.assignment.toObject(),
      summary: summarise(subs, own.assignment.dueAt),
      submissions: subs.map((s) => serialiseSubmission(s, own.assignment))
    }
  };
}

// ---------------------------------------------------------------------------
// The caller's own: scoped to them by the query itself
// ---------------------------------------------------------------------------

/**
 * GET /api/assignments: what you set (each with its summary), and your own
 * hand-ins. One person can be on both sides.
 */
async function myWorkFor(user) {
  const me = user._id;

  const set = await Assignment.find({ mentor: me }).sort({ dueAt: 1 });
  const setIds = set.map((a) => a._id);

  const setSubs = setIds.length
    ? await Submission.find({ assignment: { $in: setIds } }).select('assignment status submittedAt')
    : [];

  const subsBy = new Map();
  for (const s of setSubs) {
    const key = String(s.assignment);
    if (!subsBy.has(key)) subsBy.set(key, []);
    subsBy.get(key).push(s);
  }

  const mine = await Submission.find({ student: me })
    .populate({
      path: 'assignment',
      populate: { path: 'mentor', select: 'displayName photoURL' }
    })
    .populate('student', 'displayName photoURL');

  return {
    data: {
      set: set.map((a) => ({
        ...a.toObject(),
        summary: summarise(subsBy.get(String(a._id)) || [], a.dueAt)
      })),
      mine: mine
        // A hand-in whose assignment has gone is an orphan, not work.
        .filter((s) => s.assignment)
        .map((s) => serialiseSubmission(s))
        .sort((a, b) => new Date(a.assignment.dueAt) - new Date(b.assignment.dueAt))
    }
  };
}

/**
 * GET /api/assignments/counts: what you owe as a student, and what waits on
 * you as a mentor.
 */
async function myWorkCountsFor(user) {
  const me = user._id;

  // Owed: set for you and not handed in. A draft counts — it is attached,
  // not handed in — and so does work sent back for changes.
  const owed = await Submission.countDocuments({
    student: me,
    status: { $in: ['assigned', 'draft', 'changes-requested'] }
  });

  const set = await Assignment.find({ mentor: me }).select('_id');
  const toReview = set.length
    ? await Submission.countDocuments({
        assignment: { $in: set.map((a) => a._id) },
        status: 'submitted'
      })
    : 0;

  return { data: { owed, toReview } };
}

/**
 * GET /api/sessions/upcoming: your next sessions across ACTIVE mentorships,
 * soonest first. A session left over from a relationship that has since ended
 * is not something either person still owes.
 */
async function upcomingSessionsFor(user) {
  const mine = await Mentorship.find({
    status: 'active',
    $or: [{ mentor: user._id }, { student: user._id }]
  }).select('_id');

  if (mine.length === 0) return { data: [] };

  const data = await Session.find({
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
  return { data };
}

module.exports = {
  resolveMentorshipAccess,
  loadOwnAssignment,
  loadSubmission,
  SESSION_POPULATE,
  lateFor,
  serialiseSubmission,
  summarise,
  goalsFor,
  sessionsFor,
  resourcesFor,
  mentorshipWorkFor,
  assignmentOverviewFor,
  myWorkFor,
  myWorkCountsFor,
  upcomingSessionsFor
};
