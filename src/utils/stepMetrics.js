// src/utils/stepMetrics.js
//
// Distance, calories and active minutes, held to what the day's steps allow.
//
// ── Why the server bounds them ──────────────────────────────────────────────
//
// The client sends these three alongside its steps, and they were stored
// exactly as sent. On Android they are not measurements at all: the app
// derives every one of them from its own step count — 0.78 m a step (0.70 for
// women, 0.76 in the native worker), weight × 0.57 kcal per thousand steps, a
// minute per hundred steps (deriveFromSteps in healthConnect.service.ts,
// HealthSyncHelper.kt). And the count it derives them from is the RAW one,
// before any hold or ceiling here has touched it. On 23 Sep one row stored
// 15,000 steps beside 53.26 km, 2,725 kcal and 683 active minutes — exactly
// what 68,286 raw steps produce — and those three fields are what the
// distance, calorie and active-minute challenges pay on. None of the step
// rules ever saw them.
//
// iOS sends HealthKit's own walking-and-running distance and active energy,
// which are real measurements and can run well above the Android formulas: a
// runner covers more ground, and burns more, per step than a walker. So the
// bounds sit far above the formulas. They refuse a figure the accepted steps
// could not have produced, not one that merely differs from Android's estimate:
//
//   distance        ≤ steps × 1.5 m — a fast runner's step; walking is ~0.75
//   calories        ≤ 2.5 × the app's own walking formula, which is about what
//                     running costs per step
//   active minutes  ≤ one per 60 steps, and never more than the day has had
//
// They are measured against the day's ACCEPTED walked steps — after every hold
// and ceiling — so when steps are held, what those steps would have paid for
// is held with them.
//
// The one honest figure this can cut is energy HealthKit attributes to
// something other than steps: a gym session or a ride logged on an iPhone
// counts towards active calories without adding a step. In an app that pays
// for walking, that is the right side to be wrong on.

/** Longest distance one step may account for, in metres. */
const MAX_STEP_LENGTH_M = 1.5;
/** The app's own walking figure: kcal per step per kg of body weight. */
const KCAL_PER_STEP_PER_KG = 0.57 / 1000;
/** How far above walking a step's energy may go. */
const MAX_CALORIE_FACTOR = 2.5;
/** Fewest steps one active minute may be built from. */
const MIN_STEPS_PER_ACTIVE_MINUTE = 60;
/** Weight assumed when the profile has none — the app's own default. */
const DEFAULT_WEIGHT_KG = 70;

/**
 * The most distance, calories and active minutes a day's steps can account for.
 *
 * @param {object} params
 * @param {number} params.walkedSteps - The day's accepted walked steps.
 * @param {number} [params.weightKg] - From the profile; bounded to 30–200 kg.
 * @param {number|null} [params.minutesOnDate] - Minutes of the day elapsed so
 *   far, for today; the whole day for a past date.
 * @returns {{ distance: number, calories: number, activeMinutes: number }}
 */
function stepMetricCeilings({ walkedSteps, weightKg, minutesOnDate = null }) {
  const steps = Math.max(0, Math.round(Number(walkedSteps) || 0));
  const kg = Math.min(200, Math.max(30, Number(weightKg) || DEFAULT_WEIGHT_KG));
  // `null` is "not known", not zero minutes — Number(null) is 0, and would cap
  // active minutes at nothing.
  const byMinutes =
    minutesOnDate != null && Number.isFinite(Number(minutesOnDate))
      ? Math.max(0, Math.floor(Number(minutesOnDate)))
      : Infinity;

  return {
    distance: Math.round(((steps * MAX_STEP_LENGTH_M) / 1000) * 100) / 100,
    calories: Math.ceil(steps * kg * KCAL_PER_STEP_PER_KG * MAX_CALORIE_FACTOR),
    activeMinutes: Math.min(byMinutes, Math.ceil(steps / MIN_STEPS_PER_ACTIVE_MINUTE)),
  };
}

/**
 * Hold each metric to its ceiling. Values that are not numbers pass through
 * untouched, so a field the caller did not have stays as it was.
 *
 * @param {{ distance?: number, calories?: number, activeMinutes?: number }} values
 * @param {ReturnType<typeof stepMetricCeilings>} ceilings
 * @returns {{ distance?: number, calories?: number, activeMinutes?: number,
 *   bounded: string[] }} `bounded` names the fields that were lowered.
 */
function boundStepMetrics(values, ceilings) {
  const out = { bounded: [] };
  for (const key of ['distance', 'calories', 'activeMinutes']) {
    const v = values[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > ceilings[key]) {
      out[key] = ceilings[key];
      out.bounded.push(key);
    } else {
      out[key] = v;
    }
  }
  return out;
}

module.exports = {
  stepMetricCeilings,
  boundStepMetrics,
  MAX_STEP_LENGTH_M,
  KCAL_PER_STEP_PER_KG,
  MAX_CALORIE_FACTOR,
  MIN_STEPS_PER_ACTIVE_MINUTE,
};
