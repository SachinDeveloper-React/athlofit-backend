// src/models/HealthActivity.model.js
const mongoose = require('mongoose');

// ── One client stream's cadence history ──────────────────────────────────────
//
// The state trackClientCadence (stepValidation.js) carries between syncs, for
// recognising a source that has stopped measuring. Kept per STREAM — one entry
// per X-Client-Source value under `cadenceBySource` below — because a single
// Android phone posts through two of them a few minutes apart, and one merged
// history read their interleaving as a rate that never stopped changing. See
// the note at HOLD_STALE_MIN in stepValidation.js.
//
// These follow the RAW client total rather than the stored one. That
// distinction is the whole point: once the stuck-source rule binds, the stored
// total stops moving, so a delta measured against it would start growing and
// the constant-delta pattern would vanish on the next sync — releasing the
// guard it had just triggered. Measured against what the client itself last
// said, the pattern stays visible for as long as the device keeps producing it.
//
// null (not 0) for lastIncomingSteps means "no previous raw total recorded",
// which is a different state from a client that genuinely reported 0: the first
// sync of a day has nothing to measure against, and must not be read as a
// zero-step baseline.
//
// `lastIncomingAt` is what makes a rate computable at all — without a clock
// there is no divisor. Min and max rather than a reference rate, so the band is
// a spread over the streak and does not depend on which sample started it.
//
// `samples` is every sample the stream has produced today — a gain of at least
// STUCK_DELTA_MIN_STEPS, with the rate it implied and the window it covered.
// The streak fields above describe only the current RUN of samples and are
// reset by the first one that varies; a device that broke its run on purpose
// every fifth sync was never caught by them. The day-wide detectors read this
// list instead, so a rate the stream keeps returning to is refused however
// many breaks sit between the returns. See the note at MAX_CADENCE_SAMPLES in
// stepValidation.js. `stuck` on each sample is the stream's own verdict at the
// time, which is what a later sync too small to be a sample inherits.
const cadenceSampleSchema = new mongoose.Schema(
  {
    delta: { type: Number, required: true },
    rate: { type: Number, default: null },
    from: { type: Date, default: null },
    at: { type: Date, required: true },
    stuck: { type: Boolean, default: false },
    // The raw total itself. What `sampleTotals` below is built from.
    total: { type: Number, default: null },
  },
  { _id: false },
);

const cadenceStateSchema = new mongoose.Schema(
  {
    lastIncomingSteps: { type: Number, default: null },
    lastIncomingAt: { type: Date, default: null },
    lastIncomingDelta: { type: Number, default: 0 },
    repeatedDeltaCount: { type: Number, default: 0 },
    cadenceStreak: { type: Number, default: 0 },
    cadenceRateMin: { type: Number, default: null },
    cadenceRateMax: { type: Number, default: null },
    cadenceStreakAt: { type: Date, default: null },
    samples: { type: [cadenceSampleSchema], default: undefined },
  },
  { _id: false },
);

