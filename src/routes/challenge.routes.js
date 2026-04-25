// src/routes/challenge.routes.js
const express = require('express');
const router  = express.Router();
const {
  getChallenges,
  getChallengeById,
  getChallengeConfig,
  adminUpsertChallenge,
  adminDeleteChallenge,
  seedChallenges,
} = require('../controllers/challenge.controller');
const { protect, adminOnly } = require('../middleware/auth.middleware');

router.use(protect);

router.get('/config', getChallengeConfig);   // must be before /:id
router.get('/',       getChallenges);
router.get('/:id',    getChallengeById);

// Admin
router.post('/seed',  adminOnly, seedChallenges);
router.post('/',      adminOnly, adminUpsertChallenge);
router.put('/:id',    adminOnly, adminUpsertChallenge);
router.delete('/:id', adminOnly, adminDeleteChallenge);

module.exports = router;
