// src/services/scheduler.js
//
// Centralized cron scheduler for background jobs.
// Call startScheduler() once after the DB connection is established.

const cron = require('node-cron');
const { detectUninstalledUsers } = require('./uninstallDetection.service');
const { cleanupInactiveSessions } = require('./inactivityCleanup.service');
const { sendInactivityNudges } = require('../crons/inactivityNudge');
const { processAccountDeletions } = require('../crons/accountDeletion');
const { settleStepCoins } = require('../crons/stepCoinSettlement');

function startScheduler() {
  // ─── Uninstall Detection ────────────────────────────────────────────────────
  // Runs every 6 hours — sends silent pushes to verify FCM tokens.
  cron.schedule('0 */6 * * *', async () => {
    console.log('[Scheduler] Running uninstall detection job...');
    try {
      const result = await detectUninstalledUsers();
      console.log('[Scheduler] Uninstall detection complete:', result);
    } catch (err) {
      console.error('[Scheduler] Uninstall detection failed:', err.message);
    }
  });

  // ─── Inactivity Session Cleanup ─────────────────────────────────────────────
  // Runs once daily at 3:00 AM — revokes sessions for inactive users.
  cron.schedule('0 3 * * *', async () => {
    console.log('[Scheduler] Running inactivity cleanup job...');
    try {
      const result = await cleanupInactiveSessions();
      console.log('[Scheduler] Inactivity cleanup complete:', result);
    } catch (err) {
      console.error('[Scheduler] Inactivity cleanup failed:', err.message);
    }
  });

  // ─── Inactivity Nudge ──────────────────────────────────────────────────────
  // Runs daily at 8:00 PM IST — pushes notification to users who haven't
  // synced in 24h+ to encourage them to open the app and claim coins.
  cron.schedule('0 20 * * *', async () => {
    console.log('[Scheduler] Running inactivity nudge job...');
    try {
      const result = await sendInactivityNudges();
      console.log('[Scheduler] Inactivity nudge complete:', result);
    } catch (err) {
      console.error('[Scheduler] Inactivity nudge failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  // ─── Account deletion execution ────────────────────────────────────────────
  // Runs daily at 4:00 AM IST — purges accounts whose 30-day grace period has
  // expired. Scheduled here rather than left to the external crontab because
  // this one is a legal obligation (Play Store data-deletion policy, DPDP Act):
  // it has to run whether or not someone remembers to add a crontab line.
  //
  // 4 AM sits after the 3 AM session cleanup and well clear of the midnight
  // step/streak jobs, so a large purge batch cannot contend with them.
  cron.schedule('0 4 * * *', async () => {
    console.log('[Scheduler] Running account deletion job...');
    try {
      const result = await processAccountDeletions();
      console.log('[Scheduler] Account deletion complete:', {
        processed: result.processed,
        purged: result.purged,
        blocked: result.blocked,
        failed: result.failed,
      });
    } catch (err) {
      console.error('[Scheduler] Account deletion failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  // ─── Step-coin settlement ──────────────────────────────────────────────────
  // Runs at 3:30 AM IST — paying yesterday's step coins once the day is over
  // and has been verified as a whole: late enough that the last syncs of the
  // day have landed, early enough that users wake up to their coins — and
  // again every six hours after, so a phone that was offline overnight and
  // delivers a past day later is paid the same day it syncs, not the next
  // morning. Each run only looks at dates before today and at awards still
  // pending, so the extra runs are no-ops unless something arrived.
  // See crons/stepCoinSettlement.js.
  cron.schedule('30 3,9,15,21 * * *', async () => {
    console.log('[Scheduler] Running step-coin settlement...');
    try {
      await settleStepCoins();
    } catch (err) {
      console.error('[Scheduler] Step-coin settlement failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });

  console.log('[Scheduler] Cron jobs registered:');
  console.log('  • Uninstall detection — every 6 hours');
  console.log('  • Inactivity cleanup  — daily at 3:00 AM');
  console.log('  • Inactivity nudge    — daily at 8:00 PM IST');
  console.log('  • Account deletion    — daily at 4:00 AM IST');
  console.log('  • Step-coin settlement — 3:30 AM IST, then every 6 hours');
}

module.exports = { startScheduler };
