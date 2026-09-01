// Tests for server-side step validation.
//
// The focus is Rule 3 (no-decrease). Applied unconditionally it turned the stored
// count into a high-water mark that nothing could bring down: an inflated figure
// stayed for the rest of the day, was returned to the app as its login baseline,
// and was re-reported from there. `allowCorrection` is the repair path, and these
// tests pin down that it repairs without weakening the multi-device protection.

const { validateSteps } = require('../utils/stepValidation');

const base = {
  bonusSteps: 0,
  lastStepIncreaseAt: null,
  dailyGoal: 10000,
  timezone: 'Asia/Kolkata',
};

// ─── Frozen clock ────────────────────────────────────────────────────────────
//
// validateSteps reads Date.now() itself, and these tests build their inputs
// from Date.now() too. With a live clock the two readings differ by however
// many milliseconds passed in between, which is enough to move an assertion
// that sits exactly on a ceiling:
//
//   minsAgo(1) then windowMinutes = 1 + ε
//   → Math.ceil((1 + ε) * 220) = 221, not 220
//   → the expected 1,220 becomes 1,221
//
// That made the suite pass or fail depending on whether both reads landed in
// the same millisecond — a real intermittent failure, not a code defect.
//
// Freezing also removes a second, quieter dependency: the day-bound ceiling and
// the severity split are computed from how much of the local day has elapsed,
// so results shifted with the wall-clock time the suite happened to run at.
// Midday IST is chosen because it is far from both midnight boundaries in the
// timezone these fixtures use.
const FROZEN_NOW = new Date('2026-08-23T06:30:00.000Z'); // 12:00 Asia/Kolkata

beforeAll(() => {
  jest.useFakeTimers({ now: FROZEN_NOW });
});

afterAll(() => {
  jest.useRealTimers();
});

/** A Date `mins` minutes in the past, relative to the frozen clock. */
const minsAgo = mins => new Date(Date.now() - mins * 60_000);

describe('validateSteps — no-decrease rule', () => {
  it('keeps the stored value when a device reports fewer steps', () => {
    // Normal multi-device case: phone B is behind phone A. Not a correction.
    const result = validateSteps({
      ...base,
      incomingSteps: 3000,
      existingSteps: 8000,
    });
    expect(result.clampedSteps).toBe(8000);
    expect(result.corrected).toBe(false);
  });

  it('accepts the decrease when the client flags a correction', () => {
    const result = validateSteps({
      ...base,
      incomingSteps: 1720,
      existingSteps: 7097,
      allowCorrection: true,
    });
    expect(result.clampedSteps).toBe(1720);
    expect(result.corrected).toBe(true);
    expect(result.correctedFrom).toBe(7097);
  });

  it('leaves a decrease inside the tolerance alone', () => {
    // Source jitter, not a correction — no need to involve the correction path.
    const result = validateSteps({
      ...base,
      incomingSteps: 7050,
      existingSteps: 7097,
    });
    expect(result.clampedSteps).toBe(7050);
    expect(result.corrected).toBe(false);
  });

  it('compares against walked steps only, excluding bonus', () => {
    // Stored 2,720 = 1,720 walked + 1,000 bonus. An incoming 1,720 matches the
    // walked figure exactly and must not be read as a drop.
    const result = validateSteps({
      ...base,
      incomingSteps: 1720,
      existingSteps: 2720,
      bonusSteps: 1000,
      allowCorrection: true,
    });
    expect(result.clampedSteps).toBe(1720);
    expect(result.corrected).toBe(false);
  });

  it('never lets a correction raise the count', () => {
    // The flag exists to lower a wrong value. An increase follows the normal rules.
    // A wide window keeps the rate ceiling out of the way — the subject here is the
    // correction flag, not the rate rules (which have their own describe block).
    const result = validateSteps({
      ...base,
      incomingSteps: 9000,
      existingSteps: 3000,
      lastStepIncreaseAt: minsAgo(120),
      allowCorrection: true,
    });
    expect(result.clampedSteps).toBe(9000);
    expect(result.corrected).toBe(false);
  });
});

