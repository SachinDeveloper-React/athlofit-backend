// src/utils/configCache.js
// ─── In-memory cache for the global AppConfig document ───────────────────────
// The config is read on almost every request (coin rates, caps, features).
// Caching it for a short TTL cuts a DB round-trip per request while still
// reflecting admin changes within the TTL window.

const AppConfig = require('../models/AppConfig.model');

let cached = null;
let cachedAt = 0;
const TTL_MS = 60 * 1000; // 60 seconds

/**
 * Returns the global AppConfig doc, cached for 60s.
 * @param {boolean} force - bypass the cache and refetch
 */
async function getCachedConfig(force = false) {
  const now = Date.now();
  if (!force && cached && now - cachedAt < TTL_MS) {
    return cached;
  }
  let cfg = await AppConfig.findOne({ key: 'global' });
  if (!cfg) cfg = await AppConfig.create({ key: 'global' });
  cached = cfg;
  cachedAt = now;
  return cfg;
}

/**
 * Invalidate the cache — call after the admin updates config.
 */
function invalidateConfigCache() {
  cached = null;
  cachedAt = 0;
}

module.exports = { getCachedConfig, invalidateConfigCache };
