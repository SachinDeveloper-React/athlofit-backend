// src/routes/upload.routes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { uploadImage } = require('../controllers/upload.controller');
const { protect, adminOnly } = require('../middleware/auth.middleware');

// multer — memory storage, 8 MB limit, images only
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// Admin-only image upload
router.post('/image', protect, adminOnly, imageUpload.single('image'), uploadImage);

module.exports = router;
