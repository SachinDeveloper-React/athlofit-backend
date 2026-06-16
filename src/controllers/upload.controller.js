// src/controllers/upload.controller.js
// ─── Generic admin image upload → S3 (fallback to Cloudinary if S3 absent) ───

const { success, error } = require('../utils/response');
const { uploadToS3, isS3Configured } = require('../utils/s3');
const { uploadBuffer } = require('../utils/cloudinary');

// Allowed logical folders to keep the bucket organized + prevent abuse.
const ALLOWED_FOLDERS = ['products', 'blogs', 'misc'];

// ─── POST /upload/image ───────────────────────────────────────────────────────
// Multipart form-data: field "image" + optional "folder" (products|blogs|misc)
const uploadImage = async (req, res, next) => {
  try {
    if (!req.file) return error(res, 'No image file provided', 400);

    const folderInput = (req.body.folder || 'misc').toLowerCase();
    const folder = ALLOWED_FOLDERS.includes(folderInput) ? folderInput : 'misc';

    let url;
    if (isS3Configured()) {
      url = await uploadToS3(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        folder,
      );
    } else {
      // Graceful fallback so uploads still work in dev without S3 keys.
      url = await uploadBuffer(req.file.buffer, `athlofit/${folder}`);
    }

    return success(res, 'Image uploaded', { url });
  } catch (err) {
    next(err);
  }
};

module.exports = { uploadImage };
