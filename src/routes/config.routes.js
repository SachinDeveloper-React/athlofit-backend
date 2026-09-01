// src/routes/config.routes.js
const express = require('express');
const router = express.Router();
const {
  getAppConfig,
  updateAppConfig,
  getCoinEconomy,
  getTerms,
  updateTerms,
  getPrivacy,
  updatePrivacy,
  getLegalList,
  getLegalByType,
  updateLegalByType,
  submitSupport,
  getFaqs,
  adminCreateFaq,
  adminUpdateFaq,
  adminDeleteFaq,
  adminGetTickets,
  adminUpdateTicket,
  checkVersion,
} = require('../controllers/config.controller');
const { protect, adminOnly } = require('../middleware/auth.middleware');

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/app',     getAppConfig);
router.get('/check-version', checkVersion);
router.get('/terms',   getTerms);
router.get('/privacy', getPrivacy);
router.get('/faqs',    getFaqs);
router.get('/legal',       getLegalList);
router.get('/legal/:type', getLegalByType);

// Support — optionally authenticated (attaches user ID if logged in)
router.post('/support', (req, res, next) => {
  // Try to attach user if token present, but don't block unauthenticated users
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return protect(req, res, () => submitSupport(req, res, next));
  }
  return submitSupport(req, res, next);
});

// ── Admin only ────────────────────────────────────────────────────────────────
// What a day of rewards can actually pay at the current settings, so the
// admin panel can size the caps against live content instead of guessing.
router.get('/coin-economy', protect, adminOnly, getCoinEconomy);
router.patch('/app',    protect, adminOnly, updateAppConfig);
router.put('/terms',    protect, adminOnly, updateTerms);
router.put('/privacy',  protect, adminOnly, updatePrivacy);
router.put('/legal/:type', protect, adminOnly, updateLegalByType);

// FAQ admin CRUD
router.post('/admin/faqs',        protect, adminOnly, adminCreateFaq);
router.put('/admin/faqs/:id',     protect, adminOnly, adminUpdateFaq);
router.delete('/admin/faqs/:id',  protect, adminOnly, adminDeleteFaq);

// Support ticket management
router.get('/admin/support-tickets',       protect, adminOnly, adminGetTickets);
router.patch('/admin/support-tickets/:id', protect, adminOnly, adminUpdateTicket);

module.exports = router;
