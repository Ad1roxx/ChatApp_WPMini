/**
 * Submission Model
 *
 * One student's side of one assignment: whether they have handed it in, what
 * they handed in, what the mentor said — and a history of every one of those
 * moves, with when it happened.
 *
 * ## It exists before anything is handed in
 *
 * A row is created for every recipient the moment the assignment is set, with
 * status `assigned`. That is how Google Classroom models it too, and for the
 * same reason: "Rahul has not handed this in" is a fact about Rahul and this
 * assignment, and it needs somewhere to live.
 *
 * ## Draft is a real state
 *
 * A student can attach work without turning it in — `draft`. The mentor can
 * see it, which is deliberate and which the student is told on screen: "the
 * work is attached but not handed in" is exactly the thing a mentor chasing a
 * deadline wants to know, and a student who has started deserves to be seen
 * as having started.
 *
 * Unsubmitting takes a hand-in back to `draft` so it can be edited. It keeps
 * the work — unsubmitting is "let me change this", not "throw it away".
 *
 * ## Files
 *
 * `attachments` records the files handed in with the work; the bytes live in
 * GridFS (see lib/fileStore.js). The record is kept here, on the submission,
 * so that a file is only ever reached through the hand-in it belongs to — and
 * whoever may read the hand-in may read its files, and nobody else.
 *
 * ## The history is embedded and append-only
 *
 * Every move — assigned, draft saved, file attached or removed, handed in,
 * unsubmitted, changes asked for, accepted — is appended to `history` with who
 * did it and when. Embedded rather than its own collection because it is only
 * ever read with its submission and it is bounded by how many times two
 * people can click a button; nothing ever queries one event on its own.
 * Nothing edits or removes an entry once written, which is the property that
 * makes it worth reading.
 *
 * ## Lateness is derived, never stored
 *
 * `isLate(dueAt)` compares against the assignment's deadline at read time. A
 * stored flag would drift the moment the mentor extends the deadline.
 */

const mongoose = require('mongoose');

/**
 * Where a submission can go next.
 *
 * - `submitted → draft` is Unsubmit. It exists only from `submitted`: work
 *   that has been accepted is a record, and unsubmitting it would let a
 *   student quietly rewrite something the mentor already signed off.
 * - `changes-requested → draft` is the student editing after being sent back,
 *   before turning it in again.
 * - `changes-requested → submitted`, not `→ assigned`: they have handed
 *   something in, and "not started" would misrepresent that.
 */
const ALLOWED_TRANSITIONS = {
  assigned: ['draft', 'submitted'],
  draft: ['draft', 'submitted'],
  submitted: ['draft', 'accepted', 'changes-requested'],
  'changes-requested': ['draft', 'submitted'],
  accepted: []
};

/** Every kind of event the history records. */
const EVENT_TYPES = [
  'assigned',
  'draft-saved',
  'file-attached',
  'file-removed',
  'submitted',
  'unsubmitted',
  'changes-requested',
  'accepted'
];

const eventSchema = new mongoose.Schema(
  {
    type: { type: String, enum: EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    // Who did it. Stored even though the type usually implies it, because an
    // audit trail that relies on inference is one refactor away from lying.
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // What it was about, where the type alone does not say — the file's name,
    // for an attachment. Absent for everything else.
    detail: { type: String, maxlength: 200 }
  },
  { _id: false }
);

/**
 * One file handed in with the work. `fileId` is the GridFS id, and also the
 * id the download route is addressed by.
 */
const attachmentSchema = new mongoose.Schema(
  {
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, maxlength: 200 },
    size: { type: Number, required: true, min: 0 },
    // Decided by the server from the extension — never the type the upload
    // claimed to be.
    contentType: { type: String, required: true },
    uploadedAt: { type: Date, required: true }
  },
  { _id: false }
);

const submissionSchema = new mongoose.Schema(
  {
    assignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Assignment',
      required: true
    },

    // The relationship this hand-in belongs to — what access is checked
    // against, exactly as for goals and sessions.
    mentorship: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Mentorship',
      required: true
    },

    // Denormalised from the mentorship so "my work" is one indexed query.
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    status: {
      type: String,
      enum: ['assigned', 'draft', 'submitted', 'changes-requested', 'accepted'],
      default: 'assigned'
    },

    text: { type: String, trim: true, maxlength: 5000, default: '' },

    /**
     * Allow-listed to http(s) here as well as in the route. The mentor opens
     * this from an `href`, so a stored `javascript:` URL is stored XSS aimed
     * at them — worth refusing in two places.
     */
    url: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
      validate: {
        validator: (v) => v === '' || /^https?:\/\/\S+$/i.test(v),
        message: 'Only http and https links are allowed'
      }
    },

    attachments: { type: [attachmentSchema], default: [] },

    // When it was last turned in. Cleared on Unsubmit, because after that it
    // is not handed in — and lateness derives from this, so leaving it set
    // would make an unsubmitted piece of work look on time forever.
    submittedAt: { type: Date, default: null },

    // When a draft was last saved, so the mentor can see "attached 2 hours
    // ago" without the history having to be scanned.
    draftSavedAt: { type: Date, default: null },

    review: {
      note: { type: String, trim: true, maxlength: 2000, default: '' },
      reviewedAt: { type: Date, default: null }
    },

    history: { type: [eventSchema], default: [] }
  },
  { timestamps: true }
);

/**
 * One hand-in per student per assignment, enforced rather than assumed: a
 * duplicate would split a student's work across two rows and double-count
 * them in "4 of 6".
 */
submissionSchema.index({ assignment: 1, student: 1 }, { unique: true });

submissionSchema.index({ student: 1 });
submissionSchema.index({ mentorship: 1 });

submissionSchema.methods.canBecome = function canBecome(next) {
  return ALLOWED_TRANSITIONS[this.status].includes(next);
};

/** Append one event. The only way anything is ever written to `history`. */
submissionSchema.methods.log = function log(type, by, detail) {
  const event = { type, at: new Date(), by };
  if (detail) event.detail = detail;
  this.history.push(event);
};

/**
 * Late means one of two things:
 *
 * - handed in after the deadline
 * - not handed in (including a draft, or work taken back by Unsubmit) with
 *   the deadline past
 */
submissionSchema.methods.isLate = function isLate(dueAt) {
  const due = new Date(dueAt).getTime();
  if (this.submittedAt) return this.submittedAt.getTime() > due;
  return Date.now() > due;
};

module.exports = mongoose.model('Submission', submissionSchema);
module.exports.EVENT_TYPES = EVENT_TYPES;