// Stores daily aggregated health snapshots sent from the mobile app
const healthActivitySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    date: {
      type: String, // "YYYY-MM-DD"
      required: true,
    },
    steps: { type: Number, default: 0 },
    bonusSteps: { type: Number, default: 0 }, // steps credited by admin/system (not from device)
    distance: { type: Number, default: 0 },   // km
    calories: { type: Number, default: 0 },   // kcal
    activeMinutes: { type: Number, default: 0 },
    heartRate: { type: Number, default: 0 },  // avg bpm
    heartRateMin: { type: Number, default: 0 },
    heartRateMax: { type: Number, default: 0 },
    bloodPressureSystolic: { type: Number, default: 0 },
    bloodPressureDiastolic: { type: Number, default: 0 },
    hydration: { type: Number, default: 0 },   // ml
    sleepHours: { type: Number, default: 0 },
    bloodGlucose: { type: Number, default: 0 }, // mmol/L
    weight: { type: Number, default: 0 },        // kg
    goalMet: { type: Boolean, default: false },
    goalSnapshot: { type: Number, default: 0 }, // goal that was active on this day

    // ── Retroactive coin bookkeeping (per-date, unlike the Gamification doc) ──
    //
    // Passive step coins are paid on a watermark: the award is
    // coinsFor(steps) - coinsFor(watermark). For TODAY that watermark lives on
    // the Gamification doc (lastPassiveCoinSteps), which only ever tracks one
    // day at a time — so it cannot express "how much was already paid for
    // 2026-08-12". Retroactive awards for past dates therefore need their own
    // per-date watermark, and this is it.
    //
    // The retro path already read `stepCoinWatermark`, but the field was never
    // declared on this schema, so it was always undefined → treated as 0 → every
    // retro sync assumed nothing had been paid for that day and paid the full
    // amount again.
    //
    // Walked steps only (bonus excluded), matching the passive-coin rule.
    stepCoinWatermark: { type: Number, default: 0 },

    // ── This account's own daily step ceiling ────────────────────────────────
    //
    // computeStepBaseline() over the trailing days that PRECEDE this one, frozen
    // at the moment the row is first written with steps and never recomputed for
    // this date afterwards.
    //
    // Frozen for two reasons. It must not include today: a ceiling that rises as
    // today's total rises is not a ceiling, and an inflated sync would raise the
    // bound that is supposed to refuse it. And recomputing it on every sync would
    // put a 28-day aggregation on the hottest write path in the app for no gain,
    // since nothing it reads can change during the day.
    //
    // Null on rows written before this existed, and on hydration-only rows that
    // never carried steps. Both mean "not characterised", and validateSteps
    // treats that as "apply only the population bounds" rather than as a zero
    // ceiling — a missing baseline must never read as "this user may walk 0".
    stepBaseline: { type: Number, default: null },

    // ── Was this day's step source one the account actually uses? ────────────
    //
    // False when any sync on this day attributed its steps to a Health Connect
    // origin the account has no history with — see utils/stepOriginTrust.js for
    // what that means and why rotation, not the package name, is the signal.
    //
    // STICKY FALSE. A day with one untrusted sync is not rehabilitated by a
    // trusted one afterwards, because the mixture is exactly what the fraudulent
    // accounts looked like: real steps from a real app alongside injected ones
    // from an origin that appeared that morning.
    //
    // Its only consumer is the baseline window (see stepBaselineStore), which
    // skips untrusted days. That is what stops a patient spoofer from ratcheting
    // their own ceiling upward by sitting just under it. It does NOT clamp
    // anything on its own, today or ever.
    //
    // Defaults true, and rows written before this existed have no value at all —
    // both read as trusted. Making absence mean "untrusted" would silently drop
    // every user's entire history out of their baseline the day this shipped.
    // Days that are already known to be fraudulent are corrected by the reversal
    // tooling, not by a schema default.
    originTrusted: { type: Boolean, default: true },

    // ── The origin history the trust check reads, frozen for the day ─────────
    //
    // Counting how many distinct days each origin has been seen on is a 28-day
    // aggregation over StepProvenance, and nothing it reads can change during the
    // day. Running it per sync — which is what the first version did — put that
    // query on the hottest write path in the app: the widget worker re-posts seven
    // days every fifteen minutes, so a single device generated hundreds of them a
    // day for no new information.
    //
    // Frozen on the day's first step sync, exactly like stepBaseline, and for the
    // same second reason: the window must exclude today, so a source cannot vouch
    // for itself with the very syncs it is being judged on.
    //
    // The per-SYNC part still runs every time, because the primary origin can
    // change during a day — it is a set membership test against these two fields
    // and touches no database.
    establishedOrigins: { type: [String], default: undefined },
    originChurn: { type: Number, default: null },

    // When this day's walked step count was last actually accepted UPWARD.
    //
    // Distinct from `updatedAt`, which every write to this row bumps — including
    // hydration-only syncs, which post to /health/sync with no steps at all.
    // Step-rate validation needs "time since we last took steps", not "time since
    // anything touched this row": using updatedAt made a legitimate sync carrying
    // hours of walking look like an impossible burst if a water log happened to
    // land seconds earlier, and it let a client reset the rate window at will just
    // by syncing more often.
    lastStepIncreaseAt: { type: Date, default: null },

    // ── The last raw figure from ANY stream ─────────────────────────────────
    //
    // Not cadence state any more — that lives per stream in `cadenceBySource`.
    // These two are kept at the top level because sensorWindowMinutes in the
    // health controller measures a live-sensor figure against the time since the
    // client, whichever path it used, last said anything at all.
    //
    // Rows written before the per-stream split also carry the old streak fields
    // here (lastIncomingDelta, repeatedDeltaCount, cadenceStreak, ...). They are
    // no longer read or written; a day that straddled the deploy simply starts
    // its per-stream histories from that sync.
    lastIncomingSteps: { type: Number, default: null },
    lastIncomingAt: { type: Date, default: null },

    // ── Cadence tracking, per client stream ─────────────────────────────────
    //
    // Keyed by cadenceSourceKey() of the X-Client-Source header — the Android
    // foreground service, the widget worker and the app each get their own
    // history, so the two paths one phone syncs through cannot erase each
    // other's evidence by interleaving. See cadenceStateSchema above.
    cadenceBySource: { type: Map, of: cadenceStateSchema, default: undefined },

    // ── The day-wide hold ───────────────────────────────────────────────────
    //
    // Which stream's stuck verdict is currently holding the day, since when,
    // and how many raw client steps have been set aside on this day because
    // they arrived while it was held. Every later raw figure — from any stream
    // — is read net of `stuckForfeit`, so the steps a stuck stream reported are
    // never counted even after it starts measuring again. Written on the row
    // rather than kept implicit so an admin can see what was refused and
    // credit it back if the hold was wrong. See resolveDayHold in
    // stepValidation.js.
    stuckSource: { type: String, default: null },
    stuckSince: { type: Date, default: null },
    stuckForfeit: { type: Number, default: 0 },

    // ── The day's sample totals, for matching against other accounts ────────
    //
    // Every sample any stream produced today — the raw total and when it
    // arrived — pushed on each sync that was one, oldest dropped past
    // MAX_SAMPLE_TOTALS. The same figures already sit inside `cadenceBySource`,
    // but under a per-stream key that cannot be indexed generically; this flat
    // copy exists so {date, sampleTotals.at, sampleTotals.total} can be. It is
    // what lets one sync ask "who else posted near this total at this moment
    // today?" with an index hit rather than a scan of every row for the date.
    // See utils/sharedStepSource.js.
    sampleTotals: {
      type: [
        new mongoose.Schema(
          {
            total: { type: Number, required: true },
            at: { type: Date, required: true },
            source: { type: String, default: null },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },

    // ── One counter, several accounts ───────────────────────────────────────
    //
    // Set when this day's totals matched another account's at the same
    // moments — see sharedStepSource.js for what counts as a match. Written on
    // BOTH rows, so either account's day says who the other was. `sharedHeld`
    // is true on the newer account only: that is the one whose steps are
    // refused, and once true it stays true for the day, so the hold does not
    // depend on the older account continuing to post.
    sharedWith: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    sharedMatches: { type: Number, default: 0 },
    sharedSince: { type: Date, default: null },
    sharedHeld: { type: Boolean, default: false },

    // Whether the one-off retroactive step-goal bonus has been paid for this
    // date. Separate from the watermark because the goal bonus is a flat amount
    // awarded once, not a function of the step count.
    retroGoalCoinAwarded: { type: Boolean, default: false },

    // ── Which client build produced this day's numbers ───────────────────────
    //
    // Recorded per-day, not just per-user, because the user-level snapshot only
    // says what they run NOW. When a step-counting bug is fixed and shipped, the
    // question is always "was this particular day's data produced before or
    // after the fix?" — and the per-user field cannot answer it once they have
    // updated. `syncVersions` keeps every distinct build that wrote to the day,
    // so a day straddling an update is visible as such.
    lastSync: {
      appVersion: { type: String, default: null },
      buildNumber: { type: Number, default: null },
      platform: { type: String, default: null },
      // 'app' (JS), 'native_service' (Android foreground service),
      // 'worker' (widget / EOD WorkManager), or null for pre-telemetry builds.
      source: { type: String, default: null },
      at: { type: Date, default: null },
    },
    // Distinct app versions that contributed to this row, in first-seen order.
    // Left empty by builds that send no version headers — which is itself the
    // signal that the device has not taken the update.
    syncVersions: { type: [String], default: [] },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// One record per user per day
healthActivitySchema.index({ user: 1, date: 1 }, { unique: true });

// "Which other rows on this date have a sample at this moment, near this
// total?" — the shared-counter read in sharedStepSource.js, once per sample.
// Multikey over the array, both fields of the same element so an $elemMatch
// can bound both; the date prefix keeps it to one day's rows. (An earlier
// build indexed {date, sampleTotals.total} alone; that index can be dropped.)
healthActivitySchema.index({ date: 1, 'sampleTotals.at': 1, 'sampleTotals.total': 1 });

module.exports = mongoose.model('HealthActivity', healthActivitySchema);
