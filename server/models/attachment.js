/**
 * One stored file, as a hand-in or an assignment's brief records it. `fileId`
 * is the GridFS id (lib/fileStore.js), and also the id the download routes are
 * addressed by. Shared, so both kinds of file have exactly the same shape and
 * the retrieval index reads them the same way.
 */
const mongoose = require('mongoose');

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

module.exports = attachmentSchema;
