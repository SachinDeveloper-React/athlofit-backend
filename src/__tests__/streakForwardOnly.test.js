/**
 * The streak cursor only ever moves forward.
 *
 * A production account reached a 1,057-day streak on an app that had not existed
 * for anything like 1,057 days. Nothing exotic caused it — ordinary background
 * traffic did.
 *
 * Both sync workers backfill the last seven days on every run: the Android
 * WidgetUpdateWorker (`HealthSyncHelper.kt`, every 15 minutes) and the JS
 * background fetch (`backgroundSync.service.ts`). Each posts one
 * POST /health/sync per day, oldest first, carrying an explicit past `date`, and
 * the server decides `goalMet` itself from the stored total — so every one of
 * those days that met the goal reached the streak update, past dates included.
 *
 * That made each new batch look like a six-day gap: `lastActiveDate` was already
 * today, and the batch reopened at today-6. attemptProtect() spent a freeze,
 * setting `freezeActiveUntil = now + 24h`, after which its first branch protected
 * every later rewind for free. The rewind therefore only moved the cursor back,
 * and the five days that followed in the same batch each looked consecutive and
 * added +1 — about +6 per batch, ~96 batches a day, with grantProtections()
 * handing back a fresh freeze at every multiple of seven so the loop never ran dry.
 *
 * These tests drive advanceStreak() directly with a plain object standing in for
 * the Gamification document, which is all that function touches.
 */
const { advanceStreak, attemptProtect, grantProtections } = require('../utils/streak');

const CFG = {
  freezeEarnEvery: 7,
  maxFreezes: 2,
  freezeGraceHours: 24,
  lifeEarnIntervalDays: 7,
  maxLives: 2,
  restoreCostCoins: 100,
  restoreWindowHours: 48,
};

/** A Gamification-shaped plain object with the defaults from the schema. */
const makeGam = (over = {}) => ({
  streakDays: 0,
  bestStreakDays: 0,
  lastActiveDate: null,
  streakFreezes: 0,
  streakLives: 0,
  freezeActiveUntil: null,
  lastFreezeGrantStreak: 0,
  lastLifeGrantWeek: null,
  streakBrokenAt: null,
  streakBeforeBreak: 0,
  ...over,
});

/** "YYYY-MM-DD" `n` days after `iso`; `n` may be negative. */
const shift = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

/** The seven days a worker run posts, oldest first, exactly as the workers build them. */
const backfillBatch = today => [6, 5, 4, 3, 2, 1, 0].map(n => shift(today, -n));

describe('advanceStreak — the seven-day backfill both workers post every 15 minutes', () => {
  it('does not inflate the streak across a day of worker runs', () => {
    const today = '2026-08-30';
    const gam = makeGam();

    // Seed the streak the honest way: the seven days of the window, once each.
    for (const date of backfillBatch(today)) advanceStreak(gam, date, CFG);
    expect(gam.streakDays).toBe(7);

    // 96 worker runs — a full day at one run every 15 minutes — all re-posting
    // the same seven days. The day has not changed, so neither has the streak.
    for (let run = 0; run < 96; run++) {
      for (const date of backfillBatch(today)) advanceStreak(gam, date, CFG);
    }

    expect(gam.streakDays).toBe(7);
    expect(gam.lastActiveDate).toBe(today);
  });

  it('adds exactly one day per calendar day, however many times the workers run', () => {
    const start = '2026-08-01';
    // Cursor already at the day before the window, so the batch's pre-history is
    // behind it and only the days the clock actually reaches can count.
    const gam = makeGam({ streakDays: 1, bestStreakDays: 1, lastActiveDate: shift(start, -1) });

    // Thirty consecutive goal-met days, each hammered by four worker runs.
    const perDay = [];
    for (let day = 0; day < 30; day++) {
      const today = shift(start, day);
      for (let run = 0; run < 4; run++) {
        for (const date of backfillBatch(today)) advanceStreak(gam, date, CFG);
      }
      perDay.push(gam.streakDays);
    }

    // One per day — not 4 × 7 per day, and not anything in between.
    expect(perDay).toEqual(Array.from({ length: 30 }, (_, i) => i + 2));
    expect(gam.streakDays).toBe(31);
    expect(gam.bestStreakDays).toBe(31);
    expect(gam.lastActiveDate).toBe(shift(start, 29));
  });

  it('never spends a freeze on a rewind, so protections cannot refuel the loop', () => {
    const today = '2026-08-30';
    const gam = makeGam();
    for (const date of backfillBatch(today)) advanceStreak(gam, date, CFG);

    const freezesAfterSeed = gam.streakFreezes;
    const livesAfterSeed = gam.streakLives;

    for (let run = 0; run < 20; run++) {
      for (const date of backfillBatch(today)) advanceStreak(gam, date, CFG);
    }

    expect(gam.streakFreezes).toBe(freezesAfterSeed);
    expect(gam.streakLives).toBe(livesAfterSeed);
    expect(gam.freezeActiveUntil).toBeNull();
    expect(gam.streakBrokenAt).toBeNull();
  });

  it('reproduces the runaway when the forward-only rule is removed', () => {
    // The pre-fix transition, verbatim apart from the missing guard. Without it
    // the same traffic the tests above leave flat climbs past a thousand days —
    // which is the number the user actually saw.
    const unguarded = (gam, date) => {
      if (gam.lastActiveDate === date) return;
      const [py, pm, pd] = gam.lastActiveDate.split('-').map(Number);
      const [cy, cm, cd] = date.split('-').map(Number);
      const diff = Math.round(
        (new Date(cy, cm - 1, cd) - new Date(py, pm - 1, pd)) / 86_400_000,
      );
      if (diff === 1) {
        gam.streakDays += 1;
        gam.lastActiveDate = date;
        grantProtections(gam, CFG);
      } else {
        const p = attemptProtect(gam, CFG);
        if (!p.protected) gam.streakDays = 1;
        gam.lastActiveDate = date;
      }
    };

    const today = '2026-08-30';
    const gam = makeGam();
    for (const date of backfillBatch(today)) advanceStreak(gam, date, CFG);

    for (let run = 0; run < 200; run++) {
      for (const date of backfillBatch(today)) unguarded(gam, date);
    }

    expect(gam.streakDays).toBeGreaterThan(1000);
  });
});

