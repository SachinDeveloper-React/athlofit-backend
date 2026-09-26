// Tests for step-coin settlement: what a finished day's step coins are worth.
//
// The property that matters is the one live validation could not have: a day
// judged WHOLE. A machine moving a phone is only recognisable across many
// syncs, so live it was paid for the ninety minutes it took to see. Settled,
// the same day keeps only what arrived before the pattern began — and a day
// with nothing wrong with it is paid exactly as it would have been live.

const {
  trackClientCadence: track,
  resolveDayHold,
  validateSteps,
  BASELINE_FLOOR,
} = require('../utils/stepValidation');
const {
  verifyDay,
  settlementFor,
  isStepCoinSettlementEnabled,
  isFitnessChallenge,
  datesThrough,
} = require('../utils/stepCoinSettlement');

// The Xiaomi 23049PCD8I's day on 23 Sep — the same fixture as in
// stepValidation.test.js: ~150 steps/min on both streams from 08:00 local,
// raw totals reaching 89,339, stored at the 15,000 floor.
// [ISO time, raw client total, X-Client-Source]
const SEP23 = [
  ['2026-09-23T02:03:15Z',     33, 'worker'],
  ['2026-09-23T02:14:47Z',     91, 'app'],
  ['2026-09-23T02:18:03Z',     91, 'native_service'],
  ['2026-09-23T02:30:04Z',  1_559, 'worker'],
  ['2026-09-23T02:33:06Z',  2_119, 'native_service'],
  ['2026-09-23T02:44:58Z',  3_819, 'worker'],
  ['2026-09-23T02:48:08Z',  4_379, 'native_service'],
  ['2026-09-23T03:00:11Z',  6_069, 'worker'],
  ['2026-09-23T03:03:12Z',  6_639, 'native_service'],
  ['2026-09-23T03:15:11Z',  8_319, 'worker'],
  ['2026-09-23T03:18:14Z',  8_889, 'native_service'],
  ['2026-09-23T03:30:04Z', 10_559, 'worker'],
  ['2026-09-23T03:33:17Z', 11_139, 'native_service'],
  ['2026-09-23T03:44:58Z', 12_799, 'worker'],
  ['2026-09-23T03:48:20Z', 13_389, 'native_service'],
  ['2026-09-23T04:00:04Z', 15_049, 'worker'],
  ['2026-09-23T04:03:23Z', 15_639, 'native_service'],
  ['2026-09-23T04:14:53Z', 17_289, 'worker'],
  ['2026-09-23T04:18:26Z', 17_889, 'native_service'],
  ['2026-09-23T04:30:03Z', 19_529, 'worker'],
  ['2026-09-23T04:33:29Z', 20_139, 'native_service'],
  ['2026-09-23T04:44:57Z', 21_769, 'worker'],
  ['2026-09-23T04:48:32Z', 22_389, 'native_service'],
  ['2026-09-23T05:00:01Z', 24_019, 'worker'],
  ['2026-09-23T05:03:36Z', 24_649, 'native_service'],
  ['2026-09-23T05:14:54Z', 26_279, 'worker'],
  ['2026-09-23T05:18:37Z', 26_909, 'native_service'],
  ['2026-09-23T05:29:59Z', 28_519, 'worker'],
  ['2026-09-23T05:33:40Z', 28_520, 'native_service'],
  ['2026-09-23T05:48:48Z', 28_554, 'native_service'],
  ['2026-09-23T06:03:51Z', 29_082, 'native_service'],
  ['2026-09-23T06:18:56Z', 30_984, 'native_service'],
  ['2026-09-23T06:30:02Z', 28_660, 'worker'],
  ['2026-09-23T06:33:59Z', 31_633, 'native_service'],
  ['2026-09-23T06:44:55Z', 30_890, 'worker'],
  ['2026-09-23T06:49:03Z', 33_943, 'native_service'],
  ['2026-09-23T06:59:45Z', 33_190, 'worker'],
  ['2026-09-23T07:04:06Z', 36_133, 'native_service'],
  ['2026-09-23T07:14:46Z', 33_873, 'worker'],
  ['2026-09-23T07:19:08Z', 36_236, 'native_service'],
  ['2026-09-23T07:34:13Z', 38_022, 'native_service'],
  ['2026-09-23T07:49:15Z', 40_322, 'native_service'],
  ['2026-09-23T08:04:16Z', 42_622, 'native_service'],
  ['2026-09-23T08:19:20Z', 44_932, 'native_service'],
  ['2026-09-23T08:34:22Z', 47_232, 'native_service'],
  ['2026-09-23T08:49:25Z', 49_532, 'native_service'],
  ['2026-09-23T09:04:26Z', 51_822, 'native_service'],
  ['2026-09-23T09:19:30Z', 54_122, 'native_service'],
  ['2026-09-23T09:34:36Z', 56_422, 'native_service'],
  ['2026-09-23T09:49:39Z', 58_722, 'native_service'],
  ['2026-09-23T10:04:43Z', 61_022, 'native_service'],
  ['2026-09-23T10:19:51Z', 63_178, 'native_service'],
  ['2026-09-23T10:34:56Z', 64_586, 'native_service'],
  ['2026-09-23T10:49:59Z', 66_886, 'native_service'],
  ['2026-09-23T11:05:03Z', 69_176, 'native_service'],
  ['2026-09-23T11:20:05Z', 71_456, 'native_service'],
  ['2026-09-23T11:35:07Z', 73_736, 'native_service'],
  ['2026-09-23T11:50:08Z', 76_016, 'native_service'],
  ['2026-09-23T12:05:10Z', 78_296, 'native_service'],
  ['2026-09-23T12:20:13Z', 80_576, 'native_service'],
  ['2026-09-23T12:35:16Z', 82_856, 'native_service'],
  ['2026-09-23T12:50:19Z', 85_136, 'native_service'],
  ['2026-09-23T13:05:22Z', 87_416, 'native_service'],
  ['2026-09-23T13:20:26Z', 89_010, 'native_service'],
  ['2026-09-23T14:55:54Z', 49_897, 'worker'],
  ['2026-09-23T16:13:52Z', 89_283, 'app'],
  ['2026-09-23T16:28:53Z', 68_286, 'worker'],
  ['2026-09-23T16:51:14Z', 89_339, 'native_service'],
  ['2026-09-23T16:58:56Z', 68_286, 'worker'],
];

