// src/models/StepProvenance.model.js
//
// Where every step came from.
//
// ── The question this answers ────────────────────────────────────────────────
//
// HealthActivity stores one number per day. SyncLog stores what a device sent
// versus what the server kept. Neither can answer the question that actually
// gets asked when a step total looks wrong:
//
//   "17,000 steps landed in a single sync. Were they walked today, or is this a
//    backlog from the three days the phone was offline — and which app on the
//    phone counted them?"
//
// Both halves of that were unanswerable. The daily total is a scalar, so a jump
// is just a bigger scalar; and the payload carried only `steps`, throwing away
// everything the client already knew — which Health Connect data origins
// contributed, whether a second origin was a paired watch or a mirror of the
// platform pedometer, what clock times the underlying records covered, and
// whether the reader was Health Connect at all or the phone's own sensor.
//
// This model keeps that. Two layers:
//
//   `entries` — a ledger. One row per accepted UPWARD move of walked steps, so
//               a day reads as a sequence of "+240 at 09:15 from Samsung Health,
//               recorded 08:50–09:14" rather than a single end-of-day number.
//               A 17,000-step jump is one row, and the row says where it came
//               from and what period it covers.
//
//   `hourly`  — a 24-slot histogram of the clock hours the day's steps were
//               RECORDED in, as opposed to the hour they were delivered. This is
//               what separates "walked across the whole day, synced late" from
//               "17,000 steps all stamped inside one 15-minute record", which is
//               what a counting bug or an injection looks like.
//
// ── Delivery time vs recording time ─────────────────────────────────────────
//
// The distinction runs through the whole file and is the point of it. `at` is
// when the server accepted the steps; `recordedFrom`/`recordedTo` are when the
// device says they were walked; `daysLate` is the gap in whole local days.
// A backlog flushed after a week offline is entirely normal and looks alarming
// in every view that only has `at`.
//
// ── Volume ──────────────────────────────────────────────────────────────────
//
// One document per user per day, updated in place — not one per sync. Entries
// are capped and the document expires after 90 days. Unlike SyncLog (7 days,
// anomalies only) this is kept for every user and every accepted increase,
// because "which of these steps were real" is asked about days that are already
// weeks old, by which point a sampled log has expired.

const mongoose = require('mongoose');

/**
 * Upper bound on ledger entries per day.
 *
 * A device syncing every 15 minutes produces at most 96 increases in a day, and
 * a second device or the widget worker pushes that higher. 200 holds a normal
 * two-device day in full; past that the oldest are dropped, because a day with
 * 200+ separate increases is one where the early detail matters least.
 */
const MAX_ENTRIES = 200;

/** Per-origin attribution — one Health Connect data origin, or a native reader. */
const originSchema = new mongoose.Schema(
  {
    // Android package name ("com.sec.android.app.shealth"), or a reader id for
    // non-Health-Connect sources ("native_sensor").
    packageName: { type: String, required: true },
    // Steps this origin reported in the window that was read.
    steps: { type: Number, default: 0 },
    // Steps it actually ADDED to the total after deduplication. Zero means it
    // was judged a mirror of the primary origin — it recorded the same walk, so
    // counting it would double the day. Keeping both numbers is what makes a
    // "missing steps" report answerable: the steps were seen and deliberately
    // not counted, which is a different answer from never having been seen.
    contributed: { type: Number, default: 0 },
    // Fraction of this origin's recording time not shared with the primary.
    // Near 1 → an independent device (a watch). Near 0 → a mirror.
    disjointFraction: { type: Number, default: 0 },
  },
  { _id: false },
);

