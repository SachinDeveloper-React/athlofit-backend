// Tests for the selection half of reverseHeldSteps.js — which days it would
// correct, and to what. The write half is reverseSpoofedSteps.applyPlan and is
// covered there.

const {
  findSharedGroups,
  replayDay,
  sampleTotalsOf,
  REVERSAL_SHARED_MIN_MATCHES,
} = require('../scripts/reverseHeldSteps');

const OLDER = '6a79bede207e8236e685d50b';
const NEWER = '6a7a068c207e8236e685fafc';

/** A ledger entry, as StepProvenance stores it. */
const entry = (at, from, to, clientSource = 'native_service') => ({
  at: new Date(`2026-09-21T${at}`),
  from,
  to,
  delta: to - from,
  clientSource,
});

// The older account's 21 Sep ledger, from the provenance document.
const OLDER_ENTRIES = [
  entry('01:59:54.133Z', 0, 270, 'worker'),
  entry('02:02:35.559Z', 270, 351, 'worker'),
  entry('02:14:53.743Z', 351, 475),
  entry('02:29:56.640Z', 475, 500),
  entry('02:44:57.676Z', 500, 2_560),
  entry('02:45:51.014Z', 2_560, 2_580, 'worker'),
  entry('03:00:01.024Z', 2_580, 4_800),
  entry('03:00:53.548Z', 4_800, 4_810, 'worker'),
  entry('03:15:05.523Z', 4_810, 7_050),
  entry('03:30:09.422Z', 7_050, 9_310),
  entry('03:45:12.371Z', 9_310, 11_570),
  entry('04:00:16.310Z', 11_570, 13_830),
  entry('04:15:19.558Z', 13_830, 14_848),
  entry('04:31:33.421Z', 14_848, 14_858),
  entry('04:46:34.414Z', 14_858, 16_396),
  entry('05:01:37.338Z', 16_396, 17_738),
  entry('05:16:38.556Z', 17_738, 19_998),
  entry('05:31:41.471Z', 19_998, 20_823),
  entry('05:47:53.835Z', 20_823, 20_833),
  entry('06:15:30.177Z', 20_833, 20_834),
  entry('07:20:39.459Z', 20_834, 21_223),
  entry('07:49:01.830Z', 21_223, 21_233),
  entry('08:04:11.109Z', 21_233, 21_286),
  entry('08:33:35.713Z', 21_286, 21_296),
  entry('09:25:28.112Z', 21_296, 21_303),
  entry('09:40:30.081Z', 21_303, 21_801),
  entry('09:55:33.209Z', 21_801, 21_885),
  entry('10:10:36.547Z', 21_885, 21_899),
  entry('10:25:43.235Z', 21_899, 21_909),
  entry('10:52:55.110Z', 21_909, 21_919),
  entry('11:07:59.981Z', 21_919, 22_278),
  entry('11:23:03.859Z', 22_278, 22_423),
  entry('11:47:12.449Z', 22_423, 22_438),
  entry('12:02:20.814Z', 22_438, 22_480),
  entry('12:17:26.520Z', 22_480, 22_787),
  entry('12:32:30.103Z', 22_787, 23_748),
  entry('12:45:55.710Z', 23_748, 24_530, 'worker'),
  entry('12:47:33.974Z', 24_530, 24_759),
  entry('13:02:35.740Z', 24_759, 27_019),
  entry('13:17:38.584Z', 27_019, 29_279),
  entry('13:32:41.768Z', 29_279, 30_000),
];

// The newer account's — the same counter, from the second document.
const NEWER_ENTRIES = [
  entry('02:14:53.688Z', 0, 475),
  entry('02:29:56.633Z', 475, 500),
  entry('02:44:57.679Z', 500, 2_560),
  entry('03:00:01.017Z', 2_560, 4_800),
  entry('03:15:05.508Z', 4_800, 7_050),
  entry('03:30:09.405Z', 7_050, 9_310),
  entry('03:45:12.403Z', 9_310, 11_570),
  entry('04:00:15.891Z', 11_570, 13_830),
  entry('04:15:19.570Z', 13_830, 14_848),
  entry('04:31:33.411Z', 14_848, 14_858),
  entry('04:46:34.417Z', 14_858, 16_396),
  entry('05:01:37.331Z', 16_396, 17_738),
  entry('05:16:38.560Z', 17_738, 19_998),
  entry('05:31:41.541Z', 19_998, 20_823),
  entry('12:32:30.124Z', 22_825, 23_748),
  entry('12:41:55.691Z', 23_748, 24_329, 'worker'),
  entry('12:47:33.980Z', 24_329, 24_759),
  entry('13:02:35.744Z', 24_759, 27_019),
  entry('13:17:38.579Z', 27_019, 29_279),
  entry('13:32:41.752Z', 29_279, 30_000),
];

