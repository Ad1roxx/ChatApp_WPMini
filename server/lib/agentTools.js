/**
 * The agent's read tools, as Express runs them (AGENT_PLAN §3, S4 Step 0).
 *
 * The registry is data: for each tool, which roles may call it, what it is
 * scoped to, the exact shape of its arguments, and a handler. The endpoint in
 * index.js has already checked the token, the user, the mentorship and the
 * role before a handler runs; then it refuses a role the tool does not list,
 * and arguments that are not exactly the shape below.
 *
 * Every handler reads through lib/reads.js, the same function the page's
 * route calls, so a tool cannot see more than that page shows.
 *
 * What comes back is shaped for the model, not the page:
 *
 * - **No names.** People are "mentor" or "student", by their place in the
 *   mentorship record. Names are personal data the answers do not need.
 * - **Ids stay out of the model's sight.** Each record carries its kind and id
 *   so the AI service can give it a handle (`T1`) and the panel an anchor; the
 *   service shows the model the handle, never the id.
 * - **Bounded.** At most MAX_RECORDS records, each text field cut to
 *   MAX_TEXT characters, with a note saying so when anything was cut.
 *
 * Text people wrote (titles, notes, review comments) is untrusted. The AI
 * service fences and defuses it like any other source; nothing here treats it
 * as anything but a string.
 */
const mongoose = require('mongoose');
const Mentorship = require('../models/Mentorship');
const reads = require('./reads');

const MAX_RECORDS = 20;
const MAX_TEXT = 600;
// The Submission model's limit on an attachment's name.
const MAX_FILE_NAME = 200;
const BOTH = Object.freeze(['mentor', 'student']);

const text = (value) => {
  const s = String(value ?? '');
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
};
const when = (d) => (d ? new Date(d).toISOString() : null);
const idOf = (ref) => (ref && ref._id ? String(ref._id) : ref ? String(ref) : null);

/** "mentor", "student", or null: someone's place in this mentorship, never their name. */
function roleIn(mentorship, ref) {
  const id = idOf(ref);
  if (!id) return null;
  if (id === idOf(mentorship.mentor)) return 'mentor';
  if (id === idOf(mentorship.student)) return 'student';
  return null;
}

/** The first MAX_RECORDS, and a note when there were more. */
function bounded(records, what) {
  if (records.length <= MAX_RECORDS) return { records };
  return {
    records: records.slice(0, MAX_RECORDS),
    note: `Showing ${MAX_RECORDS} of ${records.length} ${what}.`
  };
}

function handIn(s) {
  const reviewed = s.review && s.review.reviewedAt;
  return {
    kind: 'submission',
    id: String(s._id),
    mentorshipId: idOf(s.mentorship),
    // For get_assignment_overview by this hand-in's handle; never shown to the model.
    assignmentId: idOf(s.assignment),
    assignment: text(s.assignment.title),
    dueAt: when(s.assignment.dueAt),
    status: s.status,
    late: Boolean(s.late),
    handedInAt: when(s.submittedAt),
    review: reviewed
      ? { at: when(s.review.reviewedAt), comment: text(s.review.note) }
      : null,
    files: (s.attachments || []).map((f) => text(f.name))
  };
}

function session(s, mentorship) {
  return {
    kind: 'session',
    id: String(s._id),
    mentorshipId: idOf(s.mentorship),
    title: text(s.title),
    agenda: text(s.agenda),
    at: when(s.scheduledFor),
    minutes: s.durationMinutes,
    status: s.status,
    proposedBy: mentorship ? roleIn(mentorship, s.proposedBy) : null,
    notes: text(s.notes),
    cancelReason: s.status === 'cancelled' ? text(s.cancelReason) : ''
  };
}

