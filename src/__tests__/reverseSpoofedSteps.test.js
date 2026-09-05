// Tests for the selection rules behind the step reversal.
//
// This script takes coins and step counts away from real accounts, so the half
// that decides WHO and WHICH DAYS is the half that has to be right. The tests
// that matter most are the ones built from the incident's actual shape: the ten
// honest accounts must come out with nothing to correct, and the three
// fraudulent ones must have their genuine source found rather than zeroed.

jest.mock('../models/User.model', () => ({}));
jest.mock('../models/HealthActivity.model', () => ({}));
jest.mock('../models/StepProvenance.model', () => ({}));
jest.mock('../models/Gamification.model', () => ({}));
jest.mock('../models/CoinTransaction.model', () => ({}));
jest.mock('../models/UserChallenge.model', () => ({}));
jest.mock('../models/Challenge.model', () => ({}));

const {
  analyseAccount,
  suspectDays,
  weeklyPeriodKeyFor,
  weekBoundsFor,
} = require('../scripts/reverseSpoofedSteps');

const FIT = 'com.google.android.apps.fitness';
const PLATFORM = 'com.android.healthconnect.phone.j72a0b5170cde33b8b9f7f5d4c07c5f9a';
const fake = i => `com.android.healthconnect.phone.jfake${i}`;

/** One StepProvenance document, reduced to the fields the script reads. */
const day = (date, { primaries = [], origins = [], totalSteps = 0 }) => ({
  date,
  totalSteps,
  entries: primaries.map(p => ({ primaryOrigin: p })),
  origins: origins.map(([packageName, steps]) => ({ packageName, steps })),
});

