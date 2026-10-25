/**
 * The split between what a user walked and what we will pay them for.
 *
 * Until now these were one number. Every anti-cheat ceiling lowered `steps`,
 * and `steps` was also what the user saw — so somebody who genuinely walked
 * 20,000 on a 15,000 baseline was shown 15,000 and, in effect, told they had
 * not walked it. The ceiling is a fraud control; the count is the product.
 *
 * The property that matters most here is NOT that the raw figure is reported.
 * It is that introducing it changed nothing about what pays:
 *
 *   `clampedSteps` keeps its exact previous value in every case.
 *
 * That is what makes the split safe to ship. Every coin, goal, challenge,
 * streak and baseline decision reads `clampedSteps`; if a display surface is
 * missed, a user sees a conservative number, which is the old behaviour. If
 * the two had been swapped round, a missed payment path would pay on
 * unverified steps, and the failure would be money rather than cosmetics.
 */
const { validateSteps, MAX_DAILY_STEPS } = require('../utils/stepValidation');

/** A day with enough elapsed time that the rate ceilings are not the binding one. */
const base = {
  existingSteps: 0,
  bonusSteps: 0,
  dailyGoal: 10_000,
  timezone: 'Asia/Kolkata',
  syncDate: null,
};

describe('reportedSteps — what the device said', () => {
  it('reports the real figure while the ceiling still bounds what pays', () => {
    // The case the whole change exists for.
    const r = validateSteps({ ...base, incomingSteps: 20_000, stepBaseline: 15_000 });
    expect(r.clampedSteps).toBe(15_000); // unchanged: this is what pays
    expect(r.reportedSteps).toBe(20_000); // new: this is what the user walked
    expect(r.severity).toBe('clamped');
  });

  it('is identical to clampedSteps when no ceiling binds', () => {
    const r = validateSteps({ ...base, incomingSteps: 9_000, stepBaseline: 15_000 });
    expect(r.clampedSteps).toBe(9_000);
    expect(r.reportedSteps).toBe(9_000);
    expect(r.severity).toBe('none');
  });

  it('still refuses the physically impossible', () => {
    // Display is not a licence to store anything. A day cannot hold more than
    // MAX_DAILY_STEPS, so neither can the reported figure.
    const r = validateSteps({ ...base, incomingSteps: 500_000, stepBaseline: 15_000 });
    expect(r.reportedSteps).toBe(MAX_DAILY_STEPS);
    expect(r.clampedSteps).toBeLessThanOrEqual(MAX_DAILY_STEPS);
  });

  it('is never below what will be paid for', () => {
    // A user must never be shown fewer steps than they are being credited for.
    for (const incoming of [0, 1, 5_000, 15_000, 30_000, 60_000]) {
      const r = validateSteps({ ...base, incomingSteps: incoming, stepBaseline: 15_000 });
      expect(r.reportedSteps).toBeGreaterThanOrEqual(r.clampedSteps);
    }
  });

  it('returns zero for a sync carrying no steps', () => {
    for (const v of [undefined, null, -5]) {
      const r = validateSteps({ ...base, incomingSteps: v, stepBaseline: 15_000 });
      expect(r.clampedSteps).toBe(0);
      expect(r.reportedSteps).toBe(0);
    }
  });

  it('follows a deliberate correction downward', () => {
    // The one case a decrease is intended: the client is repairing its own
    // over-count. Showing the pre-correction figure would defeat the repair.
    const r = validateSteps({
      ...base,
      incomingSteps: 4_000,
      existingSteps: 12_000,
      stepBaseline: 15_000,
      allowCorrection: true,
    });
    expect(r.corrected).toBe(true);
    expect(r.reportedSteps).toBe(r.clampedSteps);
    expect(r.reportedSteps).toBeLessThan(12_000);
  });
});

describe('the verified figure is untouched by the split', () => {
  // Pinned as a table because the guarantee is "nothing changed", and the
  // cheapest way to state that is to assert the old numbers directly.
  it.each([
    ['under every ceiling', { incomingSteps: 8_000, stepBaseline: 15_000 }, 8_000],
    ['exactly on the baseline', { incomingSteps: 15_000, stepBaseline: 15_000 }, 15_000],
    ['over the baseline', { incomingSteps: 25_000, stepBaseline: 15_000 }, 15_000],
    ['over the hard daily cap', { incomingSteps: 90_000, stepBaseline: 30_000 }, 30_000],
    ['no baseline characterised', { incomingSteps: 12_000, stepBaseline: null }, 12_000],
  ])('%s → clampedSteps stays %s', (_label, input, expected) => {
    expect(validateSteps({ ...base, ...input }).clampedSteps).toBe(expected);
  });

  it('does not let the reported figure leak into the paid one', () => {
    // If these ever become the same variable again, this fails.
    const r = validateSteps({ ...base, incomingSteps: 40_000, stepBaseline: 15_000 });
    expect(r.clampedSteps).toBe(15_000);
    expect(r.reportedSteps).toBe(40_000);
    expect(r.clampedSteps).not.toBe(r.reportedSteps);
  });
});
