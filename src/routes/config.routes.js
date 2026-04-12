const express = require('express');
const router = express.Router();
const { getTerms, getPrivacy, submitSupport, getAppConfig, getFaqs } = require('../controllers/config.controller');

// GET /config/app  (public — bootstraps coin rate, features, step goals)
router.get('/app', getAppConfig);


// GET /config/terms
router.get('/terms', getTerms);

// GET /config/privacy
router.get('/privacy', getPrivacy);

// POST /config/support
router.post('/support', submitSupport);

// GET /config/faqs
router.get('/faqs', getFaqs);

module.exports = router;
