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

// Advanced Achievements API
const {
  createAchievement,
  getAdvancedAchievements,
  claimAdvancedAchievement,
} = require('../controllers/gamification.controller');

// POST /gamification/admin/achievements  — Admin route to create an achievement
router.post('/admin/achievements', createAchievement);

// GET /gamification/achievements  — Get all achievements and progress
router.get('/achievements', getAdvancedAchievements);

// POST /gamification/achievements/claim  — Claim a completed achievement
router.post('/achievements/claim', claimAdvancedAchievement);

module.exports = router;