/**
 * Rubric coverage (S8): criteria, proposed then confirmed, and the check of one hand-in.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const mongoose = require('mongoose');
const Mentorship = require('../models/Mentorship');
const CriteriaSet = require('../models/CriteriaSet');
const criteriaRules = require('../lib/criteria');
const coverageMode = require('../lib/coverageMode');
// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const { loadOwnAssignment, loadSubmission } = require('../lib/reads');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app } = require('../app');
const { AI_SERVICE_URL, AI_SERVICE_SECRET } = require('./aiService');

// ============================================
// RUBRIC COVERAGE (S8): criteria, proposed then confirmed
// ============================================

/**
 * How long Express waits for the AI service to extract a rubric's criteria:
 * one Gemini call per window of the document, paced under the provider's limit.
 */
const COVERAGE_EXTRACT_TIMEOUT_MS = Number(process.env.COVERAGE_EXTRACT_TIMEOUT_MS) || 180000;

/** One criteria set as the mentor's screen wants it. */
function criteriaSetView(set) {
  const s = set.toObject ? set.toObject() : set;
  return {
    id: String(s._id),
    source: s.source,
    extracted: s.extracted,
    versions: s.versions,
    latest: s.versions.length ? s.versions[s.versions.length - 1] : null
  };
}

/**
 * Propose a checklist for an assignment: from its rubric file, or (S8 Step 4,
 * brief mode) from the brief's own text. The caller has already checked that
 * `user` set the assignment. Returns `{ set }` or `{ status, error }`.
 *
 * The rubric is read in the AI service as that mentor, in one of their own
 * active mentorships the work was set for, through the index's gated read;
 * Express names the file. The brief's text is sent by Express, which holds
 * it. Extracting again replaces the proposal and never touches a confirmed
 * version.
 */