const persisted = (r) => ({
  lastIncomingSteps: r.lastIncomingSteps,
  lastIncomingAt: r.lastIncomingAt,
  lastIncomingDelta: r.lastIncomingDelta,
  repeatedDeltaCount: r.repeatedDeltaCount,
  cadenceStreak: r.cadenceStreak,
  cadenceRateMin: r.cadenceRateMin,
  cadenceRateMax: r.cadenceRateMax,
  cadenceStreakAt: r.cadenceStreakAt,
  samples: r.samples,
});

/**
 * The row the live sync path leaves behind for a day: its syncs run through
 * the controller's wiring, with nothing carried in from earlier days.
 */
function liveRow(syncs, { date = '2026-09-23', stepBaseline = BASELINE_FLOOR, extra = {} } = {}) {
  let stored = 0;
  let streams = {};
  let held = { by: null, since: null, forfeit: 0, closed: false };
  let lastRaw = null;
  for (const [iso, raw, source] of syncs) {
    const at = new Date(iso);
    const cadence = track({ incomingSteps: raw, at, ...(streams[source] || {}) });
    const hold = resolveDayHold({
      source, cadence, streams,
      heldBy: held.by, heldSince: held.since, forfeit: held.forfeit, closed: held.closed,
      existingWalked: stored, at,
    });
    const r = validateSteps({
      incomingSteps: Math.max(0, raw - hold.stuckForfeit),
      existingSteps: stored,
      bonusSteps: 0,
      syncDate: date,
      dailyGoal: 10_000,
      stepBaseline,
      cadence: { ...cadence, stuck: hold.stuck, stuckReason: hold.stuckReason },
    });
    if (r.clampedSteps > stored) stored = r.clampedSteps;
    streams = { ...streams, [source]: persisted(cadence) };
    held = { by: hold.stuckSource, since: hold.stuckSince, forfeit: hold.stuckForfeit, closed: hold.closed };
    lastRaw = raw;
  }
  return {
    date,
    steps: stored,
    bonusSteps: 0,
    stepBaseline,
    cadenceBySource: streams,
    lastIncomingSteps: lastRaw,
    ...extra,
  };
}

