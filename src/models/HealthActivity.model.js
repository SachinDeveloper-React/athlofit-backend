// src/models/HealthActivity.model.js
const mongoose = require('mongoose');

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

    // ── Cadence tracking, for recognising a source that has stopped measuring ─
    //
    // These follow the RAW client total rather than the stored one. That
    // distinction is the whole point: once the stuck-source rule binds, the
    // stored total stops moving, so a delta measured against it would start
    // growing and the constant-delta pattern would vanish on the next sync —
    // releasing the guard it had just triggered. Measured against what the
    // client itself last said, the pattern stays visible for as long as the
    // device keeps producing it. See trackClientCadence in stepValidation.js.
    //
    // null (not 0) means "no previous raw total recorded", which is a different
    // state from a client that genuinely reported 0: the first sync of a day and
    // a row written by a build too old to record one both have nothing to
    // measure against, and must not be read as a zero-step baseline.
    lastIncomingSteps: { type: Number, default: null },
    lastIncomingDelta: { type: Number, default: 0 },
    repeatedDeltaCount: { type: Number, default: 0 },

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

module.exports = mongoose.model('HealthActivity', healthActivitySchema);
