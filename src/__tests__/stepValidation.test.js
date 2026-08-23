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

  it('clamps an implausible jump to what could physically have been walked', () => {
    // This previously asserted 6,000 — existing 1,000 plus a flat 5,000 — which
    // was the bug rather than the rule: the rapid-jump branch ASSIGNED
    // `existingWalked + 5000`, so an implausible report was granted 5,000 steps
    // instead of being cut down. One minute allows 220 steps, and that is now the
    // answer.
    const result = validateSteps({
      ...base,
      incomingSteps: 40_000,
      existingSteps: 1_000,
      lastStepIncreaseAt: minsAgo(1),
    });
    expect(result.clampedSteps).toBe(1_220);
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

  it('repeated syncs of an inflated value cannot ratchet the total up', () => {
    let stored = 0;
    const accepted = [];

    for (let i = 0; i < RATCHET_SYNCS; i++) {
      const r = validateSteps({
        ...base,
        incomingSteps: INFLATED,
        existingSteps: stored,
        // 20 seconds apart, the app's actual sync throttle. Under the old rule this
        // window skipped the rate check entirely and still granted 5,000.
        lastStepIncreaseAt: minsAgo(20 / 60),
      });
      accepted.push(r.clampedSteps - stored);
      stored = r.clampedSteps;
    }

    // No single sync may add anything close to 5,000.
    for (const delta of accepted) {
      expect(delta).toBeLessThanOrEqual(Math.ceil((20 / 60) * 220));
    }

    // Twelve syncs over ~4 minutes must not have produced thousands of steps.
    expect(stored).toBeLessThan(1_000);
    expect(stored).toBeLessThan(INFLATED);
  });

  it('syncing more often does not earn more steps', () => {
    // Same wall-clock span, different sync cadences. The accepted total must not
    // depend on how often the client talks to the server — that dependency was the
    // whole exploit.
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

    // Both bounded by the same physical rate over the same span, so they land in
    // the same ballpark rather than scaling with sync count.
    const bound = Math.ceil(spanMinutes * 220) + 220; // +1 window of slack
    expect(few).toBeLessThanOrEqual(bound);
    expect(many).toBeLessThanOrEqual(bound);
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
    // stand on its own. 02:00 local allows 2h * 9,000 = 18,000.
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
        timezone: 'UTC', // 02:00 local => 2h * 9,000 = 18,000
      });
      expect(result.clampedSteps).toBe(18_000);
      expect(result.flagged).toBe(true);
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
        timezone: 'UTC', // 5 minutes in — the 3,000 floor applies
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
      expect(result.clampedSteps).toBe(3_000); // FIRST_SYNC_FLOOR
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
    // A full day allows 24h * 9,000 = 216,000 by the sustained rate, so the daily
    // cap has to be what binds — otherwise "past date" would mean "unvalidated".
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
    // Passing today's date must behave exactly as before: 10 minutes in, the floor.
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
      expect(result.clampedSteps).toBe(3_000);
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
      expect(result.clampedSteps).toBe(3_000);
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

  it('leaves the delta ceiling in charge once a date has an accepted increase', () => {
    // syncDate only feeds the first-accepted-value branch. A past date that already
    // has a row is measured from lastStepIncreaseAt, and that must not change.
    jest.useFakeTimers().setSystemTime(justAfterMidnight);
    try {
      const result = validateSteps({
        ...base,
        incomingSteps: 12_000,
        existingSteps: 5_000,
        lastStepIncreaseAt: minsAgo(2), // 2 min => 440 steps allowed
        timezone: 'UTC',
        syncDate: '2026-08-16',
      });
      expect(result.clampedSteps).toBe(5_440);
      expect(result.flagged).toBe(true);
      expect(result.reason).toMatch(/Rate too high/);
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
    it.each([
      [8_000, 5_000, 'smartwatch flushes a 3,000-step backlog'],
      [12_000, 2_000, 'app reopened after the OS killed it'],
      [20_000, 3_000, 'a full day of walking arrives in one read'],
    ])(
      '%i steps over a stored %i → clamped, not implausible (%s)',
      (incoming, existing) => {
        jest.useFakeTimers().setSystemTime(new Date('2026-08-17T18:00:00Z')); // 18h elapsed
        try {
          const result = check(incoming, existing);
          expect(result.flagged).toBe(true);
          expect(result.severity).toBe('clamped');
        } finally {
          jest.useRealTimers();
        }
      },
    );

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
      // The identical 40,000 at 20:00 (1,200 min → 264,000 physical ceiling) is
      // merely clamped by the daily cap, not evidence of anything.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-17T20:00:00Z'));
      try {
        const result = check(40_000, 1_000);
        expect(result.severity).toBe('clamped');
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
