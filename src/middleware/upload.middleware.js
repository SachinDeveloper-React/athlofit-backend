// src/middleware/upload.middleware.js
// ─── Shared multer configuration for image uploads ──────────────────────────
// Memory storage (buffers go straight to S3/Cloudinary), 8 MB limit, images only.

const multer = require('multer');

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

module.exports = { imageUpload };