const TOOLS = {
  list_goals: {
    roles: BOTH,
    scope: 'mentorship',
    args: {},
    async run({ user, mentorship }) {
      const read = await reads.goalsFor(mentorship._id, user);
      if (read.error) return read;
      return bounded(
        read.data.map((g) => ({
          kind: 'goal',
          id: String(g._id),
          title: text(g.title),
          description: text(g.description),
          status: g.status,
          setBy: roleIn(mentorship, g.createdBy),
          milestones: g.milestones.map((m) => ({ title: text(m.title), done: Boolean(m.done) }))
        })),
        'goals'
      );
    }
  },

  list_mentorship_assignments: {
    roles: BOTH,
    scope: 'mentorship',
    args: {},
    async run({ user, mentorship }) {
      const read = await reads.mentorshipWorkFor(mentorship._id, user);
      if (read.error) return read;
      return bounded(read.data.map((s) => handIn(s)), 'hand-ins');
    }
  },

  list_sessions: {
    roles: BOTH,
    scope: 'mentorship',
    args: {},
    async run({ user, mentorship }) {
      const read = await reads.sessionsFor(mentorship._id, user);
      if (read.error) return read;
      return bounded(read.data.map((s) => session(s, mentorship)), 'sessions');
    }
  },

  list_resources: {
    roles: BOTH,
    scope: 'mentorship',
    args: {},
    async run({ user, mentorship }) {
      const read = await reads.resourcesFor(mentorship._id, user);
      if (read.error) return read;
      return bounded(
        read.data.map((r) => ({
          kind: 'resource',
          id: String(r._id),
          title: text(r.title),
          url: text(r.url),
          note: text(r.note),
          addedBy: roleIn(mentorship, r.addedBy)
        })),
        'resources'
      );
    }
  },

  /**
   * Counts only. The page this mirrors lists every student's hand-in by name;
   * the agent gets the summary, for work set in THIS mentorship.
   */
  get_assignment_overview: {
    roles: Object.freeze(['mentor']),
    scope: 'mentorship',
    args: { assignmentId: 'objectId' },
    async run({ user, mentorship, args }) {
      const read = await reads.assignmentOverviewFor(args.assignmentId, user);
      if (read.error) return read;
      // Stricter than the page (§4.4): the agent in one mentorship's panel
      // reads only work set in that mentorship.
      if (!read.assignment.mentorships.some((m) => String(m) === String(mentorship._id))) {
        return { error: "That work wasn't set in this mentorship", status: 403 };
      }
      const { summary } = read.data;
      return {
        records: [
          {
            kind: 'assignment',
            id: String(read.assignment._id),
            title: text(read.assignment.title),
            dueAt: when(read.assignment.dueAt),
            students: summary.total,
            // Everything handed in, including what has been sent back. The page's own
            // `handedIn` leaves those out; said to a mentor as a count it reads as "0 handed
            // in" about work that has been (BUILD_NOTES Entry 107). Shown beside its own count.
            handedIn: summary.handedIn + summary.changesRequested,
            waitingForReview: summary.toReview,
            accepted: summary.accepted,
            changesRequested: summary.changesRequested,
            drafts: summary.drafts,
            overdue: summary.overdue
          }
        ]
      };
    }
  },

  /** The asker's own work, across all their mentorships. */
  list_my_work: {
    roles: BOTH,
    scope: 'self',
    args: {},
    async run({ user, mentorship }) {
      const [work, counts] = await Promise.all([reads.myWorkFor(user), reads.myWorkCountsFor(user)]);
      const ids = [...new Set(work.data.mine.map((s) => idOf(s.mentorship)))];
      // Topics of the asker's OWN mentorships only, so a topic is never a way in.
      const topics = new Map(
        (
          await Mentorship.find({
            _id: { $in: ids },
            $or: [{ mentor: user._id }, { student: user._id }]
          }).select('topic')
        ).map((m) => [String(m._id), m.topic])
      );
      const here = String(mentorship._id);
      const mine = work.data.mine.map((s) => ({
        ...handIn(s),
        topic: text(topics.get(idOf(s.mentorship)) || ''),
        inThisMentorship: idOf(s.mentorship) === here
      }));
      const set = work.data.set.map((a) => ({
        kind: 'assignment',
        id: String(a._id),
        title: text(a.title),
        dueAt: when(a.dueAt),
        students: a.summary.total,
        waitingForReview: a.summary.toReview,
        overdue: a.summary.overdue
      }));
      const out = bounded([...mine, ...set], 'items');
      return {
        ...out,
        counts: { owedByYou: counts.data.owed, waitingForYourReview: counts.data.toReview }
      };
    }
  },

  /**
   * Not offered to the model. The AI service calls it for summarize_attachment,
   * which the model calls with a hand-in's handle and a file name: before it
   * reads one chunk of the file, this says whether the asker may open that file
   * and which file the name means. The checks are the download route's, from
   * lib/reads.js, plus the hand-in being in THIS mentorship.
   */
  check_attachment: {
    roles: BOTH,
    scope: 'mentorship',
    internal: true,
    args: { submissionId: 'objectId', fileName: 'fileName' },
    async run({ user, mentorship, args }) {
      const loaded = await reads.loadSubmission(args.submissionId);
      if (loaded.error) return loaded;
      const { submission } = loaded;
      if (idOf(submission.mentorship) !== String(mentorship._id)) {
        return { error: "That hand-in isn't in this mentorship", status: 403 };
      }
      if (!reads.canReadSubmissionFile(submission, user)) {
        return { error: 'Only the student and the mentor who set this can open it', status: 403 };
      }
      const named = (submission.attachments || []).filter((f) => f.name === args.fileName);
      if (named.length === 0) return { error: 'That hand-in has no file by that name', status: 404 };
      // Names are not unique on upload; guessing between two would summarise the wrong one.
      if (named.length > 1) return { error: 'More than one file in that hand-in has that name', status: 422 };
      const [file] = named;
      return {
        records: [
          {
            kind: 'file',
            id: String(file.fileId),
            submissionId: String(submission._id),
            mentorshipId: idOf(submission.mentorship),
            name: text(file.name),
            contentType: file.contentType
          }
        ]
      };
    }
  },

  /** The asker's next sessions, across all their active mentorships. */
  list_my_upcoming_sessions: {
    roles: BOTH,
    scope: 'self',
    args: {},
    async run({ user, mentorship }) {
      const read = await reads.upcomingSessionsFor(user);
      const here = String(mentorship._id);
      return bounded(
        read.data.map((s) => ({
          ...session(s, s.mentorship),
          mentorshipId: idOf(s.mentorship),
          topic: text(s.mentorship?.topic),
          inThisMentorship: idOf(s.mentorship) === here
        })),
        'sessions'
      );
    }
  }
};

