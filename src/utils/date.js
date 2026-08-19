// src/utils/date.js

/**
 * Returns today's date as "YYYY-MM-DD" in Asia/Kolkata (IST) timezone.
 * Using a fixed timezone ensures consistent day boundaries regardless
 * of where the server is deployed (UTC cloud servers, local dev, etc.).
 */
const todayISO = () => {
  const now = new Date();
  // Intl.DateTimeFormat gives us the correct local date in IST
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now); // returns "YYYY-MM-DD" with en-CA locale
  return parts;
};

/**
 * FIX #3: Resolves today's date using the client-provided timezone.
 * Falls back to server IST (todayISO) if no timezone is provided.
 *
 * @param {string|null|undefined} timezone - IANA timezone string (e.g., "America/New_York")
 *   or UTC offset string (e.g., "+05:30", "-08:00").
 * @returns {string} "YYYY-MM-DD" in the client's timezone.
 */
const resolveClientDate = (timezone) => {
  if (!timezone) return todayISO();

  const now = new Date();

  // If timezone is an IANA name (e.g., "Asia/Kolkata", "America/New_York")
  // use Intl.DateTimeFormat directly.
  if (timezone.includes('/') || timezone === 'UTC') {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);
    } catch (e) {
      // Invalid timezone name — fall back to server time
      return todayISO();
    }
  }

  // If timezone is a numeric offset like "+05:30" or "-08:00" or minutes like "330"
  // Convert to milliseconds and compute the date.
  let offsetMinutes;
  if (/^[+-]\d{2}:\d{2}$/.test(timezone)) {
    // Parse "+05:30" or "-08:00"
    const sign = timezone[0] === '-' ? -1 : 1;
    const [h, m] = timezone.slice(1).split(':').map(Number);
    offsetMinutes = sign * (h * 60 + m);
  } else if (/^-?\d+$/.test(timezone)) {
    // Raw minutes offset (e.g., "330" for IST, "-480" for PST)
    offsetMinutes = parseInt(timezone, 10);
  } else {
    // Unrecognized format — fall back
    return todayISO();
  }

  // Apply the offset: UTC time + client offset = client local time
  const clientTime = new Date(now.getTime() + offsetMinutes * 60_000);
  const y = clientTime.getUTCFullYear();
  const m = String(clientTime.getUTCMonth() + 1).padStart(2, '0');
  const d = String(clientTime.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** Matches a strict "YYYY-MM-DD" calendar date. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Fixed zone used whenever the client sends no usable timezone. */
const SERVER_ZONE = 'Asia/Kolkata';

/**
 * True when `timezone` looks like an IANA zone name this runtime can use.
 */
const isZoneName = (timezone) =>
  typeof timezone === 'string' && (timezone.includes('/') || timezone === 'UTC');

/**
 * Parses "+05:30" / "-08:00" / raw-minutes ("330", "-480") into minutes.
 * @returns {number|null} null when the value is not an offset form.
 */
const parseOffsetMinutes = (timezone) => {
  if (typeof timezone !== 'string') return null;
  if (/^[+-]\d{2}:\d{2}$/.test(timezone)) {
    const sign = timezone[0] === '-' ? -1 : 1;
    const [h, m] = timezone.slice(1).split(':').map(Number);
    return sign * (h * 60 + m);
  }
  if (/^-?\d+$/.test(timezone)) return parseInt(timezone, 10);
  return null;
};

/**
 * Minutes elapsed since 00:00 local time in the client's timezone.
 *
 * Used as the step-validation window when there is no record of steps having
 * been accepted yet today: the most a user can have walked is bounded by how
 * much of their local day has actually happened. Falls back to the server zone
 * when the timezone is missing or unusable, matching todayISO().
 *
 * @param {string|null|undefined} timezone
 * @param {Date} [now]
 * @returns {number} 0..1439
 */
const minutesSinceLocalMidnight = (timezone, now = new Date()) => {
  const readParts = (zone) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour').value);
    const m = Number(parts.find((p) => p.type === 'minute').value);
    return h * 60 + m;
  };

  if (isZoneName(timezone)) {
    try {
      return readParts(timezone);
    } catch (e) {
      // Unknown zone — fall through.
    }
  }

  const offsetMinutes = parseOffsetMinutes(timezone);
  if (offsetMinutes === null) return readParts(SERVER_ZONE);

  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

/**
 * True when `value` is a well-formed "YYYY-MM-DD" string denoting a real date.
 *
 * POST /health/sync takes `req.body.date` verbatim to decide which day to write,
 * with no validation at all — unlike GET /health/weekly-steps and the admin
 * add-steps route, which both check the format. A malformed or arbitrary value
 * creates junk rows under the unique {user, date} index.
 */
const isValidISODate = (value) => {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Reject impossible days (e.g. 2026-02-30) by round-tripping.
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/**
 * Formats an arbitrary Date as "YYYY-MM-DD" in the given timezone.
 *
 * Needed because comparing a UTC-derived date against a client-local date is
 * off by one for part of every day. The account-creation guard did exactly that:
 * `new Date(user.createdAt).toISOString().slice(0, 10)` is the UTC day, compared
 * against an IST/client-local `today`, so an account created between 00:00 and
 * 05:30 IST looked like it was created "tomorrow" and its first legitimate sync
 * was rejected as pre-dating the account.
 *
 * @param {Date|string|number} date
 * @param {string|null|undefined} timezone IANA name, "+05:30" offset, or minutes.
 * @returns {string|null} null when `date` is unusable.
 */
const toClientDate = (date, timezone) => {
  const dt = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(dt.getTime())) return null;

  const asDay = (zone) => new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt);

  if (isZoneName(timezone)) {
    try {
      return asDay(timezone);
    } catch (e) {
      // Unknown zone — fall through to the offset/default handling below.
    }
  }

  // Numeric offsets ("+05:30" / "-08:00" / raw minutes), else default to the
  // server's fixed zone so this agrees with todayISO().
  const offsetMinutes = parseOffsetMinutes(timezone);
  if (offsetMinutes === null) return asDay(SERVER_ZONE);

  const shifted = new Date(dt.getTime() + offsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** Minutes in a whole day. */
const MINUTES_PER_DAY = 24 * 60;

/**
 * Minutes of `isoDate` that have actually elapsed, from the user's point of view.
 *
 * For today this is the time since local midnight. For a date already in the past
 * it is the WHOLE day — all 1,440 minutes of it happened, regardless of what time
 * it is now.
 *
 * That distinction is the point of this helper. Step validation's first-accepted-
 * value ceiling called minutesSinceLocalMidnight() directly, which always answers
 * for TODAY, and then applied the result to whichever date the sync was writing.
 * POST /health/sync accepts an explicit past `date` and the Android widget worker
 * pushes the last seven days every 15 minutes, so past-date syncs are routine —
 * and one landing at 00:10 was judged against ten minutes of elapsed time. A
 * genuine 12,000-step day synced then was clamped to the 3,000-step floor, flagged
 * as a cheat, and paid retroactive coins on the clamped figure. It recovered over
 * the following hour as the delta ceiling took over, but the flags and the
 * temporarily wrong total were real.
 *
 * A date in the FUTURE gets today's elapsed minutes: no more of it can have
 * happened than has happened today, and that is the conservative answer. (Such a
 * sync should not exist, but this helper is not the place to reject it.)
 *
 * @param {string|null|undefined} isoDate "YYYY-MM-DD"; anything unusable falls
 *   back to today's elapsed minutes.
 * @param {string|null|undefined} timezone IANA name, "+05:30" offset, or minutes.
 * @param {Date} [now]
 * @returns {number} 1..1440
 */
const minutesElapsedOnDate = (isoDate, timezone, now = new Date()) => {
  const elapsedToday = Math.max(1, minutesSinceLocalMidnight(timezone, now));
  if (!isValidISODate(isoDate)) return elapsedToday;

  // toClientDate(now, tz) is resolveClientDate(tz) with an injectable clock, and
  // falls back to the same server zone, so the two always agree on "today".
  const today = toClientDate(now, timezone);
  if (!today || isoDate >= today) return elapsedToday;

  return MINUTES_PER_DAY;
};

/**
 * Returns whether two ISO date strings are consecutive days.
 * Uses date-part arithmetic only (no time/timezone math) to avoid
 * DST-related float precision issues with diffMs / 86400000.
 */
const isConsecutiveDay = (prevDate, currDate) => {
  if (!prevDate) return false;
  // Parse as local-midnight by splitting the string — avoids UTC-offset shifts
  const [py, pm, pd] = prevDate.split('-').map(Number);
  const [cy, cm, cd] = currDate.split('-').map(Number);
  const prev = new Date(py, pm - 1, pd);
  const curr = new Date(cy, cm - 1, cd);
  const diffMs   = curr.getTime() - prev.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  return diffDays === 1;
};

/**
 * Build date range array "YYYY-MM-DD" between from and to (inclusive).
 * Uses manual date arithmetic to avoid UTC shifts from toISOString().
 */
const buildDateRange = (from, to) => {
  const dates = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const cur = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
};

/**
 * Short day label "Mon", "Tue" ... from "YYYY-MM-DD"
 * Parses as local date (not UTC) to avoid day-shift issues.
 */
const toDayLabel = (isoDate) => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const [y, m, d] = isoDate.split('-').map(Number);
  return days[new Date(y, m - 1, d).getDay()];
};

/**
 * Returns a formatted label like "10 (Fri)" from "YYYY-MM-DD".
 * This includes the day-of-month number and abbreviated day name.
 */
const toDateWithDayLabel = (isoDate) => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const [y, m, d] = isoDate.split('-').map(Number);
  const dayName = days[new Date(y, m - 1, d).getDay()];
  return `${d} (${dayName})`;
};

/**
 * Number of whole days between two ISO date strings (currDate - prevDate).
 * Positive if currDate is after prevDate.
 */
const daysBetween = (prevDate, currDate) => {
  if (!prevDate || !currDate) return null;
  const [py, pm, pd] = prevDate.split('-').map(Number);
  const [cy, cm, cd] = currDate.split('-').map(Number);
  const prev = new Date(py, pm - 1, pd);
  const curr = new Date(cy, cm - 1, cd);
  return Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));
};

/**
 * Returns the current hour (0-23) in IST, regardless of server timezone.
 */
const currentHourIST = () => {
  return parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hour12: false,
  }).format(new Date()), 10);
};

/**
 * Returns the ISO week key (e.g. "2026-W28") based on IST date.
 */
const isoWeekKeyIST = () => {
  const dateStr = todayISO(); // IST date
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 4 - (dt.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
};

module.exports = { todayISO, resolveClientDate, isValidISODate, toClientDate, minutesSinceLocalMidnight, minutesElapsedOnDate, isConsecutiveDay, buildDateRange, toDayLabel, toDateWithDayLabel, daysBetween, currentHourIST, isoWeekKeyIST };
