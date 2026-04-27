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
  createAchievement,
  getAdvancedAchievements,
  claimAdvancedAchievement,
  adminGetBadges,
  adminCreateBadge,
  adminUpdateBadge,
  adminDeleteBadge,
} = require('../controllers/gamification.controller');
const { protect } = require('../middleware/auth.middleware');

// All routes require auth
router.use(protect);

// GET /gamification/me  — GamificationState (balance, streak etc.)
router.get('/me', getGamification);

// GET /gamification/streaks  — StreaksResponseData (with dynamic badge defs from DB)
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

// ─── Advanced Achievements ────────────────────────────────────────────────────

// POST /gamification/admin/achievements  — Admin: create/update achievement
router.post('/admin/achievements', createAchievement);

// GET /gamification/achievements  — Get all achievements and user progress
router.get('/achievements', getAdvancedAchievements);

// POST /gamification/achievements/claim  — Claim a completed achievement
router.post('/achievements/claim', claimAdvancedAchievement);

// ─── Admin: Badge Definitions CRUD ───────────────────────────────────────────

// GET  /gamification/admin/badges        — list all badge definitions
router.get('/admin/badges', adminGetBadges);

// POST /gamification/admin/badges        — create a badge definition
router.post('/admin/badges', adminCreateBadge);

// PUT  /gamification/admin/badges/:id    — update a badge definition
router.put('/admin/badges/:id', adminUpdateBadge);

// DELETE /gamification/admin/badges/:id  — soft-delete (deactivate) a badge
router.delete('/admin/badges/:id', adminDeleteBadge);

module.exports = router;