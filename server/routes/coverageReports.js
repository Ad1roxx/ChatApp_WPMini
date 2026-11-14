/**
 * Rubric coverage (S8): the draft report.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const mongoose = require('mongoose');
// Import our models
const User = require('../models/User');
const Mentorship = require('../models/Mentorship');
const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');
const coverageReport = require('../lib/coverageReport');
const CoverageReport = require('../models/CoverageReport');
// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const { resolveMentorshipAccess } = require('../lib/reads');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app } = require('../app');
const { AI_SERVICE_URL, AI_SERVICE_SECRET } = require('./aiService');
const { contentDisposition } = require('./submissionFiles');
const { checkSubmission } = require('./criteria');

// ============================================
// RUBRIC COVERAGE (S8): the draft report
// ============================================

/** Run a handler as if for a request, and keep what it would have sent. */
async function capture(handler, req) {
  const out = { status: 200, body: null };
  const res = {
    status(code) { out.status = code; return res; },
    json(body) { out.body = body; return res; }
  };
  await handler(req, res);
  return out;
}

/**
 * Load a coverage report for its own mentor, or say why not. A student, or
 * any other user, gets 404: a report's existence is not theirs to learn.
 */
async function loadOwnReport(id, user) {
  if (!mongoose.isValidObjectId(id)) return { status: 404, error: 'Report not found' };
  const report = await CoverageReport.findById(id);
  if (!report || String(report.mentor) !== String(user._id)) return { status: 404, error: 'Report not found' };
  const mentorship = await Mentorship.findOne({ _id: report.mentorship, mentor: user._id }).select('_id');
  if (!mentorship) return { status: 404, error: 'Report not found' };
  return { report };
}

const reportView = (r) => ({
  id: String(r._id),
  mentorship: String(r.mentorship),
  assignments: (r.assignments || []).map(String),
  period: r.period,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  status: r.status,
  reviewedAt: r.reviewedAt,
  exports: r.exports,
  draft: r.draft
});

/** At most this many assignments in one report: each is one or more checks. */
const MAX_REPORT_ASSIGNMENTS = 10;

/**
 * POST /api/mentorships/:id/coverage-reports — the mentorship's mentor drafts a
 * report: `{ assignmentIds?, from?, to?, mode? }`. Each assignment the mentor
 * set in this mentorship (all, or those named; within the period by due date)
 * is checked through the same handler as a single check, so every rule of
 * Steps 3 and 4 applies. A check that cannot run becomes that section's status.
 * The report is a draft for the mentor; nothing reaches the student.
 */
