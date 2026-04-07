// src/models/Gamification.model.js
const mongoose = require('mongoose');

const BADGE_THRESHOLDS = {
  starter: 1,
  consistent: 7,
  finisher: 15,
  elite: 30,
};

const gamificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    coinsBalance: { type: Number, default: 0, min: 0 },
    coinsEarnedToday: { type: Number, default: 0, min: 0 },
    streakDays: { type: Number, default: 0, min: 0 },
    bestStreakDays: { type: Number, default: 0, min: 0 },
    lastActiveDate: { type: String, default: null }, // ISO "YYYY-MM-DD"
    lastCoinDate: { type: String, default: null },    // ISO "YYYY-MM-DD"

    // Track unlock dates for badge history
    badges: {
      starter: { unlocked: { type: Boolean, default: false }, unlockedAt: Date },
      consistent: { unlocked: { type: Boolean, default: false }, unlockedAt: Date },
      finisher: { unlocked: { type: Boolean, default: false }, unlockedAt: Date },
      elite: { unlocked: { type: Boolean, default: false }, unlockedAt: Date },
    },
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

// ─── Virtual: compute streaks badge list (matches app type TrackerBadge[]) ────
gamificationSchema.methods.getBadgeList = function () {
  const badgeMeta = [
    { key: 'starter', title: 'Starter', rule: '1 day' },
    { key: 'consistent', title: 'Consistent', rule: '7 days' },
    { key: 'finisher', title: 'Finisher', rule: '15 days' },
    { key: 'elite', title: 'Elite', rule: '30 days' },
  ];

  return badgeMeta.map(b => ({
    key: b.key,
    title: b.title,
    rule: b.rule,
    unlocked: this.badges[b.key]?.unlocked ?? false,
  }));
};

// ─── Method: compute next badge threshold ─────────────────────────────────────
gamificationSchema.methods.getNextBadgeAt = function () {
  const order = ['starter', 'consistent', 'finisher', 'elite'];
  for (const key of order) {
    if (!this.badges[key]?.unlocked) {
      return BADGE_THRESHOLDS[key];
    }
  }
  return null; // all unlocked
};

// ─── Method: check and award badges based on current streak ───────────────────
gamificationSchema.methods.awardBadges = function () {
  const streak = this.streakDays;
  const now = new Date();

  if (streak >= 1 && !this.badges.starter.unlocked) {
    this.badges.starter.unlocked = true;
    this.badges.starter.unlockedAt = now;
  }
  if (streak >= 7 && !this.badges.consistent.unlocked) {
    this.badges.consistent.unlocked = true;
    this.badges.consistent.unlockedAt = now;
  }
  if (streak >= 15 && !this.badges.finisher.unlocked) {
    this.badges.finisher.unlocked = true;
    this.badges.finisher.unlockedAt = now;
  }
  if (streak >= 30 && !this.badges.elite.unlocked) {
    this.badges.elite.unlocked = true;
    this.badges.elite.unlockedAt = now;
  }
};

module.exports = mongoose.model('Gamification', gamificationSchema);
