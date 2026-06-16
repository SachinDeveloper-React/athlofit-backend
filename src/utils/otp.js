// src/utils/otp.js
const crypto = require('crypto');
const nodemailer = require('nodemailer');

// ─── Generate 6-digit OTP (BUG-005: use crypto.randomInt for cryptographic randomness) ──

const generateOtp = () => {
  // crypto.randomInt(min, max) returns a cryptographically secure integer in [min, max)
  return String(crypto.randomInt(100000, 1000000));
};

// ─── OTP expiry: 10 minutes ───────────────────────────────────────────────────

const getOtpExpiry = () => new Date(Date.now() + 10 * 60 * 1000);

// ─── Mailer transport (BUG-006: created once at module level, not per-send) ──

const _port = Number(process.env.SMTP_PORT) || 587;
// Port 465 uses direct TLS (secure: true).
// Port 587 (and 25) use STARTTLS (secure: false — the library upgrades automatically).
const _secure = _port === 465;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: _port,
  secure: _secure,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Verify SMTP connection on startup (non-blocking)
transporter.verify().then(() => {
  console.log('[SMTP] Mail server connection verified ✓');
}).catch((err) => {
  console.error('[SMTP] ✗ Mail server connection FAILED:', err.message);
  console.error('[SMTP] Check SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env');
});

// ─── Send OTP email ───────────────────────────────────────────────────────────

const sendOtpEmail = async (to, otp, flow) => {
  const subject =
    flow === 'forgot_password'
      ? 'Athlofit – Reset Your Password'
      : 'Athlofit – Verify Your Email';

  const body =
    flow === 'forgot_password'
      ? `<p>Your password reset code is:</p><h2 style="letter-spacing:6px">${otp}</h2><p>This code expires in 10 minutes.</p>`
      : `<p>Welcome to Athlofit! Your verification code is:</p><h2 style="letter-spacing:6px">${otp}</h2><p>This code expires in 10 minutes.</p>`;

  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;border-radius:12px;border:1px solid #eee">
      <h1 style="color:#1a1a1a;font-size:24px">Athlofit 🏃</h1>
      ${body}
      <p style="color:#999;font-size:12px;margin-top:24px">If you didn't request this, please ignore this email.</p>
    </div>`;

 const abc = await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"Athlofit" <noreply@athlofit.com>',
    to,
    subject,
    html,
  });

  console.log("abc", abc);
  
};

module.exports = { generateOtp, getOtpExpiry, sendOtpEmail };
