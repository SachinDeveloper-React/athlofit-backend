// src/routes/cron.routes.js
const express = require('express');
const router = express.Router();
const { evaluateStreaks, grantWeeklyLives } = require('../controllers/cron.controller');

// Authorization is handled inside the controller via CRON_SECRET.
// Support both GET (Vercel Cron uses GET) and POST.
router.all('/evaluate-streaks', evaluateStreaks);
router.all('/grant-weekly-lives', grantWeeklyLives);

module.exports = router;
