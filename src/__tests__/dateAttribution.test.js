/**
 * Date attribution helpers for /health/sync.
 *
 * Two defects motivated these:
 *
 *  1. `req.body.date` decided which HealthActivity document a sync wrote to and
 *     was taken verbatim — no format check at all, unlike GET /health/weekly-steps
 *     and the admin add-steps route. Any string became a document key under the
 *     unique {user, date} index.
 *
 *  2. The account-creation guard compared a UTC-derived signup date against a
 *     client-local `today`. Mixing the two breaks in both directions depending on
 *     which side of UTC the user is, so the guard either let pre-account data in
 *     or rejected a genuine first-day sync.
 */
const { isValidISODate, toClientDate, resolveClientDate, todayISO, minutesElapsedOnDate } = require('../utils/date');

describe('isValidISODate', () => {
  it.each([
    '2026-08-17',
    '2024-02-29', // real leap day
    '1999-12-31',
  ])('accepts the well-formed date %s', (value) => {
    expect(isValidISODate(value)).toBe(true);
  });

  it.each([
    ['2026-02-30', 'day that does not exist'],
    ['2023-02-29', 'leap day in a non-leap year'],
    ['2026-13-01', 'month out of range'],
    ['2026-00-10', 'zero month'],
    ['2026-08-00', 'zero day'],
    ['2026-8-17', 'unpadded month'],
    ['26-08-17', 'two-digit year'],
    ['2026-08-17T00:00:00Z', 'full timestamp'],
    ['not-a-date', 'arbitrary text'],
    ['', 'empty string'],
    ['../../etc/passwd', 'path-like text'],
  ])('rejects %s (%s)', (value) => {
    expect(isValidISODate(value)).toBe(false);
  });

  it.each([null, undefined, 20260817, {}, [], true])(
    'rejects the non-string %p',
    (value) => {
      expect(isValidISODate(value)).toBe(false);
    },
  );
});

describe('toClientDate', () => {
  // 2026-08-17T02:00:00Z is 07:30 on the 17th in IST and 19:00 on the 16th in
  // Los Angeles — a moment where the calendar day genuinely differs by zone.
  const instant = '2026-08-17T02:00:00Z';

  it('resolves an IANA zone east of UTC', () => {
    expect(toClientDate(instant, 'Asia/Kolkata')).toBe('2026-08-17');
  });

  it('resolves an IANA zone west of UTC', () => {
    expect(toClientDate(instant, 'America/Los_Angeles')).toBe('2026-08-16');
  });

  it('resolves a "+HH:MM" offset', () => {
    expect(toClientDate(instant, '+05:30')).toBe('2026-08-17');
  });

  it('resolves a negative offset given in raw minutes', () => {
    expect(toClientDate(instant, '-480')).toBe('2026-08-16');
  });

  it('falls back to the server zone when no timezone is given', () => {
    // Matches todayISO()'s fixed Asia/Kolkata basis.
    expect(toClientDate(instant, undefined)).toBe('2026-08-17');
    expect(toClientDate(instant, null)).toBe('2026-08-17');
  });

  it('falls back rather than throwing on an unknown zone name', () => {
    expect(toClientDate(instant, 'Not/AZone')).toBe('2026-08-17');
  });

  it('returns null for an unusable date', () => {
    expect(toClientDate('garbage', 'UTC')).toBeNull();
    expect(toClientDate(undefined, 'UTC')).toBeNull();
  });

  it('accepts a Date instance as well as a string', () => {
    expect(toClientDate(new Date(instant), 'Asia/Kolkata')).toBe('2026-08-17');
  });

  it('agrees with resolveClientDate when asked about the current instant', () => {
    // Both must describe "now" identically, since the controller compares a
    // toClientDate() result against a resolveClientDate() result.
    for (const tz of ['Asia/Kolkata', 'America/Los_Angeles', 'UTC', '+05:30', '-480']) {
      expect(toClientDate(new Date(), tz)).toBe(resolveClientDate(tz));
    }
    expect(toClientDate(new Date(), undefined)).toBe(todayISO());
  });
});

