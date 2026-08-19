/**
 * Coin-earning block check.
 *
 * This gates coin earning in six places — the health sync, the passive-coin cron
 * (twice), gamification earn / claim / claim-achievement, and the challenge
 * auto-award — so it is worth pinning down precisely. It was previously a stub
 * that always returned "not blocked", hidden inside cheatPenalty.js where
 * firebase-admin's require-time initialisation made it untestable.
 *
 * The governing property: a block is a punishment, so every uncertain case has to
 * fail OPEN. Nothing here may invent a block that was not deliberately set.
 */
const { isCoinBlocked } = require('../utils/coinBlock');

const NOW = new Date('2026-08-17T12:00:00Z');
const notBlocked = { isBlocked: false, blockedUntil: null, daysRemaining: 0 };

describe('isCoinBlocked', () => {
  describe('fails open on everything except a live block', () => {
    it.each([
      ['no user at all', undefined],
      ['a null user', null],
      ['a user with no field', {}],
      ['an explicit null', { coinBlockedUntil: null }],
      ['an unparseable date', { coinBlockedUntil: 'whenever' }],
    ])('returns not-blocked for %s', (_label, user) => {
      expect(isCoinBlocked(user, NOW)).toEqual(notBlocked);
    });

    it('returns not-blocked once the block has expired', () => {
      expect(isCoinBlocked({ coinBlockedUntil: new Date('2026-08-16T12:00:00Z') }, NOW))
        .toEqual(notBlocked);
    });

    it('treats the exact expiry instant as expired', () => {
      expect(isCoinBlocked({ coinBlockedUntil: NOW }, NOW)).toEqual(notBlocked);
    });
  });

  describe('reports a live block', () => {
    it('blocks and counts the days remaining', () => {
      const result = isCoinBlocked({ coinBlockedUntil: new Date('2026-08-27T12:00:00Z') }, NOW);
      expect(result.isBlocked).toBe(true);
      expect(result.daysRemaining).toBe(10);
    });

    it('rounds a part-day up, so the last day still reads as 1', () => {
      const result = isCoinBlocked({ coinBlockedUntil: new Date('2026-08-17T18:00:00Z') }, NOW);
      expect(result.isBlocked).toBe(true);
      expect(result.daysRemaining).toBe(1);
    });

    it('accepts a date stored as a string, as Mongo lean() can return', () => {
      const result = isCoinBlocked({ coinBlockedUntil: '2026-08-27T12:00:00Z' }, NOW);
      expect(result.isBlocked).toBe(true);
      expect(result.daysRemaining).toBe(10);
    });
  });

  describe('nobody is blocked while penalties are disabled', () => {
    // The field is written only by recordCheatFlag, and only when
    // features.cheatPenaltyEnabled is on. With it off no document has the field,
    // which is exactly the "user with no field" case above — restated here because
    // it is the safety property the whole restore rests on.
    it('an untouched user document is never blocked', () => {
      const freshUser = { _id: 'u1', emailVerified: true };
      expect(isCoinBlocked(freshUser, NOW).isBlocked).toBe(false);
    });
  });
});
