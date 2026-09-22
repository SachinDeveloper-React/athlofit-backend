// src/models/CoinTransactionArchive.model.js
//
// Where a coin transaction goes when a step reversal removes it.
//
// A reversal used to leave the original EARNED rows in place and add one
// DEDUCTED row for the total. That is an honest ledger, but it is not what an
// admin looking at the account wants: the "+2.09 Auto Step Coins" rows that
// were never earned stay on the screen, the day's per-date earnings still
// include them, and the analytics that sum EARNED rows still count them.
// Removing the rows from CoinTransaction is what makes every reader — the
// user's history, the admin ledger and its totals, the analytics, the AI
// summaries — stop showing them, in one place, without a `voided` filter that
// each of a dozen queries would have to remember.
//
// But a coin economy does not simply forget money. Every removed row is
// copied here first, verbatim, with why and when it was removed and which
// tool did it. Nothing reads this on the hot path; it exists so a support
// question ("my balance dropped by 600") has an answer, and so a reversal
// that turns out to be wrong can be undone from the record rather than from
// memory.

const mongoose = require('mongoose');

const coinTransactionArchiveSchema = new mongoose.Schema(
  {
    // ── The original row, as it was ─────────────────────────────────────────
    originalId: { type: mongoose.Schema.Types.ObjectId, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, required: true },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, default: 0 },
    source: { type: String, required: true },
    description: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    originalCreatedAt: { type: Date, default: null },

    // ── Why it is here ──────────────────────────────────────────────────────
    archivedAt: { type: Date, default: Date.now },
    archivedBy: { type: String, default: null }, // the script or admin action
    archiveReason: { type: String, default: null },
    // The day the reversal corrected, when the row belonged to one.
    archiveDate: { type: String, default: null },
  },
  { timestamps: false },
);

coinTransactionArchiveSchema.index({ user: 1, archivedAt: -1 });

module.exports = mongoose.model('CoinTransactionArchive', coinTransactionArchiveSchema);
