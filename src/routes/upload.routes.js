// src/routes/upload.routes.js
const express = require('express');
const router = express.Router();
const { uploadImage } = require('../controllers/upload.controller');
const { protect, adminOnly } = require('../middleware/auth.middleware');
const { imageUpload } = require('../middleware/upload.middleware');

// Admin-only generic image upload (returns { url })
router.post('/image', protect, adminOnly, imageUpload.single('image'), uploadImage);

module.exports = router;
