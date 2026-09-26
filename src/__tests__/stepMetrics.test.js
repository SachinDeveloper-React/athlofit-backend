/**
 * Distance, calories and active minutes are held to what the accepted steps
 * allow.
 *
 * The Android app derives all three from its RAW step count, so a day whose
 * steps were held still arrived with full-size figures: on 23 Sep, 53.26 km,
 * 2,725 kcal and 683 active minutes beside 15,000 stored steps — the numbers
 * 68,286 raw steps produce. Those are what the distance, calorie and
 * active-minute challenges pay on.
 */
const {
  stepMetricCeilings,
  boundStepMetrics,
} = require('../utils/stepMetrics');

/** The Android app's own derivation — deriveFromSteps in healthConnect.service.ts. */
const androidDerived = (steps, kg = 70, stride = 0.78) => ({
  distance: Math.round(steps * (stride / 1000) * 100) / 100,
  calories: Math.round(steps * ((kg * 0.57) / 1000)),
  activeMinutes: Math.round(steps / 100),
});

describe('stepMetricCeilings', () => {
  it('allows a runner’s step, two and a half walking calories, and a minute per 60 steps', () => {
    expect(stepMetricCeilings({ walkedSteps: 10_000, weightKg: 70 })).toEqual({
      distance: 15,
      calories: 998,
      activeMinutes: 167,
    });
  });

  it('never allows more active minutes than the day has had', () => {
    expect(stepMetricCeilings({ walkedSteps: 10_000, minutesOnDate: 120 }).activeMinutes).toBe(120);
  });

  it('falls back to the app’s 70 kg, and bounds an absurd weight', () => {
    const at70 = stepMetricCeilings({ walkedSteps: 10_000, weightKg: null }).calories;
    expect(at70).toBe(998);
    expect(stepMetricCeilings({ walkedSteps: 10_000, weightKg: 5_000 }).calories)
      .toBe(stepMetricCeilings({ walkedSteps: 10_000, weightKg: 200 }).calories);
  });

  it('allows nothing for no steps', () => {
    expect(stepMetricCeilings({ walkedSteps: 0 })).toEqual({ distance: 0, calories: 0, activeMinutes: 0 });
  });
});

describe('boundStepMetrics', () => {
  it('brings 23 Sep’s figures down to what its stored steps allow', () => {
    const r = boundStepMetrics(
      { distance: 53.26, calories: 2_725, activeMinutes: 683 },
      stepMetricCeilings({ walkedSteps: 15_000, weightKg: 70, minutesOnDate: 1_440 }),
    );
    expect(r).toEqual({
      distance: 22.5,
      calories: 1_497,
      activeMinutes: 250,
      bounded: ['distance', 'calories', 'activeMinutes'],
    });
  });

  it('leaves what the Android app derives from honest steps untouched', () => {
    for (const [steps, stride] of [[3_000, 0.78], [10_000, 0.78], [25_000, 0.7]]) {
      const sent = androidDerived(steps, 70, stride);
      const r = boundStepMetrics(sent, stepMetricCeilings({ walkedSteps: steps, weightKg: 70 }));
      expect(r.bounded).toEqual([]);
      expect(r).toMatchObject(sent);
    }
  });

  it('leaves a HealthKit run untouched', () => {
    // 10 km in 8,000 steps: 1.25 m a step, and running energy.
    const r = boundStepMetrics(
      { distance: 10, calories: 700, activeMinutes: 55 },
      stepMetricCeilings({ walkedSteps: 8_000, weightKg: 70 }),
    );
    expect(r.bounded).toEqual([]);
  });

  it('passes a field the sync did not carry through as it was', () => {
    const r = boundStepMetrics(
      { distance: undefined, calories: null, activeMinutes: 10 },
      stepMetricCeilings({ walkedSteps: 5_000 }),
    );
    expect(r).toEqual({ distance: undefined, calories: null, activeMinutes: 10, bounded: [] });
  });
});
