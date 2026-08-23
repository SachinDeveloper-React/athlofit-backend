// Export and deletion are the same question asked two ways: what does this
// system hold about me? The risk is drift — a collection added to one path and
// not the other. An export that misses one hides data the user is entitled to
// see; a purge that misses one leaves data behind after they asked for it gone.
// Neither shows up in manual testing, so the invariant is pinned here.

const { PURGED_COLLECTIONS } = require('../utils/purgeUserData');
const {
  EXPORTED_COLLECTIONS,
  EXCLUDED_FROM_EXPORT,
  USER_SECRET_FIELDS,
} = require('../utils/exportUserData');

describe('export / purge data-map symmetry', () => {
  it('exports every collection the purge deletes, except documented exclusions', () => {
    const missing = PURGED_COLLECTIONS.filter(
      (c) => !EXPORTED_COLLECTIONS.includes(c) && !(c in EXCLUDED_FROM_EXPORT),
    );
    // If this fails, a collection was added to purgeUserData without being
    // added to exportUserData — decide whether it belongs in the export, and
    // if not, record the reason in EXCLUDED_FROM_EXPORT.
    expect(missing).toEqual([]);
  });

  it('does not export a collection the purge never deletes', () => {
    // The reverse drift: exporting something deletion leaves behind means a
    // user can see data that survives their own deletion request.
    const orphaned = EXPORTED_COLLECTIONS.filter((c) => !PURGED_COLLECTIONS.includes(c));
    expect(orphaned).toEqual([]);
  });

  it('records a reason for every deliberate exclusion', () => {
    for (const [name, reason] of Object.entries(EXCLUDED_FROM_EXPORT)) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(0);
      // An exclusion only makes sense for something the purge actually handles.
      expect(PURGED_COLLECTIONS).toContain(name);
    }
  });

  it('never exports session tokens', () => {
    // Refresh tokens are keys to the account. A user emailing themselves their
    // own export would be distributing live credentials.
    expect(EXPORTED_COLLECTIONS).not.toContain('refreshTokens');
    expect(EXCLUDED_FROM_EXPORT).toHaveProperty('refreshTokens');
  });

  it('has no duplicate entries in either manifest', () => {
    expect(new Set(PURGED_COLLECTIONS).size).toBe(PURGED_COLLECTIONS.length);
    expect(new Set(EXPORTED_COLLECTIONS).size).toBe(EXPORTED_COLLECTIONS.length);
  });
});

describe('export — credential fields', () => {
  const projected = USER_SECRET_FIELDS.split(/\s+/).filter(Boolean);

  it.each([
    ['-password', 'password hash'],
    ['-otp', 'one-time code'],
    ['-otpExpires', 'one-time code expiry'],
    ['-otpFlow', 'one-time code flow'],
    ['-tokenVersion', 'session invalidation counter'],
    ['-fcmToken', 'push token — a handle for sending to the device'],
  ])('excludes %s from the user projection', (field) => {
    expect(projected).toContain(field);
  });

  it.each([
    ['-banInfo.bannedBy'],
    ['-stepsTracking.disabledBy'],
    ['-stepsTracking.enabledBy'],
    ['-syncDebug.enabledBy'],
  ])('excludes the staff actor field %s', (field) => {
    // Identifying the moderator to the person they moderated is how moderators
    // get targeted. The action and its reason stay in the export; the actor does not.
    expect(projected).toContain(field);
  });

  it('excludes only, never includes', () => {
    // A Mongo projection cannot mix inclusion and exclusion. One field written
    // without its leading '-' would silently flip the whole projection to an
    // allowlist and ship a near-empty profile — or, worse, throw at runtime.
    for (const f of projected) {
      expect(f.startsWith('-')).toBe(true);
    }
  });
});
