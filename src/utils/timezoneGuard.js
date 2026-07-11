// src/utils/timezoneGuard.js
//
// FIX: Timezone manipulation detection.
//
// Detects when a user changes their timezone suspiciously often within a day.
// Legitimate timezone changes (travel) happen at most 1-2 times per day.
// A user trying to game the system by jumping between UTC+14 and UTC-11
// would trigger multiple changes within hours.
//
// Strategy:
//   - Track lastKnownTimezone on the Gamification doc.
//   - If the timezone changes, increment a daily counter (timezoneChangeCount).
//   - If the counter exceeds MAX_DAILY_TZ_CHANGES, flag the user and
//     fall back to server time (IST) for coin calculations — ignore client tz.
//   - Counter resets at midnight (server day).

const { todayISO } = require('./date');

const MAX_DAILY_TZ_CHANGES = 3; // legitimate travel rarely exceeds 2

/**
 * Checks if the incoming timezone is suspicious compared to the user's
 * last known timezone. Updates tracking fields on the gam document.
 *
 * @param {object} gam - Gamification mongoose document (mutated in place)
 * @param {string|null} incomingTimezone - Client-provided timezone
 * @returns {{ blocked: boolean, reason: string|null }}
 *   blocked = true means the server should ignore the client timezone
 *   and fall back to server time for this sync.
 */
function checkTimezoneManipulation(gam, incomingTimezone) {
  if (!incomingTimezone) {
    // No timezone provided — server uses its own (safe fallback)
    return { blocked: false, reason: null };
  }

  const today = todayISO();

  // Reset daily counter if it's a new day
  if (gam.timezoneChangeDate !== today) {
    gam.timezoneChangeCount = 0;
    gam.timezoneChangeDate = today;
  }

  // If user is already flagged, block their timezone and use server time
  if (gam.timezoneFlagged) {
    return {
      blocked: true,
      reason: 'Account flagged for timezone manipulation — using server time',
    };
  }

  // Check if timezone actually changed
  const previousTz = gam.lastKnownTimezone;
  if (previousTz && previousTz !== incomingTimezone) {
    gam.timezoneChangeCount = (gam.timezoneChangeCount || 0) + 1;

    // Check if this is a suspiciously large offset jump
    const offsetDiff = getOffsetDifference(previousTz, incomingTimezone);
    const isLargeJump = Math.abs(offsetDiff) >= 10; // 10+ hours jump in one sync

    if (gam.timezoneChangeCount > MAX_DAILY_TZ_CHANGES) {
      // Too many changes today — flag the account
      gam.timezoneFlagged = true;
      gam.lastKnownTimezone = incomingTimezone;
      return {
        blocked: true,
        reason: `Timezone changed ${gam.timezoneChangeCount} times today (max ${MAX_DAILY_TZ_CHANGES})`,
      };
    }

    if (isLargeJump && gam.timezoneChangeCount >= 2) {
      // Two large jumps in one day is highly suspicious (gaming UTC+14 → UTC-11)
      gam.timezoneFlagged = true;
      gam.lastKnownTimezone = incomingTimezone;
      return {
        blocked: true,
        reason: `Large timezone jump detected: ${previousTz} → ${incomingTimezone} (${offsetDiff}h offset diff)`,
      };
    }
  }

  // Update last known timezone
  gam.lastKnownTimezone = incomingTimezone;
  return { blocked: false, reason: null };
}

/**
 * Calculates the hour difference between two IANA timezones.
 * Returns 0 if either timezone is invalid.
 */
function getOffsetDifference(tz1, tz2) {
  try {
    const now = new Date();

    const getOffset = (tz) => {
      // Use Intl to get the UTC offset for a timezone
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'shortOffset',
      });
      const parts = formatter.formatToParts(now);
      const tzPart = parts.find(p => p.type === 'timeZoneName');
      if (!tzPart) return 0;

      // Parse "GMT+5:30" or "GMT-8" into hours
      const match = tzPart.value.match(/GMT([+-]?)(\d+):?(\d*)/);
      if (!match) return 0;
      const sign = match[1] === '-' ? -1 : 1;
      const hours = parseInt(match[2], 10);
      const minutes = match[3] ? parseInt(match[3], 10) : 0;
      return sign * (hours + minutes / 60);
    };

    return getOffset(tz2) - getOffset(tz1);
  } catch {
    return 0; // Can't calculate — assume safe
  }
}

module.exports = { checkTimezoneManipulation };
