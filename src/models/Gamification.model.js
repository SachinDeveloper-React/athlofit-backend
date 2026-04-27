// src/models/Gamification.model.js
const mongoose = require('mongoose');

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
    lastWaterCoinDate: { type: String, default: null }, // ISO "YYYY-MM-DD"

    // ─── Dynamic badges array (keys match BadgeDefinition.key) ──────────────
    // Replaces the old fixed-key object { starter, consistent, finisher, elite }
    badgeList: [
      {
        key: { type: String, required: true },
        unlocked: { type: Boolean, default: false },
        unlockedAt: { type: Date, default: null },
      },
    ],

    // ─── Legacy field kept for one-time migration detection ─────────────────
    // We detect if "badges" (old object) exists and migrate to badgeList once.
    badges: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },

    // Transactional log of claimed rewards (Water, Streaks, Daily Goals)
    claimHistory: [
      {
        rewardId: String,
        amount: Number,
        source: String,
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // Track advanced achievements that the user has claimed
    claimedAchievements: [
      {
        achievementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Achievement' },
        claimedAt: { type: Date, default: Date.now },
      },
    ],
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

// ─── Migration helper ─────────────────────────────────────────────────────────
// Detects old fixed-key badges object and migrates values into the new badgeList array.
gamificationSchema.methods.migrateOldBadges = function () {
  // Old structure had top-level badges.starter, badges.consistent, etc.
  const OLD_KEYS = ['starter', 'consistent', 'finisher', 'elite'];
  const oldBadges = this.badges;
  if (!oldBadges || typeof oldBadges !== 'object') return;

  // Check if it has the old fixed-key shape
  const hasOldShape = OLD_KEYS.some(k => oldBadges[k] !== undefined);
  if (!hasOldShape) return;

  // Copy unlock states to new badgeList
  for (const key of OLD_KEYS) {
    const existing = this.badgeList.find(b => b.key === key);
    const oldEntry = oldBadges[key];
    if (!oldEntry) continue;

    if (existing) {
      // Keep highest-trust value (old wins if unlocked)
      if (oldEntry.unlocked && !existing.unlocked) {
        existing.unlocked = true;
        existing.unlockedAt = oldEntry.unlockedAt || new Date();
      }
    } else {
      this.badgeList.push({
        key,
        unlocked: oldEntry.unlocked ?? false,
        unlockedAt: oldEntry.unlockedAt ?? null,
      });
    }
  }

  // Nullify old field after migration
  this.badges = undefined;
};

// ─── Build badge list for API response ───────────────────────────────────────
// badgeDefs: BadgeDefinition[] sorted by `order`
gamificationSchema.methods.getBadgeList = function (badgeDefs) {
  return badgeDefs.map(def => {
    const entry = this.badgeList.find(b => b.key === def.key);
    return {
      key: def.key,
      title: def.title,
      rule: def.rule,
      emoji: def.emoji,
      color: def.color,
      threshold: def.threshold,
      coinReward: def.coinReward,
      unlocked: entry?.unlocked ?? false,
      unlockedAt: entry?.unlockedAt ?? null,
    };
  });
};

// ─── Next badge threshold ─────────────────────────────────────────────────────
// badgeDefs: BadgeDefinition[] sorted by `order`
gamificationSchema.methods.getNextBadgeAt = function (badgeDefs) {
  for (const def of badgeDefs) {
    const entry = this.badgeList.find(b => b.key === def.key);
    if (!entry?.unlocked) {
      return def.threshold;
    }
  }
  return null; // all unlocked
};

// ─── Award badges based on current streakDays ─────────────────────────────────
// badgeDefs: BadgeDefinition[] sorted by `order`
gamificationSchema.methods.awardBadges = function (badgeDefs) {
  const streak = this.streakDays;
  const now = new Date();

  for (const def of badgeDefs) {
    if (streak < def.threshold) continue;

    let entry = this.badgeList.find(b => b.key === def.key);
    if (!entry) {
      this.badgeList.push({ key: def.key, unlocked: false, unlockedAt: null });
      entry = this.badgeList[this.badgeList.length - 1];
    }

    if (!entry.unlocked) {
      entry.unlocked = true;
      entry.unlockedAt = now;
    }
  }
};

// ─── Check if a specific badge key is unlocked ───────────────────────────────
gamificationSchema.methods.isBadgeUnlocked = function (key) {
  return this.badgeList.find(b => b.key === key)?.unlocked ?? false;
};

// ─── Unlock a specific badge key ─────────────────────────────────────────────
gamificationSchema.methods.unlockBadge = function (key) {
  let entry = this.badgeList.find(b => b.key === key);
  if (!entry) {
    this.badgeList.push({ key, unlocked: true, unlockedAt: new Date() });
  } else if (!entry.unlocked) {
    entry.unlocked = true;
    entry.unlockedAt = new Date();
  }
};

module.exports = mongoose.model('Gamification', gamificationSchema);
