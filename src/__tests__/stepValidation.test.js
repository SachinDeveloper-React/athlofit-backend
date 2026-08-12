// Tests for server-side step validation.
//
// The focus is Rule 3 (no-decrease). Applied unconditionally it turned the stored
// count into a high-water mark that nothing could bring down: an inflated figure
// stayed for the rest of the day, was returned to the app as its login baseline,
// and was re-reported from there. `allowCorrection` is the repair path, and these
// tests pin down that it repairs without weakening the multi-device protection.

const { validateSteps } = require('../utils/stepValidation');

const base = { bonusSteps: 0, lastSyncAt: null, dailyGoal: 10000 };

describe('validateSteps — no-decrease rule', () => {
  it('keeps the stored value when a device reports fewer steps', () => {
    // Normal multi-device case: phone B is behind phone A. Not a correction.
    const result = validateSteps({ ...base, incomingSteps: 3000, existingSteps: 8000 });
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
    const result = validateSteps({ ...base, incomingSteps: 7050, existingSteps: 7097 });
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
    const result = validateSteps({
      ...base,
      incomingSteps: 9000,
      existingSteps: 3000,
      allowCorrection: true,
    });
    expect(result.clampedSteps).toBe(9000);
    expect(result.corrected).toBe(false);
  });
});

describe('validateSteps — hard limits', () => {
  it('clamps to the absolute daily cap', () => {
    const result = validateSteps({ ...base, incomingSteps: 500_000, existingSteps: 0 });
    expect(result.clampedSteps).toBe(100_000);
  });

  it('treats missing or negative input as zero', () => {
    expect(validateSteps({ ...base, incomingSteps: undefined, existingSteps: 500 }).clampedSteps).toBe(0);
    expect(validateSteps({ ...base, incomingSteps: null, existingSteps: 500 }).clampedSteps).toBe(0);
    expect(validateSteps({ ...base, incomingSteps: -50, existingSteps: 500 }).clampedSteps).toBe(0);
  });

  it('clamps an implausible jump between two closely spaced syncs', () => {
    const result = validateSteps({
      ...base,
      incomingSteps: 40_000,
      existingSteps: 1_000,
      lastSyncAt: new Date(Date.now() - 60_000), // one minute ago
    });
    // 5,000 is the most a single sync may add inside the rapid-jump window.
    expect(result.clampedSteps).toBe(6_000);
  });

  it('allows a normal increase over a normal interval', () => {
    const result = validateSteps({
      ...base,
      incomingSteps: 5_400,
      existingSteps: 5_000,
      lastSyncAt: new Date(Date.now() - 10 * 60_000),
    });
    expect(result.clampedSteps).toBe(5_400);
  });
});