describe('analyseAccount', () => {
  it('counts an origin once per day, not once per sync', () => {
    // The widget worker posts every 15 minutes, so a day yields up to ninety
    // entries naming the same origin. Counting entries would establish an origin
    // out of a single afternoon.
    const rows = [
      day('2026-09-01', { primaries: Array(90).fill(PLATFORM), origins: [[PLATFORM, 8000]] }),
    ];
    expect(analyseAccount(rows).primaryDays[PLATFORM]).toBe(1);
  });

  it('sees an honest account as settled', () => {
    // One origin, stable across a week — the shape all ten honest accounts had.
    const rows = Array.from({ length: 7 }, (_, i) =>
      day(`2026-09-0${i + 1}`, {
        primaries: [PLATFORM],
        origins: [[PLATFORM, 9000]],
        totalSteps: 9000,
      }),
    );
    const analysis = analyseAccount(rows);

    expect(analysis.distinctPrimaries).toBe(1);
    expect(analysis.churning).toBe(false);
    expect(analysis.restorable.has(PLATFORM)).toBe(true);
  });

  it('sees a rotating account as churning', () => {
    // Nine identities over six days, which is what the worst account did.
    const rows = Array.from({ length: 6 }, (_, i) =>
      day(`2026-09-0${i + 1}`, {
        primaries: [fake(i), fake(i + 10)],
        origins: [[fake(i), 30_000], [FIT, 2_000]],
        totalSteps: 30_000,
      }),
    );
    const analysis = analyseAccount(rows);

    expect(analysis.churning).toBe(true);
    expect(analysis.distinctPrimaries).toBeGreaterThan(4);
  });

  it('finds the genuine source even though it was never primary', () => {
    // The load-bearing case. On the fraudulent accounts the real app never won
    // the dedup — the injected origin always outranked it — so a count of
    // PRIMARY days would find no honest source anywhere and declare every day
    // unverifiable. Restoration counts appearances instead.
    const rows = Array.from({ length: 5 }, (_, i) =>
      day(`2026-09-0${i + 1}`, {
        primaries: [fake(i)],
        origins: [[fake(i), 30_000], [FIT, 2_101]],
        totalSteps: 30_000,
      }),
    );
    const analysis = analyseAccount(rows);

    expect(analysis.primaryDays[FIT]).toBeUndefined();
    expect(analysis.restorable.has(FIT)).toBe(true);
  });

  it('will not restore from an origin that won the dedup on a churning account', () => {
    // One of the rotating identities lasted long enough to establish on day
    // count alone. On an account that is cycling, having been primary is exactly
    // what the injection achieved, so it cannot also be the source of truth.
    const rows = [
      ...Array.from({ length: 4 }, (_, i) =>
        day(`2026-09-0${i + 1}`, {
          primaries: [fake(99)],
          origins: [[fake(99), 30_000], [FIT, 2_000]],
        }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        day(`2026-09-1${i}`, {
          primaries: [fake(i)],
          origins: [[fake(i), 30_000], [FIT, 2_000]],
        }),
      ),
    ];
    const analysis = analyseAccount(rows);

    expect(analysis.churning).toBe(true);
    expect(analysis.restorable.has(fake(99))).toBe(false);
    expect(analysis.restorable.has(FIT)).toBe(true);
  });

  it('never decides on a package name', () => {
    // The one pattern that looked like a signature was mostly honest users.
    // Two accounts with identical histories must analyse the same.
    const build = origin =>
      analyseAccount(
        Array.from({ length: 7 }, (_, i) =>
          day(`2026-09-0${i + 1}`, { primaries: [origin], origins: [[origin, 9000]] }),
        ),
      );

    expect(build(PLATFORM).churning).toBe(false);
    expect(build(FIT).churning).toBe(false);
    expect(build(PLATFORM).restorable.has(PLATFORM)).toBe(true);
  });
});

describe('suspectDays', () => {
  it('finds nothing on an honest account', () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      day(`2026-09-0${i + 1}`, {
        primaries: [PLATFORM],
        origins: [[PLATFORM, 9000]],
        totalSteps: 9000,
      }),
    );
    expect(suspectDays(rows, analyseAccount(rows))).toEqual([]);
  });

  it('leaves a NEW honest account entirely alone', () => {
    // Several accounts had one or two days of data. Their origin cannot reach the
    // establishment threshold yet, and that must read as "not enough history",
    // never as "suspect".
    //
    // The dry run caught this: without the churn gate, every day on a new account
    // was flagged, and one honest user with three days and two ordinary origins
    // had 1,946 steps proposed for removal.
    const rows = [
      day('2026-09-01', { primaries: [PLATFORM], origins: [[PLATFORM, 4_341]], totalSteps: 4_341 }),
    ];
    expect(suspectDays(rows, analyseAccount(rows))).toEqual([]);
  });

  it('leaves an account with two ordinary origins alone', () => {
    // A pedometer and a fitness app is a normal phone, not a rotation. This is
    // the exact shape the dry run flagged, and restoring it would have replaced
    // the larger genuine figure with the smaller one.
    const SWEAT = 'in.sweatco.app';
    const rows = [
      day('2026-08-30', { primaries: [SWEAT], origins: [[SWEAT, 3_272], [PLATFORM, 3_272]], totalSteps: 3_272 }),
      day('2026-08-31', { primaries: [PLATFORM], origins: [[PLATFORM, 3_648], [SWEAT, 2_238]], totalSteps: 3_648 }),
      day('2026-09-01', { primaries: [PLATFORM], origins: [[PLATFORM, 2_774], [SWEAT, 2_238]], totalSteps: 2_774 }),
    ];
    expect(suspectDays(rows, analyseAccount(rows))).toEqual([]);
  });

  it('restores the day to what the genuine source recorded', () => {
    // The actual incident: 50,000 recorded, 2,101 genuinely walked.
    const rows = [
      ...Array.from({ length: 4 }, (_, i) =>
        day(`2026-08-3${i}`, {
          primaries: [fake(i)],
          origins: [[fake(i), 20_000], [FIT, 2_000]],
          totalSteps: 20_000,
        }),
      ),
      day('2026-09-04', {
        primaries: [fake(9)],
        origins: [[fake(9), 50_000], [FIT, 2_101]],
        totalSteps: 50_000,
      }),
    ];
    const found = suspectDays(rows, analyseAccount(rows));
    const target = found.find(d => d.date === '2026-09-04');

    expect(target.recordedTotal).toBe(50_000);
    expect(target.restoredSteps).toBe(2_101);
    expect(target.untrusted).toContain(fake(9));
  });

  it('returns days in date order, so a report reads chronologically', () => {
    // Four distinct primaries, so the account is churning and the days are in
    // scope at all.
    const rows = [
      day('2026-09-04', { primaries: [fake(1)], origins: [[fake(1), 50_000]] }),
      day('2026-09-01', { primaries: [fake(2)], origins: [[fake(2), 30_000]] }),
      day('2026-09-02', { primaries: [fake(3)], origins: [[fake(3), 40_000]] }),
      day('2026-09-03', { primaries: [fake(4)], origins: [[fake(4), 45_000]] }),
    ];
    const found = suspectDays(rows, analyseAccount(rows));
    expect(found.map(d => d.date)).toEqual([
      '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
    ]);
  });

  it('does not touch an account that is not rotating, whatever its totals', () => {
    // The gate is on rotation alone. A single stable origin reporting large days
    // is a question for the ceiling rules, not for a reversal that deletes data.
    const rows = Array.from({ length: 6 }, (_, i) =>
      day(`2026-09-0${i + 1}`, {
        primaries: [PLATFORM],
        origins: [[PLATFORM, 30_000]],
        totalSteps: 30_000,
      }),
    );
    expect(suspectDays(rows, analyseAccount(rows))).toEqual([]);
  });
});

describe('week arithmetic matches the live challenge code', () => {
  // challenge.controller.js computes these for TODAY only. A boundary that
  // disagrees with it would revert the wrong period, so the shape is pinned.
  it('bounds a week Sunday to Saturday', () => {
    // 2026-09-04 is a Friday.
    expect(weekBoundsFor('2026-09-04')).toEqual({
      start: '2026-08-30',
      end: '2026-09-05',
    });
  });

  it('puts every day of one week in the same bounds', () => {
    const days = ['2026-08-30', '2026-09-01', '2026-09-04', '2026-09-05'];
    const bounds = days.map(d => JSON.stringify(weekBoundsFor(d)));
    expect(new Set(bounds).size).toBe(1);
  });

  it('gives a stable ISO week key', () => {
    expect(weeklyPeriodKeyFor('2026-09-04')).toMatch(/^\d{4}-W\d{2}$/);
    expect(weeklyPeriodKeyFor('2026-09-01')).toBe(weeklyPeriodKeyFor('2026-09-04'));
  });
});
