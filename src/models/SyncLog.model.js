// src/models/SyncLog.model.js
//
// A record of what a device actually SENT to /health/sync, alongside what the
// server accepted.
//
// Nothing recorded this before. The sync endpoint validates and clamps the
// incoming figure and stores only the final number, and CheatFlag is written
// only when validation raises a flag. So when a user says "my steps are wrong",
// there was no way to answer the first question — what did their device report,
// and did the server change it? Every step bug so far has been debugged by
// guessing from the coin ledger backwards.
//
// ── Volume ──────────────────────────────────────────────────────────────────
//
// Every device posts roughly every 15 minutes, all day, so logging every sync
// would be six-figure daily writes for a debugging aid. Two things keep it
// bounded, both decided in utils/syncLog.js:
//
//   1. Only *interesting* syncs are recorded by default — ones the validator
//      changed, rejected, or that moved steps by an unusual amount.
//   2. Full verbose tracing is opt-in per user (User.syncDebug), for the case
//      that actually matters: one specific account under investigation.
//
// A TTL index expires everything after a week. These are debugging breadcrumbs,
// not history — HealthActivity remains the record of what a day's steps were.

const mongoose = require('mongoose');

const syncLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // The day the payload was written to, not the day it was sent — a sync at
    // 00:05 can legitimately target yesterday.
    date: { type: String, required: true }, // "YYYY-MM-DD"

    // ── What the device sent ────────────────────────────────────────────────
    incomingSteps: { type: Number, default: 0 },
    // ── What was already stored, so a jump is readable without a second query ─
    existingSteps: { type: Number, default: 0 },
    // ── What validation allowed through ─────────────────────────────────────
    clampedSteps: { type: Number, default: 0 },
    // ── What the row ended up holding (walked + bonus, no-regression applied) ─
    storedSteps: { type: Number, default: 0 },

    // ── Validator verdict ───────────────────────────────────────────────────
    flagged: { type: Boolean, default: false },
    severity: { type: String, default: 'none' }, // 'none' | 'clamped' | 'implausible'
    reason: { type: String, default: null },
    corrected: { type: Boolean, default: false },

    // ── Who sent it ─────────────────────────────────────────────────────────
    // The whole point of the build telemetry: a suspicious payload can be tied
    // to the exact build and code path that produced it.
    appVersion: { type: String, default: null },
    buildNumber: { type: Number, default: null },
    platform: { type: String, default: null },
    clientSource: { type: String, default: null }, // 'app' | 'native_service' | 'worker'
    timezone: { type: String, default: null },

    // Why this particular sync was worth recording — 'flagged', 'clamped',
    // 'corrected', 'rejected', 'large_jump', or 'trace' (verbose mode on).
    // Lets a reader tell a deliberately-sampled row from an anomalous one.
    logReason: { type: String, default: null },
  },
  { timestamps: true },
);

// Expire after 7 days. Debugging breadcrumbs, not history — and an unbounded
// high-write collection is how a small Mongo runs out of disk.
syncLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

// The only read pattern: one user's recent syncs, newest first.
syncLogSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('SyncLog', syncLogSchema);
