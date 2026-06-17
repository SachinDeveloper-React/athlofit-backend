// src/utils/uploadImage.js
// ─── Unified image upload helper ─────────────────────────────────────────────
// Uploads to S3 when configured, otherwise falls back to Cloudinary so uploads
// keep working in local dev without AWS keys. Used by every endpoint that
// accepts image files (avatars, products, blogs, generic admin uploads).

const { uploadToS3, deleteFromS3, isS3Configured } = require('./s3');
const { uploadBuffer } = require('./cloudinary');

/**
 * Upload a single image buffer and return its public URL.
 * @param {object} file - multer file object ({ buffer, originalname, mimetype })
 * @param {string} folder - logical folder/prefix (e.g. 'products', 'blogs', 'avatars')
 * @param {object} [options]
 * @param {boolean} [options.faceCrop=false] - Cloudinary fallback only: crop to a
 *        400x400 face square (use true for avatars).
 * @param {string} [options.publicId] - Cloudinary fallback only: deterministic id.
 * @returns {Promise<string>} public URL
 */
async function uploadImage(file, folder = 'misc', options = {}) {
  if (!file || !file.buffer) throw new Error('No image file provided');

  if (isS3Configured()) {
    return uploadToS3(file.buffer, file.originalname, file.mimetype, folder);
  }

  // Cloudinary fallback
  const { faceCrop = false, publicId } = options;
  return uploadBuffer(file.buffer, `athlofit/${folder}`, publicId, { faceCrop });
}

/**
 * Upload multiple image buffers in parallel; returns an array of URLs.
 * @param {object[]} files - array of multer file objects
 * @param {string} folder
 * @returns {Promise<string[]>}
 */
async function uploadImages(files = [], folder = 'misc') {
  if (!files.length) return [];
  return Promise.all(files.map((f) => uploadImage(f, folder)));
}

/**
 * Best-effort delete of an S3-hosted image by URL (no-op for Cloudinary URLs).
 */
async function deleteImage(url) {
  if (isS3Configured()) {
    await deleteFromS3(url);
  }
  // Cloudinary cleanup intentionally skipped (no destroy wired); harmless.
}

module.exports = { uploadImage, uploadImages, deleteImage };
