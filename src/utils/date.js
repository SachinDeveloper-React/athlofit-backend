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

module.exports = { todayISO, resolveClientDate, isConsecutiveDay, buildDateRange, toDayLabel, daysBetween };
