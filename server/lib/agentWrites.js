/**
 * The agent's write tools, as Express knows them (AGENT_PLAN §3.2, §4.4).
 *
 * Nothing here writes. A write tool only ever becomes a signed proposal, which a
 * person approves and their own browser runs against the real route.
 *
 * Only what is listed here can be proposed or claimed. §4.4 is stricter than the
 * API on purpose: submitting or editing a hand-in, accepting or requesting
 * changes, deleting or withdrawing anything, unsubmitting, opt-outs, announcements,
 * groups and adding a student are never tools, whatever the API allows.
 *
 * For each tool, two functions:
 *
 * - `build` turns what the AI service sent (a validated model call, handles already
 *   turned into ids) into `args`, the values the browser will send. It is strict: exact
 *   keys, exact types, and a value too long is refused rather than cut, because what
 *   is shown must be what runs. Values are cleaned the way the route cleans them, so
 *   what is shown is what is stored.
 * - `describe` turns `args` into the dialog's heading and fields, reading the records
 *   it names and checking the proposal still makes sense. It runs when the proposal is
 *   made and again at the claim. If what it says has changed, the person approved
 *   something out of date, and nothing runs.
 *
 * Every field names the `arg` it shows, or '' for context the request does not carry.
 * A refusal is a `{ refuse: reason }`, one of a fixed set the panel has a sentence for.
 *
 * The real route still makes every check of its own when the browser calls it. These
 * come first so that a person is never asked to approve something that cannot work,
 * and to hold the places §4.4 is stricter than the route.
 */
const mongoose = require('mongoose');
const Goal = require('../models/Goal');
const Session = require('../models/Session');
const reads = require('./reads');
const { parseSharedUrl } = require('./sharedUrl');
const { formatTime, parseLocal } = require('./agentTime');

const BOTH = Object.freeze(['mentor', 'student']);
const MENTOR = Object.freeze(['mentor']);

