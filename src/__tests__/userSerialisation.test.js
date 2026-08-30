// GET /user/profile returns the whole user document (user.controller.js), so
// whatever the schema's toJSON leaves in place is handed to the app on every
// profile fetch.
//
// utils/exportUserData.js already refuses to disclose WHICH staff member banned
// an account, paused its step tracking, or switched on sync tracing — the fact
// of the action belongs to the user, the identity of the moderator does not.
// But it enforces that with a `.select()` on a lean query, which never reaches
// the toJSON transform. So the rule was applied on the one path a user has to
// explicitly request, and not on the one the app calls constantly.

const mongoose = require('mongoose');
const User = require('../models/User.model');

/** Builds an unsaved document so the transform can be exercised without a DB. */
function buildUser(overrides = {}) {
  return new User({
    name: 'Test User',
    email: 'test@example.com',
    password: 'hashed-password-value',
    ...overrides,
  });
}

describe('User toJSON', () => {
  const staffId = new mongoose.Types.ObjectId();

  it('still strips credentials', () => {
    const json = buildUser({ tokenVersion: 3, otp: '123456' }).toJSON();

    expect(json.password).toBeUndefined();
    expect(json.otp).toBeUndefined();
    expect(json.otpExpires).toBeUndefined();
    expect(json.tokenVersion).toBeUndefined();
  });

  it('does not disclose who switched on sync tracing', () => {
    const expiresAt = new Date(Date.now() + 3600_000);
    const json = buildUser({
      syncDebug: {
        enabled: true,
        enabledAt: new Date(),
        enabledBy: staffId,
        expiresAt,
      },
    }).toJSON();

    expect(json.syncDebug.enabledBy).toBeUndefined();
    // The fact of it stays — same line utils/exportUserData.js draws.
    expect(json.syncDebug.enabled).toBe(true);
    expect(json.syncDebug.expiresAt).toEqual(expiresAt);
  });

  it('does not disclose who banned the account', () => {
    const json = buildUser({
      banInfo: { bannedBy: staffId, reason: 'spam' },
    }).toJSON();

    expect(json.banInfo.bannedBy).toBeUndefined();
    expect(json.banInfo.reason).toBe('spam');
  });

  it('does not disclose who paused or resumed step tracking', () => {
    const json = buildUser({
      stepsTracking: {
        enabled: false,
        reason: 'Investigating step counts',
        disabledBy: staffId,
        enabledBy: staffId,
      },
    }).toJSON();

    expect(json.stepsTracking.disabledBy).toBeUndefined();
    expect(json.stepsTracking.enabledBy).toBeUndefined();
    expect(json.stepsTracking.reason).toBe('Investigating step counts');
  });

  it('does not throw when those sections are absent', () => {
    // A fresh account has no ban, no tracing and default step tracking.
    expect(() => buildUser().toJSON()).not.toThrow();
  });

  it('leaves ordinary profile fields alone', () => {
    const json = buildUser({ dailyStepGoal: 20000, emailVerified: true }).toJSON();

    expect(json.email).toBe('test@example.com');
    expect(json.dailyStepGoal).toBe(20000);
    expect(json.emailVerified).toBe(true);
  });
});
