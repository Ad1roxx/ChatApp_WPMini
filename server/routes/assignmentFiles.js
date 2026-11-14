/**
 * The brief's own attachments.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const Submission = require('../models/Submission');
const fileStore = require('../lib/fileStore');
// Tells the retrieval service which record changed - after the write, never
// awaited, never able to fail the request. See lib/indexSync.js.
const { syncSource } = require('../lib/indexSync');
// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const { loadOwnAssignment, loadAssignmentFiles } = require('../lib/reads');
const { limited } = require('../lib/rateLimit');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app, uploadLimiter } = require('../app');
const { announceAssignment } = require('./assignments');
const { sendStoredFile, receiveFile } = require('./submissionFiles');

// ============================================
// ASSIGNMENT FILES: the brief's own attachments
// ============================================

/**
 * The same files as a hand-in's, attached to the brief instead: the same
 * allow-list, 10 MB cap and five-file limit, received by the same
 * `receiveFile` and served by the same `sendStoredFile`.
 *
 * Who: ONLY the mentor who set the assignment uploads or removes
 * (`loadOwnAssignment`, the check every other assignment write uses). That
 * mentor and the students it was set for list and download
 * (`loadAssignmentFiles` in lib/reads.js). Nobody else — not another mentor
 * of the same student, not a student it was not set for.
 *
 * Each change tells the index (`syncSource('assignment', …)`), which re-reads
 * the brief's files with the brief's own viewers.
 */

