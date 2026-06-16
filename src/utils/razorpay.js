// src/utils/razorpay.js
// ─── Razorpay client + signature verification helpers ────────────────────────

const crypto = require('crypto');
const Razorpay = require('razorpay');

let instance = null;

// Lazily instantiate the Razorpay client so the app can boot without keys
// (e.g. in environments where payments are disabled).
function getRazorpay() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    return null;
  }
  if (!instance) {
    instance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return instance;
}

// Verify the checkout signature returned to the client after payment.
// Returns true if `razorpay_signature` matches the HMAC of order_id|payment_id.
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!process.env.RAZORPAY_KEY_SECRET) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  // Constant-time comparison to avoid timing attacks
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Verify an incoming webhook payload using the webhook secret.
function verifyWebhookSignature(rawBody, signature) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  getRazorpay,
  verifyPaymentSignature,
  verifyWebhookSignature,
};
