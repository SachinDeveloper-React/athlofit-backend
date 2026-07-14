// src/utils/streak.js
// ─── Streak protection: freeze, life, break, restore logic ───────────────────
// Called during health-sync / daily evaluation to decide whether to break
// or protect the streak. Also exposes a restore handler.

const AppConfig = require('../models/AppConfig.model');
const { logCoinTransaction } = require('./logCoinTransaction');

// Get the streak config (sensible defaults if DB not seeded).
async function getStreakConfig() {
  const cfg = await AppConfig.findOne({ key: 'global' });
  return {
    freezeEarnEvery: cfg?.streak?.freezeEarnEvery ?? 7,
    maxFreezes: cfg?.streak?.maxFreezes ?? 2,
    freezeGraceHours: cfg?.streak?.freezeGraceHours ?? 24,
    lifeEarnIntervalDays: cfg?.streak?.lifeEarnIntervalDays ?? 7,
    maxLives: cfg?.streak?.maxLives ?? 2,
    restoreCostCoins: cfg?.streak?.restoreCostCoins ?? 100,
    restoreWindowHours: cfg?.streak?.restoreWindowHours ?? 48,
  };
}

// ISO week key in IST (e.g. "2026-W25")
function isoWeekKey() {
  const { isoWeekKeyIST } = require('./date');
  return isoWeekKeyIST();
}

/**
 * Grant streak milestones (freezes + weekly lives) after a successful day.
 * Call this AFTER the streak has been incremented.
 * Mutates `gam` in place but does NOT save — caller must save.
 */
function grantProtections(gam, cfg) {
  // Freeze: grant 1 each time streak crosses a multiple of freezeEarnEvery.
  // After a streak break, lastFreezeGrantStreak may be higher than the current
  // streak — reset it so the user can earn freezes on the new streak too.
  if (cfg.freezeEarnEvery > 0) {
    // Reset tracking if the streak was broken and restarted
    if ((gam.lastFreezeGrantStreak || 0) > gam.streakDays) {
      gam.lastFreezeGrantStreak = 0;
    }
    const milestonesReached = Math.floor(gam.streakDays / cfg.freezeEarnEvery);
    const lastGranted = Math.floor((gam.lastFreezeGrantStreak || 0) / cfg.freezeEarnEvery);
    if (milestonesReached > lastGranted) {
      const toGrant = milestonesReached - lastGranted;
      gam.streakFreezes = Math.min((gam.streakFreezes || 0) + toGrant, cfg.maxFreezes);
      gam.lastFreezeGrantStreak = gam.streakDays;
    }
  }

  // Weekly life: grant 1 per calendar week (prevent double-grant in same week).
  const thisWeek = isoWeekKey();
  if (gam.lastLifeGrantWeek !== thisWeek) {
    gam.streakLives = Math.min((gam.streakLives || 0) + 1, cfg.maxLives);
    gam.lastLifeGrantWeek = thisWeek;
  }
}

/**
 * Called when a streak break is ABOUT to happen (user missed the goal yesterday).
 * Returns { protected: true/false, method?: 'freeze'|'life', ... }
 * If protected, the streak is NOT broken. Mutates `gam` in place — caller saves.
 */
function attemptProtect(gam, cfg) {
  const now = new Date();

  // 1. If a freeze is already active and hasn't expired, streak is protected.
  if (gam.freezeActiveUntil && gam.freezeActiveUntil > now) {
    return { protected: true, method: 'freeze_active' };
  }

  // 2. Try to consume a stored freeze (gives 24hr grace).
  if ((gam.streakFreezes || 0) > 0) {
    gam.streakFreezes -= 1;
    const graceEnd = new Date(now.getTime() + (cfg.freezeGraceHours || 24) * 60 * 60 * 1000);
    gam.freezeActiveUntil = graceEnd;
    return { protected: true, method: 'freeze', graceUntil: graceEnd };
  }

  // 3. Try to auto-apply a life/bandage.
  if ((gam.streakLives || 0) > 0) {
    gam.streakLives -= 1;
    return { protected: true, method: 'life' };
  }

  // 4. No protection available — streak breaks.
  gam.streakBeforeBreak = gam.streakDays;
  gam.streakBrokenAt = now;
  gam.streakDays = 0;
  gam.freezeActiveUntil = null;
  gam.lastFreezeGrantStreak = 0; // reset so new streak can earn freezes
  return { protected: false };
}

/**
 * Restore a broken streak by paying coins.
 * Returns { success, message, ... } — does NOT save gam (caller does).
 */
function restoreStreak(gam, cfg) {
  const now = new Date();

  if (!gam.streakBrokenAt) {
    return { success: false, message: 'Streak is not broken — nothing to restore.' };
  }

  const msElapsed = now.getTime() - new Date(gam.streakBrokenAt).getTime();
  const windowMs = (cfg.restoreWindowHours || 48) * 60 * 60 * 1000;
  if (msElapsed > windowMs) {
    return { success: false, message: 'Restore window expired. Start a new streak!' };
  }

  const cost = cfg.restoreCostCoins || 100;
  if ((gam.coinsBalance || 0) < cost) {
    return { success: false, message: `Not enough coins. Restore costs ${cost} coins.` };
  }

  // Deduct coins and restore streak.
  gam.coinsBalance = Math.round(gam.coinsBalance - cost);
  gam.streakDays = gam.streakBeforeBreak || 1;
  gam.streakBrokenAt = null;
  gam.streakBeforeBreak = 0;

  return { success: true, cost, restoredTo: gam.streakDays };
}

module.exports = { getStreakConfig, grantProtections, attemptProtect, restoreStreak, isoWeekKey };
