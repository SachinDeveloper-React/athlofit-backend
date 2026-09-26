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

// Several tests below set their own clock and then call jest.useRealTimers()
// in a `finally`, which discards the frozen clock for every test after them.
// That made the rest of the file depend on the wall-clock time of day again —
// it failed in the minutes after midnight IST, when "today so far" is almost
// nothing. Re-freeze before every test so no test inherits another's clock.
beforeEach(() => {
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
    // A past date, because that is now the only way the daily cap is the binding
    // rule. The day ceiling is hard (it used to be overridable by the looser
    // delta bound), and it only reaches MAX_DAILY_STEPS when a whole day has
    // elapsed — so for TODAY the time-of-day bound always binds first.
    const result = validateSteps({
      ...base,
      incomingSteps: 500_000,
      existingSteps: 49_000,
      syncDate: '2026-08-22', // the day before the frozen clock
    });
    expect(result.clampedSteps).toBe(50_000);
    expect(result.flagged).toBe(true);
  });

  it('will not grow a total the elapsed day has no room for', () => {
    // Same figures against TODAY at noon. The day ceiling says 28,000 and the
    // stored total is already 49,000, so the answer is "no further", not a
    // clawback to 28,000 — ceilings stop growth, the no-decrease rule owns
    // decreases, and a ceiling that pushed the total down would be flagged and
    // then immediately undone on every sync for the rest of the day.
    const result = validateSteps({
      ...base,
      incomingSteps: 500_000,
      existingSteps: 49_000,
    });
    expect(result.clampedSteps).toBe(49_000);
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

    // Both land exactly on the day ceiling at the frozen noon. This used to need
    // a tolerance — each sync carried its own delta allowance, so a denser cadence
    // collected more rounding-up and the assertion could only bound the drift.
    // With the delta ceiling gone there is nothing left for cadence to buy, and
    // the property the exploit violated now holds exactly.
    expect(few).toBe(28_000);
    expect(many).toBe(28_000);
    expect(many).toBe(few);
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

    // A past date, so the whole day is available to the figure: under the
    // frozen noon clock, 39,088 "today" is over the half-day ceiling, and
    // these two used to pass only because an earlier test had un-frozen it.
    const PAST = '2026-08-22';

    it('changes nothing when the cadence is healthy', () => {
      const healthy = { delta: 2_270, repeatedDeltaCount: 1, stuck: false };
      const r = validateSteps({
        ...base,
        incomingSteps: 39_088,
        existingSteps: 36_818,
        syncDate: PAST,
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
        syncDate: PAST,
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

// ─────────────────────────────────────────────────────────────────────────────
// The per-user ceiling, and the incident it was written for.
// ─────────────────────────────────────────────────────────────────────────────

const {
  computeStepBaseline,
  BASELINE_FLOOR,
  MAX_BASELINE_CEILING,
  BASELINE_MIN_DAYS,
} = require('../utils/stepValidation');

describe('computeStepBaseline', () => {
  const days = (n, value) => Array.from({ length: n }, () => value);

  it('gives a new account the floor and nothing more', () => {
    expect(computeStepBaseline([])).toBe(BASELINE_FLOOR);
  });

  it('will not characterise an account on too few days', () => {
    // One enormous day must not become a licence. Below the minimum the history
    // is ignored entirely rather than extrapolated from.
    const almost = days(BASELINE_MIN_DAYS - 1, 40_000);
    expect(computeStepBaseline(almost)).toBe(BASELINE_FLOOR);
  });

  it('sets the ceiling from a good day, not an average one', () => {
    // Twenty-five quiet days and three 12,000 days. The mean is 3,071 — a ceiling
    // built on it would clamp this user every time they walked properly. p90 picks
    // out the good days instead.
    const history = [...days(25, 2_000), ...days(3, 12_000)];
    expect(computeStepBaseline(history)).toBe(Math.ceil(12_000 * 1.75));
  });

  it('is not moved by a single exceptional day', () => {
    // The other side of that choice, and the reason it is p90 and not the max: one
    // big day is not yet a habit, so it must not raise the ceiling on its own.
    const history = [...days(27, 2_000), 40_000];
    expect(computeStepBaseline(history)).toBe(BASELINE_FLOOR);
  });

  it('never drops below the floor for a quiet account', () => {
    // Someone averaging 800 steps a day is not thereby limited to 1,400: the
    // ceiling exists to catch fabrication, not to hold sedentary users down.
    expect(computeStepBaseline(days(28, 800))).toBe(BASELINE_FLOOR);
  });

  it('caps at the roof however good the history looks', () => {
    // The case that matters while poisoned history is still being cleaned up:
    // a run of fabricated 45,000-step days must not unlock the full daily cap.
    expect(computeStepBaseline(days(28, 45_000))).toBe(MAX_BASELINE_CEILING);
  });

  it('ignores junk entries rather than being skewed by them', () => {
    const history = [...days(10, 12_000), null, undefined, NaN, -5];
    expect(computeStepBaseline(history)).toBe(Math.ceil(12_000 * 1.75));
  });

  it('leaves the ten honest accounts from the incident untouched', () => {
    // Their real days, from the provenance ledger. Every one of them sits under
    // the floor, so the rule never engages for any of them.
    const honestDailyMaxima = [
      13_830, 6_623, 13_014, 11_087, 3_648, 4_498, 4_341, 2_298, 1_054, 533,
    ];
    for (const max of honestDailyMaxima) {
      expect(max).toBeLessThan(BASELINE_FLOOR);
    }
  });
});

describe('validateSteps — the per-user ceiling', () => {
  it('holds a figure that is impossible for THIS account', () => {
    const result = validateSteps({
      ...base,
      incomingSteps: 26_000,
      existingSteps: 5_000,
      stepBaseline: 15_000,
    });
    expect(result.clampedSteps).toBe(15_000);
    expect(result.flagged).toBe(true);
  });

  it('grades a physically possible figure clamped, never implausible', () => {
    // A real ultramarathon lands here. It is over this account's distribution and
    // physically possible, so it must not reach recordCheatFlag.
    const result = validateSteps({
      ...base,
      incomingSteps: 26_000,
      existingSteps: 5_000,
      stepBaseline: 15_000,
    });
    expect(result.severity).toBe('clamped');
  });

  it('still grades a fabricated figure implausible', () => {
    // The ceiling must not become a laundering step. Once an account has a
    // baseline it is the lowest ceiling and therefore the one that binds — so if
    // it graded itself 'clamped', a client posting 999,999 would be graded
    // 'clamped' too and never reach the cheat path.
    const result = validateSteps({
      ...base,
      incomingSteps: 999_999,
      existingSteps: 5_000,
      stepBaseline: 15_000,
    });
    expect(result.clampedSteps).toBe(15_000);
    expect(result.severity).toBe('implausible');
  });

  it('leaves an ordinary day for that account alone', () => {
    const result = validateSteps({
      ...base,
      incomingSteps: 9_400,
      existingSteps: 9_000,
      stepBaseline: 15_000,
    });
    expect(result.clampedSteps).toBe(9_400);
    expect(result.flagged).toBe(false);
  });

  it('falls back to the population bounds when the account is uncharacterised', () => {
    // An older row with no baseline, or a failed read. It must read as "unknown",
    // never as "this user may walk zero".
    const result = validateSteps({
      ...base,
      incomingSteps: 9_400,
      existingSteps: 9_000,
      stepBaseline: null,
    });
    expect(result.clampedSteps).toBe(9_400);
    expect(result.flagged).toBe(false);
  });

  it('stops growth without clawing back what is already stored', () => {
    const result = validateSteps({
      ...base,
      incomingSteps: 40_000,
      existingSteps: 20_000,
      stepBaseline: 15_000,
    });
    expect(result.clampedSteps).toBe(20_000);
  });
});

describe('the step-spoofing incident cannot happen again', () => {
  // A replay of the real ledger for user 6a79bede on 2026-09-04. Nineteen syncs
  // 15 minutes apart, each carrying about 2,270 steps — a flat 149–153 steps per
  // minute for four and three quarter hours. Every one was accepted at the time
  // and the day closed at exactly MAX_DAILY_STEPS.
  const SYNCS = [
    ['11:44', 8_941], ['11:59', 11_211], ['12:14', 13_481], ['12:29', 15_761],
    ['12:45', 18_031], ['13:00', 20_331], ['13:15', 22_611], ['13:30', 24_851],
    ['13:45', 27_161], ['14:00', 29_441], ['14:15', 31_701], ['14:30', 33_981],
    ['14:45', 36_241], ['15:00', 38_521], ['15:15', 40_791], ['15:30', 43_061],
    ['15:45', 45_331], ['16:16', 49_881], ['16:31', 50_000],
  ];
  const DATE = '2026-09-04';

  /** The frozen clock moved to a wall time on DATE, in Asia/Kolkata (UTC+5:30). */
  const istClock = hhmm => {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(2026, 8, 4, h - 5, m - 30));
  };

  const replay = ({ stepBaseline }) => {
    let stored = 0;
    for (const [at, incoming] of SYNCS) {
      jest.setSystemTime(istClock(at));
      stored = validateSteps({
        ...base,
        incomingSteps: incoming,
        existingSteps: stored,
        syncDate: DATE,
        stepBaseline,
      }).clampedSteps;
    }
    return stored;
  };

  // Own the clock rather than inheriting it. The describe blocks above install
  // and TEAR DOWN their own fake timers (`jest.useRealTimers()` in their cleanup),
  // so by the time these run the suite-level fake clock from beforeAll is gone and
  // jest.setSystemTime is a no-op against the real one. That silently dated every
  // sync below to the real today, which is after the date they claim — so the day
  // ceiling saw a whole elapsed day, allowed MAX_DAILY_STEPS, and the replay
  // "passed through" at 50,000 while passing in isolation.
  beforeEach(() => {
    jest.useFakeTimers({ now: FROZEN_NOW });
  });

  afterEach(() => {
    jest.setSystemTime(FROZEN_NOW);
  });

  it('was accepted in full before the fix', () => {
    // Not a claim about the current code — it pins what the ledger actually shows,
    // so the numbers below are read against something rather than in isolation.
    expect(SYNCS[SYNCS.length - 1][1]).toBe(50_000);
  });

  it('is held at the account ceiling for a new account', () => {
    // The account had no clean history to characterise it, so the floor applies —
    // and the floor alone removes 35,000 of the 50,000.
    expect(replay({ stepBaseline: BASELINE_FLOOR })).toBe(BASELINE_FLOOR);
  });

  it('is held by the day ceiling even with no baseline at all', () => {
    // The other half of the fix, on its own. A client that syncs every 15 minutes
    // used to collect 220 steps/min indefinitely because the delta ceiling was
    // looser than the day ceiling and the looser one won. With the day ceiling
    // hard, the same nineteen syncs cannot reach the cap.
    const stored = replay({ stepBaseline: null });
    expect(stored).toBeLessThan(40_000);
    expect(stored).toBeLessThan(50_000);
  });

  it('never grades the run as cheating, so no user is penalised for it', () => {
    // The clamping is what stops it. Grading it 'implausible' would hand a
    // spoofed device's victim — or a genuinely fast walker — to the cheat path.
    jest.setSystemTime(istClock('14:30'));
    const result = validateSteps({
      ...base,
      incomingSteps: 33_981,
      existingSteps: 31_701,
      syncDate: DATE,
      stepBaseline: BASELINE_FLOOR,
    });
    expect(result.severity).toBe('clamped');
  });

  it('does not touch the honest day the same ledger contains', () => {
    // 2,101 steps from Google Fit — what this user actually walked that day.
    jest.setSystemTime(istClock('16:31'));
    const result = validateSteps({
      ...base,
      incomingSteps: 2_101,
      existingSteps: 1_900,
      syncDate: DATE,
      stepBaseline: BASELINE_FLOOR,
    });
    expect(result.clampedSteps).toBe(2_101);
    expect(result.flagged).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The second stuck-source detector: a rate that has stopped varying.
//
// Testing deltas for exact equality was a threshold an attacker steps over by
// adding noise. The same account came back posting 2,240 / 2,310 / 2,280 /
// 2,260 — a spread of about 1.5% — and the streak never got past two, because
// the fourth identical delta it waits for never arrived.
// ─────────────────────────────────────────────────────────────────────────────

const {
  trackClientCadence,
  STUCK_RATE_SAMPLES,
  STUCK_RATE_MIN_WINDOW_MIN,
} = require('../utils/stepValidation');

describe('stuck source — invariant rate', () => {
  const T0 = new Date('2026-09-04T06:00:00.000Z').getTime();

  /**
   * Feeds cumulative totals through trackClientCadence, carrying the state the
   * caller would have persisted, and returns every result.
   */
  const run = samples => {
    let state = {
      lastIncomingSteps: null,
      lastIncomingAt: null,
      lastIncomingDelta: 0,
      repeatedDeltaCount: 0,
      cadenceStreak: 0,
      cadenceRateMin: null,
      cadenceRateMax: null,
      cadenceStreakAt: null,
    };
    let total = 0;
    const out = [];
    for (const { gainedSteps, afterMinutes } of samples) {
      total += gainedSteps;
      const result = trackClientCadence({
        incomingSteps: total,
        at: T0 + afterMinutes * 60_000,
        ...state,
      });
      out.push(result);
      state = {
        lastIncomingSteps: result.lastIncomingSteps,
        lastIncomingAt: result.lastIncomingAt,
        lastIncomingDelta: result.lastIncomingDelta,
        repeatedDeltaCount: result.repeatedDeltaCount,
        cadenceStreak: result.cadenceStreak,
        cadenceRateMin: result.cadenceRateMin,
        cadenceRateMax: result.cadenceRateMax,
        cadenceStreakAt: result.cadenceStreakAt,
        samples: result.samples,
      };
    }
    return out;
  };

  /** `count` syncs 15 minutes apart, each gaining `steps` ± `jitter`. */
  const steadyRun = (count, steps, jitter = 0) =>
    Array.from({ length: count + 1 }, (_, i) => ({
      // The first sample only seeds; nothing is measurable until there are two.
      gainedSteps: i === 0 ? 0 : steps + (i % 2 ? jitter : -jitter),
      afterMinutes: i * 15,
    }));

  it('catches the jittered run the equality test let through', () => {
    // ±35 on 2,270 is the spread the real account produced.
    const results = run(steadyRun(12, 2_270, 35));

    expect(results.some(r => r.stuck)).toBe(true);
    // And the equality detector on its own would still be sitting at zero.
    const atStuck = results.find(r => r.stuck);
    expect(atStuck.repeatedDeltaCount).toBeLessThan(3);
    expect(atStuck.stuckReason).toMatch(/steps\/min held across/);
  });

  it('needs the span, not just the sample count', () => {
    // The same number of samples from a client that syncs every three minutes is
    // eighteen minutes of walking, which is an ordinary steady stretch. Sample
    // count is not a unit that means anything when cadence is the client's choice.
    // Jittered, so the equality detector stays out of it and this isolates the
    // rate rule — identical deltas would trip the older rule and prove nothing
    // about the span requirement.
    const rapid = Array.from({ length: STUCK_RATE_SAMPLES + 4 }, (_, i) => ({
      gainedSteps: i === 0 ? 0 : i % 2 ? 604 : 596,
      afterMinutes: i * 3,
    }));
    const results = run(rapid);

    expect(results.some(r => r.stuck)).toBe(false);
    expect(Math.max(...results.map(r => r.cadenceStreak))).toBeGreaterThanOrEqual(
      STUCK_RATE_SAMPLES,
    );
  });

  it('leaves a real walker alone', () => {
    // A human's pace over 15-minute windows: traffic lights, a sit-down, a hill.
    const paces = [1400, 900, 1750, 300, 1600, 120, 1500, 1650, 800, 1300, 1550, 400];
    const results = run([
      { gainedSteps: 0, afterMinutes: 0 },
      ...paces.map((p, i) => ({ gainedSteps: p, afterMinutes: (i + 1) * 15 })),
    ]);

    expect(results.some(r => r.stuck)).toBe(false);
  });

  it('releases as soon as the pace changes', () => {
    const results = run([
      ...steadyRun(12, 2_270, 35),
      // The device starts measuring again.
      { gainedSteps: 400, afterMinutes: 13 * 15 },
      { gainedSteps: 2_100, afterMinutes: 14 * 15 },
    ]);

    expect(results.some(r => r.stuck)).toBe(true);
    expect(results[results.length - 1].stuck).toBe(false);
  });

  it('ignores windows too short to measure a rate from', () => {
    // A burst of rapid syncs is a normal thing for the app to do. It must neither
    // build a streak out of timing noise nor clear one that is already running.
    const results = run([
      ...steadyRun(12, 2_270, 35),
      {
        gainedSteps: 900,
        afterMinutes: 12 * 15 + STUCK_RATE_MIN_WINDOW_MIN / 2,
      },
    ]);

    const beforeBurst = results[results.length - 2];
    const afterBurst = results[results.length - 1];
    expect(afterBurst.cadenceStreak).toBe(beforeBurst.cadenceStreak);
    expect(afterBurst.rate).toBeNull();
  });

  it('does not build a streak out of small deltas', () => {
    // A phone idling on a desk reports +10 all day at a perfectly flat rate. That
    // is not evidence of anything, and holding such a user's total would be a
    // pure false positive.
    const idle = Array.from({ length: 20 }, (_, i) => ({
      gainedSteps: i === 0 ? 0 : 10,
      afterMinutes: i * 15,
    }));
    const results = run(idle);

    expect(results.some(r => r.stuck)).toBe(false);
    expect(Math.max(...results.map(r => r.cadenceStreak))).toBe(0);
  });

  it('two phones on one account do not look stuck', () => {
    // Multi-device accounts must fail OPEN. Two devices each post their OWN
    // running total, so on one stream the figure keeps dropping back to the
    // other phone's lower count — and a drop clears every kind of evidence.
    // The phone in the pocket is on a flat 2,270 a window here, which on its
    // own would be refused; the second phone's figures keep interrupting it.
    let phoneA = 0;
    let phoneB = 0;
    const syncs = [{ raw: 0, afterMinutes: 0 }];
    for (let i = 1; i <= 14; i++) {
      phoneA += 2_270;
      phoneB += 400;
      syncs.push({ raw: i % 2 ? phoneA : phoneB, afterMinutes: i * 15 });
    }
    let state = {};
    const results = syncs.map(({ raw, afterMinutes }) => {
      const r = trackClientCadence({ incomingSteps: raw, at: T0 + afterMinutes * 60_000, ...state });
      state = { ...r };
      return r;
    });

    expect(results.some(r => r.stuck)).toBe(false);
  });

  it('a run interrupted every other sync is still a run', () => {
    // This fixture used to stand in for "two phones", and it passed because a
    // gain of 700 between every 2,270 reset both streaks. It is not two phones
    // — one monotonic counter gained exactly 2,270 in every second window for
    // three and a half hours — and it is precisely the shape the day-wide
    // evidence exists to refuse.
    const results = run([
      { gainedSteps: 0, afterMinutes: 0 },
      ...Array.from({ length: 14 }, (_, i) => ({
        gainedSteps: i % 2 ? 2_270 : 700,
        afterMinutes: (i + 1) * 15,
      })),
    ]);

    expect(results.some(r => r.stuck)).toBe(true);
    // The consecutive detectors never got anywhere: it is the day that saw it.
    expect(Math.max(...results.map(r => r.cadenceStreak))).toBeLessThan(STUCK_RATE_SAMPLES);
    expect(Math.max(...results.map(r => r.repeatedDeltaCount))).toBe(0);
  });

  it('still catches an exactly repeated delta, which the rate test cannot', () => {
    // The two detectors see different faults and both are kept. A constant delta
    // across windows of DIFFERENT lengths has a VARYING rate, so the rate test
    // would miss it — and it is the stronger evidence of the two.
    const results = run([
      { gainedSteps: 0, afterMinutes: 0 },
      { gainedSteps: 2_270, afterMinutes: 10 },
      { gainedSteps: 2_270, afterMinutes: 35 },
      { gainedSteps: 2_270, afterMinutes: 50 },
      { gainedSteps: 2_270, afterMinutes: 95 },
    ]);

    const last = results[results.length - 1];
    expect(last.stuck).toBe(true);
    expect(last.stuckReason).toMatch(/identical to the step/);
    // Not the rate detector — the windows were all different lengths.
    expect(last.cadenceStreak).toBeLessThan(STUCK_RATE_SAMPLES);
  });

  it('is inert for callers that supply no clock', () => {
    // Backward compatibility: a caller that passes no timestamps gets exactly the
    // old equality-only behaviour rather than a rate computed from nothing.
    const result = trackClientCadence({
      incomingSteps: 5_000,
      lastIncomingSteps: 2_730,
      lastIncomingDelta: 2_270,
      repeatedDeltaCount: 1,
    });

    expect(result.rate).toBeNull();
    expect(result.cadenceStreak).toBe(0);
    expect(result.stuck).toBe(false);
  });
});

describe('stuck source — held, and never punished', () => {
  it('grades a rate-stuck source as stuck_source, not implausible', () => {
    // A broken sensor is a fault, not a choice. Grading it by magnitude would
    // hand the user to recordCheatFlag for their phone's bug.
    const result = validateSteps({
      ...base,
      incomingSteps: 999_999,
      existingSteps: 20_000,
      cadence: {
        stuck: true,
        stuckReason: '149.3–154.0 steps/min held across 6 syncs over 90 minutes',
      },
    });

    expect(result.clampedSteps).toBe(20_000);
    expect(result.severity).toBe('stuck_source');
    expect(result.reason).toMatch(/149\.3–154\.0 steps\/min/);
  });
});

describe('stuck source — a small sync cannot buy back the hold', () => {
  const T0 = new Date('2026-09-04T06:00:00.000Z').getTime();

  const feed = samples => {
    let state = {
      lastIncomingSteps: null, lastIncomingAt: null, lastIncomingDelta: 0,
      repeatedDeltaCount: 0, cadenceStreak: 0, cadenceRateMin: null,
      cadenceRateMax: null, cadenceStreakAt: null,
    };
    let total = 0;
    const out = [];
    for (const { gainedSteps, afterMinutes } of samples) {
      total += gainedSteps;
      const r = trackClientCadence({
        incomingSteps: total, at: T0 + afterMinutes * 60_000, ...state,
      });
      out.push(r);
      state = {
        lastIncomingSteps: r.lastIncomingSteps, lastIncomingAt: r.lastIncomingAt,
        lastIncomingDelta: r.lastIncomingDelta, repeatedDeltaCount: r.repeatedDeltaCount,
        cadenceStreak: r.cadenceStreak, cadenceRateMin: r.cadenceRateMin,
        cadenceRateMax: r.cadenceRateMax, cadenceStreakAt: r.cadenceStreakAt,
        samples: r.samples,
      };
    }
    return out;
  };

  const stuckRun = Array.from({ length: 13 }, (_, i) => ({
    gainedSteps: i === 0 ? 0 : 2_270 + (i % 2 ? 35 : -35),
    afterMinutes: i * 15,
  }));

  it('holds through a sync too small to be evidence', () => {
    // The real ledger ended with a +119 sync. Under the old rule any delta below
    // the threshold cleared both detectors, so that one sync released a hold that
    // had taken ninety minutes of evidence to earn — and the total climbed again
    // on the very next ceiling.
    const results = feed([
      ...stuckRun,
      { gainedSteps: 119, afterMinutes: 13 * 15 },
    ]);

    expect(results[results.length - 2].stuck).toBe(true);
    expect(results[results.length - 1].stuck).toBe(true);
  });

  it('still releases when the device actually resumes measuring', () => {
    // The hold is a hold, not a penalty. A real, differently-paced gain ends it.
    //
    // "Differently paced" by the rule's own definition: this used to resume at
    // 2,400, which is 4% off the 2,305 half of the run and so inside the 5% the
    // rule calls the same rate. With the evidence kept for the whole day, a
    // return to within the band is a return to the band.
    const results = feed([
      ...stuckRun,
      { gainedSteps: 700, afterMinutes: 13 * 15 },
      { gainedSteps: 1_900, afterMinutes: 14 * 15 },
    ]);

    expect(results[results.length - 1].stuck).toBe(false);
  });

  it('still releases for a second device posting a lower total', () => {
    // delta <= 0 clears outright, which is what keeps multi-device accounts
    // failing open.
    const results = feed([
      ...stuckRun,
      { gainedSteps: -5_000, afterMinutes: 13 * 15 },
    ]);

    const last = results[results.length - 1];
    expect(last.stuck).toBe(false);
    expect(last.cadenceStreak).toBe(0);
  });
});

describe('a live sensor cannot deliver a backlog', () => {
  // The delta ceiling was removed from this file because it punished a legitimate
  // Health Connect backlog. That reasoning does not extend to the hardware sensor:
  // the service listens live, so its steps were walked inside the window it was
  // listening for. The old rule applied one bound to both readers, so removing it
  // removed it from both.

  it('clamps the incident: +8,328 across a 30-minute window', () => {
    // s.chetanshetty23, 2026-09-06, labelled native_sensor at 276 steps/min. It
    // came from seedDayFromHealthConnect folding a Health Connect total into the
    // service's own count.
    const result = validateSteps({
      ...base,
      incomingSteps: 9_471,
      existingSteps: 1_143,
      reader: 'native_sensor',
      sensorWindowMinutes: 30.15,
    });

    expect(result.clampedSteps).toBe(1_143 + Math.ceil(30.15 * 220));
    expect(result.flagged).toBe(true);
    expect(result.reason).toMatch(/Live sensor cannot have counted this/);
  });

  it('leaves a brisk real walk alone', () => {
    // 15 minutes at 150 steps/min is an ordinary walking pace and well inside it.
    const result = validateSteps({
      ...base,
      incomingSteps: 3_250,
      existingSteps: 1_000,
      reader: 'native_sensor',
      sensorWindowMinutes: 15,
    });
    expect(result.clampedSteps).toBe(3_250);
    expect(result.flagged).toBe(false);
  });

  it('does not bind a Health Connect backlog', () => {
    // The case the delta ceiling was removed for. HC reports the day cumulatively,
    // so a phone reading it in the evening carries hours of walking in one sync.
    const result = validateSteps({
      ...base,
      incomingSteps: 12_000,
      existingSteps: 7_207,
      reader: 'health_connect',
      sensorWindowMinutes: 5,
    });
    expect(result.clampedSteps).toBe(12_000);
    expect(result.flagged).toBe(false);
  });

  it('covers a window the foreground service spent killed', () => {
    // Android keeps TYPE_STEP_COUNTER running in hardware when an OEM kills the
    // service, so the sync afterwards genuinely covers the whole silent period.
    // The phones that kill background services hardest are exactly the ones this
    // must not clamp, which is why the caller widens the window by offlineMinutes.
    const result = validateSteps({
      ...base,
      incomingSteps: 9_471,
      existingSteps: 1_143,
      reader: 'native_sensor',
      sensorWindowMinutes: 180,
    });
    expect(result.clampedSteps).toBe(9_471);
    expect(result.flagged).toBe(false);
  });

  it('is inert for callers that pass no window', () => {
    const result = validateSteps({
      ...base,
      incomingSteps: 9_471,
      existingSteps: 1_143,
      reader: 'native_sensor',
      sensorWindowMinutes: null,
    });
    expect(result.clampedSteps).toBe(9_471);
  });
});

describe('a day that has already ended is judged by its whole day', () => {
  // The sensor backfill sends days a phone recorded while it could not reach the
  // server, each under its own date. Those steps were walked ACROSS that day, not
  // since the last sync — so measuring them against a fifteen-minute gap would
  // clamp a whole day of real walking the moment it finally arrived.
  const PAST = '2026-08-22'; // the day before the frozen clock

  it('accepts a full day flushed from the backlog', () => {
    const result = validateSteps({
      ...base,
      incomingSteps: 9_500,
      existingSteps: 0,
      syncDate: PAST,
      reader: 'native_sensor',
      // What minutesElapsedOnDate gives a past date: the whole 1,440.
      sensorWindowMinutes: 1_440,
      stepBaseline: 15_000,
    });

    expect(result.clampedSteps).toBe(9_500);
    expect(result.flagged).toBe(false);
  });

  it('still bounds a past day by human cadence', () => {
    // A whole day is 1,440 minutes, which is a real bound and not an absent one:
    // 400,000 steps do not fit in it, and neither does anything past the account's
    // own ceiling.
    const result = validateSteps({
      ...base,
      incomingSteps: 400_000,
      existingSteps: 0,
      syncDate: PAST,
      reader: 'native_sensor',
      sensorWindowMinutes: 1_440,
      stepBaseline: 15_000,
    });

    expect(result.clampedSteps).toBe(15_000);
    expect(result.flagged).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One phone, two streams — per-stream cadence and the day-wide hold.
// ─────────────────────────────────────────────────────────────────────────────

const {
  trackClientCadence: track,
  cadenceSourceKey,
  resolveDayHold,
  HOLD_STALE_MIN,
  STUCK_DELTA_REPEATS: DELTA_REPEATS,
} = require('../utils/stepValidation');

/** The fields the controller persists from a tracker result. */
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

describe('stuck source — one phone on two streams', () => {
  // A real day, from the provenance ledger: the foreground service and the
  // widget worker both posting every fifteen minutes, a few minutes apart. The
  // service's own deltas were 2,250 nine times running — 150 steps/min flat for
  // three hours — while the worker carried Health Connect's copy, a minute or
  // two behind. [ISO time, raw client total, X-Client-Source]
  const SEP12 = [
    ['2026-09-12T01:47:17Z', 10, 'native_service'],
    ['2026-09-12T02:02:10Z', 47, 'app'],
    ['2026-09-12T02:17:29Z', 85, 'native_service'],
    ['2026-09-12T02:32:31Z', 109, 'native_service'],
    ['2026-09-12T02:51:35Z', 119, 'native_service'],
    ['2026-09-12T03:02:12Z', 891, 'worker'],
    ['2026-09-12T03:06:39Z', 1_547, 'native_service'],
    ['2026-09-12T03:20:07Z', 3_419, 'worker'],
    ['2026-09-12T03:21:41Z', 3_807, 'native_service'],
    ['2026-09-12T03:32:29Z', 5_219, 'worker'],
    ['2026-09-12T03:36:42Z', 6_057, 'native_service'],
    ['2026-09-12T03:47:25Z', 7_469, 'worker'],
    ['2026-09-12T03:51:44Z', 8_307, 'native_service'],
    ['2026-09-12T04:02:28Z', 9_709, 'worker'],
    ['2026-09-12T04:06:46Z', 10_557, 'native_service'],
    ['2026-09-12T04:20:06Z', 12_409, 'worker'],
    ['2026-09-12T04:21:47Z', 12_807, 'native_service'],
    ['2026-09-12T04:32:27Z', 14_209, 'worker'],
    ['2026-09-12T04:36:50Z', 15_057, 'native_service'],
    ['2026-09-12T04:50:06Z', 16_899, 'worker'],
    ['2026-09-12T04:51:51Z', 17_307, 'native_service'],
    ['2026-09-12T05:02:16Z', 18_699, 'worker'],
    ['2026-09-12T05:06:54Z', 19_557, 'native_service'],
    ['2026-09-12T05:20:07Z', 21_389, 'worker'],
    ['2026-09-12T05:21:57Z', 21_807, 'native_service'],
    ['2026-09-12T05:32:30Z', 23_179, 'worker'],
    ['2026-09-12T05:37:00Z', 24_057, 'native_service'],
    ['2026-09-12T05:47:27Z', 25_429, 'worker'],
    ['2026-09-12T05:52:07Z', 26_187, 'native_service'],
    ['2026-09-12T06:02:17Z', 26_221, 'worker'],
    ['2026-09-12T06:07:10Z', 26_306, 'native_service'],
    ['2026-09-12T06:22:12Z', 26_367, 'native_service'],
  ];

  /**
   * Runs a day's syncs through the controller's wiring — per-stream tracker,
   * day hold, forfeit, validateSteps — carrying exactly the state the row would.
   * `perStream: false` keys every sync to one history, which is the old wiring.
   */
  const runDay = (syncs, { perStream = true } = {}) => {
    let stored = 0;
    let streams = {};
    let held = { by: null, since: null, forfeit: 0 };
    const out = [];
    try {
      for (const [iso, raw, source] of syncs) {
        const at = new Date(iso);
        jest.setSystemTime(at);
        const key = perStream ? source : 'merged';
        const cadence = track({ incomingSteps: raw, at, ...(streams[key] || {}) });
        const hold = resolveDayHold({
          source: key,
          cadence,
          streams,
          heldBy: held.by,
          heldSince: held.since,
          forfeit: held.forfeit,
          existingWalked: stored,
          at,
        });
        const r = validateSteps({
          ...base,
          incomingSteps: Math.max(0, raw - hold.stuckForfeit),
          existingSteps: stored,
          syncDate: '2026-09-12',
          cadence: { ...cadence, stuck: hold.stuck, stuckReason: hold.stuckReason },
        });
        if (r.clampedSteps > stored) stored = r.clampedSteps;
        streams = { ...streams, [key]: persisted(cadence) };
        held = { by: hold.stuckSource, since: hold.stuckSince, forfeit: hold.stuckForfeit };
        out.push({
          at: iso, source, raw, stored,
          stuck: hold.stuck, released: hold.released, forfeit: hold.stuckForfeit,
          severity: r.severity,
        });
      }
    } finally {
      jest.setSystemTime(FROZEN_NOW);
    }
    return out;
  };

  it('one merged history sees it an hour later, and only by recurrence', () => {
    // Worker-to-service windows run ~195 steps/min and service-to-worker ~131,
    // because Health Connect trails the live sensor. A 40% spread resets the
    // rate streak on every sync, and the exact-delta streak never sees two of
    // the service's 2,250s in a row — so before the evidence was kept for the
    // whole day, one merged history accepted every sync and the day closed at
    // 26,367. It now catches the ~131 rate the worker keeps returning to, but
    // only on its sixth return, seventy minutes after the per-stream wiring
    // below refuses the service outright.
    const day = runDay(SEP12, { perStream: false });
    const first = day.find((s) => s.stuck);
    expect(first).toMatchObject({ at: '2026-09-12T05:32:30Z', source: 'worker' });
    expect(Math.max(...day.map((s) => s.stored))).toBeGreaterThan(20_000);
  });

  it('per stream, the service is refused at its fifth identical delta', () => {
    const day = runDay(SEP12);
    const first = day.find((s) => s.stuck);
    expect(first).toMatchObject({
      at: '2026-09-12T04:21:47Z',
      source: 'native_service',
      raw: 12_807,
      severity: 'stuck_source',
    });
    // The stored total is where the day stood when the hold began — the
    // worker's figure from a minute earlier.
    expect(first.stored).toBe(12_409);
  });

  it('holds the worker too, even though its own deltas look healthy', () => {
    // The worker is a second copy of the same steps. Its own history — jittered
    // by Health Connect's batching — was not yet stuck when the service tripped,
    // and if it could go through, the hold would have refused nothing.
    const day = runDay(SEP12);
    const heldWorker = day.filter((s) => s.source === 'worker' && s.stuck);
    expect(heldWorker.length).toBeGreaterThan(0);
    expect(heldWorker.every((s) => s.stored === 12_409)).toBe(true);
    expect(heldWorker.every((s) => s.severity === 'stuck_source')).toBe(true);
  });

  it('releases only when the service varies, and keeps what it reported meanwhile', () => {
    const day = runDay(SEP12);
    const release = day.find((s) => s.released);
    // The first delta that was not 2,250: 24,057 → 26,187.
    expect(release).toMatchObject({ at: '2026-09-12T05:52:07Z', source: 'native_service' });
    // Everything the service reported while held — from the 12,409 the day was
    // frozen at up to its last held figure of 24,057 — is set aside.
    expect(release.forfeit).toBe(24_057 - 12_409);
    // The releasing delta itself is accepted: it is the first measurement.
    expect(release.stored).toBe(12_409 + (26_187 - 24_057));
  });

  it('reads every later figure net of the forfeit, from either stream', () => {
    const day = runDay(SEP12);
    const after = day.filter((s) => s.at > '2026-09-12T05:52:07Z');
    expect(after.every((s) => !s.stuck)).toBe(true);
    expect(after.map((s) => s.stored)).toEqual([
      26_221 - 11_648, // worker
      26_306 - 11_648, // service
      26_367 - 11_648, // service
    ]);
    // Unguarded, the day closed at 26,367.
    expect(day.at(-1).stored).toBe(14_719);
  });

  it('leaves a real walker on two streams alone', () => {
    // Genuine walking, seen by both paths: deltas that vary the way a person
    // does — stops, lights, a sprint for a bus — and Health Connect a minute
    // behind the sensor. Neither stream's own history ever holds still.
    const T0 = new Date('2026-09-12T03:00:00Z').getTime();
    const gains = [900, 1_400, 300, 1_700, 650, 1_100, 2_000, 400, 1_250, 800, 1_500, 200, 1_800, 950];
    let live = 0;
    const syncs = [];
    gains.forEach((g, i) => {
      live += g;
      // The worker reads a figure ~80 steps stale, four minutes before the
      // service posts.
      syncs.push([new Date(T0 + (i * 15 + 11) * 60_000).toISOString(), Math.max(0, live - 80), 'worker']);
      syncs.push([new Date(T0 + (i * 15 + 15) * 60_000).toISOString(), live, 'native_service']);
    });
    const day = runDay(syncs);
    expect(day.some((s) => s.stuck)).toBe(false);
    expect(day.at(-1).stored).toBe(live);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Evidence that survives an interruption — the 21 Sep day.
// ─────────────────────────────────────────────────────────────────────────────

describe('stuck source — a run that breaks itself every fifth sync', () => {
  const {
    STUCK_RATE_SAMPLES: RATE_SAMPLES,
    MAX_BASELINE_CEILING: BASELINE_ROOF,
    MAX_CADENCE_SAMPLES,
  } = require('../utils/stepValidation');

  // A real day, from the provenance ledger: a Xiaomi 23049PCD8I on build 81,
  // its foreground service posting the live sensor count every fifteen minutes.
  // The service gained 2,240 / 2,250 / 2,260 / 2,260 / 2,260 — five windows
  // inside 1.2% of each other — then 1,018, then a 2,260 again, then a stretch
  // of ordinary figures, then 2,260 three more times. Google Fit and the
  // platform pedometer agreed with the sensor's total, so the figure was
  // genuinely coming off the hardware; a rate that identical across windows
  // of 15.02 to 15.07 minutes is a phone being moved by a machine, not walked.
  // The final raw figure is inferred: the ledger shows the sync landing on the
  // 30,000 baseline roof, one more 2,260 above the previous total.
  // [ISO time, raw client total, X-Client-Source]
  const SEP21 = [
    ['2026-09-21T01:59:54Z',    270, 'worker'],
    ['2026-09-21T02:02:35Z',    351, 'worker'],
    ['2026-09-21T02:14:53Z',    475, 'native_service'],
    ['2026-09-21T02:29:56Z',    500, 'native_service'],
    ['2026-09-21T02:44:57Z',  2_560, 'native_service'],
    ['2026-09-21T02:45:51Z',  2_580, 'worker'],
    ['2026-09-21T03:00:01Z',  4_800, 'native_service'],
    ['2026-09-21T03:00:53Z',  4_810, 'worker'],
    ['2026-09-21T03:15:05Z',  7_050, 'native_service'],
    ['2026-09-21T03:30:09Z',  9_310, 'native_service'],
    ['2026-09-21T03:45:12Z', 11_570, 'native_service'],
    ['2026-09-21T04:00:16Z', 13_830, 'native_service'],
    ['2026-09-21T04:15:19Z', 14_848, 'native_service'],
    ['2026-09-21T04:31:33Z', 14_858, 'native_service'],
    ['2026-09-21T04:46:34Z', 16_396, 'native_service'],
    ['2026-09-21T05:01:37Z', 17_738, 'native_service'],
    ['2026-09-21T05:16:38Z', 19_998, 'native_service'],
    ['2026-09-21T05:31:41Z', 20_823, 'native_service'],
    ['2026-09-21T05:47:53Z', 20_833, 'native_service'],
    ['2026-09-21T06:15:30Z', 20_834, 'native_service'],
    ['2026-09-21T07:20:39Z', 21_223, 'native_service'],
    ['2026-09-21T07:49:01Z', 21_233, 'native_service'],
    ['2026-09-21T08:04:11Z', 21_286, 'native_service'],
    ['2026-09-21T08:33:35Z', 21_296, 'native_service'],
    ['2026-09-21T09:25:28Z', 21_303, 'native_service'],
    ['2026-09-21T09:40:30Z', 21_801, 'native_service'],
    ['2026-09-21T09:55:33Z', 21_885, 'native_service'],
    ['2026-09-21T10:10:36Z', 21_899, 'native_service'],
    ['2026-09-21T10:25:43Z', 21_909, 'native_service'],
    ['2026-09-21T10:52:55Z', 21_919, 'native_service'],
    ['2026-09-21T11:07:59Z', 22_278, 'native_service'],
    ['2026-09-21T11:23:03Z', 22_423, 'native_service'],
    ['2026-09-21T11:47:12Z', 22_438, 'native_service'],
    ['2026-09-21T12:02:20Z', 22_480, 'native_service'],
    ['2026-09-21T12:17:26Z', 22_787, 'native_service'],
    ['2026-09-21T12:32:30Z', 23_748, 'native_service'],
    ['2026-09-21T12:45:55Z', 24_530, 'worker'],
    ['2026-09-21T12:47:33Z', 24_759, 'native_service'],
    ['2026-09-21T13:02:35Z', 27_019, 'native_service'],
    ['2026-09-21T13:17:38Z', 29_279, 'native_service'],
    ['2026-09-21T13:32:41Z', 31_539, 'native_service'],
  ];

  /**
   * The controller's wiring, as in the two-stream block above, with the
   * account's real ceiling — its history had already earned the roof. With
   * `keepSamples: false` the day's samples are not carried between syncs,
   * which is exactly the streak-only tracker this replaces.
   */
  const runDay = (syncs, { keepSamples = true } = {}) => {
    let stored = 0;
    let streams = {};
    let held = { by: null, since: null, forfeit: 0 };
    const out = [];
    try {
      for (const [iso, raw, source] of syncs) {
        const at = new Date(iso);
        jest.setSystemTime(at);
        const cadence = track({ incomingSteps: raw, at, ...(streams[source] || {}) });
        const hold = resolveDayHold({
          source, cadence, streams,
          heldBy: held.by, heldSince: held.since, forfeit: held.forfeit,
          existingWalked: stored, at,
        });
        const r = validateSteps({
          ...base,
          incomingSteps: Math.max(0, raw - hold.stuckForfeit),
          existingSteps: stored,
          syncDate: '2026-09-21',
          stepBaseline: BASELINE_ROOF,
          cadence: { ...cadence, stuck: hold.stuck, stuckReason: hold.stuckReason },
        });
        if (r.clampedSteps > stored) stored = r.clampedSteps;
        const state = persisted(cadence);
        if (!keepSamples) delete state.samples;
        streams = { ...streams, [source]: state };
        held = { by: hold.stuckSource, since: hold.stuckSince, forfeit: hold.stuckForfeit };
        out.push({
          at: iso, source, raw, delta: cadence.delta, stored,
          stuck: hold.stuck, released: hold.released, forfeit: hold.stuckForfeit,
          severity: r.severity, reason: hold.stuckReason,
        });
      }
    } finally {
      jest.setSystemTime(FROZEN_NOW);
    }
    return out;
  };

  it('was accepted in full by the streak-only tracker', () => {
    // Five in a band is one short of RATE_SAMPLES; three identical deltas is one
    // short of the fourth that DELTA_REPEATS refuses; and every break put both
    // counters back to zero. Nothing was refused, and only the account's own
    // roof stopped the day.
    const day = runDay(SEP21, { keepSamples: false });
    expect(day.some((s) => s.stuck)).toBe(false);
    expect(day.at(-1).stored).toBe(BASELINE_ROOF);
    expect(day.at(-1).severity).toBe('clamped');
  });

  it('is refused the moment the delta comes back for the fourth time', () => {
    const day = runDay(SEP21);
    const first = day.find((s) => s.stuck);
    expect(first).toMatchObject({
      at: '2026-09-21T05:16:38Z',
      source: 'native_service',
      raw: 19_998,
      delta: 2_260,
      severity: 'stuck_source',
    });
    // The three earlier 2,260s were an hour ago, with three varying windows in
    // between — which the streak counters had forgotten entirely.
    expect(first.reason).toMatch(/4 times today/);
    expect(first.stored).toBe(17_738);
  });

  it('releases on the window that varied, and sets aside the one it refused', () => {
    const day = runDay(SEP21);
    const release = day.find((s) => s.released);
    expect(release).toMatchObject({ at: '2026-09-21T05:31:41Z', delta: 825 });
    expect(release.forfeit).toBe(2_260);
    expect(release.stored).toBe(17_738 + 825);
  });

  it('refuses every later return to the pattern, however many breaks sit between', () => {
    // Seven hours of ordinary figures, then 2,260 three more times. Under the
    // streak-only tracker the run had to rebuild from nothing and never got
    // there; the day remembers.
    const day = runDay(SEP21);
    const evening = day.filter((s) => s.at >= '2026-09-21T13:00:00Z');
    expect(evening.map((s) => s.stuck)).toEqual([true, true, true]);
    expect(evening.every((s) => s.severity === 'stuck_source')).toBe(true);
    expect(new Set(evening.map((s) => s.stored))).toEqual(new Set([22_499]));
  });

  it('still accepts the figures that varied — the small gains and the worker', () => {
    // The hold is narrow: only the samples that belong to the pattern are
    // refused. Everything between them goes through, read net of the forfeit.
    const day = runDay(SEP21);
    const between = day.filter(
      (s) => s.at > '2026-09-21T05:31:41Z' && s.at < '2026-09-21T13:00:00Z',
    );
    expect(between.some((s) => s.stuck)).toBe(false);
    expect(between.at(-1)).toMatchObject({ raw: 24_759, stored: 24_759 - 2_260 });
  });

  it('closes the day at what varied, not at the roof', () => {
    const day = runDay(SEP21);
    expect(day.at(-1).stored).toBe(22_499);
    expect(day.at(-1).stored).toBeLessThan(BASELINE_ROOF);
  });

  it('leaves a walker who takes the same route twice a day alone', () => {
    // Morning and evening walks at a human's variance: the same person, the same
    // route, and windows that still spread 10-15% because a light changed or a
    // conversation happened. Six full windows in a day, none of them the same.
    const T0 = new Date('2026-09-21T02:00:00Z').getTime();
    const gains = [
      1_580, 1_650, 1_490, 240,            // morning
      30, 10, 80, 0, 120, 15, 40, 60,      // the working day
      1_620, 1_540, 1_700, 310,            // evening
    ];
    let live = 0;
    const syncs = gains.map((g, i) => {
      live += g;
      return [new Date(T0 + (i + 1) * 15 * 60_000).toISOString(), live, 'native_service'];
    });
    const day = runDay(syncs);
    expect(day.some((s) => s.stuck)).toBe(false);
    expect(day.at(-1).stored).toBe(live);
  });

  it('a stream on a build that kept no samples still holds through a small sync', () => {
    // A row written before samples were persisted carries only the streak
    // counters. A hold they earned must still stand across a +10, exactly as
    // it did before — the fallback is the old derivation.
    const r = track({
      incomingSteps: 39_098,
      at: FROZEN_NOW,
      lastIncomingSteps: 39_088,
      lastIncomingAt: FROZEN_NOW.getTime() - 5 * 60_000,
      lastIncomingDelta: 2_270,
      repeatedDeltaCount: DELTA_REPEATS,
      // no `samples`
    });
    expect(r.stuck).toBe(true);
    expect(r.samples).toEqual([]);
  });

  it('keeps only the newest samples once a stream has produced enough', () => {
    let state = {};
    const T0 = new Date('2026-09-21T00:00:00Z').getTime();
    let total = 0;
    for (let i = 0; i <= MAX_CADENCE_SAMPLES + 10; i++) {
      // Every gain distinct and far apart, so nothing here is ever refused and
      // the only thing being tested is the bound.
      total += 500 + ((i * 137) % 1_500);
      state = track({ incomingSteps: total, at: T0 + i * 5 * 60_000, ...state });
    }
    expect(state.samples.length).toBe(MAX_CADENCE_SAMPLES);
    expect(state.samples.at(-1).delta).toBe(500 + (((MAX_CADENCE_SAMPLES + 10) * 137) % 1_500));
  });

  it('exposes the thresholds it shares with the streak rules', () => {
    expect(RATE_SAMPLES).toBe(6);
    expect(MAX_CADENCE_SAMPLES).toBeGreaterThanOrEqual(96);
  });
});

describe('resolveDayHold', () => {
  const T0 = new Date('2026-09-12T04:21:47Z').getTime();
  const min = (n) => n * 60_000;
  const holderStream = {
    native_service: { lastIncomingSteps: 15_057, lastIncomingAt: T0 },
  };

  it('a stuck stream takes the hold, and keeps it while it stays stuck', () => {
    const first = resolveDayHold({
      source: 'native_service',
      cadence: { stuck: true, stuckReason: '+2250 steps reported 4 times in a row' },
      streams: {},
      existingWalked: 12_409,
      at: T0,
    });
    expect(first).toMatchObject({
      stuck: true,
      stuckSource: 'native_service',
      stuckSince: T0,
      stuckForfeit: 0,
      released: false,
    });
    expect(first.stuckReason).toMatch(/4 times in a row/);

    const again = resolveDayHold({
      source: 'native_service',
      cadence: { stuck: true, stuckReason: '+2250 steps reported 5 times in a row' },
      streams: holderStream,
      heldBy: 'native_service',
      heldSince: T0,
      existingWalked: 12_409,
      at: T0 + min(15),
    });
    expect(again.stuck).toBe(true);
    expect(again.stuckSince).toBe(T0); // the original start, not this sync
  });

  it('refuses another stream while the hold stands, and does not let it release', () => {
    const r = resolveDayHold({
      source: 'worker',
      cadence: { stuck: false, stuckReason: null },
      streams: holderStream,
      heldBy: 'native_service',
      heldSince: T0,
      existingWalked: 12_409,
      at: T0 + min(11),
    });
    expect(r.stuck).toBe(true);
    expect(r.stuckReason).toMatch(/held by the native_service stream for 11 min/);
    expect(r.stuckReason).toMatch(/this worker figure/);
    expect(r.stuckSource).toBe('native_service');
    expect(r.released).toBe(false);
    expect(r.stuckForfeit).toBe(0);
  });

  it('a second stream that trips does not take the hold over', () => {
    // The first holder's release condition is the one the forfeit is measured
    // against. The second simply re-holds on its own next sync once the first
    // lets go.
    const r = resolveDayHold({
      source: 'worker',
      cadence: { stuck: true, stuckReason: '145.8–153.1 steps/min held across 7 syncs' },
      streams: holderStream,
      heldBy: 'native_service',
      heldSince: T0,
      existingWalked: 12_409,
      at: T0 + min(58),
    });
    expect(r.stuck).toBe(true);
    expect(r.stuckReason).toMatch(/145\.8–153\.1/);
    expect(r.stuckSource).toBe('native_service');
  });

  it('the holder releases by varying, forfeiting what it reported while held', () => {
    const r = resolveDayHold({
      source: 'native_service',
      cadence: { stuck: false, stuckReason: null },
      streams: { native_service: { lastIncomingSteps: 24_057, lastIncomingAt: T0 + min(75) } },
      heldBy: 'native_service',
      heldSince: T0,
      existingWalked: 12_409,
      at: T0 + min(90),
    });
    expect(r).toMatchObject({
      stuck: false,
      stuckReason: null,
      released: true,
      stuckSource: null,
      stuckSince: null,
      stuckForfeit: 24_057 - 12_409,
    });
  });

  it('accumulates the forfeit across a second hold on the same day', () => {
    // The first hold set 11,648 aside. A second hold later in the day is
    // measured on figures that are already net of that, so the holder's last
    // raw figure is read the same way — or the first forfeit would be counted
    // twice.
    const r = resolveDayHold({
      source: 'native_service',
      cadence: { stuck: false, stuckReason: null },
      streams: { native_service: { lastIncomingSteps: 30_000, lastIncomingAt: T0 } },
      heldBy: 'native_service',
      heldSince: T0,
      forfeit: 11_648,
      existingWalked: 15_000,
      at: T0 + min(15),
    });
    // 30,000 raw is 18,352 net; the day stood at 15,000; 3,352 more is set aside.
    expect(r.stuckForfeit).toBe(11_648 + 3_352);
  });

  it('never forfeits a negative amount', () => {
    // A holder whose last figure was below the stored total had nothing refused.
    const r = resolveDayHold({
      source: 'native_service',
      cadence: { stuck: false, stuckReason: null },
      streams: { native_service: { lastIncomingSteps: 12_000, lastIncomingAt: T0 } },
      heldBy: 'native_service',
      heldSince: T0,
      existingWalked: 12_409,
      at: T0 + min(15),
    });
    expect(r.released).toBe(true);
    expect(r.stuckForfeit).toBe(0);
  });

  it('lets another stream release a holder that has gone silent', () => {
    // The OS killed the foreground service mid-hold. Without this the worker's
    // honest figures would be refused until midnight with no one to release.
    const stillHeld = resolveDayHold({
      source: 'worker',
      cadence: { stuck: false, stuckReason: null },
      streams: holderStream,
      heldBy: 'native_service',
      heldSince: T0,
      existingWalked: 12_409,
      at: T0 + min(HOLD_STALE_MIN - 1),
    });
    expect(stillHeld.stuck).toBe(true);
    expect(stillHeld.released).toBe(false);

    const released = resolveDayHold({
      source: 'worker',
      cadence: { stuck: false, stuckReason: null },
      streams: holderStream,
      heldBy: 'native_service',
      heldSince: T0,
      existingWalked: 12_409,
      at: T0 + min(HOLD_STALE_MIN),
    });
    expect(released).toMatchObject({
      stuck: false,
      released: true,
      stuckSource: null,
      stuckForfeit: 15_057 - 12_409, // what the dead holder had reported
    });
  });

  it('a stuck stream arriving at a stale hold takes it over cleanly', () => {
    const r = resolveDayHold({
      source: 'worker',
      cadence: { stuck: true, stuckReason: 'rate held across 7 syncs' },
      streams: holderStream,
      heldBy: 'native_service',
      heldSince: T0,
      existingWalked: 12_409,
      at: T0 + min(HOLD_STALE_MIN + 5),
    });
    expect(r.stuck).toBe(true);
    expect(r.released).toBe(true); // the old hold went
    expect(r.stuckSource).toBe('worker');
    expect(r.stuckSince).toBe(T0 + min(HOLD_STALE_MIN + 5));
    expect(r.stuckForfeit).toBe(15_057 - 12_409);
  });

  it('is nothing when no stream is stuck and none holds', () => {
    const r = resolveDayHold({
      source: 'app',
      cadence: { stuck: false, stuckReason: null },
      streams: {},
      existingWalked: 5_000,
      at: T0,
    });
    expect(r).toEqual({
      stuck: false,
      stuckReason: null,
      released: false,
      stuckSource: null,
      stuckSince: null,
      stuckForfeit: 0,
      closed: false,
    });
  });
});

describe('cadenceSourceKey', () => {
  it('keeps the header values the clients send', () => {
    expect(cadenceSourceKey('native_service')).toBe('native_service');
    expect(cadenceSourceKey('worker')).toBe('worker');
    expect(cadenceSourceKey(' app ')).toBe('app');
  });

  it('folds anything unusable into one shared bucket', () => {
    // A map key on the row, so nothing Mongo rejects in a path — and no fresh,
    // evidence-free history for every novel string a client might send.
    expect(cadenceSourceKey(null)).toBe('other');
    expect(cadenceSourceKey('')).toBe('other');
    expect(cadenceSourceKey('a.b')).toBe('other');
    expect(cadenceSourceKey('$set')).toBe('other');
    expect(cadenceSourceKey('x'.repeat(33))).toBe('other');
  });
});

describe('stuck source — a re-send is not a sample', () => {
  const T0 = new Date('2026-09-12T04:21:47Z').getTime();
  const min = (n) => n * 60_000;

  /** A stream held by the exact-delta detector, as persisted. */
  const held = {
    lastIncomingSteps: 12_807,
    lastIncomingAt: T0,
    lastIncomingDelta: 2_250,
    repeatedDeltaCount: DELTA_REPEATS,
    cadenceStreak: 5,
    cadenceRateMin: 149.4,
    cadenceRateMax: 149.8,
    cadenceStreakAt: T0 - min(75),
  };

  it('does not release a hold', () => {
    // A retried POST — the service re-posts a payload whose response it never
    // saw. This used to land in the "behind" branch and clear both streaks.
    const r = track({ incomingSteps: 12_807, at: T0 + min(5), ...held });
    expect(r.delta).toBe(0);
    expect(r.stuck).toBe(true);
    expect(r.repeatedDeltaCount).toBe(DELTA_REPEATS);
    expect(r.cadenceStreak).toBe(5);
  });

  it('does not move the markers, so the next window is measured from the first arrival', () => {
    const resent = track({ incomingSteps: 12_807, at: T0 + min(5), ...held });
    expect(resent.lastIncomingAt).toBe(T0);

    // Fifteen minutes after the ORIGINAL figure, the next 2,250 arrives. Measured
    // from the re-send it would be a 10-minute window at 225/min — out of band,
    // and the re-send would have broken the streak by another route.
    const next = track({ incomingSteps: 15_057, at: T0 + min(15), ...persisted(resent) });
    expect(next.rate).toBeCloseTo(150, 0);
    expect(next.stuck).toBe(true);
    expect(next.repeatedDeltaCount).toBe(DELTA_REPEATS + 1);
  });

  it('still says nothing when there was no hold to keep', () => {
    const r = track({
      incomingSteps: 5_000,
      at: T0 + min(5),
      lastIncomingSteps: 5_000,
      lastIncomingAt: T0,
      lastIncomingDelta: 900,
      repeatedDeltaCount: 0,
      cadenceStreak: 2,
      cadenceRateMin: 58,
      cadenceRateMax: 61,
      cadenceStreakAt: T0 - min(30),
    });
    expect(r.stuck).toBe(false);
    expect(r.cadenceStreak).toBe(2);
    expect(r.lastIncomingAt).toBe(T0);
  });
});

describe('stuck source — a pattern the account was already held for', () => {
  const {
    selectPriorStuckSamples,
    BASELINE_FLOOR,
    STUCK_RATE_SAMPLES: RATE_SAMPLES,
  } = require('../utils/stepValidation');
  const min = (n) => n * 60_000;
  const DAY = min(24 * 60);

  // A real day, rebuilt from the account's cadence samples: the same Xiaomi
  // 23049PCD8I, ~150 steps/min on both streams from 08:00 local, service and
  // worker a few minutes apart. The worker's first stretch was held from 09:30,
  // the service's from 13:19 to 18:50 local, with a pause and four short breaks
  // between. Sub-500 figures between samples are inferred from the next
  // sample's window. Its ceiling was the 15,000 floor, and the day closed on it.
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

  /**
   * The controller's wiring — per-stream tracker with the carried samples,
   * the day hold with its closed flag, the forfeit, validateSteps — carrying
   * exactly the state the row would, at the account's own ceiling.
   */
  const runDay = (syncs, { prior = [], date = '2026-09-23' } = {}) => {
    let stored = 0;
    let streams = {};
    let held = { by: null, since: null, forfeit: 0, closed: false };
    const day = [];
    try {
      for (const [iso, raw, source] of syncs) {
        const at = new Date(iso);
        jest.setSystemTime(at);
        const cadence = track({
          incomingSteps: raw,
          at,
          ...(streams[source] || {}),
          priorSamples: prior,
        });
        const hold = resolveDayHold({
          source, cadence, streams,
          heldBy: held.by, heldSince: held.since, forfeit: held.forfeit, closed: held.closed,
          existingWalked: stored, at,
        });
        const r = validateSteps({
          ...base,
          incomingSteps: Math.max(0, raw - hold.stuckForfeit),
          existingSteps: stored,
          syncDate: date,
          stepBaseline: BASELINE_FLOOR,
          cadence: { ...cadence, stuck: hold.stuck, stuckReason: hold.stuckReason },
        });
        if (r.clampedSteps > stored) stored = r.clampedSteps;
        streams = { ...streams, [source]: persisted(cadence) };
        held = {
          by: hold.stuckSource, since: hold.stuckSince,
          forfeit: hold.stuckForfeit, closed: hold.closed,
        };
        day.push({
          at: iso, source, raw, stored, ownStuck: cadence.stuck,
          stuck: hold.stuck, released: hold.released, closed: hold.closed,
          severity: r.severity, reason: hold.stuckReason,
        });
      }
    } finally {
      jest.setSystemTime(FROZEN_NOW);
    }
    return { day, streams };
  };

  const shiftSyncs = (syncs, by) =>
    syncs.map(([iso, raw, source]) => [new Date(new Date(iso).getTime() + by).toISOString(), raw, source]);

  /** A day's streams as the next day's store reads them off its row. */
  const asRow = (streams) => ({
    cadenceBySource: Object.fromEntries(
      Object.entries(streams).map(([key, state]) => [key, { samples: state.samples || [] }]),
    ),
  });

  // The account did the same thing the day before. Nothing about the device
  // changes overnight, so yesterday is today's own figures a day earlier.
  const carriedFromYesterday = () =>
    selectPriorStuckSamples([asRow(runDay(shiftSyncs(SEP23, -DAY), { date: '2026-09-22' }).streams)]);

  it('on its own, still pays for the ninety minutes it takes to see', () => {
    const { day } = runDay(SEP23);
    const first = day.find((s) => s.stuck);
    expect(first).toMatchObject({ at: '2026-09-23T04:00:04Z', source: 'worker', stored: 13_389 });
    expect(day.some((s) => s.closed)).toBe(false);
    // The floor, which is also the goal and then some.
    expect(day.at(-1).stored).toBe(BASELINE_FLOOR);
  });

  it('carries a stream that kept going for another ninety minutes after its hold', () => {
    const prior = carriedFromYesterday();
    expect(prior.length).toBeGreaterThanOrEqual(RATE_SAMPLES);
    expect(prior.every((s) => s.rate > 140 && s.rate < 160)).toBe(true);
    expect(prior.every((s) => s.at < new Date('2026-09-23T00:00:00Z').getTime())).toBe(true);
    // Oldest first, whatever order the streams were read in.
    expect(prior.map((s) => s.at)).toEqual([...prior.map((s) => s.at)].sort((a, b) => a - b));
  });

  it('reads a hydrated row the same as a lean one', () => {
    const row = asRow(runDay(shiftSyncs(SEP23, -DAY), { date: '2026-09-22' }).streams);
    const hydrated = { cadenceBySource: new Map(Object.entries(row.cadenceBySource)) };
    expect(selectPriorStuckSamples([hydrated])).toEqual(selectPriorStuckSamples([row]));
  });

  it('carries nothing from a hold released by stepping off the treadmill', () => {
    const T0 = new Date('2026-09-22T11:00:00Z').getTime();
    const window = (i, stuck) => ({
      delta: 1_800 + (i % 2) * 10, rate: 120 + (i % 2) * 0.7,
      from: T0 + min(i * 15), at: T0 + min(i * 15 + 15), stuck,
    });
    // Ninety minutes of evidence, one refused window, then the cadence changed.
    const treadmill = [...Array.from({ length: 6 }, (_, i) => window(i, i === 5)), window(6, true)];
    expect(selectPriorStuckSamples([{ cadenceBySource: { native_service: { samples: treadmill } } }]))
      .toEqual([]);

    // Enough refusals, but only half an hour of them — a burst of rapid syncs.
    const burst = Array.from({ length: RATE_SAMPLES }, (_, i) => ({
      delta: 600, rate: 120, from: T0 + min(i * 5), at: T0 + min(i * 5 + 5), stuck: true,
    }));
    expect(selectPriorStuckSamples([{ cadenceBySource: { app: { samples: burst } } }])).toEqual([]);
  });

  it('refuses the first return to the band the next morning, and closes the day', () => {
    const { day } = runDay(SEP23, { prior: carriedFromYesterday() });
    const first = day.find((s) => s.stuck);
    // The worker's second window, the first at the device's rate. Only the two
    // partial windows before it were accepted.
    expect(first).toMatchObject({
      at: '2026-09-23T02:44:58Z',
      source: 'worker',
      stored: 2_119,
      closed: true,
      severity: 'stuck_source',
    });
    expect(first.reason).toMatch(/earlier days/);

    const after = day.filter((s) => s.at >= first.at);
    expect(after.every((s) => s.stuck && s.closed && s.severity === 'stuck_source')).toBe(true);
    expect(after.some((s) => s.released)).toBe(false);
    expect(day.at(-1).stored).toBe(2_119);
  });

  it('does not reopen when the device pauses, or when the holder goes quiet', () => {
    const { day } = runDay(SEP23, { prior: carriedFromYesterday() });
    const first = day.find((s) => s.stuck);
    // Every figure the device's own stream did not call stuck — its breaks —
    // and the worker's return after six hours of silence, which an ordinary
    // hold would have let release it.
    const quiet = day.filter((s) => s.at > first.at && !s.ownStuck);
    expect(quiet.map((s) => s.at)).toEqual(
      expect.arrayContaining(['2026-09-23T07:14:46Z', '2026-09-23T13:20:26Z', '2026-09-23T14:55:54Z']),
    );
    expect(quiet.every((s) => s.stuck && !s.released && s.stored === 2_119)).toBe(true);
    expect(day.find((s) => s.at === '2026-09-23T14:55:54Z').reason).toMatch(/day closed/);
  });

  it('leaves a person walking the next day alone', () => {
    // Deltas that vary the way a person does, on both streams, the morning
    // after the account was held all day at ~150 steps/min.
    const T0 = new Date('2026-09-23T03:00:00Z').getTime();
    const gains = [900, 1_400, 300, 1_700, 650, 1_100, 2_000, 400, 1_250, 800, 1_500, 200, 1_800, 950];
    let live = 0;
    const syncs = [];
    gains.forEach((g, i) => {
      live += g;
      syncs.push([new Date(T0 + min(i * 15 + 11)).toISOString(), Math.max(0, live - 80), 'worker']);
      syncs.push([new Date(T0 + min(i * 15 + 15)).toISOString(), live, 'native_service']);
    });
    const { day } = runDay(syncs, { prior: carriedFromYesterday() });
    expect(day.some((s) => s.stuck)).toBe(false);
    expect(day.at(-1).stored).toBe(live);
  });

  it('judges carried samples as evidence only, never as today’s history', () => {
    const T0 = new Date('2026-09-23T02:30:00Z').getTime();
    const prior = Array.from({ length: RATE_SAMPLES }, (_, i) => ({
      delta: 2_250 + (i % 3) * 10,
      rate: 150 + (i % 3) * 0.6,
      from: T0 - DAY + min(i * 15),
      at: T0 - DAY + min(i * 15 + 15),
    }));
    const sync = {
      incomingSteps: 3_819,
      at: T0 + min(15),
      lastIncomingSteps: 1_559,
      lastIncomingAt: T0,
      lastIncomingDelta: 1_526,
      samples: [],
    };

    const alone = track(sync);
    expect(alone.stuck).toBe(false);

    const r = track({ ...sync, priorSamples: prior });
    expect(r).toMatchObject({ stuck: true, recurrent: true });
    expect(r.stuckReason).toMatch(/6 samples were refused in as a stuck source on earlier days/);
    expect(r.samples).toHaveLength(1);
    expect(r.samples[0].total).toBe(3_819);
  });

  it('closes the day only on a verdict resting on earlier days', () => {
    const T0 = new Date('2026-09-23T02:44:58Z').getTime();
    const ordinary = resolveDayHold({
      source: 'worker',
      cadence: { stuck: true, stuckReason: '+2250 steps reported 4 times in a row', recurrent: false },
      existingWalked: 2_119,
      at: T0,
    });
    expect(ordinary).toMatchObject({ stuck: true, closed: false });

    const recurrent = resolveDayHold({
      source: 'worker',
      cadence: { stuck: true, stuckReason: 'the pattern this account was already held for', recurrent: true },
      existingWalked: 2_119,
      at: T0,
    });
    expect(recurrent).toMatchObject({
      stuck: true, closed: true, stuckSource: 'worker', stuckSince: T0, released: false,
    });
  });

  it('nothing releases a closed day', () => {
    const T0 = new Date('2026-09-23T02:44:58Z').getTime();
    const closedDay = { heldBy: 'worker', heldSince: T0, closed: true, existingWalked: 2_119 };

    // The holder varies — an ordinary hold's release.
    const varied = resolveDayHold({
      source: 'worker',
      cadence: { stuck: false, stuckReason: null },
      streams: { worker: { lastIncomingSteps: 33_190, lastIncomingAt: T0 + min(255) } },
      ...closedDay,
      at: T0 + min(270),
    });
    expect(varied).toMatchObject({
      stuck: true, released: false, closed: true, stuckSource: 'worker', stuckForfeit: 0,
    });

    // The holder has gone quiet and another stream posts — the stale release.
    const stale = resolveDayHold({
      source: 'native_service',
      cadence: { stuck: false, stuckReason: null },
      streams: { worker: { lastIncomingSteps: 33_873, lastIncomingAt: T0 + min(270) } },
      ...closedDay,
      at: T0 + min(270) + min(HOLD_STALE_MIN * 5),
    });
    expect(stale).toMatchObject({ stuck: true, released: false, closed: true, stuckSource: 'worker' });
    expect(stale.stuckReason).toMatch(/day closed \d+ min ago, when the worker stream returned/);
  });
});
