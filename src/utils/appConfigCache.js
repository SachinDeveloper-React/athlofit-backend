// src/utils/appConfigCache.js
//
// FIX #7: In-memory cache for AppConfig to avoid a DB query on every sync.
//
// AppConfig (key: 'global') stores coin rates, reward values, and feature flags.
// It changes rarely (only when an admin updates it), so reading it from DB on
// every 15-second health sync is wasteful. This module caches it in memory with
// a 5-minute TTL and exposes a getter + invalidation helper.

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _cachedConfig = null;
let _cacheTime = 0;

/**
 * Returns the global AppConfig document, using an in-memory cache.
 * Cache TTL is 5 minutes — after that, the next call re-reads from DB.
 *
 * @returns {Promise<object>} The AppConfig document
 */
async function getCachedAppConfig() {
  const now = Date.now();
  if (_cachedConfig && now - _cacheTime < CACHE_TTL_MS) {
    return _cachedConfig;
  }

  const AppConfig = require('../models/AppConfig.model');
  let cfg = await AppConfig.findOne({ key: 'global' }).lean();
  if (!cfg) {
    cfg = await AppConfig.create({ key: 'global' });
    cfg = cfg.toObject();
  }

  _cachedConfig = cfg;
  _cacheTime = now;
  return _cachedConfig;
}

/**
 * Invalidates the cache. Call this when an admin updates AppConfig
 * (e.g., in admin.controller.js after a config save).
 */
function invalidateAppConfigCache() {
  _cachedConfig = null;
  _cacheTime = 0;
}

module.exports = { getCachedAppConfig, invalidateAppConfigCache };
