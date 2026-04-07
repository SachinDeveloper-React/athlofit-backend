// src/routes/gamification.routes.js
const express = require('express');
const router = express.Router();
const {
  getGamification,
  getStreaks,
  syncGamification,
  earnCoins,
  getLeaderboard,
  getCoinData,
  claimReward,
} = require('../controllers/gamification.controller');
const { protect } = require('../middleware/auth.middleware');

// All routes require auth
router.use(protect);

// GET /gamification/me  — GamificationState (balance, streak etc.)
router.get('/me', getGamification);

// GET /gamification/streaks  — StreaksResponseData
router.get('/streaks', getStreaks);

// POST /gamification/sync  — sync local state to server
router.post('/sync', syncGamification);

// POST /gamification/coins/earn  — award coins for completing a step goal
router.post('/coins/earn', earnCoins);

// GET /gamification/coins/data  — full CoinData (balance, transactions, claimable)
router.get('/coins/data', getCoinData);

// POST /gamification/coins/claim  — claim a specific reward by id
router.post('/coins/claim', claimReward);

// GET /gamification/leaderboard
router.get('/leaderboard', getLeaderboard);

module.exports = router;