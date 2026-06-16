// src/utils/s3.js
// ─── Amazon S3 upload helper for admin image uploads ─────────────────────────

const crypto = require('crypto');
const path = require('path');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

let client = null;

// Lazily build the S3 client so the app boots even if S3 isn't configured.
function getClient() {
  if (!process.env.AWS_S3_BUCKET || !process.env.AWS_REGION) return null;
  if (!client) {
    client = new S3Client({
      region: process.env.AWS_REGION,
      // If running on AWS with an IAM role, credentials can be omitted.
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
  }
  return client;
}

function isS3Configured() {
  return !!(process.env.AWS_S3_BUCKET && process.env.AWS_REGION);
}

// Builds the public URL for an uploaded object.
// Prefers a CDN/custom domain when AWS_S3_PUBLIC_URL is set.
function buildPublicUrl(key) {
  const base = process.env.AWS_S3_PUBLIC_URL;
  if (base) return `${base.replace(/\/$/, '')}/${key}`;
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION;
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Uploads a file buffer to S3 and returns its public URL.
 * @param {Buffer} buffer
 * @param {string} originalName - original filename (for extension)
 * @param {string} mimetype
 * @param {string} folder - logical folder/prefix, e.g. 'products' | 'blogs'
 * @returns {Promise<string>} public URL
 */
async function uploadToS3(buffer, originalName, mimetype, folder = 'uploads') {
  const s3 = getClient();
  if (!s3) throw new Error('S3 is not configured');

  const ext = (path.extname(originalName || '') || '.jpg').toLowerCase();
  const safeFolder = folder.replace(/[^a-z0-9/_-]/gi, '');
  const key = `${safeFolder}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype || 'application/octet-stream',
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );

  return buildPublicUrl(key);
}

/**
 * Deletes an object from S3 given its public URL (best-effort).
 */
async function deleteFromS3(url) {
  const s3 = getClient();
  if (!s3 || !url) return;
  try {
    // Derive the key from the URL
    const base = process.env.AWS_S3_PUBLIC_URL
      ? process.env.AWS_S3_PUBLIC_URL.replace(/\/$/, '')
      : `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;
    if (!url.startsWith(base)) return;
    const key = url.slice(base.length + 1);
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: key }));
  } catch (err) {
    console.error('S3 delete failed:', err.message);
  }
}

module.exports = { uploadToS3, deleteFromS3, isS3Configured };
