// src/crons/inactivityNudge.js
// ─── Push notification nudge for users who haven't synced in 24h+ ────────────
//
// Runs daily at 8:00 PM IST. Identifies users who:
//   1. Have a valid FCM token (push enabled)
//   2. Have NOT synced health data in the last 24 hours
//   3. Have NOT already been nudged today (prevents spam)
//
// Sends a push notification encouraging them to open the app and sync steps
// so they don't miss out on coin rewards.

const cron = require('node-cron');
const User = require('../models/User.model');
const HealthActivity = require('../models/HealthActivity.model');
const { todayISO } = require('../utils/date');
const { createNotification } = require('../utils/createNotification');

// ─── Nudge messages (randomly picked for variety) ────────────────────────────

const NUDGE_MESSAGES = [
  {
    title: '👟 Tumhare steps pending hain!',
    message: 'Aaj ke steps abhi tak sync nahi hue. App open karo aur apne coins claim karo!',
  },
  {
    title: '🪙 Coins miss mat karo!',
    message: 'Tumne kal se app open nahi ki. Sync karo aur apne earned coins le jao!',
  },
  {
    title: '🔥 Streak ka khayal rakho!',
    message: 'App open karke steps sync karo — tumhari streak safe rahe aur coins bhi milein!',
  },
  {
    title: '💪 Steps walk kiye? Coins lo!',
    message: 'Tumhare steps waiting me hain. Open the app to claim your rewards!',
  },
];

// ─── Core nudge function ─────────────────────────────────────────────────────

async function sendInactivityNudges() {
  const today = todayISO();
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Find users who:
  // - Have FCM token (push enabled)
  // - Were last active more than 24h ago
  // - Haven't been nudged today (using lastNudgeDate in Notification collection)
  const eligibleUsers = await User.find({
    fcmToken: { $ne: null },
    notificationsEnabled: true,
    lastActiveAt: { $lt: twentyFourHoursAgo },
  })
    .select('_id lastActiveAt')
    .limit(500) // batch limit to prevent overwhelming FCM
    .lean();

  if (eligibleUsers.length === 0) {
    console.log(`[CRON:Nudge] No inactive users to nudge for ${today}.`);
    return { date: today, nudged: 0, skipped: 0 };
  }

  let nudged = 0;
  let skipped = 0;

  for (const user of eligibleUsers) {
    try {
      // Check if this user has today's health activity (means they synced recently)
      const todayActivity = await HealthActivity.findOne({
        user: user._id,
        date: today,
      }).select('_id').lean();

      // If they already have today's activity, skip (they synced via background)
      if (todayActivity) {
        skipped++;
        continue;
      }

      // Check if we already nudged this user today (prevent spam)
      const Notification = require('../models/Notification.model');
      const alreadyNudged = await Notification.findOne({
        user: user._id,
        type: 'COIN',
        title: { $in: NUDGE_MESSAGES.map(m => m.title) },
        createdAt: { $gte: new Date(today + 'T00:00:00.000Z') },
      }).select('_id').lean();

      if (alreadyNudged) {
        skipped++;
        continue;
      }

      // Pick a random nudge message
      const msg = NUDGE_MESSAGES[Math.floor(Math.random() * NUDGE_MESSAGES.length)];

      await createNotification(user._id, {
        type: 'COIN',
        title: msg.title,
        message: msg.message,
        data: { screen: 'Tracker' },
      });

      nudged++;
    } catch (err) {
      console.warn(`[CRON:Nudge] Error nudging user ${user._id}:`, err.message);
    }
  }

  console.log(
    `[CRON:Nudge] Done — ${nudged} users nudged, ${skipped} skipped (already synced/nudged today)`
  );

  return { date: today, nudged, skipped, totalChecked: eligibleUsers.length };
}

// ─── Schedule the cron job ───────────────────────────────────────────────────

function startInactivityNudgeCron() {
  // Daily at 8:00 PM IST — good time when users are likely to check their phone
  cron.schedule('0 20 * * *', () => {
    console.log('[CRON:Nudge] Running daily inactivity nudge...');
    sendInactivityNudges().catch(err =>
      console.error('[CRON:Nudge] Job failed:', err.message)
    );
  }, { timezone: 'Asia/Kolkata' });

  console.log('⏰ Inactivity nudge cron scheduled (IST): daily at 20:00');
}

module.exports = { startInactivityNudgeCron, sendInactivityNudges };
