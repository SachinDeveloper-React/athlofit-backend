/**
 * A day that turns out not to have met its goal comes back out of the streak.
 *
 * The streak counts a day when it syncs, on the steps stored at the time. The
 * step-coin settlement looks at the finished day later and can find those
 * steps were not walked — 23 Sep's 15,000 were a machine, and 2,119 of them
 * were real. The goal was never met, so the day should never have extended the
 * streak, and the badges that streak unlocked should not stay claimable on it.
 *
 * withdrawStreakDay() is pure; these drive it with plain objects.
 */
const { withdrawStreakDay, goalMetRuns } = require('../utils/streak');

const gamOf = (over = {}) => ({
  streakDays: 5,
  bestStreakDays: 5,
  lastActiveDate: '2026-09-23',
  lastFreezeGrantStreak: 0,
  badgeList: [],
  ...over,
});

describe('goalMetRuns', () => {
  it('counts the run that ends on the latest day, and the longest one', () => {
    expect(goalMetRuns(['2026-09-23', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-22']))
      .toEqual({ currentRun: 2, longestRun: 3, lastDate: '2026-09-23' });
  });

  it('is nothing for no days', () => {
    expect(goalMetRuns([])).toEqual({ currentRun: 0, longestRun: 0, lastDate: null });
  });
});

describe('withdrawStreakDay', () => {
  it('breaks the run at the withdrawn day, keeping the days after it', () => {
    const change = withdrawStreakDay(gamOf(), '2026-09-21', {
      goalMetDates: ['2026-09-19', '2026-09-20', '2026-09-22', '2026-09-23'],
    });
    expect(change).toMatchObject({ streakDays: 2, bestStreakDays: 2 });
  });

  it('leaves nothing when the withdrawn day was the last one counted', () => {
    const change = withdrawStreakDay(
      gamOf({ streakDays: 3, bestStreakDays: 9, lastActiveDate: '2026-09-22' }),
      '2026-09-22',
      { goalMetDates: ['2026-09-20', '2026-09-21'] },
    );
    // The next goal-met day starts a new streak from one.
    expect(change).toMatchObject({ streakDays: 0, bestStreakDays: 9 });
  });

  it('counts through a gap a freeze bridged, from the record rather than the calendar', () => {
    // 21 Sep was missed and protected: the streak is 3 goal-met days across four.
    const change = withdrawStreakDay(
      gamOf({ streakDays: 3, bestStreakDays: 3 }),
      '2026-09-20',
      { goalMetDates: ['2026-09-22', '2026-09-23'] },
    );
    expect(change.streakDays).toBe(2);
  });

  it('does nothing for a day before the current run began', () => {
    expect(
      withdrawStreakDay(gamOf({ streakDays: 2 }), '2026-09-18', {
        goalMetDates: ['2026-09-22', '2026-09-23'],
      }),
    ).toBeNull();
  });

  it('does nothing for a day after the cursor, or with no streak', () => {
    expect(withdrawStreakDay(gamOf(), '2026-09-24', { goalMetDates: [] })).toBeNull();
    expect(withdrawStreakDay(gamOf({ streakDays: 0 }), '2026-09-22', { goalMetDates: [] })).toBeNull();
    expect(withdrawStreakDay(gamOf({ lastActiveDate: null }), '2026-09-22', { goalMetDates: [] })).toBeNull();
  });

  it('keeps a best streak that an earlier, real run set', () => {
    const change = withdrawStreakDay(gamOf({ bestStreakDays: 12 }), '2026-09-21', {
      goalMetDates: ['2026-09-19', '2026-09-20', '2026-09-22', '2026-09-23'],
    });
    expect(change.bestStreakDays).toBe(12);
  });

  it('never lets the freeze tracker sit above the corrected streak', () => {
    const change = withdrawStreakDay(gamOf({ lastFreezeGrantStreak: 5 }), '2026-09-21', {
      goalMetDates: ['2026-09-22', '2026-09-23'],
    });
    expect(change.lastFreezeGrantStreak).toBe(2);
  });

  it('clears unclaimed badges the corrected streak no longer reaches, and only reports paid ones', () => {
    const gam = gamOf({
      streakDays: 7,
      bestStreakDays: 7,
      badgeList: [
        { key: 'starter', unlocked: true, coinsClaimed: false },
        { key: 'five', unlocked: true, coinsClaimed: true },
        { key: 'week', unlocked: true, coinsClaimed: false },
      ],
    });
    const change = withdrawStreakDay(gam, '2026-09-20', {
      goalMetDates: ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-21', '2026-09-22', '2026-09-23'],
      badgeDefs: [
        { key: 'starter', threshold: 3 },
        { key: 'five', threshold: 5 },
        { key: 'week', threshold: 7 },
      ],
    });
    expect(change).toMatchObject({ streakDays: 3, bestStreakDays: 3 });
    expect(change.clearBadges).toEqual(['week']);
    expect(change.paidBadges).toEqual(['five']);
  });
});