const entrySchema = new mongoose.Schema(
  {
    // When the SERVER accepted this increase. Not when the steps were walked.
    at: { type: Date, default: Date.now },

    // ── The move ────────────────────────────────────────────────────────────
    from: { type: Number, default: 0 }, // walked steps before
    to: { type: Number, default: 0 },   // walked steps after
    delta: { type: Number, default: 0 },

    // ── Which reader produced the figure ────────────────────────────────────
    // 'health_connect' | 'native_sensor' | 'server' | 'unknown'. The two
    // physical readers answer completely different questions when they
    // disagree, so a total with no reader attached cannot be diagnosed.
    reader: { type: String, default: 'unknown' },
    // How the reader resolved multiple origins: 'single-origin',
    // 'coverage-dedup', 'own-records-only', 'no-records', 'failed', 'sensor'.
    method: { type: String, default: null },
    // The origin used as the dedup baseline — the one most of these steps are
    // attributable to.
    primaryOrigin: { type: String, default: null },
    origins: { type: [originSchema], default: [] },

    // ── When the steps were RECORDED, per the device ────────────────────────
    // The heart of the "were these today's steps?" question. Null when the
    // reader cannot say (the native sensor knows a running count, not the
    // timestamps behind it).
    recordedFrom: { type: Date, default: null },
    recordedTo: { type: Date, default: null },
    // How many underlying Health Connect records this figure was built from.
    // One record holding 17,000 steps and 300 records holding 17,000 steps are
    // the same total and completely different events.
    recordCount: { type: Number, default: 0 },

    // ── Delivery lateness ───────────────────────────────────────────────────
    // Whole local days between the date these steps belong to and the day they
    // were accepted. 0 is a live sync; 3 means a backlog landed three days
    // late, which is the honest explanation for most alarming jumps.
    daysLate: { type: Number, default: 0 },
    // Minutes since this device last synced successfully, as reported by the
    // client. A long gap is the other half of the backlog explanation.
    offlineMinutes: { type: Number, default: null },

    // ── Who delivered it ────────────────────────────────────────────────────
    appVersion: { type: String, default: null },
    buildNumber: { type: Number, default: null },
    platform: { type: String, default: null },
    clientSource: { type: String, default: null }, // app | native_service | worker
  },
  { _id: false },
);

const stepProvenanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // The day the steps BELONG to, not the day they arrived.
    date: { type: String, required: true }, // "YYYY-MM-DD"

    // ── Ledger ──────────────────────────────────────────────────────────────
    entries: { type: [entrySchema], default: [] },
    // Increases that happened after the cap was reached, so the ledger never
    // silently claims to be complete when it is not.
    droppedEntries: { type: Number, default: 0 },

    // ── Rolled-up attribution for the whole day ─────────────────────────────
    // The latest full breakdown, so the common question ("who counted today's
    // steps?") is one field read rather than a walk of the ledger.
    origins: { type: [originSchema], default: [] },

    // Local-hour histogram of when the day's steps were RECORDED. Index 0 is
    // 00:00–00:59 in the device's timezone. Empty when no reader supplied
    // record timestamps.
    hourly: { type: [Number], default: [] },

    // ── Totals, for reading the ledger without a second query ───────────────
    walkedSteps: { type: Number, default: 0 },
    bonusSteps: { type: Number, default: 0 },
    totalSteps: { type: Number, default: 0 },

    // Distinct readers that contributed to this day. A day fed by both Health
    // Connect and the native sensor is the setup most disagreements come from.
    readers: { type: [String], default: [] },
    timezone: { type: String, default: null },

    firstSyncAt: { type: Date, default: null },
    lastSyncAt: { type: Date, default: null },
    // Accepted increases seen, including any dropped past the cap.
    increaseCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// One document per user per day — the same key HealthActivity uses, so the two
// join directly.
stepProvenanceSchema.index({ user: 1, date: 1 }, { unique: true });
// The read pattern behind the admin view: one user's recent days, newest first.
stepProvenanceSchema.index({ user: 1, createdAt: -1 });
// 90 days. Long enough that a month-old dispute is still answerable, bounded
// enough that the collection cannot grow without limit.
stepProvenanceSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const StepProvenance = mongoose.model('StepProvenance', stepProvenanceSchema);

module.exports = StepProvenance;
module.exports.MAX_ENTRIES = MAX_ENTRIES;
