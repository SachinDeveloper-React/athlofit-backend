// src/cron.js
// ─── Scheduled tasks (runs inside the Node process on EC2) ───────────────────
// Imported once from server.js after DB connects. Uses node-cron.

const cron = require('node-cron');
const Gamification = require('./models/Gamification.model');
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

// ─── Start the schedules ─────────────────────────────────────────────────────
function startCronJobs() {
  // Daily at 00:30 IST
  cron.schedule('30 0 * * *', () => {
    evaluateStreaks().catch((err) => console.error('[CRON] evaluateStreaks failed:', err.message));
  }, { timezone: 'Asia/Kolkata' });

  // Weekly Monday at 00:45 IST
  cron.schedule('45 0 * * 1', () => {
    grantWeeklyLives().catch((err) => console.error('[CRON] grantWeeklyLives failed:', err.message));
  }, { timezone: 'Asia/Kolkata' });

  console.log('⏰ Cron jobs scheduled (IST): streak evaluation @00:30 daily, weekly lives @00:45 Monday');
}

module.exports = { startCronJobs, evaluateStreaks, grantWeeklyLives };
