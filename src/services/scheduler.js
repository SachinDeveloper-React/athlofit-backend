// src/services/scheduler.js
//
// Centralized cron scheduler for background jobs.
// Call startScheduler() once after the DB connection is established.

const cron = require('node-cron');
const { detectUninstalledUsers } = require('./uninstallDetection.service');
const { cleanupInactiveSessions } = require('./inactivityCleanup.service');

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

  console.log('[Scheduler] Cron jobs registered:');
  console.log('  • Uninstall detection — every 6 hours');
  console.log('  • Inactivity cleanup  — daily at 3:00 AM');
}

module.exports = { startScheduler };
