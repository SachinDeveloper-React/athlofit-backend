// src/routes/challenge.routes.js
const express = require('express');
const router  = express.Router();
const {
  getChallenges,
  getChallengeById,
  getChallengeConfig,
  adminUpsertChallenge,
  adminDeleteChallenge,
  adminGetAllChallenges,
  adminToggleChallenge,
  seedChallenges,
} = require('../controllers/challenge.controller');
const { protect, adminOnly } = require('../middleware/auth.middleware');

router.use(protect);

// Admin (must be before /:id to avoid shadowing)
router.get('/admin/all',       adminOnly, adminGetAllChallenges);
router.patch('/:id/toggle',    adminOnly, adminToggleChallenge);
router.post('/seed',           adminOnly, seedChallenges);
router.post('/',               adminOnly, adminUpsertChallenge);
router.put('/:id',             adminOnly, adminUpsertChallenge);
router.delete('/:id',          adminOnly, adminDeleteChallenge);

// Public
router.get('/config', getChallengeConfig);
router.get('/',       getChallenges);
router.get('/:id',    getChallengeById);

module.exports = router;