for (const spec of Object.values(TOOLS)) Object.freeze(spec);
Object.freeze(TOOLS);

/** The tool by name, as an own property only: `constructor` is not a tool. */
function toolNamed(name) {
  return Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
}

/** Names of the tools this role may be offered. Pure. */
function toolsFor(role) {
  return Object.keys(TOOLS).filter((name) => !TOOLS[name].internal && TOOLS[name].roles.includes(role));
}

/** Names of the tools only the AI service calls, for this role. Pure. */
function internalToolsFor(role) {
  return Object.keys(TOOLS).filter((name) => TOOLS[name].internal && TOOLS[name].roles.includes(role));
}

/**
 * Why these arguments are not exactly the tool's shape, or null.
 *
 * Exactly: no missing key, no extra key, nothing that is not the type named.
 * So a model that invents `mentorshipId` or `userId` is refused here as well
 * as in the AI service, and identity can never ride in on an argument.
 */
function argsProblem(spec, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'not an object';
  const want = Object.keys(spec.args);
  const got = Object.keys(args);
  const extra = got.filter((k) => !want.includes(k));
  if (extra.length) return `unexpected ${extra.join(', ')}`;
  for (const key of want) {
    if (!(key in args)) return `missing ${key}`;
    if (spec.args[key] === 'objectId') {
      if (typeof args[key] !== 'string' || !/^[0-9a-f]{24}$/.test(args[key]) || !mongoose.isValidObjectId(args[key])) {
        return `${key} is not an id`;
      }
    }
    if (spec.args[key] === 'fileName') {
      if (typeof args[key] !== 'string' || args[key].length < 1 || args[key].length > MAX_FILE_NAME) {
        return `${key} is not a file name`;
      }
    }
  }
  return null;
}

module.exports = { TOOLS, toolNamed, toolsFor, internalToolsFor, argsProblem, MAX_RECORDS, MAX_TEXT, MAX_FILE_NAME };
