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

/**
 * Apply one goal-met day to the streak.
 *
 * ── The streak cursor only ever moves FORWARD ────────────────────────────────
 *
 * This is the whole reason the transition lives here as one function instead of
 * inline in the sync handler: without the guard below the streak inflates
 * without bound, and the path that does it is completely routine traffic.
 *
 * Both sync workers backfill the last seven days on every run — the Android
 * WidgetUpdateWorker every 15 minutes, the JS background fetch alongside it —
 * posting one POST /health/sync per day, oldest first, each carrying an explicit
 * past `date`. Every one of those days whose goal was met reaches this function.
 *
 * So a batch that reopens at `today - 6` while `lastActiveDate` is already
 * `today` read as a six-day GAP. attemptProtect() spent a freeze, which sets
 * `freezeActiveUntil = now + 24h`; from then on its first branch protected every
 * later rewind for free — no break, nothing consumed. The rewind therefore only
 * moved the cursor back to `today - 6`, and the five days that followed in the
 * same batch each looked consecutive and added +1. Net +6 per batch, ~96 batches
 * a day, and grantProtections() handed back a fresh freeze each time the streak
 * crossed another multiple of seven, so the loop refuelled itself. That is how
 * an account reached a 1,057-day streak on an app not remotely that old.
 *
 * Requiring a strictly later date makes an increment cost a new calendar day,
 * which is the invariant a "day streak" actually encodes. A backfilled day that
 * is still ahead of the cursor — yesterday's goal met but never synced — is
 * unaffected and extends the streak normally.
 *
 * Mutates `gam` in place; the caller saves.
 *
 * @param {object} gam    Gamification document.
 * @param {string} date   "YYYY-MM-DD" of the goal-met day being applied.
 * @param {object} cfg    getStreakConfig() result.
 * @returns {{changed: boolean, broke: boolean, protectedBy: string|null}}
 *   `changed` false means the day was a repeat or a rewind and nothing moved.
 */
function advanceStreak(gam, date, cfg) {
  const { isConsecutiveDay } = require('./date');
  const unchanged = { changed: false, broke: false, protectedBy: null };

  if (gam.lastActiveDate && date <= gam.lastActiveDate) return unchanged;

  let result;
  if (!gam.lastActiveDate) {
    // First-ever sync, or lastActiveDate was cleared — preserve any existing
    // streak rather than resetting it, and just start tracking from here.
    gam.lastActiveDate = date;
    if (!gam.streakDays) gam.streakDays = 1;
    result = { changed: true, broke: false, protectedBy: null };
  } else if (isConsecutiveDay(gam.lastActiveDate, date)) {
    gam.streakDays += 1;
    gam.lastActiveDate = date;
    grantProtections(gam, cfg);
    result = { changed: true, broke: false, protectedBy: null };
  } else {
    // A real gap — the user missed at least one whole day. Spend a freeze or a
    // life before breaking.
    const protection = attemptProtect(gam, cfg);
    gam.lastActiveDate = date;
    if (!protection.protected) {
      // attemptProtect already zeroed streakDays; this day starts the new one.
      gam.streakDays = 1;
    }
    result = {
      changed: true,
      broke: !protection.protected,
      protectedBy: protection.method || null,
    };
  }

  if (gam.streakDays > (gam.bestStreakDays || 0)) {
    gam.bestStreakDays = gam.streakDays;
  }
  return result;
}

module.exports = { getStreakConfig, grantProtections, attemptProtect, advanceStreak, restoreStreak, isoWeekKey };