/** Checked BEFORE the upload is read, like `canAttach`. */
async function canAttachToAssignment(req, res, next) {
  try {
    const own = await loadOwnAssignment(req.params.id, req.authUser);
    if (own.error) {
      return res.status(own.status).json({ error: own.error });
    }
    if (own.assignment.attachments.length >= fileStore.MAX_FILES_PER_SUBMISSION) {
      return res.status(400).json({
        error: `Up to ${fileStore.MAX_FILES_PER_SUBMISSION} files per assignment`
      });
    }
    req.assignment = own.assignment;
    next();
  } catch (err) {
    console.error('Error checking assignment upload:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

/** Everyone the brief is shown to, told it changed. */
async function announceBrief(assignment) {
  const subs = await Submission.find({ assignment: assignment._id }).select('student');
  announceAssignment(assignment._id, assignment.mentor, subs.map((s) => s.student));
}

/** POST /api/assignments/:id/files — the mentor who set it attaches one file. */
app.post(
  '/api/assignments/:id/files',
  requireAuth,
  limited(uploadLimiter, 'Too many uploads. Try again in a few minutes.'),
  canAttachToAssignment,
  receiveFile,
  async (req, res) => {
    let unrecorded = null;
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Choose a file to attach' });
      }
      if (req.file.size === 0) {
        return res.status(400).json({ error: 'That file is empty' });
      }
      const checked = fileStore.checkFile(req.file.originalname);
      if (checked.error) {
        return res.status(400).json({ error: checked.error });
      }

      const { assignment } = req;
      const fileId = await fileStore.saveFile(req.file.buffer, {
        name: checked.name,
        contentType: checked.contentType,
        metadata: { assignment: assignment._id, uploadedBy: req.authUser._id }
      });
      unrecorded = fileId;

      assignment.attachments.push({
        fileId,
        name: checked.name,
        size: req.file.size,
        contentType: checked.contentType,
        uploadedAt: new Date()
      });
      await assignment.save();
      unrecorded = null;
      syncSource('assignment', assignment._id);
      await announceBrief(assignment);

      res.status(201).json({ attachments: assignment.attachments });
    } catch (err) {
      console.error('Error attaching a file to an assignment:', err);
      if (unrecorded) await fileStore.removeFile(unrecorded).catch(() => {});
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/** GET /api/assignments/:id/files — the brief's files, for those who may see them. */
app.get('/api/assignments/:id/files', requireAuth, async (req, res) => {
  try {
    const read = await loadAssignmentFiles(req.params.id, req.authUser);
    if (read.error) {
      return res.status(read.status).json({ error: read.error });
    }
    res.json({ attachments: read.files });
  } catch (err) {
    console.error('Error listing assignment files:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/assignments/:id/files/:fileId — download one. Found THROUGH the
 * brief, among the files this user is shown, so an id from anywhere else
 * finds nothing.
 */
app.get('/api/assignments/:id/files/:fileId', requireAuth, async (req, res) => {
  try {
    const read = await loadAssignmentFiles(req.params.id, req.authUser);
    if (read.error) {
      return res.status(read.status).json({ error: read.error });
    }
    const attachment = read.files.find((f) => String(f.fileId) === String(req.params.fileId));
    await sendStoredFile(res, attachment);
  } catch (err) {
    console.error('Error downloading an assignment file:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/assignments/:id/files/:fileId — the mentor who set it removes
 * one. Record first, bytes second, as for hand-ins.
 */
app.delete('/api/assignments/:id/files/:fileId', requireAuth, async (req, res) => {
  try {
    const own = await loadOwnAssignment(req.params.id, req.authUser);
    if (own.error) {
      return res.status(own.status).json({ error: own.error });
    }
    const { assignment } = own;
    const index = assignment.attachments.findIndex(
      (f) => String(f.fileId) === String(req.params.fileId)
    );
    if (index === -1) {
      return res.status(404).json({ error: 'File not found' });
    }

    const [removed] = assignment.attachments.splice(index, 1);
    await assignment.save();
    await fileStore.removeFile(removed.fileId);
    syncSource('assignment', assignment._id);
    await announceBrief(assignment);

    res.json({ attachments: assignment.attachments });
  } catch (err) {
    console.error('Error removing an assignment file:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/assignments/:id/files/:fileId — the mentor who set it marks a
 * file as the rubric, or not, and shares it with the students, or not (D5).
 *
 * Body: `{ rubric?: boolean, shared?: boolean }`, at least one. One rubric per
 * assignment: flagging a second while one is flagged is refused (409).
 * Unflagging also unshares; sharing needs the flag. Every change stamps
 * `changedAt`, which the index reads as a new version, and syncs the brief so
 * the file's chunks are rewritten with the new viewers. Unsharing takes effect
 * in search at once regardless: the read-time check rebuilds the audience from
 * this record.
 */
app.patch('/api/assignments/:id/files/:fileId', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const unknown = Object.keys(body).filter((k) => k !== 'rubric' && k !== 'shared');
    const given = ['rubric', 'shared'].filter((k) => k in body);
    if (unknown.length || !given.length || given.some((k) => typeof body[k] !== 'boolean')) {
      return res.status(400).json({ error: 'Send rubric and/or shared, each true or false' });
    }

    const own = await loadOwnAssignment(req.params.id, req.authUser);
    if (own.error) {
      return res.status(own.status).json({ error: own.error });
    }
    const { assignment } = own;
    const file = assignment.attachments.find((f) => String(f.fileId) === String(req.params.fileId));
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    const was = file.rubric || { isRubric: false, shared: false };
    const isRubric = 'rubric' in body ? body.rubric : was.isRubric;
    let shared = 'shared' in body ? body.shared : was.shared;
    if (!isRubric) {
      if (body.shared === true) {
        return res.status(400).json({ error: 'Only the rubric can be shared this way' });
      }
      shared = false;
    }
    if (isRubric && !was.isRubric) {
      const other = assignment.attachments.find(
        (f) => f !== file && f.rubric && f.rubric.isRubric
      );
      if (other) {
        return res.status(409).json({ error: `${other.name} is already the rubric. Unmark it first.` });
      }
    }
    if (isRubric === was.isRubric && shared === was.shared) {
      return res.json({ attachments: assignment.attachments });
    }

    file.rubric = { isRubric, shared, changedAt: new Date() };
    assignment.markModified('attachments');
    await assignment.save();
    syncSource('assignment', assignment._id);
    await announceBrief(assignment);

    res.json({ attachments: assignment.attachments });
  } catch (err) {
    console.error('Error changing a brief file\'s rubric flag:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
