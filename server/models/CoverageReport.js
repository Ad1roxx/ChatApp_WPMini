/**
 * CoverageReport — a mentor's draft report on one mentorship's work (S8 Step 5).
 *
 * Not `Report`: that model is the moderation queue.
 *
 * - `generated`: what the checks produced (lib/coverageReport.buildReport).
 *   Never edited, so the mentor's changes can always be told from the system's.
 * - `draft`: the mentor's edited copy; facts and evidence are always the
 *   generated ones (lib/coverageReport.applyEdits).
 * - `reviewedAt`: set when the mentor ticks "I have reviewed this draft",
 *   cleared by any later edit. Export needs it, so the export's "Draft,
 *   reviewed by the mentor" marker is true.
 * - Always a draft. Only its mentor can read it; no route sends it to the
 *   student, and nothing notifies them.
 */

const mongoose = require('mongoose');

const coverageReportSchema = new mongoose.Schema(
  {
    mentorship: { type: mongoose.Schema.Types.ObjectId, ref: 'Mentorship', required: true, index: true },
    mentor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    period: { from: { type: Date, default: null }, to: { type: Date, default: null } },
    assignments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Assignment' }],
    status: { type: String, enum: ['draft'], default: 'draft' },
    generated: { type: mongoose.Schema.Types.Mixed, required: true },
    draft: { type: mongoose.Schema.Types.Mixed, required: true },
    reviewedAt: { type: Date, default: null },
    exports: { type: [new mongoose.Schema({ at: Date, format: String }, { _id: false })], default: [] }
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model('CoverageReport', coverageReportSchema);
