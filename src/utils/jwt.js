
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const RefreshToken = require("../models/RefreshToken.model");

// ─── Generate tokens ──────────────────────────────────────────────────────────

const generateAccessToken = (userId) => {
  return jwt.sign({ sub: userId, type: "access" }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "30d",
  });
};

const generateRefreshTokenString = () => uuidv4();

// ─── Save refresh token to DB ─────────────────────────────────────────────────

const parseMs = (val = '90d') => {
  const n = parseInt(val, 10);
  if (val.endsWith('d'))  return n * 24 * 60 * 60 * 1000;
  if (val.endsWith('h'))  return n * 60 * 60 * 1000;
  if (val.endsWith('m'))  return n * 60 * 1000;
  if (val.endsWith('s'))  return n * 1000;
  return n; // raw ms
};

const saveRefreshToken = async (userId, ip, userAgent, absoluteExpiresAt = null) => {
  const token = generateRefreshTokenString();
  const ttlMs = parseMs(process.env.JWT_REFRESH_EXPIRES_IN || '90d');
  const now = Date.now();

  // absoluteExpiresAt is the hard session deadline — set once at login and
  // carried forward unchanged during every rotation. This ensures the session
  // expires at a fixed point in time regardless of how often the token is used.
  const absExpiry = absoluteExpiresAt ?? new Date(now + ttlMs);

  // expiresAt is the rolling window — each rotation gives a short window
  // (same as TTL) but capped at the absolute deadline.
  const rollingExpiry = new Date(Math.min(now + ttlMs, absExpiry.getTime()));

  await RefreshToken.create({
    token,
    user: userId,
    expiresAt: rollingExpiry,
    absoluteExpiresAt: absExpiry,
    ip,
    userAgent,
  });

  return token;
};

// ─── Verify access token ──────────────────────────────────────────────────────

const verifyAccessToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};

// ─── Rotate refresh token ─────────────────────────────────────────────────────

const rotateRefreshToken = async (oldToken, ip, userAgent) => {
  const stored = await RefreshToken.findOne({
    token: oldToken,
    revoked: false,
  });

  const now = new Date();

  if (!stored || stored.expiresAt < now) {
    if (stored) {
      // Revoke all tokens for this user (token reuse detected or expired)
      await RefreshToken.updateMany({ user: stored.user }, { revoked: true });
    }
    return null;
  }

  // Hard session deadline check — if the absolute expiry has passed,
  // the session is over regardless of the rolling window.
  if (stored.absoluteExpiresAt && stored.absoluteExpiresAt < now) {
    await RefreshToken.updateMany({ user: stored.user }, { revoked: true });
    return null;
  }

  // Revoke old token
  stored.revoked = true;
  await stored.save();

  // Issue new token — carry the original absoluteExpiresAt forward unchanged
  const newToken = await saveRefreshToken(
    stored.user,
    ip,
    userAgent,
    stored.absoluteExpiresAt ?? null,
  );
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
