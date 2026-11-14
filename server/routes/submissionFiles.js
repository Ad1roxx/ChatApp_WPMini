/**
 * Files attached to a hand-in: upload, download, remove.
 *
 * Moved out of index.js as it was (docs/AUDIT.md, H7; BUILD_NOTES Entry 155). Loaded by index.js,
 * in the order the sections had there, which is the order Express tries routes in.
 */

const multer = require('multer');
const fileStore = require('../lib/fileStore');
// Tells the retrieval service which record changed - after the write, never
// awaited, never able to fail the request. See lib/indexSync.js.
const { syncSource } = require('../lib/indexSync');
// Reads with their permission checks, shared by the routes below and the
// agent's tools, so that each check is written once.
const { loadSubmission, canReadSubmissionFile, serialiseSubmission } = require('../lib/reads');
const { limited } = require('../lib/rateLimit');
// Authentication
const { requireAuth } = require('../middleware/auth');
const { app, uploadLimiter } = require('../app');
const { loadSubmissionForResponse, announceAssignment } = require('./assignments');

// ============================================
// ASSIGNMENT FILES
// ============================================

/**
 * Upload parsing. Held in memory rather than written to a temp folder: the
 * cap is 10 MB, the bytes go straight on to GridFS, and a hosted server's
 * disk is no place to keep anything anyway.
 *
 * `defParamCharset: 'utf8'` so a name like `résumé.pdf` arrives as itself,
 * not as the Latin-1 misreading of its bytes.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: fileStore.MAX_FILE_BYTES, files: 1, fields: 10 },
  defParamCharset: 'utf8'
});

/** Why a hand-in's files cannot change right now, or null if they can. */
function frozenReason(submission) {
  if (submission.status === 'submitted') return 'Unsubmit it first to change it';
  if (submission.status === 'accepted') return 'That work has already been accepted';
  return null;
}

/**
 * `attachment; filename=…` in the form every browser reads: an ASCII
 * fallback, plus the real name percent-encoded (RFC 6266) so `résumé.pdf`
 * downloads as itself.
 */
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Serve one stored file so that it can never run as part of this app,
 * whatever is in it, or answer 404 when there is no such file:
 *
 * - `Content-Disposition: attachment` — the browser saves it, never shows it
 * - a Content-Type the server chose from the extension at upload time
 * - `nosniff`, so the browser does not second-guess that type
 * - a CSP sandbox, in case anyone opens the URL directly anyway
 *
 * Shared by hand-in files and assignment files.
 */
async function sendStoredFile(res, attachment) {
  const file = attachment && (await fileStore.findFile(attachment.fileId));
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.setHeader('Content-Type', attachment.contentType);
  res.setHeader('Content-Length', String(file.length));
  res.setHeader('Content-Disposition', contentDisposition(attachment.name));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, no-store');

  fileStore
    .openFile(attachment.fileId)
    .on('error', (err) => {
      console.error('Error streaming file:', err);
      res.destroy(err);
    })
    .pipe(res);
}

/**
 * Everything checked BEFORE the upload is read: who is asking, and whether
 * this hand-in can take another file. Someone who may not attach here is
 * turned away without the server buffering their 10 MB first.
 */
async function canAttach(req, res, next) {
  try {
    const loaded = await loadSubmission(req.params.id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const { submission } = loaded;

    if (String(submission.student) !== String(req.authUser._id)) {
      return res
        .status(403)
        .json({ error: 'Only the student it was set for can attach files' });
    }

    const frozen = frozenReason(submission);
    if (frozen) {
      return res.status(400).json({ error: frozen });
    }

    if (submission.attachments.length >= fileStore.MAX_FILES_PER_SUBMISSION) {
      return res.status(400).json({
        error: `Up to ${fileStore.MAX_FILES_PER_SUBMISSION} files per hand-in`
      });
    }

    req.submission = submission;
    next();
  } catch (err) {
    console.error('Error checking upload:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

/** Parse the one file, turning multer's errors into the app's JSON ones. */
function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `Files can be up to ${fileStore.MAX_FILE_BYTES / (1024 * 1024)} MB`
      });
    }

    // Anything else is a malformed request — a second file, a stray field.
    res.status(400).json({ error: 'Send one file, in a field called "file"' });
  });
}

