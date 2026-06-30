// src/utils/notificationTemplates.js
// ─── Resolves admin-configured notification templates with dynamic variables ─

const { getCachedConfig } = require('./configCache');

/**
 * Resolves a notification template by key, replacing {{variables}}.
 * Falls back to hardcoded defaults if the config hasn't been loaded.
 * 
 * @param {string} key - Template key (e.g. 'orderConfirmed', 'stepGoalReached')
 * @param {object} vars - Variables to substitute (e.g. { orderId, coins, goal })
 * @returns {Promise<{ title: string, message: string }>}
 */
async function resolveNotification(key, vars = {}) {
  let title = '';
  let message = '';

  try {
    const cfg = await getCachedConfig();
    const tpl = cfg?.notifications?.[key];
    if (tpl) {
      title = tpl.title || '';
      message = tpl.message || '';
    }
  } catch {
    // Config unavailable — use empty and let fallback below handle it.
  }

  // If no template found in DB, return the vars as-is so the caller can
  // fall back to a hardcoded string.
  if (!title && !message) {
    return null; // signals caller to use its inline default
  }

  // Replace {{variable}} placeholders
  const resolve = (str) =>
    str.replace(/\{\{(\w+)\}\}/g, (_, name) => {
      const val = vars[name];
      return val !== undefined && val !== null ? String(val) : '';
    });

  return {
    title: resolve(title),
    message: resolve(message),
  };
}

module.exports = { resolveNotification };
