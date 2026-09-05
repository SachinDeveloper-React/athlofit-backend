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

    // ── Rate-invariance streak ──────────────────────────────────────────────
    //
    // The second stuck-source detector. Testing deltas for exact equality turned
    // out to be a threshold an attacker steps over by adding ±1.5% of noise, so
    // the general form of the same question — has steps/min stopped varying? —
    // is tracked alongside it. See STUCK_RATE_TOLERANCE in stepValidation.js.
    //
    // `lastIncomingAt` is what makes a rate computable at all: the raw totals
    // were already followed across syncs, but nothing recorded WHEN, so there
    // was no divisor. It follows lastIncomingSteps exactly — the raw client
    // figure, not the stored one — for the same reason that field does.
    //
    // Min and max rather than a reference rate, so the band is a spread over the
    // streak and does not depend on which sample happened to start it.
    lastIncomingAt: { type: Date, default: null },
    cadenceStreak: { type: Number, default: 0 },
    cadenceRateMin: { type: Number, default: null },
    cadenceRateMax: { type: Number, default: null },
    cadenceStreakAt: { type: Date, default: null },

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