describe('advanceStreak — the days that should still count', () => {
  it('starts a streak at 1 on the first goal-met day', () => {
    const gam = makeGam();
    const move = advanceStreak(gam, '2026-08-30', CFG);

    expect(move).toEqual({ changed: true, broke: false, protectedBy: null });
    expect(gam.streakDays).toBe(1);
    expect(gam.bestStreakDays).toBe(1);
    expect(gam.lastActiveDate).toBe('2026-08-30');
  });

  it('extends the streak from a backfilled day the cursor has not reached yet', () => {
    // Yesterday's goal was met but never synced; today's run backfills it first.
    const gam = makeGam({ streakDays: 4, bestStreakDays: 4, lastActiveDate: '2026-08-28' });

    expect(advanceStreak(gam, '2026-08-29', CFG).changed).toBe(true);
    expect(gam.streakDays).toBe(5);
    expect(advanceStreak(gam, '2026-08-30', CFG).changed).toBe(true);
    expect(gam.streakDays).toBe(6);
    expect(gam.lastActiveDate).toBe('2026-08-30');
  });

  it('reports no change for a repeat sync of the day already counted', () => {
    const gam = makeGam({ streakDays: 9, bestStreakDays: 9, lastActiveDate: '2026-08-30' });
    const move = advanceStreak(gam, '2026-08-30', CFG);

    expect(move).toEqual({ changed: false, broke: false, protectedBy: null });
    expect(gam.streakDays).toBe(9);
  });

  it('still breaks the streak on a real gap with no protection left', () => {
    const gam = makeGam({ streakDays: 12, bestStreakDays: 12, lastActiveDate: '2026-08-20' });
    const move = advanceStreak(gam, '2026-08-30', CFG);

    expect(move.broke).toBe(true);
    expect(gam.streakDays).toBe(1);
    expect(gam.bestStreakDays).toBe(12);
    expect(gam.streakBeforeBreak).toBe(12);
    expect(gam.lastActiveDate).toBe('2026-08-30');
  });

  it('spends a stored freeze on a real gap instead of breaking', () => {
    const gam = makeGam({
      streakDays: 12, bestStreakDays: 12, lastActiveDate: '2026-08-28', streakFreezes: 1,
    });
    const move = advanceStreak(gam, '2026-08-30', CFG);

    expect(move).toMatchObject({ changed: true, broke: false, protectedBy: 'freeze' });
    expect(gam.streakDays).toBe(12);
    expect(gam.streakFreezes).toBe(0);
    expect(gam.lastActiveDate).toBe('2026-08-30');
  });

  it('keeps an existing streak when lastActiveDate was cleared', () => {
    const gam = makeGam({ streakDays: 6, bestStreakDays: 6, lastActiveDate: null });
    advanceStreak(gam, '2026-08-30', CFG);

    expect(gam.streakDays).toBe(6);
    expect(gam.lastActiveDate).toBe('2026-08-30');
  });
});