const olderRow = { user: OLDER, date: '2026-09-21', timezone: 'Asia/Kolkata', walkedSteps: 30_000, entries: OLDER_ENTRIES };
const newerRow = { user: NEWER, date: '2026-09-21', timezone: 'Asia/Kolkata', walkedSteps: 30_000, entries: NEWER_ENTRIES };

describe('sampleTotalsOf', () => {
  it('keeps the increases that are samples, and only those big enough to compare', () => {
    const totals = sampleTotalsOf(olderRow).map(s => s.total);
    expect(totals).toContain(2_560);
    expect(totals).toContain(27_019);
    expect(totals).not.toContain(475); // too small a total
    expect(totals).not.toContain(14_858); // +10 is not a sample
  });
});

describe('findSharedGroups', () => {
  it('puts the 21 Sep pair in one group, older account keeping', () => {
    const groups = findSharedGroups([olderRow, newerRow]);
    expect(groups).toHaveLength(1);
    expect(groups[0].keeper).toBe(OLDER);
    expect(groups[0].held).toHaveLength(1);
    expect(groups[0].held[0].user).toBe(NEWER);
    expect(groups[0].held[0].matches).toBeGreaterThanOrEqual(14);
  });

  it('is unmoved by which order the rows come in', () => {
    const groups = findSharedGroups([newerRow, olderRow]);
    expect(groups[0].keeper).toBe(OLDER);
  });

  it('needs one match more than the live rule', () => {
    expect(REVERSAL_SHARED_MIN_MATCHES).toBe(3);
    const two = (user, offsetMs) => ({
      user,
      entries: [
        { at: new Date(new Date('2026-09-21T03:00:00Z').getTime() + offsetMs), from: 0, to: 2_560, delta: 2_560 },
        { at: new Date(new Date('2026-09-21T03:15:00Z').getTime() + offsetMs), from: 2_560, to: 4_800, delta: 2_240 },
      ],
    });
    expect(findSharedGroups([two(OLDER, 0), two(NEWER, 40)])).toHaveLength(0);
  });

  it('leaves two honest walkers who cross the same total together alone', () => {
    const a = {
      user: OLDER,
      entries: [
        entry('03:00:00.000Z', 0, 1_200),
        entry('03:15:00.000Z', 1_200, 2_900),
        entry('03:30:00.000Z', 2_900, 3_650),
      ],
    };
    const b = {
      user: NEWER,
      entries: [
        entry('03:00:30.000Z', 0, 1_200), // the one coincidence
        entry('03:15:30.000Z', 1_200, 2_100),
        entry('03:30:30.000Z', 2_100, 3_900),
      ],
    };
    expect(findSharedGroups([a, b])).toHaveLength(0);
  });

  it('folds three copies of one app into one group', () => {
    const THIRD = '6a7b000000000000000000ff';
    const third = { ...newerRow, user: THIRD };
    const groups = findSharedGroups([olderRow, newerRow, third]);
    expect(groups).toHaveLength(1);
    expect(groups[0].keeper).toBe(OLDER);
    expect(groups[0].held.map(h => h.user).sort()).toEqual([NEWER, THIRD].sort());
  });

  it('does not group two accounts that share a total hours apart', () => {
    const shifted = {
      ...newerRow,
      entries: NEWER_ENTRIES.map(e => ({ ...e, at: new Date(e.at.getTime() + 4 * 60 * 60_000) })),
    };
    expect(findSharedGroups([olderRow, shifted])).toHaveLength(0);
  });
});