app.post('/api/mentorships/:id/coverage-reports', requireAuth, async (req, res) => {
  try {
    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }
    if (!access.isMentor || access.mentorship.status !== 'active') {
      return res.status(403).json({ error: 'Only this mentorship\'s mentor can draft a coverage report' });
    }
    const { assignmentIds, from, to, mode } = req.body || {};
    const query = { mentor: req.authUser._id, mentorships: access.mentorship._id };
    if (assignmentIds !== undefined) {
      if (!Array.isArray(assignmentIds) || !assignmentIds.every((id) => mongoose.isValidObjectId(id))) {
        return res.status(400).json({ error: 'assignmentIds must be a list of assignment ids' });
      }
      query._id = { $in: assignmentIds };
    }
    const period = { from: from ? new Date(from) : null, to: to ? new Date(to) : null };
    if ((from && Number.isNaN(period.from.getTime())) || (to && Number.isNaN(period.to.getTime()))) {
      return res.status(400).json({ error: 'from and to must be dates' });
    }
    if (period.from || period.to) {
      query.dueAt = {};
      if (period.from) query.dueAt.$gte = period.from;
      if (period.to) query.dueAt.$lte = period.to;
    }
    const assignments = await Assignment.find(query).sort({ dueAt: 1 }).limit(MAX_REPORT_ASSIGNMENTS + 1);
    if (assignments.length === 0) {
      return res.status(400).json({ error: 'No work you set in this mentorship matches' });
    }
    if (assignments.length > MAX_REPORT_ASSIGNMENTS) {
      return res.status(400).json({ error: `At most ${MAX_REPORT_ASSIGNMENTS} assignments in one report` });
    }

    const items = [];
    for (const assignment of assignments) {
      const submission = await Submission.findOne({ assignment: assignment._id, mentorship: access.mentorship._id });
      const item = { assignment, submission, late: submission ? submission.isLate(assignment.dueAt) : false, result: null, problem: null };
      if (!submission) {
        item.problem = 'No hand-in for this assignment';
      } else {
        const done = await capture(checkSubmission, {
          params: { id: String(submission._id) },
          authUser: req.authUser,
          body: mode ? { mode } : {}
        });
        if (done.status === 200) item.result = done.body;
        else item.problem = `Not checked: ${(done.body && done.body.error) || 'the check could not run'}`;
      }
      items.push(item);
    }

    const [student, mentor] = await Promise.all([
      User.findById(access.mentorship.student).select('displayName'),
      User.findById(req.authUser._id).select('displayName')
    ]);
    const generated = coverageReport.buildReport({
      student: student || {},
      mentor: mentor || {},
      mentorship: access.mentorship,
      period: period.from || period.to ? period : null,
      items
    });
    const report = await CoverageReport.create({
      mentorship: access.mentorship._id,
      mentor: req.authUser._id,
      student: access.mentorship.student,
      period,
      assignments: assignments.map((a) => a._id),
      generated,
      draft: generated
    });
    res.status(201).json(reportView(report));
  } catch (err) {
    console.error('Error drafting a coverage report:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/mentorships/:id/coverage-reports — the mentor's drafts for this mentorship. */
app.get('/api/mentorships/:id/coverage-reports', requireAuth, async (req, res) => {
  try {
    const access = await resolveMentorshipAccess(req.params.id, req.authUser);
    if (access.error) {
      return res.status(access.status).json({ error: access.error });
    }
    if (!access.isMentor) {
      return res.status(403).json({ error: 'Only this mentorship\'s mentor can see its coverage reports' });
    }
    const reports = await CoverageReport.find({ mentorship: access.mentorship._id, mentor: req.authUser._id })
      .sort({ createdAt: -1 })
      .select('-generated -draft');
    res.json({
      reports: reports.map((r) => ({
        id: String(r._id), createdAt: r.createdAt, period: r.period, reviewedAt: r.reviewedAt, exports: r.exports,
        assignments: r.assignments.length
      }))
    });
  } catch (err) {
    console.error('Error listing coverage reports:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/coverage-reports/:id — its mentor only. */
app.get('/api/coverage-reports/:id', requireAuth, async (req, res) => {
  try {
    const own = await loadOwnReport(req.params.id, req.authUser);
    if (own.error) return res.status(own.status).json({ error: own.error });
    res.json(reportView(own.report));
  } catch (err) {
    console.error('Error reading a coverage report:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/coverage-reports/:id — `{ draft }`, the mentor's edits. Only
 * editable fields are taken (lib/coverageReport.applyEdits); facts and
 * evidence stay the generated ones. Any edit clears the review tick.
 */
app.patch('/api/coverage-reports/:id', requireAuth, async (req, res) => {
  try {
    const own = await loadOwnReport(req.params.id, req.authUser);
    if (own.error) return res.status(own.status).json({ error: own.error });
    const edited = coverageReport.applyEdits(own.report.generated, (req.body || {}).draft);
    if (edited.error) return res.status(400).json({ error: edited.error });
    own.report.draft = edited.draft;
    own.report.reviewedAt = null;
    own.report.markModified('draft');
    await own.report.save();
    res.json(reportView(own.report));
  } catch (err) {
    console.error('Error editing a coverage report:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/coverage-reports/:id/review — `{ reviewed: true|false }`: the mentor's tick. */
app.post('/api/coverage-reports/:id/review', requireAuth, async (req, res) => {
  try {
    const own = await loadOwnReport(req.params.id, req.authUser);
    if (own.error) return res.status(own.status).json({ error: own.error });
    const { reviewed } = req.body || {};
    if (typeof reviewed !== 'boolean') return res.status(400).json({ error: 'reviewed must be true or false' });
    own.report.reviewedAt = reviewed ? new Date() : null;
    await own.report.save();
    res.json(reportView(own.report));
  } catch (err) {
    console.error('Error reviewing a coverage report:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/coverage-reports/:id/export — `{ format: 'docx'|'pdf' }`. Only
 * after the mentor's review tick (409 otherwise). The AI service renders
 * exactly the stored draft; the file goes back to this mentor as a download,
 * and nowhere else.
 */
app.post('/api/coverage-reports/:id/export', requireAuth, async (req, res) => {
  try {
    const own = await loadOwnReport(req.params.id, req.authUser);
    if (own.error) return res.status(own.status).json({ error: own.error });
    const { format } = req.body || {};
    if (format !== 'docx' && format !== 'pdf') return res.status(400).json({ error: 'format must be docx or pdf' });
    if (!own.report.reviewedAt) {
      return res.status(409).json({ error: 'Tick "I have reviewed this draft" before exporting it' });
    }
    if (!AI_SERVICE_URL || !AI_SERVICE_SECRET) {
      return res.status(503).json({ error: 'Report export is not configured on this server' });
    }
    const upstream = await fetch(`${AI_SERVICE_URL}/reports/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AI-Secret': AI_SERVICE_SECRET },
      body: JSON.stringify({ draft: own.report.draft, format })
    });
    if (!upstream.ok) {
      console.error('Report export answered', upstream.status);
      return res.status(502).json({ error: 'The report could not be exported' });
    }
    const data = Buffer.from(await upstream.arrayBuffer());
    own.report.exports.push({ at: new Date(), format });
    await own.report.save();
    const type = format === 'pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Content-Disposition', contentDisposition(`coverage-report-draft.${format}`));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(data);
  } catch (err) {
    console.error('Error exporting a coverage report:', err);
    res.status(502).json({ error: 'The report could not be exported' });
  }
});
