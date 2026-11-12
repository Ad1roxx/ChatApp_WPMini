/**
 * CriteriaSet — the checklist a coverage report is assessed against (S8, D6).
 *
 * One per assignment and source: the rubric file, or (S8 Step 4) the brief.
 * It holds two different things, kept apart on purpose:
 *
 * - `extracted`: what the assistant proposed from the document, each criterion
 *   with its verbatim quote (checked by code in ai/criteria.py). A proposal,
 *   never assessed against. Extracting again replaces it.
 * - `versions`: what the mentor confirmed, one entry per confirmation, in
 *   order. **Only ever appended**: the confirm route adds version n+1 with a
 *   condition that version n+1 does not exist yet, and nothing edits or
 *   removes a version. A report records which version it used, so "which
 *   checklist produced this report?" always has an exact answer (D6).
 *
 * In a confirmed criterion, `sourceText` is never what the client sent: the
 * server copies it from the extracted criteria (or joins them, for a merge),
 * so a quote the mentor sees as "from the rubric" always is. The mentor's own
 * wording is `text`; a criterion the mentor added has no `sourceText`.
 */

const mongoose = require('mongoose');

const ORIGINS = ['extracted', 'edited', 'merged', 'added'];

const extractedSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    sourceText: { type: String, required: true, maxlength: 4000 },
    marks: { type: Number, default: null },
    weight: { type: Number, default: null }
  },
  { _id: false }
);

const confirmedSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true, maxlength: 1000 },
    sourceText: { type: String, default: null, maxlength: 16000 },
    marks: { type: Number, default: null, min: 0, max: 1000 },
    weight: { type: Number, default: null, min: 0, max: 100 },
    origin: { type: String, enum: ORIGINS, required: true },
    // The extracted or earlier-confirmed criteria this one came from.
    from: { type: [String], default: [] }
  },
  { _id: false }
);

const versionSchema = new mongoose.Schema(
  {
    n: { type: Number, required: true, min: 1 },
    confirmedAt: { type: Date, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    criteria: { type: [confirmedSchema], required: true }
  },
  { _id: false }
);

const criteriaSetSchema = new mongoose.Schema(
  {
    assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment', required: true },
    mentor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    source: {
      kind: { type: String, enum: ['rubric', 'brief'], required: true },
      // The rubric file's GridFS id; null for the brief.
      fileId: { type: mongoose.Schema.Types.ObjectId, default: null },
      fileName: { type: String, default: '' }
    },
    extracted: {
      at: { type: Date, default: null },
      promptVersion: { type: String, default: '' },
      criteria: { type: [extractedSchema], default: [] },
      rejected: {
        type: [new mongoose.Schema({ sourceText: String, reason: String }, { _id: false })],
        default: []
      },
      notRead: {
        type: [new mongoose.Schema({ sections: [Number], reason: String }, { _id: false })],
        default: []
      }
    },
    versions: { type: [versionSchema], default: [] }
  },
  { timestamps: true }
);

criteriaSetSchema.index({ assignment: 1, 'source.kind': 1, 'source.fileId': 1 }, { unique: true });

/** The latest confirmed version, or null: nothing is assessed until there is one. */
criteriaSetSchema.methods.latest = function latest() {
  return this.versions.length ? this.versions[this.versions.length - 1] : null;
};

criteriaSetSchema.statics.ORIGINS = ORIGINS;

module.exports = mongoose.model('CriteriaSet', criteriaSetSchema);
