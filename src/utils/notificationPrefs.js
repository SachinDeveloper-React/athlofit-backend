// src/utils/notificationPrefs.js
//
// Single source of truth for notification categories and per-user preferences.
//
// ── Why categories live here and not in the model ───────────────────────────
//
// They used to live only in the Notification schema's enum, and the codebase
// drifted away from it: STREAK, GENERAL and SUPPORT were being passed to
// createNotification while none of them were valid enum values. Mongoose
// rejected the write, createNotification swallowed the error in its catch, and
// because the push is sent AFTER the create, the push never fired either. Every
// streak notification, the account-ban notice and support-ticket replies were
// silently dead — no in-app record, no push, no error anyone would see.
//
// With the list defined once and imported by both the schema and the
// preference logic, adding a category to one and not the other is no longer
// possible.

/**
 * Categories a user may switch off individually.
 * The key is the preference field name; the value is the notification type.
 */
const TOGGLEABLE = {
  goal: 'GOAL',
  hydration: 'HYDRATION',
  streak: 'STREAK',
  challenge: 'CHALLENGE',
  coin: 'COIN',
  product: 'PRODUCT',
  heart: 'HEART',
};

/**
 * Categories that cannot be switched off individually.
 *
 * These carry things the user needs to know to understand their own account:
 * step tracking being paused, a deletion request, a ban, a reply to a support
 * ticket they opened. Letting someone mute the daily nudges but keep these is
 * the point of having categories at all — before this, one boolean meant
 * silencing spam also silenced the step-pause notice, which is how a user ends
 * up staring at a frozen step count with no idea why.
 *
 * The master switch still governs them: a user who turns off notifications
 * entirely gets nothing, which is the honest reading of that choice. They are
 * still persisted in-app either way — see shouldPersist below.
 */
const ALWAYS_ON = ['SECURITY', 'SYSTEM', 'GENERAL', 'SUPPORT'];

/** Every valid notification type. The Notification schema enum reads this. */
const ALL_TYPES = [...Object.values(TOGGLEABLE), ...ALWAYS_ON];

/** Preference field names, for validating an incoming PATCH body. */
const PREF_KEYS = Object.keys(TOGGLEABLE);

/** type → preference key, for the send-time lookup. */
const TYPE_TO_KEY = Object.fromEntries(
  Object.entries(TOGGLEABLE).map(([key, type]) => [type, key]),
);

/**
 * May a push for this notification type be sent to this user?
 *
 * @param {object} user  needs `notificationsEnabled` and `notificationPrefs`
 * @param {string} type  notification type, e.g. 'STREAK'
 */
function isPushAllowed(user, type) {
  // Master switch. Off means off, including for the always-on categories —
  // pretending otherwise would make the setting a lie.
  if (user?.notificationsEnabled === false) return false;

  const key = TYPE_TO_KEY[type];
  // Unknown or always-on type: allowed. Defaulting an unrecognised type to
  // "blocked" would mean a newly added category is silently undeliverable until
  // someone remembers to add a preference for it — the same failure mode as the
  // enum drift this module exists to prevent.
  if (!key) return true;

  // Absent preferences mean "never configured", which is enabled — every user
  // predates this field, and reading absence as off would mute the entire user
  // base on deploy.
  return user?.notificationPrefs?.[key] !== false;
}

/**
 * Should the in-app record be written even when the push is muted?
 *
 * Always yes. Muting a category is about not being interrupted, not about
 * losing the information: the notification list is a pull surface the user
 * opens deliberately, so a muted category should still be there when they look.
 * Kept as a named function rather than an inline `true` so the reasoning has
 * somewhere to live if it is ever revisited.
 */
function shouldPersist() {
  return true;
}

/**
 * Sanitise a PATCH body into a safe $set map.
 *
 * Only known keys, only booleans. Prevents an arbitrary body from writing
 * junk paths into the user document, and silently ignores attempts to toggle an
 * always-on category rather than pretending to honour them.
 */
function buildPrefUpdate(body = {}) {
  const set = {};
  const rejected = [];
  for (const [k, v] of Object.entries(body)) {
    if (!PREF_KEYS.includes(k)) {
      rejected.push(k);
      continue;
    }
    if (typeof v !== 'boolean') {
      rejected.push(k);
      continue;
    }
    set[`notificationPrefs.${k}`] = v;
  }
  return { set, rejected };
}

/** Full preference state for the client, with defaults filled in. */
function readPrefs(user) {
  const prefs = user?.notificationPrefs || {};
  return {
    masterEnabled: user?.notificationsEnabled !== false,
    categories: Object.fromEntries(
      PREF_KEYS.map((k) => [k, prefs[k] !== false]),
    ),
    // Sent so the client can render these as always-on rather than guessing,
    // and so adding a category server-side does not need an app release.
    alwaysOn: ALWAYS_ON,
  };
}

module.exports = {
  TOGGLEABLE,
  ALWAYS_ON,
  ALL_TYPES,
  PREF_KEYS,
  TYPE_TO_KEY,
  isPushAllowed,
  shouldPersist,
  buildPrefUpdate,
  readPrefs,
};
