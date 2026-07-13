// src/routes/cron.routes.js
const express = require('express');
const router = express.Router();
const { evaluateStreaks, grantWeeklyLives, applyPendingGoals } = require('../controllers/cron.controller');
const { distributePassiveCoins } = require('../crons/passiveCoinDistribution');

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

module.exports = router;