/**
 * POST /api/submissions/:id/files
 *
 * Attach one file to your own work. STUDENT ONLY, and only while the work can
 * still change — handed-in work is frozen until it is unsubmitted, exactly as
 * its text is.
 *
 * Attaching IS saving a draft: the work becomes "attached, not handed in",
 * which the mentor can see. That is how Classroom behaves, and it is the very
 * state the mentor asked to be able to see.
 */
app.post(
  '/api/submissions/:id/files',
  requireAuth,
  limited(uploadLimiter, 'Too many uploads. Try again in a few minutes.'),
  canAttach,
  receiveFile,
  async (req, res) => {
    // Set once the bytes are stored and cleared once they are recorded, so a
    // failure in between can take back a file nothing points at.
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

      const { submission } = req;

      const fileId = await fileStore.saveFile(req.file.buffer, {
        name: checked.name,
        contentType: checked.contentType,
        metadata: { submission: submission._id, uploadedBy: req.authUser._id }
      });
      unrecorded = fileId;

      submission.attachments.push({
        fileId,
        name: checked.name,
        size: req.file.size,
        contentType: checked.contentType,
        uploadedAt: new Date()
      });
      submission.status = 'draft';
      submission.draftSavedAt = new Date();
      submission.log('file-attached', req.authUser._id, checked.name);

      await submission.save();
      unrecorded = null;
      syncSource('submission', submission._id);

      announceAssignment(submission.assignment._id, submission.assignment.mentor, [
        submission.student
      ]);

      res
        .status(201)
        .json(serialiseSubmission(await loadSubmissionForResponse(submission._id), undefined, req.authUser));
    } catch (err) {
      console.error('Error attaching file:', err);
      if (unrecorded) await fileStore.removeFile(unrecorded).catch(() => {});
      res.status(500).json({ error: 'Server error' });
    }
  }
);

/**
 * GET /api/submissions/:id/files/:fileId
 *
 * Download one file: the student it belongs to, and the mentor who set the
 * assignment — the same two people who can read the hand-in. The file is
 * found THROUGH the hand-in, so an id from anywhere else finds nothing.
 *
 * Served by `sendStoredFile`, so it can never run as part of this app.
 */
app.get('/api/submissions/:id/files/:fileId', requireAuth, async (req, res) => {
  try {
    const loaded = await loadSubmission(req.params.id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const { submission } = loaded;

    if (!canReadSubmissionFile(submission, req.authUser)) {
      return res
        .status(403)
        .json({ error: 'Only the student and the mentor who set this can open it' });
    }

    const attachment = submission.attachments.find(
      (f) => String(f.fileId) === String(req.params.fileId)
    );
    await sendStoredFile(res, attachment);
  } catch (err) {
    console.error('Error downloading file:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/submissions/:id/files/:fileId
 *
 * Remove a file from your own work, under the same rules as attaching:
 * student only, and not while it is handed in. The record goes first and the
 * bytes second — a failure between the two leaves an unreachable file, never
 * a hand-in listing a file that is gone.
 */
app.delete('/api/submissions/:id/files/:fileId', requireAuth, async (req, res) => {
  try {
    const loaded = await loadSubmission(req.params.id);
    if (loaded.error) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const { submission } = loaded;

    if (String(submission.student) !== String(req.authUser._id)) {
      return res
        .status(403)
        .json({ error: 'Only the student it was set for can remove files' });
    }

    const frozen = frozenReason(submission);
    if (frozen) {
      return res.status(400).json({ error: frozen });
    }

    const index = submission.attachments.findIndex(
      (f) => String(f.fileId) === String(req.params.fileId)
    );
    if (index === -1) {
      return res.status(404).json({ error: 'File not found' });
    }

    const [removed] = submission.attachments.splice(index, 1);
    submission.status = 'draft';
    submission.draftSavedAt = new Date();
    submission.log('file-removed', req.authUser._id, removed.name);

    await submission.save();
    await fileStore.removeFile(removed.fileId);
    syncSource('submission', submission._id);

    announceAssignment(submission.assignment._id, submission.assignment.mentor, [
      submission.student
    ]);

    res.json(serialiseSubmission(await loadSubmissionForResponse(submission._id), undefined, req.authUser));
  } catch (err) {
    console.error('Error removing file:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { contentDisposition, sendStoredFile, receiveFile };
