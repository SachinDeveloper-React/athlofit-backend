// src/utils/cloudinary.js
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a file buffer to Cloudinary.
 * @param {Buffer} buffer  - File buffer from multer memoryStorage
 * @param {string} folder  - Cloudinary folder (e.g. 'athlofit/avatars')
 * @param {string} publicId - Optional public_id (e.g. userId for deterministic URL)
 * @returns {Promise<string>} Secure URL of the uploaded image
 */
function uploadBuffer(buffer, folder, publicId) {
  return new Promise((resolve, reject) => {
    const opts = {
      folder,
      resource_type: 'image',
      transformation: [
        { width: 400, height: 400, crop: 'fill', gravity: 'face' },
        { quality: 'auto', fetch_format: 'auto' },
      ],
    };
    if (publicId) opts.public_id = publicId;

    const stream = cloudinary.uploader.upload_stream(opts, (err, result) => {
      if (err) return reject(err);
      resolve(result.secure_url);
    });

    stream.end(buffer);
  });
}

module.exports = { uploadBuffer };
