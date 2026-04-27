// src/utils/otp.js
const crypto = require('crypto');
const nodemailer = require('nodemailer');

// ─── Generate 6-digit OTP ─────────────────────────────────────────────────────

const generateOtp = () => {
  return String(Math.floor(100000 + Math.random() * 900000));
};

// ─── OTP expiry: 10 minutes ───────────────────────────────────────────────────

const getOtpExpiry = () => new Date(Date.now() + 10 * 60 * 1000);

// ─── Mailer transport ─────────────────────────────────────────────────────────

const createTransport = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    debug: true, // 👈 ADD THIS
    logger: true, // 👈 ADD THIS
  });
};

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

  const transporter = createTransport();

  await transporter.verify();
  console.log('✅ SMTP ready');

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"Athlofit" <noreply@athlofit.com>',
    to,
    subject,
    html,
  });
};

module.exports = { generateOtp, getOtpExpiry, sendOtpEmail };
