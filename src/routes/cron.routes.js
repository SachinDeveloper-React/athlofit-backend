// src/routes/cron.routes.js
const express = require('express');
const router = express.Router();
const { evaluateStreaks, grantWeeklyLives, applyPendingGoals } = require('../controllers/cron.controller');
const { distributePassiveCoins, eodAutoClaimStepGoal } = require('../crons/passiveCoinDistribution');
const { sendInactivityNudges } = require('../crons/inactivityNudge');

// Authorization is handled inside the controller via CRON_SECRET.
// Support both GET (for curl/crontab) and POST.
router.all('/evaluate-streaks', evaluateStreaks);
router.all('/grant-weekly-lives', grantWeeklyLives);
router.all('/apply-pending-goals', applyPendingGoals);

// Passive coin distribution (called every 3h + EOD by system cron)
router.all('/distribute-passive-coins', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const keyParam = req.query?.key;
  if (!secret || (auth !== `Bearer ${secret}` && keyParam !== secret)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const result = await distributePassiveCoins();
    return res.json({ success: true, message: 'Passive coins distributed', data: result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Inactivity nudge — push notification to users who haven't synced in 24h+
router.all('/send-inactivity-nudges', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const keyParam = req.query?.key;
  if (!secret || (auth !== `Bearer ${secret}` && keyParam !== secret)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const result = await sendInactivityNudges();
    return res.json({ success: true, message: 'Inactivity nudges sent', data: result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// EOD step goal auto-claim — awards step goal coins to users who met goal but didn't claim
router.all('/eod-auto-claim-step-goal', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const keyParam = req.query?.key;
  if (!secret || (auth !== `Bearer ${secret}` && keyParam !== secret)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const result = await eodAutoClaimStepGoal();
    return res.json({ success: true, message: 'EOD step goal auto-claim complete', data: result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