describe('account-creation guard skew', () => {
  const guardRejects = (accountCreatedDate, today) =>
    Boolean(accountCreatedDate) && today < accountCreatedDate;

  it('no longer lets a pre-signup day through for a user east of UTC', () => {
    // Signup 00:30 IST on the 17th. The UTC day is still the 16th.
    const signup = '2026-08-16T19:00:00Z';
    const tz = 'Asia/Kolkata';

    const oldGuardDate = new Date(signup).toISOString().slice(0, 10); // 2026-08-16
    const newGuardDate = toClientDate(signup, tz);                    // 2026-08-17
    expect(oldGuardDate).toBe('2026-08-16');
    expect(newGuardDate).toBe('2026-08-17');

    // A background sync pushing the 16th (the day before signup) must be rejected.
    expect(guardRejects(oldGuardDate, '2026-08-16')).toBe(false); // leaked through
    expect(guardRejects(newGuardDate, '2026-08-16')).toBe(true);  // now blocked
  });

  it('no longer rejects the genuine first-day sync for a user west of UTC', () => {
    // Signup 19:00 on the 16th in Los Angeles. The UTC day is already the 17th.
    const signup = '2026-08-17T02:00:00Z';
    const tz = 'America/Los_Angeles';

    const oldGuardDate = new Date(signup).toISOString().slice(0, 10); // 2026-08-17
    const newGuardDate = toClientDate(signup, tz);                    // 2026-08-16
    expect(oldGuardDate).toBe('2026-08-17');
    expect(newGuardDate).toBe('2026-08-16');

    // The user's own signup day is the 16th; syncing it must be allowed.
    expect(guardRejects(oldGuardDate, '2026-08-16')).toBe(true);   // wrongly rejected
    expect(guardRejects(newGuardDate, '2026-08-16')).toBe(false);  // now allowed
  });

  it('still blocks dates genuinely before signup', () => {
    const signup = '2026-08-16T19:00:00Z';
    const guardDate = toClientDate(signup, 'Asia/Kolkata'); // 2026-08-17
    expect(guardRejects(guardDate, '2026-08-10')).toBe(true);
    expect(guardRejects(guardDate, '2026-08-17')).toBe(false);
    expect(guardRejects(guardDate, '2026-08-18')).toBe(false);
  });
});

describe('minutesElapsedOnDate', () => {
  // Step validation's first-accepted-value ceiling asks "how much of this day could
  // the user have walked in". It used to ask minutesSinceLocalMidnight(), which
  // always answers for TODAY, and then applied that to whichever date the sync was
  // writing — and POST /health/sync takes an explicit past `date`, which the Android
  // widget worker exercises every 15 minutes for the last seven days.

  /** 00:10 UTC on 2026-08-17. */
  const justAfterMidnight = new Date('2026-08-17T00:10:00Z');

  it('gives today the minutes elapsed so far', () => {
    expect(minutesElapsedOnDate('2026-08-17', 'UTC', justAfterMidnight)).toBe(10);
  });

  it('gives a past date the whole day', () => {
    expect(minutesElapsedOnDate('2026-08-16', 'UTC', justAfterMidnight)).toBe(1440);
    expect(minutesElapsedOnDate('2026-08-01', 'UTC', justAfterMidnight)).toBe(1440);
  });

  it('gives a future date no more than today has elapsed', () => {
    // Conservative rather than generous: a client must not be able to buy a
    // full-day allowance by labelling its sync tomorrow.
    expect(minutesElapsedOnDate('2026-08-18', 'UTC', justAfterMidnight)).toBe(10);
  });

  it('decides past-vs-today in the client timezone', () => {
    // 20:10 UTC on the 16th is 01:40 on the 17th in IST. The 16th is therefore
    // yesterday for an IST user and still today for a UTC user.
    const evening = new Date('2026-08-16T20:10:00Z');
    expect(minutesElapsedOnDate('2026-08-16', 'Asia/Kolkata', evening)).toBe(1440);
    expect(minutesElapsedOnDate('2026-08-16', 'UTC', evening)).toBe(20 * 60 + 10);
  });

  it('accepts offset-form timezones', () => {
    expect(minutesElapsedOnDate('2026-08-16', '+05:30', new Date('2026-08-16T20:10:00Z'))).toBe(1440);
    expect(minutesElapsedOnDate('2026-08-16', '330', new Date('2026-08-16T20:10:00Z'))).toBe(1440);
  });

  it.each([null, undefined, '', 'not-a-date', '2026-02-30', '2026-8-17'])(
    'falls back to today for the unusable date %p',
    (isoDate) => {
      expect(minutesElapsedOnDate(isoDate, 'UTC', justAfterMidnight)).toBe(10);
    },
  );

  it('never returns 0, so a caller can divide by it', () => {
    // Exactly midnight. The old minutesSinceLocalMidnight() returns 0 here; this
    // helper floors at 1 so an hours-based rate cannot collapse to a zero ceiling.
    expect(minutesElapsedOnDate('2026-08-17', 'UTC', new Date('2026-08-17T00:00:00Z'))).toBe(1);
  });

  it('falls back to the server zone when the timezone is unusable', () => {
    // Matches todayISO()/resolveClientDate(), which both default to Asia/Kolkata.
    const evening = new Date('2026-08-16T20:10:00Z'); // 01:40 IST on the 17th
    expect(minutesElapsedOnDate('2026-08-16', 'Mars/Olympus', evening)).toBe(1440);
    expect(minutesElapsedOnDate('2026-08-16', null, evening)).toBe(1440);
  });
});
