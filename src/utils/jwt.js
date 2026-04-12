// src/utils/jwt.js
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const RefreshToken = require('../models/RefreshToken.model');

// ─── Generate tokens ──────────────────────────────────────────────────────────

const generateAccessToken = (userId) => {
  return jwt.sign(
    { sub: userId, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
};

const generateRefreshTokenString = () => uuidv4();

// ─── Save refresh token to DB ─────────────────────────────────────────────────

const saveRefreshToken = async (userId, ip, userAgent) => {
  const token = generateRefreshTokenString();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await RefreshToken.create({ token, user: userId, expiresAt, ip, userAgent });

  return token;
};

// ─── Verify access token ──────────────────────────────────────────────────────

const verifyAccessToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};

// ─── Rotate refresh token ─────────────────────────────────────────────────────

const rotateRefreshToken = async (oldToken, ip, userAgent) => {
  const stored = await RefreshToken.findOne({ token: oldToken, revoked: false });

  if (!stored || stored.expiresAt < new Date()) {
    if (stored) {
      // Revoke all tokens for this user (token reuse detected)
      await RefreshToken.updateMany({ user: stored.user }, { revoked: true });
    }
    return null;
  }

  // Revoke old token
  stored.revoked = true;
  await stored.save();

  // Issue new one
  const newToken = await saveRefreshToken(stored.user, ip, userAgent);
  const accessToken = generateAccessToken(stored.user.toString());

  return { accessToken, refreshToken: newToken, userId: stored.user };
};

// ─── Revoke all user tokens ───────────────────────────────────────────────────

const revokeAllUserTokens = async (userId) => {
  await RefreshToken.updateMany({ user: userId }, { revoked: true });
};

module.exports = {
  generateAccessToken,
  saveRefreshToken,
  verifyAccessToken,
  rotateRefreshToken,
  revokeAllUserTokens,
};
