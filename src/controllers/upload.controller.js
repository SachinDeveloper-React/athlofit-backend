// src/controllers/upload.controller.js
// ─── Generic admin image upload → S3 (fallback to Cloudinary if S3 absent) ───

const { success, error } = require('../utils/response');
const { uploadImage } = require('../utils/uploadImage');

// Allowed logical folders to keep the bucket organized + prevent abuse.
const ALLOWED_FOLDERS = ['products', 'blogs', 'avatars', 'categories', 'misc'];

// ─── POST /upload/image ───────────────────────────────────────────────────────
// Multipart form-data: field "image" + optional "folder"
const uploadImageHandler = async (req, res, next) => {
  try {
    if (!req.file) return error(res, 'No image file provided', 400);

    const folderInput = (req.body.folder || 'misc').toLowerCase();
    const folder = ALLOWED_FOLDERS.includes(folderInput) ? folderInput : 'misc';

    const url = await uploadImage(req.file, folder, {
      faceCrop: folder === 'avatars',
    });

    return success(res, 'Image uploaded', { url });
  } catch (err) {
    next(err);
  }
};

module.exports = { uploadImage: uploadImageHandler };
