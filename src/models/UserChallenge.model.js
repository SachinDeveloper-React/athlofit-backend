// src/models/UserChallenge.model.js
// Tracks each user's progress on each challenge for the current period.
const mongoose = require('mongoose');

const userChallengeSchema = new mongoose.Schema(
  {
    user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    challenge: { type: mongoose.Schema.Types.ObjectId, ref: 'Challenge', required: true },

    // "2024-04-19" for daily, "2024-W16" for weekly
    periodKey: { type: String, required: true },

    currentValue: { type: Number, default: 0 },
    isCompleted:  { type: Boolean, default: false },
    completedAt:  { type: Date, default: null },
    isRewarded:   { type: Boolean, default: false },  // fully paid — locked
    rewardedAt:   { type: Date, default: null },

    // Coins actually credited for this challenge, which is not always its full
    // `coinReward`: the daily coin ceiling can pay out only part of it.
    //
    // Without this the award was all-or-nothing and `isRewarded` was set either
    // way, so a challenge completed after the day's allowance ran out was marked
    // paid while crediting nothing — the reward destroyed rather than deferred.
    // Recording what was paid lets a later sync in the same period top it up, and
    // makes `isRewarded` mean "fully paid" rather than "we looked at it once".
    rewardedAmount: { type: Number, default: 0, min: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  },
);

// One record per user per challenge per period
userChallengeSchema.index({ user: 1, challenge: 1, periodKey: 1 }, { unique: true });

module.exports = mongoose.model('UserChallenge', userChallengeSchema);
