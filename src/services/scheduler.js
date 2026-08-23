// src/services/scheduler.js
//
// Centralized cron scheduler for background jobs.
// Call startScheduler() once after the DB connection is established.

const cron = require('node-cron');
const { detectUninstalledUsers } = require('./uninstallDetection.service');
const { cleanupInactiveSessions } = require('./inactivityCleanup.service');
const { sendInactivityNudges } = require('../crons/inactivityNudge');
const { processAccountDeletions } = require('../crons/accountDeletion');

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

  console.log('[Scheduler] Cron jobs registered:');
  console.log('  • Uninstall detection — every 6 hours');
  console.log('  • Inactivity cleanup  — daily at 3:00 AM');
  console.log('  • Inactivity nudge    — daily at 8:00 PM IST');
  console.log('  • Account deletion    — daily at 4:00 AM IST');
}

module.exports = { startScheduler };