const OBJECT_ID = /^[0-9a-f]{24}$/;
// Control characters, and the ones that reorder or hide text: what is approved must read as it is.
// eslint-disable-next-line no-control-regex
const UNSAFE_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/;
// eslint-disable-next-line no-control-regex
const UNSAFE_LINE = /[\u0000-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/;

const refuse = (reason) => ({ refuse: reason });

function isExactly(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const got = Object.keys(input);
  return got.length === keys.length && keys.every((k) => Object.hasOwn(input, k));
}

/** A cleaned text value, or a reason it can't be used. Never shortened. */
function text(value, max, { required = false, multiline = false } = {}) {
  if (typeof value !== 'string') return refuse('bad_args');
  const clean = value.trim();
  if (required && !clean) return refuse('bad_args');
  if (clean.length > max) return refuse('too_long');
  if ((multiline ? UNSAFE_MULTILINE : UNSAFE_LINE).test(clean)) return refuse('bad_text');
  return { value: clean };
}

/** A moment from what the model wrote, as the ISO string the route will be sent. `describe` checks it's in the future. */
function isoTime(value) {
  const at = parseLocal(value);
  return at ? { value: at.toISOString() } : refuse('bad_args');
}

const isFuture = (iso) => new Date(iso).getTime() > Date.now();
const idIs = (a, b) => String(a) === String(b);
const otherParty = (role, parties) => (role === 'mentor' ? parties.student : parties.mentor);
const nameIn = (id, mentorship, parties) => (idIs(id, mentorship.mentor?._id ?? mentorship.mentor) ? parties.mentor : parties.student);
const minutes = (n) => `${n} minutes`;

/** The mentorship id in `args`, or a refusal if it isn't the one this turn is about. */
const inThisMentorship = (id, mentorship) => (idIs(id, mentorship._id) ? null : refuse('not_here'));

async function goalHere(goalId, mentorship) {
  if (!OBJECT_ID.test(String(goalId)) || !mongoose.isValidObjectId(goalId)) return refuse('not_found');
  const goal = await Goal.findById(goalId);
  if (!goal) return refuse('not_found');
  if (!idIs(goal.mentorship, mentorship._id)) return refuse('not_here');
  if (goal.status === 'archived') return refuse('archived');
  return { goal };
}

async function sessionToConfirm(sessionId, mentorship, user) {
  if (!OBJECT_ID.test(String(sessionId)) || !mongoose.isValidObjectId(sessionId)) return refuse('not_found');
  const session = await Session.findById(sessionId);
  if (!session) return refuse('not_found');
  if (!idIs(session.mentorship, mentorship._id)) return refuse('not_here');
  if (!session.canBecome('confirmed')) return refuse('wrong_state');
  if (idIs(session.proposedBy, user._id)) return refuse('your_proposal');
  return { session };
}

async function ownAssignmentHere(assignmentId, mentorship, user) {
  const own = await reads.loadOwnAssignment(assignmentId, user);
  if (own.error) return refuse(own.status === 403 ? 'not_yours' : 'not_found');
  if (!own.assignment.mentorships.some((m) => idIs(m, mentorship._id))) return refuse('not_here');
  return { assignment: own.assignment };
}

const WRITE_TOOLS = {
  create_assignment: {
    roles: MENTOR,
    build({ input, mentorship }) {
      if (!isExactly(input, ['title', 'instructions', 'due_at'])) return refuse('bad_args');
      const title = text(input.title, 200, { required: true });
      if (title.refuse) return title;
      const instructions = text(input.instructions, 5000, { multiline: true });
      if (instructions.refuse) return instructions;
      const due = isoTime(input.due_at);
      if (due.refuse) return due;
      return {
        // This mentorship only (the human, 2026-11-10), set here and never by the model.
        args: { title: title.value, instructions: instructions.value, dueAt: due.value, mentorshipIds: [String(mentorship._id)] }
      };
    },
    describe({ args, mentorship, parties }) {
      if (args.mentorshipIds.length !== 1) return refuse('not_here');
      const elsewhere = inThisMentorship(args.mentorshipIds[0], mentorship);
      if (elsewhere) return elsewhere;
      if (!isFuture(args.dueAt)) return refuse('past_date');
      return {
        heading: `Set work for ${parties.student}`,
        fields: [
          { label: 'Title', value: args.title, arg: 'title' },
          { label: 'Instructions', value: args.instructions, arg: 'instructions' },
          { label: 'Due', value: formatTime(args.dueAt), arg: 'dueAt' },
          { label: 'For', value: parties.student, arg: 'mentorshipIds' }
        ]
      };
    }
  },

  extend_assignment_deadline: {
    roles: MENTOR,
    build({ input }) {
      if (!isExactly(input, ['assignmentId', 'new_due_at'])) return refuse('bad_args');
      if (!OBJECT_ID.test(String(input.assignmentId))) return refuse('not_found');
      const due = isoTime(input.new_due_at);
      if (due.refuse) return due;
      return { args: { assignmentId: input.assignmentId, dueAt: due.value } };
    },
    async describe({ args, mentorship, user }) {
      const found = await ownAssignmentHere(args.assignmentId, mentorship, user);
      if (found.refuse) return found;
      const { assignment } = found;
      if (!isFuture(args.dueAt)) return refuse('past_date');
      // Forward only. The route allows any future date; §3.2 says "move a due date forward".
      if (new Date(args.dueAt).getTime() <= assignment.dueAt.getTime()) return refuse('not_later');
      const n = assignment.mentorships.length;
      return {
        heading: 'Move a deadline',
        fields: [
          { label: 'Work', value: assignment.title, arg: 'assignmentId' },
          { label: 'Currently due', value: formatTime(assignment.dueAt), arg: '' },
          { label: 'New due', value: formatTime(args.dueAt), arg: 'dueAt' },
          // The route moves it for everyone it was set for, so the dialog says so.
          { label: 'Applies to', value: n === 1 ? 'The one student this was set for' : `All ${n} students this was set for`, arg: '' }
        ]
      };
    }
  },

  set_goal: {
    roles: MENTOR,
    build({ input, mentorship }) {
      if (!isExactly(input, ['title', 'description', 'milestones'])) return refuse('bad_args');
      const title = text(input.title, 200, { required: true });
      if (title.refuse) return title;
      const description = text(input.description, 1000, { multiline: true });
      if (description.refuse) return description;
      if (!Array.isArray(input.milestones)) return refuse('bad_args');
      if (input.milestones.length > 50) return refuse('too_long');
      const milestones = [];
      for (const m of input.milestones) {
        const one = text(m, 200, { required: true });
        if (one.refuse) return one;
        milestones.push(one.value);
      }
      return { args: { mentorshipId: String(mentorship._id), title: title.value, description: description.value, milestones } };
    },
    describe({ args, mentorship, parties }) {
      const elsewhere = inThisMentorship(args.mentorshipId, mentorship);
      if (elsewhere) return elsewhere;
      return {
        heading: `Set a goal for ${parties.student}`,
        fields: [
          { label: 'Title', value: args.title, arg: 'title' },
          { label: 'Description', value: args.description, arg: 'description' },
          { label: 'Milestones', value: args.milestones.map((m, i) => `${i + 1}. ${m}`).join('\n'), arg: 'milestones' },
          { label: 'In', value: `Your mentorship with ${parties.student}`, arg: 'mentorshipId' }
        ]
      };
    }
  },

  toggle_milestone: {
    roles: BOTH,
    async build({ input, mentorship }) {
      if (!isExactly(input, ['goalId', 'milestone_number', 'done'])) return refuse('bad_args');
      if (!Number.isInteger(input.milestone_number) || typeof input.done !== 'boolean') return refuse('bad_args');
      const found = await goalHere(input.goalId, mentorship);
      if (found.refuse) return found;
      // Its position in the list the model read: milestones are not given handles of their own.
      const milestone = found.goal.milestones[input.milestone_number - 1];
      if (!milestone) return refuse('not_found');
      return { args: { goalId: String(found.goal._id), milestoneId: String(milestone._id), done: input.done } };
    },
    async describe({ args, mentorship }) {
      const found = await goalHere(args.goalId, mentorship);
      if (found.refuse) return found;
      const milestone = found.goal.milestones.id(args.milestoneId);
      if (!milestone) return refuse('not_found');
      if (Boolean(milestone.done) === args.done) return refuse('no_change');
      return {
        heading: 'Update a milestone',
        fields: [
          { label: 'Goal', value: found.goal.title, arg: 'goalId' },
          { label: 'Milestone', value: milestone.title, arg: 'milestoneId' },
          { label: 'Change', value: args.done ? 'Not done → Done' : 'Done → Not done', arg: 'done' }
        ]
      };
    }
  },

  propose_session: {
    roles: BOTH,
    build({ input, mentorship }) {
      if (!isExactly(input, ['title', 'agenda', 'scheduled_for', 'duration_minutes'])) return refuse('bad_args');
      const title = text(input.title, 200, { required: true });
      if (title.refuse) return title;
      const agenda = text(input.agenda, 1000, { multiline: true });
      if (agenda.refuse) return agenda;
      const when = isoTime(input.scheduled_for);
      if (when.refuse) return when;
      const d = input.duration_minutes;
      if (!Number.isInteger(d) || d < 5 || d > 480) return refuse('bad_args');
      return {
        args: { mentorshipId: String(mentorship._id), title: title.value, agenda: agenda.value, scheduledFor: when.value, durationMinutes: d }
      };
    },
    describe({ args, mentorship, role, parties }) {
      const elsewhere = inThisMentorship(args.mentorshipId, mentorship);
      if (elsewhere) return elsewhere;
      if (!isFuture(args.scheduledFor)) return refuse('past_date');
      const other = otherParty(role, parties);
      return {
        heading: `Propose a session with ${other}`,
        fields: [
          { label: 'Title', value: args.title, arg: 'title' },
          { label: 'Agenda', value: args.agenda, arg: 'agenda' },
          { label: 'When', value: formatTime(args.scheduledFor), arg: 'scheduledFor' },
          { label: 'Length', value: minutes(args.durationMinutes), arg: 'durationMinutes' },
          { label: 'With', value: `${other}, who will need to confirm it`, arg: 'mentorshipId' }
        ]
      };
    }
  },

  confirm_session: {
    roles: BOTH,
    build({ input }) {
      if (!isExactly(input, ['sessionId'])) return refuse('bad_args');
      if (!OBJECT_ID.test(String(input.sessionId))) return refuse('not_found');
      return { args: { sessionId: input.sessionId } };
    },
    async describe({ args, mentorship, user, parties }) {
      const found = await sessionToConfirm(args.sessionId, mentorship, user);
      if (found.refuse) return found;
      const { session } = found;
      return {
        heading: 'Confirm this session',
        fields: [
          { label: 'Title', value: session.title, arg: 'sessionId' },
          { label: 'When', value: formatTime(session.scheduledFor), arg: '' },
          { label: 'Length', value: minutes(session.durationMinutes), arg: '' },
          { label: 'Proposed by', value: nameIn(session.proposedBy, mentorship, parties), arg: '' }
        ]
      };
    }
  },

  add_resource: {
    roles: BOTH,
    build({ input, mentorship }) {
      if (!isExactly(input, ['title', 'url', 'note'])) return refuse('bad_args');
      const title = text(input.title, 200, { required: true });
      if (title.refuse) return title;
      const note = text(input.note, 500, { multiline: true });
      if (note.refuse) return note;
      if (typeof input.url !== 'string') return refuse('bad_args');
      if (UNSAFE_LINE.test(input.url.trim())) return refuse('bad_text');
      const link = parseSharedUrl(input.url);
      if (link.error) return refuse('bad_url');
      // As the route will store it, so the link shown is the link kept.
      return { args: { mentorshipId: String(mentorship._id), title: title.value, url: link.url, note: note.value } };
    },
    describe({ args, mentorship, parties, role }) {
      const elsewhere = inThisMentorship(args.mentorshipId, mentorship);
      if (elsewhere) return elsewhere;
      return {
        heading: 'Pin a link',
        fields: [
          { label: 'Title', value: args.title, arg: 'title' },
          { label: 'Link', value: args.url, arg: 'url' },
          { label: 'Note', value: args.note, arg: 'note' },
          { label: 'Shared with', value: otherParty(role, parties), arg: 'mentorshipId' }
        ]
      };
    }
  }
};

for (const spec of Object.values(WRITE_TOOLS)) Object.freeze(spec);
Object.freeze(WRITE_TOOLS);

/** The tool by name, as an own property only: `constructor` is not a tool. */
function writeTool(name) {
  return typeof name === 'string' && Object.hasOwn(WRITE_TOOLS, name) ? WRITE_TOOLS[name] : null;
}

/**
 * From a model's call to what a person will be asked: `{ args, heading, fields }`, or
 * `{ refuse }`. `context` is `{ input, user, mentorship, role, parties }`, and `role`
 * and the mentorship come from the record, never from the call.
 */
async function prepare(name, context) {
  const tool = writeTool(name);
  if (!tool || !tool.roles.includes(context.role)) return refuse('not_allowed');
  const built = await tool.build(context);
  if (built.refuse) return built;
  const described = await tool.describe({ ...context, args: built.args });
  if (described.refuse) return described;
  return { args: built.args, heading: described.heading, fields: described.fields };
}

/**
 * At the claim: does this signed proposal still say what it said? `{ ok: true }`, or
 * `{ refuse }` naming why not. Anything different means what was approved is out of date.
 */
async function recheck(claims, context) {
  const tool = writeTool(claims.tool);
  if (!tool || !tool.roles.includes(context.role)) return refuse('not_allowed');
  const described = await tool.describe({ ...context, args: claims.args });
  if (described.refuse) return described;
  const same = JSON.stringify([described.heading, described.fields]) === JSON.stringify([claims.heading, claims.fields]);
  return same ? { ok: true } : refuse('changed');
}

module.exports = { WRITE_TOOLS, writeTool, prepare, recheck };