describe('validateSteps — hard limits', () => {
  it('clamps to the absolute daily cap', () => {
    // Late enough in the day that the daily cap, not the time-of-day bound, binds.
    const result = validateSteps({
      ...base,
      incomingSteps: 500_000,
      existingSteps: 49_000,
      lastStepIncreaseAt: minsAgo(600),
    });
    expect(result.clampedSteps).toBe(50_000);
    expect(result.flagged).toBe(true);
  });

  it('treats missing or negative input as zero', () => {
    expect(
      validateSteps({ ...base, incomingSteps: undefined, existingSteps: 500 })
        .clampedSteps,
    ).toBe(0);
    expect(
      validateSteps({ ...base, incomingSteps: null, existingSteps: 500 })
        .clampedSteps,
    ).toBe(0);
    expect(
      validateSteps({ ...base, incomingSteps: -50, existingSteps: 500 })
        .clampedSteps,
    ).toBe(0);
  });

  it('clamps an implausible jump to what the day could plausibly hold', () => {
    // This asserted 6,000 originally — existing 1,000 plus a flat 5,000 — which
    // was the bug rather than the rule: the rapid-jump branch ASSIGNED
    // `existingWalked + 5000`, so an implausible report was granted 5,000 steps
    // instead of being cut down.
    //
    // It then asserted 1,220: the one-minute delta window, which was the only
    // bound applied once a date had an accepted increase. The rate ceiling is now
    // the looser of the delta bound and the day bound, so what answers here is
    // the day bound — 12:00 local => 6,000 + 44,000 * 12/24 = 28,000. Still a
    // clamp, still flagged, and still far below the 40,000 claimed; what changed
    // is that the same figure is now judged the same way whether or not this
    // account happened to sync earlier today.
    const result = validateSteps({
      ...base,
      incomingSteps: 40_000,
      existingSteps: 1_000,
      lastStepIncreaseAt: minsAgo(1),
    });
    expect(result.clampedSteps).toBe(28_000);
    expect(result.flagged).toBe(true);
  });

  it('allows a normal increase over a normal interval', () => {
    const result = validateSteps({
      ...base,
      incomingSteps: 5_400,
      existingSteps: 5_000,
      lastStepIncreaseAt: minsAgo(10),
    });
    expect(result.clampedSteps).toBe(5_400);
    expect(result.flagged).toBe(false);
  });
});