/** A person's day: deltas that vary, Health Connect a little behind the sensor. */
function walkerSyncs(date = '2026-09-23') {
  const T0 = new Date(`${date}T03:00:00Z`).getTime();
  const gains = [900, 1_400, 300, 1_700, 650, 1_100, 2_000, 400, 1_250, 800, 1_500, 200, 1_800, 950];
  let live = 0;
  const syncs = [];
  gains.forEach((g, i) => {
    live += g;
    syncs.push([new Date(T0 + (i * 15 + 11) * 60_000).toISOString(), Math.max(0, live - 80), 'worker']);
    syncs.push([new Date(T0 + (i * 15 + 15) * 60_000).toISOString(), live, 'native_service']);
  });
  return syncs;
}

const SEP23_ROW = () =>
  liveRow(SEP23, { extra: { distance: 53.26, calories: 2_725, activeMinutes: 683 } });

describe('verifyDay', () => {
  it('pays a day with nothing wrong with it exactly what it stored', () => {
    const row = liveRow(walkerSyncs(), { extra: { distance: 9.1, calories: 480 } });
    expect(verifyDay(row)).toMatchObject({
      status: 'verified',
      walked: row.steps,
      payableWalked: row.steps,
      ratio: 1,
      reason: null,
    });
  });

  it('keeps only what 23 Sep walked before the machine started', () => {
    const row = SEP23_ROW();
    // Live, the floor was the only thing that stopped it.
    expect(row.steps).toBe(BASELINE_FLOOR);

    const verdict = verifyDay(row);
    // The two partial windows before the first return to the band.
    expect(verdict).toMatchObject({ status: 'partial', walked: 15_000, payableWalked: 2_119 });
    // Distance and calories scale by the payable share of what the phone
    // counted — the largest total any stream reported as a sample, the app's
    // 89,283 — not of what was stored.
    expect(verdict.ratio).toBeCloseTo(2_119 / 89_283, 6);
    expect(verdict.reason).toMatch(/only 2,119 of the day's 15,000 steps/);
  });

  // A morning walk, a device on a swing for two and a half hours at ~150
  // steps/min, then an evening walk. Live, the hold comes after ninety minutes
  // and five windows are refused — one short of what is carried into the next
  // day, so nothing tomorrow would catch it either, and the ninety minutes
  // before the hold are paid every single day.
  const T0 = new Date('2026-09-23T03:00:00Z').getTime();
  const at = (min) => new Date(T0 + min * 60_000).toISOString();
  const shortMachineDay = (() => {
    const syncs = [];
    let total = 100;
    syncs.push([at(0), total, 'native_service']);
    for (const [i, g] of [900, 1_400, 300, 1_700].entries()) {
      total += g;
      syncs.push([at((i + 1) * 15), total, 'native_service']);
    }
    const morning = total; // 4,400
    for (let i = 0; i < 10; i++) {
      total += 2_250 + (i % 3) * 10;
      syncs.push([at(75 + i * 15), total, 'native_service']);
    }
    const afterMachine = total;
    for (const [i, g] of [60, 1_100, 700, 1_300].entries()) {
      total += g;
      syncs.push([at(240 + i * 20), total, 'native_service']);
    }
    return { syncs, morning, machine: afterMachine - morning, evening: total - afterMachine };
  })();

  it('refuses a short machine run as a whole, and still pays the walks around it', () => {
    const { syncs, morning, evening } = shortMachineDay;
    const row = liveRow(syncs, { stepBaseline: 30_000 });
    const refused = row.cadenceBySource.native_service.samples.filter((x) => x.stuck);
    // Not long enough to be carried into tomorrow...
    expect(refused.length).toBeLessThan(6);
    // ...and live, the ninety minutes before the hold were accepted.
    expect(row.steps).toBeGreaterThan(morning + 10_000);

    const verdict = verifyDay(row);
    expect(verdict.status).toBe('partial');
    // The morning and the evening walks — not the machine, and not the day
    // closed behind it.
    expect(verdict.payableWalked).toBeGreaterThanOrEqual(morning);
    expect(verdict.payableWalked).toBeLessThanOrEqual(morning + evening);
    expect(verdict.payableWalked).toBeGreaterThan(morning + 1_000);
  });

  it('holds a treadmill session steady enough to trip the live rule, but not the day', () => {
    // 105 minutes at a flat 120 steps/min, then an ordinary walk. The price of
    // the rule: the session goes unpaid; the walk after it does not.
    const syncs = [[at(0), 500, 'native_service'], [at(15), 1_700, 'native_service']];
    let total = 1_700;
    for (let i = 0; i < 7; i++) {
      total += 1_800 + (i % 2) * 10;
      syncs.push([at(30 + i * 15), total, 'native_service']);
    }
    const afterSession = total;
    for (const [i, g] of [900, 1_400, 650, 1_200].entries()) {
      total += g;
      syncs.push([at(150 + i * 15), total, 'native_service']);
    }
    const verdict = verifyDay(liveRow(syncs, { stepBaseline: 30_000 }));
    expect(verdict.status).toBe('partial');
    expect(verdict.payableWalked).toBeLessThan(afterSession);
    expect(verdict.payableWalked).toBeGreaterThan(1_700 + 3_000);
  });

  it('pays nothing for a day held because its counter fed another account', () => {
    const row = { ...liveRow(walkerSyncs()), sharedHeld: true };
    expect(verifyDay(row)).toMatchObject({ status: 'refused', payableWalked: 0 });
  });

  it('says a day with no row was missing, and worth nothing', () => {
    expect(verifyDay(null, '2026-09-20')).toMatchObject({
      date: '2026-09-20',
      status: 'missing',
      payableWalked: 0,
    });
  });

  it('keeps bonus steps out of what is judged and in what is counted', () => {
    const row = { ...SEP23_ROW(), steps: 15_000 + 500, bonusSteps: 500 };
    expect(verifyDay(row)).toMatchObject({ walked: 15_000, bonus: 500, payableWalked: 2_119 });
  });
});

describe('settlementFor', () => {
  const partial = verifyDay(SEP23_ROW());
  const verified = {
    ...partial,
    status: 'verified',
    payableWalked: 15_000,
    ratio: 1,
    reason: null,
  };
  const on = (verdict) => () => verdict;

  describe('passive step coins', () => {
    const passive = (previousSteps, steps, amount) => ({
      date: '2026-09-23',
      source: 'PASSIVE_STEPS',
      amount,
      metadata: { previousSteps, steps },
    });

    it('pays a range that lies under the payable total in full', () => {
      expect(settlementFor(passive(0, 1_559, 7.5), on(partial))).toEqual({ pay: 7.5, reason: null });
    });

    it('pays the payable part of a range that straddles it, pro rata', () => {
      // 1,559 → 3,819 paid 11.3 coins; 560 of its 2,260 steps are payable.
      const r = settlementFor(passive(1_559, 3_819, 11.3), on(partial));
      expect(r.pay).toBeCloseTo((11.3 * 560) / 2_260, 4);
      expect(r.reason).toMatch(/machine-like/);
    });

    it('pays nothing for a range above it', () => {
      expect(settlementFor(passive(3_819, 6_069, 11.25), on(partial)).pay).toBe(0);
    });

    it('pays everything on a verified day', () => {
      expect(settlementFor(passive(12_000, 15_000, 15), on(verified)).pay).toBe(15);
    });
  });

  describe('the step-goal bonus', () => {
    const goal = (source) => ({
      date: '2026-09-23',
      source,
      amount: 50,
      metadata: { goal: 10_000 },
    });

    it.each(['DAILY_STEP_GOAL', 'DAILY_STEP_GOAL_AUTO', 'DAILY_STEP_GOAL_RETRO'])(
      'refuses %s when the payable total falls short of the goal',
      (source) => {
        expect(settlementFor(goal(source), on(partial)).pay).toBe(0);
      },
    );

    it('pays it when the payable total still meets the goal', () => {
      const r = settlementFor(goal('DAILY_STEP_GOAL_AUTO'), on({ ...partial, payableWalked: 10_200 }));
      expect(r.pay).toBe(50);
    });

    it('counts bonus steps toward the goal, as the live award did', () => {
      const r = settlementFor(
        goal('DAILY_STEP_GOAL_AUTO'),
        on({ ...partial, payableWalked: 9_700, bonus: 300 }),
      );
      expect(r.pay).toBe(50);
    });

    it('falls back to the default goal when none was recorded', () => {
      const entry = { date: '2026-09-23', source: 'DAILY_STEP_GOAL_AUTO', amount: 50, metadata: {} };
      expect(settlementFor(entry, on({ ...partial, payableWalked: 9_999 })).pay).toBe(0);
      expect(settlementFor(entry, on({ ...partial, payableWalked: 10_000 })).pay).toBe(50);
    });
  });

  describe('challenges measured by the step pipeline', () => {
    const challenge = (criteriaType, targetValue, extra = {}) => ({
      date: '2026-09-23',
      source: 'CHALLENGE',
      amount: 35,
      metadata: { criteriaType, targetValue, challengeType: 'daily', ...extra },
    });

    it('refuses a step target the payable total does not reach', () => {
      expect(settlementFor(challenge('STEPS', 5_000), on(partial)).pay).toBe(0);
    });

    it('scales distance, calories and active minutes on a day that did not verify', () => {
      // 53.26 km for 89,283 raw steps is 1.26 km for the 2,119 that count.
      expect(settlementFor(challenge('DISTANCE', 3), on(partial)).pay).toBe(0);
      expect(settlementFor(challenge('DISTANCE', 1), on(partial)).pay).toBe(35);
      expect(settlementFor(challenge('CALORIES', 300), on(partial)).pay).toBe(0);
      expect(settlementFor(challenge('ACTIVE_MINUTES', 30), on(partial)).pay).toBe(0);
    });

    it('takes them as sent on a day that verified', () => {
      expect(settlementFor(challenge('DISTANCE', 30), on(verified)).pay).toBe(35);
    });

    it('sums a weekly challenge over its week, each day judged on its own', () => {
      const entry = challenge('STEPS', 50_000, {
        challengeType: 'weekly',
        weekStart: '2026-09-20',
      });
      const days = {
        '2026-09-20': { ...verified, date: '2026-09-20', payableWalked: 12_000 },
        '2026-09-21': { ...verified, date: '2026-09-21', payableWalked: 12_000 },
        '2026-09-22': { ...verified, date: '2026-09-22', payableWalked: 12_000 },
        '2026-09-23': partial,
      };
      // Live: 36,000 + 15,000 = 51,000, completed. Verified: 36,000 + 2,119.
      expect(settlementFor(entry, (d) => days[d]).pay).toBe(0);

      const honest = { ...days, '2026-09-23': { ...verified, payableWalked: 15_000 } };
      expect(settlementFor(entry, (d) => honest[d]).pay).toBe(35);
    });

    it('adds nothing for a day of the week with no row, exactly as live', () => {
      const entry = challenge('STEPS', 20_000, { challengeType: 'weekly', weekStart: '2026-09-21' });
      const days = {
        '2026-09-21': verifyDay(null, '2026-09-21'),
        '2026-09-22': { ...verified, payableWalked: 10_000 },
        '2026-09-23': { ...verified, payableWalked: 10_000 },
      };
      expect(settlementFor(entry, (d) => days[d]).pay).toBe(35);
    });
  });
});

describe('settlement switches and helpers', () => {
  it('is off unless the feature says so', () => {
    expect(isStepCoinSettlementEnabled({})).toBe(false);
    expect(isStepCoinSettlementEnabled({ features: { stepCoinSettlement: false } })).toBe(false);
    expect(isStepCoinSettlementEnabled({ features: { stepCoinSettlement: true } })).toBe(true);
  });

  it('treats only step-pipeline challenges as step coins', () => {
    for (const c of ['STEPS', 'DISTANCE', 'CALORIES', 'ACTIVE_MINUTES']) {
      expect(isFitnessChallenge(c)).toBe(true);
    }
    for (const c of ['HYDRATION', 'MEALS_LOGGED', 'NUTRITION_CALORIES', 'SPECIFIC_FOOD']) {
      expect(isFitnessChallenge(c)).toBe(false);
    }
  });

  it('lists a week of dates, and never more', () => {
    expect(datesThrough('2026-09-20', '2026-09-23')).toEqual([
      '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23',
    ]);
    expect(datesThrough('2026-09-01', '2026-09-30')).toHaveLength(8);
    expect(datesThrough('2026-09-23', '2026-09-23')).toEqual(['2026-09-23']);
  });
});
