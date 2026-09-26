// src/models/PendingCoin.model.js
//
// Step coins that have been earned but not yet paid.
//
// With `features.stepCoinSettlement` on, every award that depends on steps —
// passive step coins, the daily step-goal bonus, and challenges measured in
// steps, distance, calories or active minutes — is computed exactly as before,
// with the same caps and the same idempotency markers, but is written here
// instead of to the balance. Once the day it belongs to is over, the
// settlement job (crons/stepCoinSettlement.js) looks at the whole day, decides
// how much of it was measurement, and moves what was into the balance.
//
// Why a day at a time and not as the steps arrive: a machine moving a phone is
// only recognisable across many syncs, and live the account had already been
// paid by the time the pattern was clear. With the whole day in view the
// pattern is plain from its first window. See utils/stepCoinSettlement.js.
//
// One row per award, carrying everything the settlement needs to judge it
// later — the step range it paid for, the goal it met, the challenge target —
// so a later change to a goal, a rate or a challenge cannot change what an
// earlier day is judged against.

const mongoose = require('mongoose');

const pendingCoinSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // The activity date these coins were earned for — "YYYY-MM-DD", the same
    // key HealthActivity uses. Not necessarily the day the row was written: a
    // past date re-synced after midnight is recorded against that past date.
    date: { type: String, required: true },

    // The CoinTransaction source the coins are logged under once paid.
    source: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    description: { type: String, required: true },

    metadata: {
      // Passive coins: the step range this award paid for.
      steps: Number,
      previousSteps: Number,
      stepDelta: Number,
      // Step-goal bonus: the goal it was awarded against.
      goal: Number,
      // Challenges: what was met, so the verdict does not depend on the
      // challenge document still saying the same thing later.
      rewardId: String,
      challengeId: mongoose.Schema.Types.ObjectId,
      challengeType: String,
      criteriaType: String,
      targetValue: Number,
      periodKey: String,
      weekStart: String,
      daysAgo: Number,
      trigger: String,
    },

    status: {
      type: String,
      enum: ['pending', 'settled', 'refused'],
      default: 'pending',
    },
    // What was actually paid — the whole amount, part of it, or nothing.
    settledAmount: { type: Number, default: 0, min: 0 },
    // Why anything was held back. Null when paid in full.
    reason: { type: String, default: null },
    settledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The settlement job's sweep, and the per-user pending total.
pendingCoinSchema.index({ status: 1, date: 1 });
pendingCoinSchema.index({ user: 1, status: 1, date: 1 });

module.exports = mongoose.model('PendingCoin', pendingCoinSchema);
