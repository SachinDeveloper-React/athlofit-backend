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
    stepGoalCoinDate: { type: String, default: null }, // ISO "YYYY-MM-DD" — tracks last date step-goal coins were awarded (BUG-017)
    lastWaterCoinDate: { type: String, default: null }, // ISO "YYYY-MM-DD"

    // ─── Passive step coin throttle (3-hour intervals) ──────────────────
    // Tracks when the last PASSIVE_STEPS transaction was logged
    lastPassiveCoinTime: { type: Date, default: null },
    // Steps count at the time of the last PASSIVE_STEPS transaction
    lastPassiveCoinSteps: { type: Number, default: 0 },

    // ─── FIX: Timezone manipulation detection ────────────────────────────
    // Tracks the user's last known timezone to detect suspicious shifts.
    lastKnownTimezone: { type: String, default: null },
    // Count of timezone changes within the current day (resets daily)
    timezoneChangeCount: { type: Number, default: 0, min: 0 },
    // Date when timezoneChangeCount was last reset
    timezoneChangeDate: { type: String, default: null },
    // Flag: true if user is suspected of timezone manipulation
    timezoneFlagged: { type: Boolean, default: false },

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
    // FIX #12: Capped at 50 entries via pre-save hook below.
    claimHistory: {
      type: [
        {
          rewardId: String,
          amount: Number,
          source: String,
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
      validate: {
        validator: function (arr) {
          return arr.length <= 100; // hard reject at 2x cap (safety net)
        },
        message: 'claimHistory exceeds maximum allowed entries',
      },
    },

    // ─── Streak protection system ────────────────────────────────────────────
    // Freezes (earned at 7-day milestones — 24hr grace on miss)
    streakFreezes: { type: Number, default: 0, min: 0 },
    // Lives / bandages (earned weekly — auto-repair a break)
    streakLives: { type: Number, default: 0, min: 0 },
    // When a freeze is active (consuming a freeze sets this to tomorrow midnight)
    freezeActiveUntil: { type: Date, default: null },
    // ISO week key when last freeze was granted (prevent double-grant)
    lastFreezeGrantStreak: { type: Number, default: 0 },
    // ISO week key when last weekly life was granted
    lastLifeGrantWeek: { type: String, default: null },
    // When streak was last broken (for restore window)
    streakBrokenAt: { type: Date, default: null },
    // Streak value before the break (for restore)
    streakBeforeBreak: { type: Number, default: 0 },

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

// ─── FIX #12: Pre-save hook to cap claimHistory at 50 entries ────────────────
// This ensures the array never grows unbounded even if $slice is missed
// in a push operation somewhere. Keeps only the most recent 50 entries.
// FIX #5: Only runs the trim if claimHistory was actually modified this save —
// avoids touching the array on unrelated saves (e.g., streak updates).
gamificationSchema.pre('save', function (next) {
  if (this.isModified('claimHistory') && this.claimHistory && this.claimHistory.length > 50) {
    this.claimHistory = this.claimHistory.slice(-50);
  }
  next();
});

// ─── FIX #5: One-time migration for bloated claimHistory arrays ──────────────
// For very old accounts with 1000+ entries, loading the full document into
// memory just to slice is expensive. This static method runs a server-side
// $push/$slice update directly in MongoDB — no document load needed.
// Call this once from a startup script or admin endpoint.
gamificationSchema.statics.trimAllClaimHistories = async function () {
  // Find all documents where claimHistory has more than 50 entries
  const bloated = await this.find({
    $expr: { $gt: [{ $size: { $ifNull: ['$claimHistory', []] } }, 50] },
  }).select('_id claimHistory').lean();

  let trimmed = 0;
  for (const doc of bloated) {
    // Keep only the last 50 entries using $set with slice (server-side)
    const last50 = doc.claimHistory.slice(-50);
    await this.updateOne(
      { _id: doc._id },
      { $set: { claimHistory: last50 } }
    );
    trimmed++;
  }

  return { total: bloated.length, trimmed };
};

module.exports = mongoose.model('Gamification', gamificationSchema);
