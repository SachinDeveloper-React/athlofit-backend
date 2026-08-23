// Two failure modes are pinned here, both silent in manual testing.
//
// 1. Enum/category drift. STREAK, GENERAL and SUPPORT were being sent while
//    none were valid enum values, so Mongoose rejected the write,
//    createNotification swallowed it, and — because the push fires after the
//    create — no push went out either. Streak notifications, the ban notice and
//    support replies were all dead with nothing in any log but a console.warn.
// 2. Default direction. Reading an absent preference as "off" would mute every
//    existing user on deploy.

const {
  ALL_TYPES,
  ALWAYS_ON,
  PREF_KEYS,
  TOGGLEABLE,
  isPushAllowed,
  buildPrefUpdate,
  readPrefs,
} = require('../utils/notificationPrefs');

describe('category list', () => {
  it('covers every type the codebase actually sends', () => {
    // Grepped from the createNotification call sites. If a new one is added
    // without a category, this is the test that catches it before the write
    // starts failing silently in production.
    const inUse = ['GOAL', 'HYDRATION', 'PRODUCT', 'SECURITY', 'HEART',
                   'CHALLENGE', 'COIN', 'SYSTEM', 'STREAK', 'GENERAL', 'SUPPORT'];
    for (const t of inUse) expect(ALL_TYPES).toContain(t);
  });

  it('has no type in both the toggleable and always-on lists', () => {
    // A type in both would be togglable and claimed un-togglable at once, and
    // which one won would depend on lookup order.
    for (const type of Object.values(TOGGLEABLE)) {
      expect(ALWAYS_ON).not.toContain(type);
    }
  });

  it('keeps account-critical categories un-mutable', () => {
    // The whole point of categories: muting nudges must not also mute the
    // step-tracking-paused notice, which is what one boolean did.
    for (const t of ['SECURITY', 'SYSTEM', 'GENERAL', 'SUPPORT']) {
      expect(ALWAYS_ON).toContain(t);
      expect(Object.values(TOGGLEABLE)).not.toContain(t);
    }
  });
});

describe('isPushAllowed', () => {
  const on = { notificationsEnabled: true };

  it('allows everything for a user who predates the field', () => {
    for (const t of ALL_TYPES) expect(isPushAllowed(on, t)).toBe(true);
    expect(isPushAllowed({}, 'COIN')).toBe(true);
  });

  it('blocks only the muted category', () => {
    const u = { notificationsEnabled: true, notificationPrefs: { coin: false } };
    expect(isPushAllowed(u, 'COIN')).toBe(false);
    expect(isPushAllowed(u, 'GOAL')).toBe(true);
    expect(isPushAllowed(u, 'STREAK')).toBe(true);
  });

  it('ignores a muted category for always-on types', () => {
    const u = { notificationsEnabled: true, notificationPrefs: { coin: false, goal: false } };
    for (const t of ALWAYS_ON) expect(isPushAllowed(u, t)).toBe(true);
  });

  it('honours the master switch even for always-on types', () => {
    // Turning notifications off entirely is an explicit choice; quietly
    // overriding it would make the setting a lie.
    const u = { notificationsEnabled: false };
    for (const t of ALL_TYPES) expect(isPushAllowed(u, t)).toBe(false);
  });

  it('allows an unrecognised type rather than dropping it', () => {
    // Failing closed would make any newly added category silently
    // undeliverable until someone remembered to add a preference for it —
    // exactly the drift this module exists to prevent.
    expect(isPushAllowed(on, 'BRAND_NEW_CATEGORY')).toBe(true);
    expect(isPushAllowed(on, undefined)).toBe(true);
    expect(isPushAllowed(on, null)).toBe(true);
  });
});

describe('buildPrefUpdate', () => {
  it('maps known boolean keys to their document paths', () => {
    const { set, rejected } = buildPrefUpdate({ coin: false, goal: true });
    expect(set).toEqual({
      'notificationPrefs.coin': false,
      'notificationPrefs.goal': true,
    });
    expect(rejected).toEqual([]);
  });

  it('rejects unknown keys instead of writing them', () => {
    // Without the allowlist an arbitrary body writes junk paths straight into
    // the user document.
    const { set, rejected } = buildPrefUpdate({ role: 'admin', coinsBalance: 999 });
    expect(set).toEqual({});
    expect(rejected).toEqual(['role', 'coinsBalance']);
  });

  it('rejects non-boolean values', () => {
    const { set, rejected } = buildPrefUpdate({ coin: 'false', goal: 1 });
    expect(set).toEqual({});
    expect(rejected.sort()).toEqual(['coin', 'goal']);
  });

  it('refuses to toggle an always-on category', () => {
    const { set, rejected } = buildPrefUpdate({ security: false, system: false });
    expect(set).toEqual({});
    expect(rejected.sort()).toEqual(['security', 'system']);
  });
});

describe('readPrefs', () => {
  it('fills defaults for a user who has never set anything', () => {
    const p = readPrefs({});
    expect(p.masterEnabled).toBe(true);
    for (const k of PREF_KEYS) expect(p.categories[k]).toBe(true);
    expect(p.alwaysOn).toEqual(ALWAYS_ON);
  });

  it('reflects what the user actually set', () => {
    const p = readPrefs({
      notificationsEnabled: false,
      notificationPrefs: { coin: false, goal: true },
    });
    expect(p.masterEnabled).toBe(false);
    expect(p.categories.coin).toBe(false);
    expect(p.categories.goal).toBe(true);
    expect(p.categories.streak).toBe(true); // unset stays on
  });
});
