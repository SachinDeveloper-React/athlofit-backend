// src/routes/notification.routes.js
const express = require('express');
const router  = express.Router();
const { sendNotification, getScreens, getTargets } = require('../controllers/notification.controller');
const { protect, adminOnly } = require('../middleware/auth.middleware');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate.middleware');

const sendRules = [
  body('title').notEmpty().withMessage('title is required'),
  body('body').notEmpty().withMessage('body is required'),
  body('type').optional()
    .isIn(['GOAL', 'HYDRATION', 'PRODUCT', 'CHALLENGE', 'COIN', 'SECURITY', 'HEART'])
    .withMessage('Invalid notification type'),
  body('target').optional()
    .isIn(['all','ios','android','user','users','streak','coins','gender','provider','profileComplete','newUsers'])
    .withMessage('Invalid target'),
  body('priority').optional()
    .isIn(['high', 'normal'])
    .withMessage('priority must be high or normal'),
  body('badge').optional()
    .isInt({ min: 0 })
    .withMessage('badge must be a non-negative integer'),
];

router.post('/send',    protect, adminOnly, sendRules, validate, sendNotification);
router.get('/screens',  protect, adminOnly, getScreens);
router.get('/targets',  protect, adminOnly, getTargets);

module.exports = router;
