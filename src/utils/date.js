// src/utils/date.js

/**
 * Returns today's date as "YYYY-MM-DD" in the server's local time.
 * Using local time (not UTC) avoids off-by-one date issues for users
 * in timezones ahead of UTC (e.g. UTC+5:30 after midnight UTC).
 */
const todayISO = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
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
 * Build date range array "YYYY-MM-DD" between from and to (inclusive)
 */
const buildDateRange = (from, to) => {
  const dates = [];
  const cur = new Date(from);
  const end = new Date(to);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
};

/**
 * Short day label "Mon", "Tue" ... from "YYYY-MM-DD"
 */
const toDayLabel = (isoDate) => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[new Date(isoDate).getDay()];
};

module.exports = { todayISO, isConsecutiveDay, buildDateRange, toDayLabel };
