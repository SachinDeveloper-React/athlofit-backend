// src/utils/date.js

/**
 * Returns today's date as "YYYY-MM-DD" in UTC
 */
const todayISO = () => new Date().toISOString().slice(0, 10);

/**
 * Returns whether two ISO date strings are consecutive days
 */
const isConsecutiveDay = (prevDate, currDate) => {
  if (!prevDate) return false;
  const prev = new Date(prevDate);
  const curr = new Date(currDate);
  const diffMs = curr.getTime() - prev.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
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
