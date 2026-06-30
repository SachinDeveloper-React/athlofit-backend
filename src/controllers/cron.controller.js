// src/controllers/cron.controller.js
// ─── Scheduled streak evaluation ─────────────────────────────────────────────
// Runs daily (via Vercel Cron) to break/protect streaks for users who did NOT
// open the app. Without this, a missed day is only processed on the next sync.

const Gamification = require('../models/Gamification.model');
const { success, error } = require('../utils/response');
const { todayISO, daysBetween } = require('../utils/date');
const { getStreakConfig, attemptProtect } = require('../utils/streak');
const { createNotification } = require('../utils/createNotification');

// Returns yesterday's date string (IST) relative to a given ISO date.
function yesterdayOf(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// Verify the request came from the scheduler (or an admin) via a shared secret.
function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // must be configured
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${secret}`) return true;
  // Also allow ?key= for manual triggering / other schedulers
  if (req.query?.key && req.query.key === secret) return true;
  return false;
}

// ─── GET/POST /cron/evaluate-streaks ─────────────────────────────────────────
const evaluateStreaks = async (req, res, next) => {
  try {
    if (!isAuthorized(req)) {
      return error(res, 'Unauthorized', 401);
    }

    const today = todayISO();
    const cfg = await getStreakConfig();

    let processed = 0;
    let broken = 0;
    let protectedCount = 0;

    // Only users with an active streak who have a recorded last-active date.
    // A streak is "at risk" only if they missed a FULL day:
    //   daysBetween(lastActiveDate, today) >= 2  →  yesterday was entirely missed.
    // (== 1 means yesterday was their last active day; they still have today.)
    const cursor = Gamification.find({
      streakDays: { $gt: 0 },
      lastActiveDate: { $ne: null },
    }).cursor();

    for (let gam = await cursor.next(); gam != null; gam = await cursor.next()) {
      const gap = daysBetween(gam.lastActiveDate, today);
      if (gap == null || gap < 2) continue; // not at risk yet

      processed++;
      const result = attemptProtect(gam, cfg);

      if (result.protected) {
        protectedCount++;
        // Advance lastActiveDate to yesterday so the covered day isn't
        // re-processed tomorrow. Streak stays intact; if the user syncs today
        // the streak continues normally (yesterday → today is consecutive).
        gam.lastActiveDate = yesterdayOf(today);
        await gam.save();

        createNotification(gam.user, {
          type: 'STREAK',
          title: result.method === 'life' ? '🩹 Streak Saved!' : '🧊 Streak Frozen!',
          message: result.method === 'life'
            ? 'We used one of your streak lives to keep your streak alive. Walk today to keep it going!'
            : 'Your streak freeze kicked in — you have a grace day. Get moving today!',
          data: { screen: 'Tracker' },
        });
      } else {
        broken++;
        await gam.save(); // attemptProtect already reset streakDays to 0

        createNotification(gam.user, {
          type: 'STREAK',
          title: "💪 Your streak ended — start fresh!",
          message: 'You missed a day and your streak reset. No worries — every step counts. Start a new streak today!',
          data: { screen: 'Tracker' },
        });
      }
    }

    return success(res, 'Streak evaluation complete', {
      date: today,
      processed,
      protected: protectedCount,
      broken,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET/POST /cron/grant-weekly-lives ───────────────────────────────────────
// Optional: ensure every active user gets their weekly life even without syncing.
const grantWeeklyLives = async (req, res, next) => {
  try {
    if (!isAuthorized(req)) return error(res, 'Unauthorized', 401);

    const { isoWeekKey } = require('../utils/streak');
    const cfg = await getStreakConfig();
    const thisWeek = isoWeekKey();
    let granted = 0;

    const cursor = Gamification.find({
      lastLifeGrantWeek: { $ne: thisWeek },
    }).cursor();

    for (let gam = await cursor.next(); gam != null; gam = await cursor.next()) {
      gam.streakLives = Math.min((gam.streakLives || 0) + 1, cfg.maxLives);
      gam.lastLifeGrantWeek = thisWeek;
      await gam.save();
      granted++;
    }

    return success(res, 'Weekly lives granted', { week: thisWeek, granted });
  } catch (err) {
    next(err);
  }
};

module.exports = { evaluateStreaks, grantWeeklyLives };
