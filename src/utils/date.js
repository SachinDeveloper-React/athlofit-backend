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

module.exports = { todayISO, isConsecutiveDay, buildDateRange, toDayLabel, daysBetween };