async function extractChecklist(assignment, user, kind) {
  let request;
  let file = null;
  if (kind === 'rubric') {
    file = assignment.attachments.find((f) => f.rubric && f.rubric.isRubric);
    if (!file) return { status: 400, error: 'Mark one of the brief\'s files as the rubric first' };
  }
  if (!AI_SERVICE_URL || !AI_SERVICE_SECRET) {
    return { status: 503, error: 'Rubric checks are not configured on this server' };
  }
  if (kind === 'rubric') {
    const mentorship = await Mentorship.findOne({
      _id: { $in: assignment.mentorships },
      mentor: user._id,
      status: 'active'
    }).select('_id');
    if (!mentorship) return { status: 409, error: 'This work is not set in any active mentorship of yours' };
    request = {
      path: '/criteria/extract',
      // From the verified identity, never the request body.
      body: { mentorshipId: String(mentorship._id), viewerId: String(user._id), fileId: String(file.fileId) }
    };
  } else {
    const text = [assignment.title, assignment.instructions].filter(Boolean).join('\n\n');
    request = { path: '/criteria/extract-brief', body: { text } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COVERAGE_EXTRACT_TIMEOUT_MS);
  let upstream;
  let body;
  try {
    upstream = await fetch(`${AI_SERVICE_URL}${request.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AI-Secret': AI_SERVICE_SECRET },
      body: JSON.stringify(request.body),
      signal: controller.signal
    });
    body = await upstream.json().catch(() => null);
  } catch (err) {
    console.error('Error extracting criteria:', err.name === 'AbortError' ? 'timed out' : err);
    return { status: 502, error: `The ${kind} could not be read` };
  } finally {
    clearTimeout(timer);
  }

  if (upstream.status === 404) {
    return {
      status: 409,
      error: 'No text could be read from the rubric yet. Try again in a minute; a scan with no text layer cannot be read.'
    };
  }
  if (!upstream.ok || !body || !Array.isArray(body.criteria)) {
    if ([429, 502, 503].includes(upstream.status) && typeof body?.message === 'string') {
      return { status: upstream.status, error: body.message };
    }
    console.error('Criteria extraction answered', upstream.status);
    return { status: 502, error: `The ${kind} could not be read` };
  }

  // Each extraction's ids are its own (`x<stamp>-c1`), so a screen still
  // holding an earlier extraction cannot confirm `c1` against a different
  // quote: an id from a replaced extraction is simply not in the checklist.
  const stamp = `x${Date.now().toString(36)}`;
  const proposed = body.criteria.map((c) => ({ ...c, id: `${stamp}-${c.id}` }));
  const fileId = file ? file.fileId : null;

  const set = await CriteriaSet.findOneAndUpdate(
    { assignment: assignment._id, 'source.kind': kind, 'source.fileId': fileId },
    {
      $setOnInsert: { assignment: assignment._id, mentor: user._id },
      $set: {
        'source.kind': kind,
        'source.fileId': fileId,
        'source.fileName': file ? file.name : '',
        extracted: {
          at: new Date(),
          promptVersion: String(body.promptVersion || ''),
          criteria: proposed,
          rejected: body.rejected || [],
          notRead: body.notRead || []
        }
      }
    },
    { new: true, upsert: true, runValidators: true }
  );
  return { set };
}

/**
 * POST /api/assignments/:id/criteria/extract — the mentor who set the
 * assignment asks for a checklist to be proposed. Body `{ source }`:
 * `'rubric'` (the default) or `'brief'`. Only that mentor (loadOwnAssignment).
 */
app.post('/api/assignments/:id/criteria/extract', requireAuth, async (req, res) => {
  try {
    const own = await loadOwnAssignment(req.params.id, req.authUser);
    if (own.error) {
      return res.status(own.status).json({ error: own.error });
    }
    const source = (req.body || {}).source || 'rubric';
    if (source !== 'rubric' && source !== 'brief') {
      return res.status(400).json({ error: 'Read criteria from the rubric or the brief' });
    }
    const done = await extractChecklist(own.assignment, req.authUser, source);
    if (done.error) {
      return res.status(done.status).json({ error: done.error });
    }
    res.json(criteriaSetView(done.set));
  } catch (err) {
    console.error('Error extracting criteria:', err);
    res.status(502).json({ error: 'The checklist could not be read' });
  }
});

/** GET /api/assignments/:id/criteria — the mentor who set it: every checklist, proposed and confirmed. */
app.get('/api/assignments/:id/criteria', requireAuth, async (req, res) => {
  try {
    const own = await loadOwnAssignment(req.params.id, req.authUser);
    if (own.error) {
      return res.status(own.status).json({ error: own.error });
    }
    const sets = await CriteriaSet.find({ assignment: own.assignment._id }).sort({ createdAt: 1 });
    res.json({ sets: sets.map(criteriaSetView) });
  } catch (err) {
    console.error('Error listing criteria:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/assignments/:id/criteria/:setId/confirm — the mentor confirms a
 * checklist: edited, merged, deleted or added to. Appends version n+1 and
 * changes nothing else (D6); see lib/criteria.js for what is taken from the
 * client and what is not. The append is conditional on version n+1 not
 * existing yet, so two confirmations at once cannot both become n+1.
 */
app.post('/api/assignments/:id/criteria/:setId/confirm', requireAuth, async (req, res) => {
  try {
    const own = await loadOwnAssignment(req.params.id, req.authUser);
    if (own.error) {
      return res.status(own.status).json({ error: own.error });
    }
    if (!mongoose.isValidObjectId(req.params.setId)) {
      return res.status(404).json({ error: 'Checklist not found' });
    }
    const set = await CriteriaSet.findOne({ _id: req.params.setId, assignment: own.assignment._id });
    if (!set) {
      return res.status(404).json({ error: 'Checklist not found' });
    }
    const built = criteriaRules.nextVersion(set, (req.body || {}).criteria);
    if (built.error) {
      return res.status(400).json({ error: built.error });
    }

    const n = set.versions.length + 1;
    const version = { n, confirmedAt: new Date(), by: req.authUser._id, criteria: built.criteria };
    const done = await CriteriaSet.updateOne(
      { _id: set._id, [`versions.${n - 1}`]: { $exists: false } },
      { $push: { versions: version } },
      { runValidators: true }
    );
    if (done.modifiedCount !== 1) {
      return res.status(409).json({ error: 'This checklist was confirmed in the meantime. Reload and try again.' });
    }
    res.status(201).json(criteriaSetView(await CriteriaSet.findById(set._id)));
  } catch (err) {
    console.error('Error confirming criteria:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** How long Express waits for one hand-in's assessment: a call per window and per few criteria. */
const COVERAGE_ASSESS_TIMEOUT_MS = Number(process.env.COVERAGE_ASSESS_TIMEOUT_MS) || 300000;

/** What of the AI service's assessment reaches the mentor: these fields and nothing else. */
const ASSESSMENT_FIELDS = ['verdicts', 'notRead', 'setAside', 'droppedQuotes', 'calls', 'promptVersion'];
const VERDICT_FIELDS = [
  'criterionId', 'criterion', 'verdict', 'label', 'present', 'absent', 'reason', 'reasonText',
  'evidence', 'strippedCitations', 'suggestedMarks', 'maxMarks', 'suggestion'
];
const SUMMARY_FIELDS = ['points', 'notRead', 'setAside', 'droppedQuotes', 'calls', 'promptVersion'];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in (obj || {})).map((k) => [k, obj[k]]));

/**
 * POST /api/submissions/:id/coverage — suggested verdicts for one hand-in,
 * criterion by criterion, against a confirmed checklist (S8 Step 3).
 *
 * Body: `{ setId }`. Only the mentor who set the assignment, in their own
 * active mentorship; never the student. Nothing is assessed without a
 * confirmed version (409). The AI service is sent the hand-in's own text box
 * (never the mentor's review) and its own files, and reads those files as
 * this mentor; it keeps only chunks that belong to this hand-in. The reply is
 * a draft for the mentor: nothing is written to the hand-in, nothing is sent
 * to the student, and only the named fields are passed on (never a total).
 */
async function checkSubmission(req, res) {
  try {
    const loaded = await loadSubmission(req.params.id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const { submission } = loaded;
    if (String(submission.assignment.mentor) !== String(req.authUser._id)) {
      return res.status(403).json({ error: 'Only the mentor who set this can check it against a rubric' });
    }
    const mentorship = await Mentorship.findOne({
      _id: submission.mentorship,
      mentor: req.authUser._id,
      status: 'active'
    }).select('_id');
    if (!mentorship) {
      return res.status(403).json({ error: 'This hand-in is not in an active mentorship of yours' });
    }

    if (!submission.text && submission.attachments.length === 0) {
      return res.status(400).json({ error: 'There is nothing in this hand-in to check yet' });
    }
    if (!AI_SERVICE_URL || !AI_SERVICE_SECRET) {
      return res.status(503).json({ error: 'Rubric checks are not configured on this server' });
    }

    // Which checklist, or none: a named checklist decides the mode itself;
    // otherwise the mentor's choice, or the rule (lib/coverageMode.js, N = 3).
    const { setId, mode: override } = req.body || {};
    const assignment = submission.assignment;
    const rubricFile = assignment.attachments.find((f) => f.rubric && f.rubric.isRubric);
    let set = null;
    let mode;
    if (setId !== undefined) {
      if (!mongoose.isValidObjectId(setId)) {
        return res.status(404).json({ error: 'Checklist not found' });
      }
      set = await CriteriaSet.findOne({ _id: setId, assignment: assignment._id });
      if (!set) {
        return res.status(404).json({ error: 'Checklist not found' });
      }
      mode = { mode: set.source.kind, chosenBy: 'mentor', label: coverageMode.LABELS[set.source.kind] };
    } else {
      let brief = await CriteriaSet.findOne({ assignment: assignment._id, 'source.kind': 'brief' });
      const briefCount = () => (brief ? brief.extracted.criteria.length : null);
      mode = coverageMode.chooseMode({ rubricMarked: Boolean(rubricFile), briefCount: briefCount(), override });
      if (mode.needsBrief) {
        // The rule needs the brief's checklist to count: read it now, once.
        const done = await extractChecklist(assignment, req.authUser, 'brief');
        if (done.error) {
          return res.status(done.status).json({ error: done.error });
        }
        brief = done.set;
        mode = coverageMode.chooseMode({ rubricMarked: false, briefCount: briefCount(), override });
      }
      if (mode.error) {
        return res.status(400).json({ error: mode.error });
      }
      if (mode.mode === 'rubric') {
        set = await CriteriaSet.findOne({ assignment: assignment._id, 'source.kind': 'rubric', 'source.fileId': rubricFile.fileId });
      } else if (mode.mode === 'brief') {
        set = brief;
      }
    }

    const latest = set ? set.latest() : null;
    if (mode.mode !== 'summary' && !latest) {
      return res.status(409).json({
        error: 'Confirm the checklist first: nothing is assessed until you do',
        mode: mode.mode,
        setId: set ? String(set._id) : null
      });
    }
    // When a rubric now exists and this check is not against it, the mentor can regenerate in rubric mode.
    const rubricSet = rubricFile
      ? await CriteriaSet.findOne({ assignment: assignment._id, 'source.kind': 'rubric', 'source.fileId': rubricFile.fileId })
      : null;
    const rubricReady = Boolean(rubricSet && rubricSet.latest()) && mode.mode !== 'rubric';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COVERAGE_ASSESS_TIMEOUT_MS);
    let upstream;
    let body;
    try {
      const scope = {
        mentorshipId: String(mentorship._id),
        viewerId: String(req.authUser._id),
        submissionId: String(submission._id),
        // The hand-in's own text box: never `review.note`, which is the mentor's.
        text: submission.text || '',
        files: submission.attachments.map((f) => ({ fileId: String(f.fileId), name: f.name }))
      };
      const summary = mode.mode === 'summary';
      upstream = await fetch(`${AI_SERVICE_URL}${summary ? '/coverage/summary' : '/coverage/assess'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AI-Secret': AI_SERVICE_SECRET },
        body: JSON.stringify(
          summary ? scope : { ...scope, criteria: latest.criteria.map((c) => ({ id: c.id, text: c.text, marks: c.marks })) }
        ),
        signal: controller.signal
      });
      body = await upstream.json().catch(() => null);
    } finally {
      clearTimeout(timer);
    }

    const expected = mode.mode === 'summary' ? 'points' : 'verdicts';
    if (!upstream.ok || !body || !Array.isArray(body[expected])) {
      if ([429, 502, 503].includes(upstream.status) && typeof body?.message === 'string') {
        return res.status(upstream.status).json({ error: body.message });
      }
      console.error('Coverage assessment answered', upstream.status);
      return res.status(502).json({ error: 'The hand-in could not be checked' });
    }

    const head = {
      submissionId: String(submission._id),
      mode: mode.mode,
      modeLabel: mode.label,
      modeChosenBy: mode.chosenBy,
      rubricAvailable: rubricReady,
      draft: true
    };
    if (mode.mode === 'summary') {
      // No verdicts, no marks, no checklist: only these fields reach the mentor.
      const result = pick(body, SUMMARY_FIELDS);
      result.points = body.points.map((p) => pick(p, ['point', 'evidence']));
      return res.json({ ...result, ...head, checklist: null });
    }
    const result = pick(body, ASSESSMENT_FIELDS);
    result.verdicts = body.verdicts.map((v) => pick(v, VERDICT_FIELDS));
    res.json({
      ...result,
      ...head,
      checklist: { setId: String(set._id), version: latest.n, source: set.source }
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('Error checking a hand-in: timed out');
      return res.status(504).json({ error: 'Checking this hand-in took too long. Try again in a few minutes.' });
    }
    console.error('Error checking a hand-in:', err);
    res.status(502).json({ error: 'The hand-in could not be checked' });
  }
}
app.post('/api/submissions/:id/coverage', requireAuth, checkSubmission);

module.exports = { pick, checkSubmission };