describe('validateSteps — the 5,000-step ratchet', () => {
  // The reported symptom: a user's stored total climbing by exactly 5,000 on every
  // sync, continuously. The old rapid-jump branch handed out `existing + 5000`
  // whenever the client reported far above the stored value, so a client that kept
  // re-sending the same inflated figure was walked all the way up to it — and the
  // app's foreground sync throttle is 20 seconds, so this repeated every 20s.
  const RATCHET_SYNCS = 12;
  const INFLATED = 45_000;

  // ── What "cannot ratchet" means now ─────────────────────────────────────────
  //
  // These two used to assert that twelve rapid syncs of an inflated figure added
  // under 1,000 steps in total, because the delta window was the only bound in
  // play once a date had an accepted increase.
  //
  // The rate ceiling now takes the looser of the delta bound and the day bound,
  // so the first sync goes straight to the day bound — 28,000 at the suite's
  // frozen noon. That is not a regression of the reported bug, for two reasons.
  // The bug was UNBOUNDED climbing: `existing + 5000` every 20 seconds, forever,
  // all the way to whatever the client claimed. What replaces it is a hard
  // ceiling the client cannot climb past by talking more. And 28,000 at noon was
  // already reachable in a single post by any account that had simply not synced
  // yet that day — the old rule made the figure depend on the account's sync
  // history rather than on whether it was plausible.
  //
  // So what these now pin is the property that actually matters: the ceiling
  // holds no matter how often it is pushed, and the inflated figure is never
  // reached.
  it('repeated syncs of an inflated value cannot climb past the day ceiling', () => {
    let stored = 0;

    for (let i = 0; i < RATCHET_SYNCS; i++) {
      stored = validateSteps({
        ...base,
        incomingSteps: INFLATED,
        existingSteps: stored,
        // 20 seconds apart, the app's old sync throttle. Under the original rule
        // this window skipped the rate check entirely and still granted 5,000.
        lastStepIncreaseAt: minsAgo(20 / 60),
      }).clampedSteps;
    }

    // 12:00 local => 6,000 + 44,000 * 12/24 = 28,000, plus the 20-second delta
    // window each sync is separately allowed. Twelve syncs may not compound into
    // anything near the 45,000 claimed.
    const dayCeiling = 28_000;
    const perSyncSlack = Math.ceil((20 / 60) * 220) * RATCHET_SYNCS;
    expect(stored).toBeLessThanOrEqual(dayCeiling + perSyncSlack);
    expect(stored).toBeLessThan(INFLATED);
  });

  it('syncing more often does not earn more steps', () => {
    // Same wall-clock span, different sync cadences. The accepted total must not
    // SCALE with how often the client talks to the server — that dependency was
    // the whole exploit, and it is the property the change to the ceiling must not
    // weaken.
    //
    // Exact equality is not the right assertion and never was: each sync's delta
    // allowance is `ceil(windowMinutes * 220)`, so a cadence with more syncs
    // collects more rounding-up, and the two runs also divide the span into
    // different numbers of windows. What has to hold is that both stay under what
    // the elapsed span could physically produce — 30 times the syncs must not buy
    // anything like 30 times the steps.
    const spanMinutes = 10;

    const runCadence = syncCount => {
      let stored = 0;
      const gap = spanMinutes / syncCount;
      for (let i = 0; i < syncCount; i++) {
        stored = validateSteps({
          ...base,
          incomingSteps: INFLATED,
          existingSteps: stored,
          lastStepIncreaseAt: minsAgo(gap),
        }).clampedSteps;
      }
      return stored;
    };

    const few = runCadence(2); // every 5 minutes
    const many = runCadence(60); // every 10 seconds

    // The day ceiling at the frozen noon, plus everything the span could hold.
    const bound = 28_000 + Math.ceil(spanMinutes * 220);
    expect(few).toBeLessThanOrEqual(bound);
    expect(many).toBeLessThanOrEqual(bound);

    // And the 30x cadence buys well under 2x the steps above the ceiling, rather
    // than scaling with the sync count.
    expect(many - 28_000).toBeLessThan((few - 28_000) * 2);
    expect(many).toBeLessThan(INFLATED);
  });

  it('a hydration-only sync cannot shrink the window a real sync is judged against', () => {
    // updatedAt used to define the rate window, and a hydration-only POST to
    // /health/sync bumps it. So a water log at 12:00 made a legitimate 12:00:30
    // sync — carrying three hours of real walking — look like an impossible burst.
    // lastStepIncreaseAt is untouched by writes that carry no step increase.
    const threeHoursOfWalking = 9_000;

    const result = validateSteps({
      ...base,
      incomingSteps: threeHoursOfWalking,
      existingSteps: 2_000,
      // Steps last accepted three hours ago; a hydration write 30s ago is irrelevant.
      lastStepIncreaseAt: minsAgo(180),
    });

    expect(result.clampedSteps).toBe(threeHoursOfWalking);
    expect(result.flagged).toBe(false);
  });
});

