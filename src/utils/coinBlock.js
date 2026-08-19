// src/utils/coinBlock.js
// ─── Is this user currently barred from earning coins? ───────────────────────
//
// Pure, dependency-free, and deliberately in its own module. It lives here rather
// than in cheatPenalty.js because that file requires createNotification, which
// initialises firebase-admin at require time and throws without live service
// account credentials — so anything importing it cannot be unit tested. This
// function gates coin earning in six separate places (health sync, the passive
// coin cron ×2, gamification earn/claim/claim-achievement, challenge auto-award),
// which is far too much reach to leave untested.
//
// cheatPenalty.js re-exports it, so every existing import keeps working.

/**
 * Needs no feature gate of its own: `coinBlockedUntil` is written only by
 * recordCheatFlag, and only when features.cheatPenaltyEnabled is on. While that
 * flag is off nothing sets the field, so this answers "not blocked" for everyone.
 *
 * @param {{ coinBlockedUntil?: Date|string|null }} user The user document.
 * @param {Date} [now]
 * @returns {{ isBlocked: boolean, blockedUntil: Date|null, daysRemaining: number }}
 */
function isCoinBlocked(user, now = new Date()) {
  const notBlocked = { isBlocked: false, blockedUntil: null, daysRemaining: 0 };

  if (!user || !user.coinBlockedUntil) return notBlocked;

  const blockedUntil = new Date(user.coinBlockedUntil);

  // Unparseable dates fail OPEN. A block is a punishment, so when the stored
  // value cannot be read the user gets the benefit of the doubt rather than an
  // indefinite block nothing can lift.
  if (Number.isNaN(blockedUntil.getTime())) return notBlocked;

  if (now >= blockedUntil) return notBlocked; // expired

  const daysRemaining = Math.ceil((blockedUntil - now) / (1000 * 60 * 60 * 24));
  return { isBlocked: true, blockedUntil, daysRemaining };
}

module.exports = { isCoinBlocked };
