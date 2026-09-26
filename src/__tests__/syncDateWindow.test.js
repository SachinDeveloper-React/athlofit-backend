// Which dates a step sync may write to. A future date let a client park steps on
// tomorrow's row; an old one let it rewrite the history the baseline ceiling is
// computed from.

const { checkSyncDate, SYNC_BACKFILL_DAYS } = require('../utils/syncDateWindow');

// 12:00 in Asia/Kolkata on 26 Sep.
const noonIST = new Date('2026-09-26T06:30:00.000Z');
const tz = 'Asia/Kolkata';

describe('checkSyncDate', () => {
  it('accepts today', () => {
    expect(checkSyncDate({ date: '2026-09-26', timezone: tz, now: noonIST }).ok).toBe(true);
  });

  it('accepts every day of the backfill window', () => {
    for (const date of ['2026-09-25', '2026-09-22', '2026-09-19']) {
      expect(checkSyncDate({ date, timezone: tz, now: noonIST }).ok).toBe(true);
    }
    expect(SYNC_BACKFILL_DAYS).toBe(7);
  });

  it('refuses a date older than the window', () => {
    const r = checkSyncDate({ date: '2026-09-18', timezone: tz, now: noonIST });
    expect(r).toMatchObject({ ok: false, reason: 'too_old' });
  });

  it('refuses tomorrow', () => {
    const r = checkSyncDate({ date: '2026-09-27', timezone: tz, now: noonIST });
    expect(r).toMatchObject({ ok: false, reason: 'future' });
  });

  it('allows the new date a few minutes early, for a device clock that runs ahead', () => {
    const justBeforeMidnight = new Date('2026-09-26T18:25:00.000Z'); // 23:55 IST
    expect(checkSyncDate({ date: '2026-09-27', timezone: tz, now: justBeforeMidnight }).ok).toBe(true);
  });

  it('does not allow it an hour early', () => {
    const elevenPm = new Date('2026-09-26T17:30:00.000Z'); // 23:00 IST
    expect(checkSyncDate({ date: '2026-09-27', timezone: tz, now: elevenPm }).ok).toBe(false);
  });

  it('judges the window in the client timezone', () => {
    // 01:00 on 27 Sep in Kolkata is still 26 Sep in UTC; the client's 27th is today.
    const oneAmIST = new Date('2026-09-26T19:30:00.000Z');
    expect(checkSyncDate({ date: '2026-09-27', timezone: tz, now: oneAmIST }).ok).toBe(true);
  });
});