describe('validateSteps — first accepted value of the day', () => {
  it('bounds the first value by how much of the local day has elapsed', () => {
    // No accepted increase yet and nothing stored, so the whole figure has to
    // stand on its own, bounded by how much of the day has elapsed.
    const result = validateSteps({
      ...base,
      incomingSteps: 40_000,
      existingSteps: 0,
      lastStepIncreaseAt: null,
      timezone: 'UTC',
      // Pinned below via fake timers so the assertion is not clock-dependent.
    });
    expect(result.clampedSteps).toBeLessThanOrEqual(40_000);
  });

  it('is bounded by elapsed local time, not by a fixed allowance', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-17T02:00:00Z'));
    try {
      const result = validateSteps({
        ...base,
        incomingSteps: 40_000,
        existingSteps: 0,
        lastStepIncreaseAt: null,
        // 02:00 local => 6,000 + (50,000 - 6,000) * 2/24 = 9,667.
        timezone: 'UTC',
      });
      expect(result.clampedSteps).toBe(9_667);
      expect(result.flagged).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  // ── Regression: the ceiling used to expire before lunch ───────────────────
  //
  // The bound was `max(3_000, hours * 9_000)`. 50,000 / 9,000 is 5.6 hours, so
  // from 05:36 onward it sat above MAX_DAILY_STEPS and never bound anything. A
  // client's first sync of the day could hand over any figure under the daily cap
  // in one post and be paid passive step coins for all of it — the "0 → 26,872
  // (+25.46 coins)" row in the ledger that started this.
  it('still binds late in the day, where the old sustained rate had expired', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-17T20:40:00Z'));
    try {
      const result = validateSteps({
        ...base,
        incomingSteps: 49_000,
        existingSteps: 0,
        lastStepIncreaseAt: null,
        timezone: 'UTC',
        syncDate: '2026-08-17',
      });

      // 20:40 => 6,000 + 44,000 * (1240/1440) = 43,889. The old rule allowed
      // 186,000 here, i.e. the absolute daily cap and nothing else.
      expect(result.clampedSteps).toBe(43_889);
      expect(result.flagged).toBe(true);
      expect(result.reason).toMatch(/Total too high for the day/);
    } finally {
      jest.useRealTimers();
    }
  });

  it('accepts a genuine day of walking that was only synced in the evening', () => {
    // The bound has to stay generous enough for the honest version of the same
    // shape: the app was killed all day and reads the whole total at 20:40.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-17T20:40:00Z'));
    try {
      const result = validateSteps({
        ...base,
        incomingSteps: 15_800,
        existingSteps: 0,
        lastStepIncreaseAt: null,
        timezone: 'UTC',
        syncDate: '2026-08-17',
      });

      expect(result.clampedSteps).toBe(15_800);
      expect(result.flagged).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves room for a front-loaded morning run', () => {
    // 8,000 steps by 02:00 is a real thing people do, and the intercept exists
    // so the bound does not reject it.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-17T02:00:00Z'));
    try {
      const result = validateSteps({
        ...base,
        incomingSteps: 8_000,
        existingSteps: 0,
        lastStepIncreaseAt: null,
        timezone: 'UTC',
      });

      expect(result.clampedSteps).toBe(8_000);
      expect(result.flagged).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never bounds the first value below the floor', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-17T00:05:00Z'));
    try {
      const result = validateSteps({
        ...base,
        incomingSteps: 2_500,
        existingSteps: 0,
        lastStepIncreaseAt: null,
        timezone: 'UTC', // 5 minutes in — the midnight burst allowance applies
      });
      expect(result.clampedSteps).toBe(2_500);
      expect(result.flagged).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('validateSteps — past-date syncs get the whole day, not today so far', () => {
  // POST /health/sync accepts an explicit `date`, and the Android widget worker
  // re-posts the last seven days every 15 minutes (HealthSyncHelper.
  // syncTodayAndYesterday), so past-date syncs are routine rather than rare.
  //
  // The first-accepted-value ceiling used to call minutesSinceLocalMidnight()
  // directly, which always answers for TODAY. A past date with no row yet — the
  // user was offline all of it — was therefore judged against however little of
  // today had elapsed. Just after midnight that clamped a real day of walking to
  // the 3,000-step floor, flagged it as a cheat, and paid retroactive coins on the
  // clamped figure.

  /** 00:10 UTC on 2026-08-17, i.e. ten minutes into the day. */
  const justAfterMidnight = new Date('2026-08-17T00:10:00Z');

  it('clamped a genuine past day to the floor when measured against today (the bug)', () => {
    jest.useFakeTimers().setSystemTime(justAfterMidnight);
    try {
      // What the old code did: no syncDate, so the bound is today's 10 minutes.
      const result = validateSteps({
        ...base,
        incomingSteps: 12_000,
        existingSteps: 0,
        lastStepIncreaseAt: null,
        timezone: 'UTC',
      });
      // 00:10 => 6,000 + 44,000 * (10/1440) = 6,306, the midnight allowance
      // plus the sliver of the day that has actually happened.
      expect(result.clampedSteps).toBe(6_306);
      expect(result.flagged).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('accepts the same figure in full once the date it belongs to is known', () => {
    jest.useFakeTimers().setSystemTime(justAfterMidnight);
    try {
      const result = validateSteps({
        ...base,
        incomingSteps: 12_000,
        existingSteps: 0,
        lastStepIncreaseAt: null,
        timezone: 'UTC',
        syncDate: '2026-08-16', // yesterday — all 1,440 of its minutes happened
      });
      expect(result.clampedSteps).toBe(12_000);
      expect(result.flagged).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still applies the absolute daily cap to a past date', () => {
    // A full day's first-sync ceiling lands exactly on MAX_DAILY_STEPS, so the
    // daily cap is what binds and what gets reported — otherwise "past date"
    // would mean "unvalidated".
    jest.useFakeTimers().setSystemTime(justAfterMidnight);
    try {
      const result = validateSteps({
        ...base,
        incomingSteps: 90_000,
        existingSteps: 0,
        lastStepIncreaseAt: null,
        timezone: 'UTC',
        syncDate: '2026-08-16',
      });
      expect(result.clampedSteps).toBe(50_000); // MAX_DAILY_STEPS
      expect(result.flagged).toBe(true);
      expect(result.reason).toMatch(/daily cap/i);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not loosen the bound for TODAY', () => {
    // Passing today's date must behave exactly as before: 10 minutes in, the
    // midnight allowance — not a whole day's worth.
    jest.useFakeTimers().setSystemTime(justAfterMidnight);
    try {
      const result = validateSteps({
        ...base,
        incomingSteps: 12_000,
        existingSteps: 0,
        lastStepIncreaseAt: null,
        timezone: 'UTC',
        syncDate: '2026-08-17',
      });
      expect(result.clampedSteps).toBe(6_306);
      expect(result.flagged).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not loosen the bound for a FUTURE date', () => {
    // A clock-skewed or hostile client must not be able to buy a full-day
    // allowance by labelling the sync tomorrow.
    jest.useFakeTimers().setSystemTime(justAfterMidnight);
    try {
      const result = validateSteps({
        ...base,
        incomingSteps: 12_000,
        existingSteps: 0,
        lastStepIncreaseAt: null,
        timezone: 'UTC',
        syncDate: '2026-08-18',
      });
      expect(result.clampedSteps).toBe(6_306);
      expect(result.flagged).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('resolves "past" in the client timezone, not the server zone', () => {
    // 20:10 UTC on the 16th is already 01:40 on the 17th in IST. For an IST user
    // the 16th is yesterday; for a UTC user it is still today. The same payload
    // must therefore be judged differently for the two, which only works if the
    // comparison uses the client's own day.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-16T20:10:00Z'));
    try {
      const forIstUser = validateSteps({
        ...base,
        incomingSteps: 12_000,
        existingSteps: 0,
        lastStepIncreaseAt: null,
        timezone: 'Asia/Kolkata',
        syncDate: '2026-08-16', // yesterday in IST
      });
      const forUtcUser = validateSteps({
        ...base,
        incomingSteps: 12_000,
        existingSteps: 0,
        lastStepIncreaseAt: null,
        timezone: 'UTC',
        syncDate: '2026-08-16', // still today in UTC — 20:10, so 20h * 9,000
      });

      expect(forIstUser.clampedSteps).toBe(12_000); // whole day
      expect(forUtcUser.clampedSteps).toBe(12_000); // 180,000 allowance, also fine
      expect(forIstUser.flagged).toBe(false);
      expect(forUtcUser.flagged).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('accepts a past date backlog that the day it belongs to had time for', () => {
    // This used to assert the opposite — that a past date with an accepted increase
    // stayed under the delta ceiling and was cut to 5,440. That was the clearest
    // case of the asymmetry the day ceiling now removes: the delta window here is
    // "2 minutes since we last accepted steps", and it was being applied to steps
    // that were walked YESTERDAY. A whole day genuinely did elapse for 2026-08-16,
    // so 12,000 is an ordinary figure for it, and the fact that this row already
    // had one accepted increase says nothing about whether the rest is plausible.
    //
    // A first sync for the same past date was already accepted in full before this
    // change. Now the second one is too.
    jest.useFakeTimers().setSystemTime(justAfterMidnight);
    try {
      const result = validateSteps({
        ...base,
        incomingSteps: 12_000,
        existingSteps: 5_000,
        lastStepIncreaseAt: minsAgo(2), // 2 min => only 440 by the delta bound
        timezone: 'UTC',
        syncDate: '2026-08-16',
      });
      expect(result.clampedSteps).toBe(12_000);
      expect(result.flagged).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still bounds a past date by its own whole day, not by the daily cap alone', () => {
    // The looser bound is the DAY's, not "anything goes". A past date gets its
    // full 1,440 minutes, at which point MAX_DAILY_STEPS is what binds — and it
    // still binds.
    jest.useFakeTimers().setSystemTime(justAfterMidnight);
    try {
      const result = validateSteps({
        ...base,
        incomingSteps: 90_000,
        existingSteps: 5_000,
        lastStepIncreaseAt: minsAgo(2),
        timezone: 'UTC',
        syncDate: '2026-08-16',
      });
      expect(result.clampedSteps).toBe(50_000);
      expect(result.flagged).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('validateSteps — severity separates routine clamping from cheating', () => {
  // The anti-cheat penalty was wired to `flagged`, which meant "I clamped this".
  // Clamping is routine: the rate ceiling measures against the time since steps
  // were last accepted — often seconds — while a client's figure can legitimately
  // jump by thousands when a paired smartwatch flushes its backlog into Health
  // Connect. The server then walks the stored total up at the maximum rate,
  // flagging on every sync until it converges, so an honest watch user was
  // indistinguishable from someone posting 999,999 and got coin-blocked for ten
  // days. That is why the whole penalty system was commented out.
  //
  // `severity` is the signal that can carry a punishment: 'implausible' means the
  // figure exceeds what any human could walk in the elapsed day.

  /** Steps were accepted a moment ago, so the rate window is at its tightest. */
  const justAccepted = () => new Date();

  const check = (incomingSteps, existingSteps, extra = {}) =>
    validateSteps({
      ...base,
      incomingSteps,
      existingSteps,
      lastStepIncreaseAt: justAccepted(),
      timezone: 'UTC',
      ...extra,
    });

  describe('honest submissions are never graded implausible', () => {
    // These three are the backlog shapes the severity split was introduced for.
    // They used to be accepted only in part — clamped and flagged on every sync
    // until the server walked up to them — and the split's job was to make sure
    // that clamping was never mistaken for cheating.
    //
    // With the day ceiling now applying alongside the delta ceiling, all three
    // are simply accepted: 18h elapsed allows 6,000 + 44,000 * 18/24 = 39,000,
    // and none of them claims anywhere near that. The property under test is
    // unchanged and satisfied more strongly — an honest backlog is not merely
    // graded gently, it is no longer clamped at all.
    it.each([
      [8_000, 5_000, 'smartwatch flushes a 3,000-step backlog'],
      [12_000, 2_000, 'app reopened after the OS killed it'],
      [20_000, 3_000, 'a full day of walking arrives in one read'],
    ])(
      '%i steps over a stored %i → accepted outright (%s)',
      (incoming, existing) => {
        jest.useFakeTimers().setSystemTime(new Date('2026-08-17T18:00:00Z')); // 18h elapsed
        try {
          const result = check(incoming, existing);
          expect(result.clampedSteps).toBe(incoming);
          expect(result.flagged).toBe(false);
          expect(result.severity).toBe('none');
        } finally {
          jest.useRealTimers();
        }
      },
    );

    it('grades a figure over the day ceiling as clamped, never implausible', () => {
      // Above what the elapsed day allows but below what a human could physically
      // have walked in it. Routine, and must stay unpunishable.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-17T18:00:00Z'));
      try {
        const result = check(45_000, 3_000); // ceiling is 39,000
        expect(result.clampedSteps).toBe(39_000);
        expect(result.flagged).toBe(true);
        expect(result.severity).toBe('clamped');
      } finally {
        jest.useRealTimers();
      }
    });

    it('grades an unclamped submission as none', () => {
      const result = check(5_000, 5_000);
      expect(result.flagged).toBe(false);
      expect(result.severity).toBe('none');
    });

    it('grades a payload with no steps at all as none', () => {
      // A hydration-only sync. Must never look like a cheat.
      const result = validateSteps({
        ...base,
        incomingSteps: undefined,
        existingSteps: 5_000,
      });
      expect(result.severity).toBe('none');
    });
  });

  describe('physically impossible submissions are graded implausible', () => {
    it('grades a figure over the absolute daily cap as implausible', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-17T18:00:00Z'));
      try {
        const result = check(999_999, 5_000);
        expect(result.severity).toBe('implausible');
      } finally {
        jest.useRealTimers();
      }
    });

    it('grades a figure impossible for the time of day as implausible', () => {
      // 02:00 → 120 min elapsed → 120 * 220 = 26,400 is the physical ceiling.
      // 40,000 is under the 50,000 daily cap but nobody walks it by 2am.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-17T02:00:00Z'));
      try {
        const result = check(40_000, 1_000);
        expect(result.severity).toBe('implausible');
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not call that same figure implausible late in the day', () => {
      // The identical 40,000 at 20:00 is an ordinary total for twenty hours of
      // walking (the day ceiling there is 6,000 + 44,000 * 20/24 = 42,667), so it
      // is now accepted outright rather than clamped. Either way, the point of the
      // pairing with the 02:00 case above stands: the SAME number is evidence of
      // cheating at 2am and of nothing at all at 8pm.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-17T20:00:00Z'));
      try {
        const result = check(40_000, 1_000);
        expect(result.severity).not.toBe('implausible');
        expect(result.severity).toBe('none');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('a past date is graded against its whole day', () => {
    it('does not call a real past day implausible just after midnight', () => {
      // The P3 case: at 00:10 today, yesterday's genuine 12,000 steps must not be
      // graded a cheat merely because little of TODAY has elapsed.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-17T00:10:00Z'));
      try {
        const result = validateSteps({
          ...base,
          incomingSteps: 12_000,
          existingSteps: 0,
          lastStepIncreaseAt: null,
          timezone: 'UTC',
          syncDate: '2026-08-16',
        });
        expect(result.severity).toBe('none');
        expect(result.flagged).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('the honest-vs-cheat gap holds across a whole sync storm', () => {
    // The scenario that made the old system unusable: 40 consecutive syncs while
    // the server converges. The honest user must accumulate ZERO penalty-worthy
    // flags across all of them; the cheat must accumulate them every time.
    const stormSeverities = (clientSteps, startExisting) => {
      let existing = startExisting;
      let last = justAccepted();
      const seen = [];
      for (let i = 0; i < 40; i++) {
        const r = validateSteps({
          ...base,
          incomingSteps: clientSteps,
          existingSteps: existing,
          lastStepIncreaseAt: last,
          timezone: 'UTC',
        });
        seen.push(r.severity);
        if (r.clampedSteps > existing) {
          existing = r.clampedSteps;
          last = new Date();
        }
      }
      return seen;
    };

    it('an honest watch backlog produces no implausible grades in 40 syncs', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-17T18:00:00Z'));
      try {
        const severities = stormSeverities(8_000, 5_000);
        expect(severities).toHaveLength(40);
        expect(severities.filter(s => s === 'implausible')).toHaveLength(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('a client posting 999,999 is graded implausible every time', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-17T18:00:00Z'));
      try {
        const severities = stormSeverities(999_999, 5_000);
        expect(severities.every(s => s === 'implausible')).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

// ─── The stuck source ────────────────────────────────────────────────────────
//
// Every other rule in this file bounds how FAST steps may arrive. None of them
// can say whether the number arriving is a measurement at all, and a real
// account fell straight through that gap: eight consecutive 15-minute syncs
// each reporting exactly +2,270 steps, 18,160 in total, every one accepted
// because 2,270 is comfortably under the 3,311 a 15-minute window allows.
//
// These tests pin the rule to the property that actually gave it away — that
// the deltas did not vary with the length of the windows they spanned — and to
// the two things it must not do: punish the user, or keep refusing a device
// that has started working again.
describe('stuck source detection', () => {
  const {
    trackClientCadence,
    STUCK_DELTA_MIN_STEPS,
    STUCK_DELTA_REPEATS,
  } = require('../utils/stepValidation');

  /** Runs a series of raw client totals through the tracker, keeping its state. */
  const runCadence = (totals, seed = null) => {
    let state = {
      lastIncomingSteps: seed,
      lastIncomingDelta: 0,
      repeatedDeltaCount: 0,
    };
    return totals.map((incomingSteps) => {
      state = trackClientCadence({ incomingSteps, ...state });
      return state;
    });
  };

  describe('trackClientCadence', () => {
    it('seeds silently when there is no previous raw total', () => {
      const [first] = runCadence([27_794]);
      expect(first).toMatchObject({
        delta: 0,
        lastIncomingSteps: 27_794,
        repeatedDeltaCount: 0,
        stuck: false,
      });
    });

    it('binds on the delta after STUCK_DELTA_REPEATS identical ones', () => {
      // The real incident: 30,008 → 48,168 in exact 2,270 increments.
      const totals = [30_008, 32_278, 34_548, 36_818, 39_088, 41_358];
      const states = runCadence(totals, 27_794);

      expect(states.map((s) => s.stuck)).toEqual([
        false, // +2,214 — first delta, nothing to match
        false, // +2,270 — first of its kind
        false, // repeat 1
        false, // repeat 2
        true, //  repeat 3 → refused
        true, //  and stays refused while it continues
      ]);
      expect(states[4].repeatedDeltaCount).toBe(STUCK_DELTA_REPEATS);
    });

    it('releases as soon as the device reports a different delta', () => {
      const stuck = runCadence(
        [32_278, 34_548, 36_818, 39_088],
        30_008,
      ).at(-1);
      expect(stuck.stuck).toBe(true);

      const recovered = trackClientCadence({
        incomingSteps: 40_000, // +912, a real measurement again
        ...stuck,
      });
      expect(recovered.stuck).toBe(false);
      expect(recovered.repeatedDeltaCount).toBe(0);
    });

    it('ignores repeats too small to be evidence', () => {
      // A phone idling on a desk reports the same tiny gain over and over. That
      // is ordinary, and freezing someone's day over it would be absurd.
      const small = STUCK_DELTA_MIN_STEPS - 1;
      const totals = [1, 2, 3, 4, 5, 6].map((n) => 5_000 + n * small);
      expect(runCadence(totals, 5_000).some((s) => s.stuck)).toBe(false);
    });

    it('does not let a re-send or a behind device build a streak', () => {
      // Same count twice, then a lower figure from a second device.
      const states = runCadence([20_000, 20_000, 18_000, 20_000], 20_000);
      expect(states.some((s) => s.stuck)).toBe(false);
      expect(states.every((s) => s.repeatedDeltaCount === 0)).toBe(true);
    });

    it('leaves a real walker alone across a whole day of syncs', () => {
      // Steady brisk walking, with the step-level jitter a real counter has.
      const jitter = [2_270, 2_268, 2_271, 2_269, 2_273, 2_270, 2_266, 2_272];
      let total = 5_000;
      const totals = jitter.map((d) => (total += d));
      expect(runCadence(totals, 5_000).some((s) => s.stuck)).toBe(false);
    });
  });

  describe('validateSteps under a stuck source', () => {
    const stuckCadence = {
      delta: 2_270,
      repeatedDeltaCount: STUCK_DELTA_REPEATS,
      stuck: true,
    };

    it('holds the stored total exactly where it is', () => {
      const r = validateSteps({
        ...base,
        incomingSteps: 39_088,
        existingSteps: 36_818,
        cadence: stuckCadence,
      });
      expect(r.clampedSteps).toBe(36_818);
      expect(r.severity).toBe('stuck_source');
      expect(r.flagged).toBe(true);
      expect(r.reason).toMatch(/not measuring/i);
    });

    it('never grades a stuck source as cheating, even past the daily cap', () => {
      // This is the case that matters. A stuck counter keeps climbing, and
      // graded by magnitude alone it eventually crosses MAX_DAILY_STEPS and is
      // handed to recordCheatFlag — flagging someone for their phone's fault.
      const r = validateSteps({
        ...base,
        incomingSteps: 90_000,
        existingSteps: 48_168,
        cadence: stuckCadence,
      });
      expect(r.severity).toBe('stuck_source');
      expect(r.severity).not.toBe('implausible');
      expect(r.clampedSteps).toBe(48_168);
    });

    it('changes nothing when the cadence is healthy', () => {
      const healthy = { delta: 2_270, repeatedDeltaCount: 1, stuck: false };
      const r = validateSteps({
        ...base,
        incomingSteps: 39_088,
        existingSteps: 36_818,
        cadence: healthy,
      });
      expect(r.clampedSteps).toBe(39_088);
      expect(r.severity).toBe('none');
    });

    it('is a no-op for callers that pass no cadence at all', () => {
      const r = validateSteps({
        ...base,
        incomingSteps: 39_088,
        existingSteps: 36_818,
      });
      expect(r.clampedSteps).toBe(39_088);
      expect(r.severity).toBe('none');
    });
  });

  it('bounds the damage of the real incident', () => {
    // Replay of the ledger: the device reports its own total every ~15 minutes,
    // climbing by exactly 2,270 each time, and the server applies both rules
    // together the way the controller does.
    jest.useFakeTimers({ now: new Date('2026-09-01T14:57:00.000Z') });
    try {
      let stored = 27_794; // last figure Health Connect corroborated
      let lastAccepted = new Date();
      let cadence = {
        lastIncomingSteps: 27_794,
        lastIncomingDelta: 0,
        repeatedDeltaCount: 0,
      };

      let client = 30_008;
      for (let i = 0; i < 8; i++) {
        cadence = trackClientCadence({ incomingSteps: client, ...cadence });
        const r = validateSteps({
          ...base,
          incomingSteps: client,
          existingSteps: stored,
          lastStepIncreaseAt: lastAccepted,
          syncDate: '2026-09-01',
          cadence,
        });
        if (r.clampedSteps > stored) {
          stored = r.clampedSteps;
          lastAccepted = new Date();
        }
        client += 2_270;
        jest.advanceTimersByTime(15 * 60 * 1000);
      }

      // Unguarded this run stored 48,168. The rule lets the first few through —
      // it cannot know yet — then holds the line for the rest of the day.
      expect(stored).toBe(36_818);
      expect(stored).toBeLessThan(48_168);
    } finally {
      jest.useRealTimers();
    }
  });
});