describe('replayDay', () => {
  it('refuses on the 21 Sep day what the live rule would have', () => {
    const r = replayDay(olderRow);
    expect(r.recorded).toBe(30_000);
    // The first refusal is the fourth +2,260, at 05:16 UTC.
    expect(r.holds[0]).toMatchObject({ at: '2026-09-21T05:16:38.556Z', source: 'native_service', raw: 19_998 });
    expect(r.holds[0].reason).toMatch(/4 times today/);
    // The ledger's last figure is the clamped 30,000 rather than the raw
    // 31,539, so the final window reads as +721 and is accepted — the replay
    // can only refuse less than live did. Three windows go: 6,780 steps.
    expect(r.replayed).toBe(30_000 - 3 * 2_260);
    expect(r.refused).toBe(3 * 2_260);
  });

  it('leaves an ordinary day untouched', () => {
    const gains = [900, 1_400, 300, 1_700, 650, 1_100, 2_000, 400, 1_250, 800, 1_500, 200];
    let live = 0;
    const entries = gains.map((g, i) => {
      const from = live;
      live += g;
      return entry(`${String(3 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00.000Z`, from, live);
    });
    const r = replayDay({ user: OLDER, date: '2026-09-21', timezone: 'Asia/Kolkata', walkedSteps: live, entries });
    expect(r.refused).toBe(0);
    expect(r.holds).toHaveLength(0);
  });

  it('never restores above what was recorded', () => {
    const r = replayDay({ ...olderRow, walkedSteps: 20_000 });
    expect(r.replayed).toBeLessThanOrEqual(20_000);
    expect(r.refused).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Which ledger rows a correction removes.
// ─────────────────────────────────────────────────────────────────────────────

const { rowsToVoidFor, dayWindowMs } = require('../scripts/reverseSpoofedSteps');

describe('rowsToVoidFor', () => {
  // The older account's 21 Sep ledger, abridged: one passive row per paid
  // window, and the goal bonus claimed in the evening.
  const passive = (at, steps, previousSteps, amount) => ({
    _id: `${at}`,
    type: 'EARNED',
    source: 'PASSIVE_STEPS',
    amount,
    createdAt: new Date(`2026-09-21T${at}`),
    metadata: { date: '2026-09-21', steps, previousSteps },
  });
  const goal = {
    _id: 'goal',
    type: 'EARNED',
    source: 'DAILY_STEP_GOAL',
    amount: 13,
    createdAt: new Date('2026-09-21T17:59:23.445Z'),
    metadata: { date: '2026-09-21' },
  };
  const paid = [
    passive('04:00:16.330Z', 13_830, 11_570, 2.185),
    passive('04:15:19.580Z', 14_848, 13_830, 0.95),
    passive('05:01:37.360Z', 17_738, 16_396, 1.33),
    passive('05:16:38.580Z', 19_998, 17_738, 2.09),
    passive('05:31:41.490Z', 20_823, 19_998, 0.855),
    passive('13:02:35.760Z', 27_019, 24_759, 2.09),
    passive('13:17:38.600Z', 29_279, 27_019, 2.185),
    passive('13:32:41.786Z', 30_000, 29_279, 0.76),
    goal,
  ];

  it('removes everything for a day restored to zero', () => {
    const rows = rowsToVoidFor({ restoredSteps: 0, goalSnapshot: 10_000 }, paid);
    expect(rows).toHaveLength(paid.length);
  });

  it('removes only the rows paid for the refused syncs on a partial day', () => {
    // What replayDay found on 21 Sep: refused at 05:16 (19,998), 13:02
    // (27,019) and 13:17 (29,279). Restored 23,220, still over the goal.
    const day = {
      restoredSteps: 23_220,
      bonusSteps: 0,
      goalSnapshot: 10_000,
      refusedSyncs: [
        { at: '2026-09-21T05:16:38.556Z', raw: 19_998 },
        { at: '2026-09-21T13:02:35.740Z', raw: 27_019 },
        { at: '2026-09-21T13:17:38.584Z', raw: 29_279 },
      ],
    };
    const rows = rowsToVoidFor(day, paid);
    expect(rows.map(r => r.metadata.steps)).toEqual([19_998, 27_019, 29_279]);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(2.09 + 2.09 + 2.185, 3);
    // The goal is still met at 23,220, so its bonus stays.
    expect(rows.find(r => r.source === 'DAILY_STEP_GOAL')).toBeUndefined();
  });

  it('takes the goal bonus too once the corrected day no longer meets the goal', () => {
    const day = {
      restoredSteps: 8_000,
      bonusSteps: 0,
      goalSnapshot: 10_000,
      refusedSyncs: [{ at: '2026-09-21T13:17:38.584Z', raw: 29_279 }],
    };
    const rows = rowsToVoidFor(day, paid);
    expect(rows.map(r => r._id)).toEqual(['13:17:38.600Z', 'goal']);
  });

  it('matches by the minute when the paid-up-to figure differs', () => {
    // A row whose `steps` is the stored total rather than the stream's raw
    // — still the same sync, written seconds after it arrived.
    const day = {
      restoredSteps: 23_220,
      bonusSteps: 0,
      goalSnapshot: 10_000,
      refusedSyncs: [{ at: '2026-09-21T13:02:35.740Z', raw: 27_100 }],
    };
    const rows = rowsToVoidFor(day, paid);
    expect(rows.map(r => r.metadata.steps)).toEqual([27_019]);
  });

  it('cannot match a partial day with no refused syncs, and says so', () => {
    expect(rowsToVoidFor({ restoredSteps: 23_220, goalSnapshot: 10_000 }, paid)).toBeNull();
  });

  it('has nothing to remove when nothing was paid', () => {
    expect(rowsToVoidFor({ restoredSteps: 0 }, [])).toEqual([]);
  });
});

describe('dayWindowMs', () => {
  it('spans the local day in the user zone', () => {
    const w = dayWindowMs('2026-09-21', 'Asia/Kolkata');
    expect(new Date(w.start).toISOString()).toBe('2026-09-20T18:30:00.000Z');
    expect(new Date(w.end).toISOString()).toBe('2026-09-21T18:30:00.000Z');
  });
});

describe('findSharedGroups — 12 Sep, six steps apart', () => {
  const e12 = (at, from, to, src = 'native_service') => ({
    at: new Date(`2026-09-12T${at}`), from, to, delta: to - from, clientSource: src,
  });
  const olderSep12 = {
    user: OLDER, date: '2026-09-12', walkedSteps: 30_000,
    entries: [
      e12('03:06:39.000Z', 891, 1_547), e12('03:21:41.000Z', 3_419, 3_807),
      e12('03:36:42.000Z', 5_219, 6_057), e12('03:51:44.000Z', 7_469, 8_307),
      e12('04:06:46.000Z', 9_709, 10_557), e12('05:52:07.000Z', 25_429, 26_187),
      e12('10:08:19.000Z', 27_669, 28_407),
    ],
  };
  const newerSep12 = {
    user: NEWER, date: '2026-09-12', walkedSteps: 30_000,
    entries: [
      e12('03:06:39.020Z', 113, 1_541), e12('03:21:41.020Z', 1_541, 3_801),
      e12('03:36:42.020Z', 3_801, 6_051), e12('03:51:44.020Z', 6_051, 8_301),
      e12('04:06:46.020Z', 8_301, 10_551), e12('05:52:07.020Z', 10_551, 26_181),
      e12('10:08:19.020Z', 26_381, 28_401),
    ],
  };

  it('groups the pair on the constant offset, newer account held', () => {
    const groups = findSharedGroups([olderSep12, newerSep12]);
    expect(groups).toHaveLength(1);
    expect(groups[0].keeper).toBe(OLDER);
    expect(groups[0].held[0].user).toBe(NEWER);
    // Six steps apart; which way round depends on pair order, and the report
    // prints the magnitude.
    expect(Math.abs(groups[0].held[0].offset)).toBe(6);
    expect(groups[0].held[0].matches).toBeGreaterThanOrEqual(4);
  });

  it('asks one more match at an offset than the live rule', () => {
    const { reversalMatchesNeeded } = require('../scripts/reverseHeldSteps');
    expect(reversalMatchesNeeded(0)).toBe(3);
    expect(reversalMatchesNeeded(-6)).toBe(4);
    const short = {
      ...newerSep12,
      entries: newerSep12.entries.slice(0, 3),
    };
    expect(findSharedGroups([olderSep12, short])).toHaveLength(0);
  });
});

describe('rowsToVoidFor — one row per refused sync', () => {
  const row = (at, steps, amount, src = 'PASSIVE_STEPS') => ({
    _id: at, type: 'EARNED', source: src, amount,
    createdAt: new Date(`2026-09-12T${at}`), metadata: { date: '2026-09-12', steps },
  });
  it('does not take an accepted row that merely sits inside the window of a refused one', () => {
    // 12 Sep: the worker posted at 04:20:06 (accepted) and the service at
    // 04:21:47 (refused). The worker's row lies 101 s from the refusal.
    const paid = [
      row('04:20:06.500Z', 12_409, 1.71), // worker, accepted
      row('04:21:47.500Z', 12_807, 0.38), // service, refused
      row('04:36:50.500Z', 15_057, 2.09), // service, refused
    ];
    const day = {
      restoredSteps: 18_352, bonusSteps: 0, goalSnapshot: 10_000,
      refusedSyncs: [
        { at: '2026-09-12T04:21:47.000Z', raw: 12_807 },
        { at: '2026-09-12T04:36:50.000Z', raw: 15_057 },
      ],
    };
    expect(rowsToVoidFor(day, paid).map(r => r.metadata.steps)).toEqual([12_807, 15_057]);
  });

  it('falls back to the nearest row in time only when no row was paid up to that total', () => {
    const paid = [
      row('04:20:06.500Z', 12_409, 1.71),
      row('04:21:50.000Z', 12_900, 0.38), // stored total differed from the raw
    ];
    const day = {
      restoredSteps: 18_352, bonusSteps: 0, goalSnapshot: 10_000,
      refusedSyncs: [{ at: '2026-09-12T04:21:47.000Z', raw: 12_807 }],
    };
    expect(rowsToVoidFor(day, paid).map(r => r._id)).toEqual(['04:21:50.000Z']);
  });

  it('spends each row once across several refused syncs', () => {
    const paid = [row('04:21:50.000Z', 12_900, 0.38)];
    const day = {
      restoredSteps: 18_352, bonusSteps: 0, goalSnapshot: 10_000,
      refusedSyncs: [
        { at: '2026-09-12T04:21:47.000Z', raw: 12_807 },
        { at: '2026-09-12T04:22:30.000Z', raw: 12_850 },
      ],
    };
    expect(rowsToVoidFor(day, paid)).toHaveLength(1);
  });
});
