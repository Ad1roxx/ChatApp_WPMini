/**
 * fileStore — where uploaded files live
 *
 * Files are stored in MongoDB itself, using GridFS: the driver splits each
 * file into 255 KB chunks across two collections — `attachments.files`, one
 * document per file, and `attachments.chunks`, the bytes.
 *
 * ## Why the database, and not a storage bucket
 *
 * A bucket (S3, R2, Firebase Storage) is the textbook answer, and it is where
 * this should move if the app ever holds a lot of files. But every one of them
 * needs an account, credentials in the server's environment and, for most, a
 * card on file. GridFS needs nothing the app does not already have: the same
 * code works on a laptop, in CI's throwaway Mongo, and on a hosted MongoDB.
 * The cost is space in the database, which the limits below keep bounded — a
 * free Atlas cluster is 512 MB for everything.
 *
 * ## Swapping it out later
 *
 * The rest of the server calls only the functions exported here. Moving to a
 * bucket means rewriting this file, not the routes.
 */

const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const mongoose = require('mongoose');

/** 10 MB — a PDF, a slide deck, a zipped project; not a screen recording. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Per hand-in. With the size cap, one hand-in can never pass 50 MB. */
const MAX_FILES_PER_SUBMISSION = 5;

/**
 * What can be attached, and the Content-Type each is served with.
 *
 * An allow-list, not a block-list: the list of dangerous extensions is
 * open-ended, the list of things a student hands in is not. Nothing here
 * launches on a double-click — no .exe, .bat, .msi, .jar, .ps1 — so a hand-in
 * cannot be used to pass a program from one account to another. SVG is left
 * out on purpose too: it is an image format that can carry script.
 *
 * The type is decided HERE, from the extension, and never taken from the
 * upload: the type a browser claims is whatever the sender wants it to be.
 */
const DOCUMENTS = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip'
};

/**
 * Source code — most of what a coding mentorship hands in. All of it is
 * served as plain text, .html included: an uploaded page must never be served
 * as a page from this server's origin.
 */
const CODE = [
  'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs',
  'rb', 'php', 'kt', 'swift', 'sql', 'json', 'ipynb', 'html', 'css', 'xml',
  'yaml', 'yml'
];

const TYPES = {
  ...DOCUMENTS,
  ...Object.fromEntries(CODE.map((ext) => [ext, 'text/plain; charset=utf-8']))
};

const ALLOWED_EXTENSIONS = Object.keys(TYPES);

/**
 * A filename that is safe to store and to show.
 *
 * - Only the last path segment. A name like `../../server/.env` is a name,
 *   never a location, but there is no reason to keep the path at all.
 * - No control characters, and no bidirectional overrides — those can make
 *   `invoice<U+202E>fdp.exe` display as `invoiceexe.pdf`.
 * - At most 200 characters, keeping the extension.
 */
function cleanName(raw) {
  const base = String(raw || '').split(/[/\\]/).pop();
  const clean = base
    .replace(/\p{Cc}/gu, '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim();

  if (clean.length <= 200) return clean;
  const ext = path.extname(clean);
  return clean.slice(0, 200 - ext.length) + ext;
}

/** Clean the name, and say whether that kind of file may be attached. */
function checkFile(originalName) {
  const name = cleanName(originalName);
  const ext = path.extname(name).slice(1).toLowerCase();

  if (!name || !ext) {
    return { error: 'That file has no extension, so it cannot be attached' };
  }

  // hasOwn, not `TYPES[ext]`: a file called `x.constructor` would otherwise
  // find Object's own constructor and be let through.
  if (!Object.hasOwn(TYPES, ext)) {
    return { error: `.${ext} files cannot be attached` };
  }

  return { name, contentType: TYPES[ext] };
}

let bucket = null;

/** Made on first use rather than at require time, when Mongo is not connected yet. */
function files() {
  if (!bucket) {
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: 'attachments'
    });
  }
  return bucket;
}

const toId = (id) => new mongoose.Types.ObjectId(String(id));

/** Store the bytes; resolves with the new file's id once they are all written. */
async function saveFile(buffer, { name, contentType, metadata = {} }) {
  const upload = files().openUploadStream(name, {
    metadata: { ...metadata, contentType }
  });
  await pipeline(Readable.from([buffer]), upload);
  return upload.id;
}

/** The stored file's record (name, length), or null. */
async function findFile(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  return files().find({ _id: toId(id) }).next();
}

/** A readable stream of the bytes. Check `findFile` first. */
function openFile(id) {
  return files().openDownloadStream(toId(id));
}

/** Delete, treating "already gone" as done: the goal is that it is not there. */
async function removeFile(id) {
  try {
    await files().delete(toId(id));
  } catch (err) {
    if (!/not found/i.test(err.message)) throw err;
  }
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_FILES_PER_SUBMISSION,
  ALLOWED_EXTENSIONS,
  cleanName,
  checkFile,
  saveFile,
  findFile,
  openFile,
  removeFile
};
