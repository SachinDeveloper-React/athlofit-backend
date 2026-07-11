// src/cron.js
// ─── Scheduled tasks (runs inside the Node process on EC2) ───────────────────
// Imported once from server.js after DB connects. Uses node-cron.

const cron = require('node-cron');
const Gamification = require('./models/Gamification.model');
const User = require('./models/User.model');
const { todayISO, daysBetween } = require('./utils/date');
const { getStreakConfig, attemptProtect, isoWeekKey } = require('./utils/streak');
const { createNotification } = require('./utils/createNotification');

function yesterdayOf(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// ─── 1. Evaluate streaks — daily at 00:30 IST ────────────────────────────────
async function evaluateStreaks() {
  const today = todayISO();
  const cfg = await getStreakConfig();
  let processed = 0, broken = 0, protectedCount = 0;

  const cursor = Gamification.find({
    streakDays: { $gt: 0 },
    lastActiveDate: { $ne: null },
  }).cursor();

  for (let gam = await cursor.next(); gam != null; gam = await cursor.next()) {
    const gap = daysBetween(gam.lastActiveDate, today);
    if (gap == null || gap < 2) continue;

    processed++;
    const result = attemptProtect(gam, cfg);

    if (result.protected) {
      protectedCount++;
      gam.lastActiveDate = yesterdayOf(today);
      await gam.save();

      createNotification(gam.user, {
        type: 'STREAK',
        title: result.method === 'life' ? '🩹 Streak Saved!' : '🧊 Streak Frozen!',
        message: result.method === 'life'
          ? 'A streak life was used. Walk today to keep it going!'
          : 'Your streak freeze kicked in! Get moving today.',
        data: { screen: 'Tracker' },
      });
    } else {
      broken++;
      await gam.save();

      createNotification(gam.user, {
        type: 'STREAK',
        title: "💪 Start fresh!",
        message: 'Your streak ended, but every step counts. Start a new one today!',
        data: { screen: 'Tracker' },
      });
    }
  }

  console.log(`[CRON] Streaks evaluated: ${processed} checked, ${protectedCount} protected, ${broken} broken`);
}

// ─── 2. Grant weekly lives — every Monday at 00:45 IST ───────────────────────
async function grantWeeklyLives() {
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

  console.log(`[CRON] Weekly lives granted: ${granted} users (week ${thisWeek})`);
}

// ─── 3. Apply pending step goals — daily at 00:05 IST ────────────────────────
async function applyPendingGoals() {
  const today = todayISO();
  const result = await User.updateMany(
    {
      pendingStepGoal: { $ne: null },
      pendingGoalEffectiveDate: { $lte: today },
    },
    [
      {
        $set: {
          dailyStepGoal: '$pendingStepGoal',
          pendingStepGoal: null,
          pendingGoalEffectiveDate: null,
        },
      },
    ],
  );
  console.log(`[CRON] Pending goals applied: ${result.modifiedCount || 0} users (date ${today})`);
}

// ─── Start the schedules ─────────────────────────────────────────────────────
function startCronJobs() {
  // Daily at 00:30 IST — evaluate streaks
  cron.schedule('30 0 * * *', () => {
    evaluateStreaks().catch((err) => console.error('[CRON] evaluateStreaks failed:', err.message));
  }, { timezone: 'Asia/Kolkata' });

  // Weekly Monday at 00:45 IST — grant weekly lives
  cron.schedule('45 0 * * 1', () => {
    grantWeeklyLives().catch((err) => console.error('[CRON] grantWeeklyLives failed:', err.message));
  }, { timezone: 'Asia/Kolkata' });

  // Daily at 00:05 IST — apply pending step goal changes
  cron.schedule('5 0 * * *', () => {
    applyPendingGoals().catch((err) => console.error('[CRON] applyPendingGoals failed:', err.message));
  }, { timezone: 'Asia/Kolkata' });

  console.log('⏰ Cron jobs scheduled (IST): streaks @00:30, lives @Mon 00:45, goals @00:05');
}

module.exports = { startCronJobs, evaluateStreaks, grantWeeklyLives, applyPendingGoals };
