/**
 * AgentProposal: what makes a signed proposal single-use.
 *
 * The token (lib/agentProposal.js) says what was proposed. This record says
 * whether it has been used. It moves one way, atomically:
 *
 *   pending -> claimed -> closed     approved, then run by the browser
 *   pending -> closed                dismissed
 *
 * It lives in Mongo rather than in memory so that restarting Express cannot make
 * a used proposal usable again.
 *
 * It holds no argument, field or question: the token carries those. And it never
 * records whether the write worked, because the only source for that is the
 * browser's own report, which is not a fact the server may keep (§2.4).
 */
const mongoose = require('mongoose');

const agentProposalSchema = new mongoose.Schema(
  {
    // The token's `jti`, which is also the paused turn's thread id.
    _id: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    mentorship: { type: mongoose.Schema.Types.ObjectId, ref: 'Mentorship', required: true },
    tool: { type: String, required: true },
    status: { type: String, enum: ['pending', 'claimed', 'closed'], default: 'pending', required: true },
    // After the token has expired, so the record outlasts anything that could use it.
    expiresAt: { type: Date, required: true },
    claimedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

agentProposalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AgentProposal', agentProposalSchema);
