// src/utils/stepValidation.js
//
// Server-side step validation / anti-cheat.
//
// Validates incoming step counts against physiological limits and
// rate-of-change rules. Returns the clamped (safe) step count and
// flags suspicious submissions.
//
// How it works:
//   Every rule contributes a CEILING, and the accepted value is the minimum of
//   them. That structure is deliberate — see the note on the old design below.
//
//   1. Absolute daily cap.
//   2. Stuck-source rule: a device reporting a constant rather than a
//      measurement is held where it is. Judged per client stream, and a hold
//      covers the whole day — see the note at HOLD_STALE_MIN. A pattern the
//      account was already held for on an earlier day is refused on its first
//      return and closes the day — see the note at PRIOR_STUCK_DAYS.
//      Shared-source rule: a counter that is also feeding an older account is
//      held where it is, for the day. Decided outside this file, in
//      utils/sharedStepSource.js, because it needs other accounts' rows; this
//      file only applies the verdict.
//   3. Day ceiling: the total against how much of its day has elapsed. A hard
//      bound — no story about backlogs or sync cadence makes more steps fit into
//      a day than the day has room for. There used to be a second, DELTA-based
//      rate ceiling here and the looser of the two won; that let a client syncing
//      every 15 minutes collect 220 steps/min all day. See the long note at the
//      ceiling itself.
//   4. Baseline ceiling: what THIS account walks, from its own trailing days.
//      The only rule here that is about the user rather than about the species,
//      and the one the step-spoofing incident needed. See the note at
//      BASELINE_FLOOR.
//   5. No-decrease rule (handled separately, after the ceilings): steps should
//      not decrease within a day, allowing a small tolerance for sensor jitter.
//      Overridable via `allowCorrection` so a client that over-reported can
//      repair the record.
//
// ── Why the ceilings are composed with Math.min ──────────────────────────────
//
// The previous version applied each rule by ASSIGNING to `steps`, so the last
// rule to run decided the value. That turned the rapid-jump rule into a step
// GRANT rather than a cap:
//
//     if (elapsedMs < 5min && stepDelta > 5000) steps = existingWalked + 5000;
//
// A client reporting a figure far above the stored one was not rejected — it was
// handed exactly `existing + 5000`. It then reported the same figure again, and
// got another 5000 on top. The stored total climbed in exact 5,000-step
// increments, indefinitely, which is the "steps jumping by 5000 continuously"
// report this replaces.
//
// Two things made it worse:
//   * The rule computed `stepDelta` from the ORIGINAL input, then overwrote the
//     much tighter value the rate rule had just produced. So it actively undid
//     the rate limit (a 3-minute window allows 660 steps; this raised it to 5000).
//   * A 2-minute minimum on the rate check meant syncs closer together than that
//     skipped the rate rule entirely. The app's foreground sync throttle is 20
//     seconds, so the grant applied every 20 seconds with no rate check at all.
//
// Note that 5,000 steps in under 5 minutes needs >1,000 steps/min, while this
// file's own MAX_STEPS_PER_MINUTE is 220 — the threshold was looser than the
// rate limit for every window under ~22 minutes, so it could only ever add
// steps, never restrict them. It is gone; the rate ceiling covers the same
// attack correctly, at every window size.

const { minutesElapsedOnDate } = require('./date');

const MAX_DAILY_STEPS = 50_000; // realistic daily cap (marathon = ~42k steps)
const MAX_STEPS_PER_MINUTE = 220; // absolute burst (sprinting)
const DECREASE_TOLERANCE = 100; // allow small sensor corrections

// ── The day ceiling's intercept at midnight ─────────────────────────────────
//
// (This bound was once the "first accepted value of the day" ceiling and applied
// only to a day's first sync. It now applies to every sync, as the second of the
// two rate bounds — see the note at the ceiling. The reasoning below is what set
// its shape, and is unchanged by that.)
//
// This bound used to be `max(3_000, hours * 9_000)` — a sustained 150 steps/min
// for however much of the day had elapsed. That is a rate no human holds for a
// whole day, and the arithmetic made it worse: 50,000 / 9,000 is 5.6 hours, so
// from mid-morning onward the bound exceeded MAX_DAILY_STEPS and stopped binding
// altogether. From 05:36 until midnight the ONLY limit on the first sync of a day
// was the absolute daily cap, so a client could hand over 50,000 steps in a single
// post and be paid passive coins for all of them without the rule ever engaging.
// That is the "0 → 26,872 in one transaction" row in the coin ledger.
//
// The replacement interpolates between two figures the system already commits to:
// what could plausibly arrive at any single moment, and what a whole day may hold.
//
//   * At 00:00 the bound is FIRST_SYNC_BURST_ALLOWANCE. An intercept is needed
//     because the client and server do not agree on the day boundary to the
//     minute — timezone strings, clock skew and a device that just crossed
//     midnight all put real steps in the first minutes of a "day" — and because
//     an early-morning run is genuinely front-loaded.
//   * At 24:00 the bound is exactly MAX_DAILY_STEPS, so a past date whose whole
//     day happened is judged by the daily cap and nothing tighter. (Exactly, not
//     approximately: the ceilings are combined with a strict `<`, so a tie leaves
//     the daily cap as the binding rule and its reason as the one reported.)
//
// In between it is linear, which keeps it BELOW the daily cap for the first 22
// hours of every day — so unlike the old version it actually does something for
// the whole day rather than expiring before lunch.
const FIRST_SYNC_BURST_ALLOWANCE = 6_000;

// ── A source that has stopped measuring ─────────────────────────────────────
//
// Every ceiling above bounds how FAST steps may arrive. None of them can tell
// whether the number arriving is a measurement at all, and that is a real gap:
// a device whose counter is being advanced by a fixed quantum each sync sits
// comfortably under the rate ceiling forever. One account reported 2,270 steps
// in each of eight consecutive 15-minute syncs — 18,160 steps — and every one
// of them was accepted, because 2,270 is well below the 3,311 a 15-minute
// window allows.
//
// What gave it away was not the size of the deltas but their INVARIANCE. The
// sync windows in that run ranged from 15.02 to 15.09 minutes; at the implied
// 150.8 steps/min a real counter would have varied by roughly ±11 steps across
// them. It varied by zero. A figure derived from a hardware counter cannot be
// independent of how much time elapsed, so a delta that repeats to the exact
// step across differently-sized windows is not a measurement — it is a constant
// being added.
//
// Hence a rule about repetition rather than magnitude. It is deliberately
// measured on the RAW client total, not on the stored one: once this rule binds,
// the stored total stops moving, so a server-side delta would start growing
// (2,270, 4,540, 6,810…) and the pattern would break on the very next sync,
// releasing the guard it just triggered.
//
// Both thresholds are set so that no real device trips them:
//   * 500 steps, because small identical deltas are ordinary — a phone idling on
//     a desk reports +10 twice in a row all the time, and that is not evidence.
//   * three repeats, so the fourth identical delta is the first one refused. Two
//     matching deltas is a coincidence a brisk, steady walker could produce; four
//     identical to the step is not something a counter does.
const STUCK_DELTA_MIN_STEPS = 500;
const STUCK_DELTA_REPEATS = 3;

// ── The same fault, one jitter away ─────────────────────────────────────────
//
// The rule above tests deltas for EXACT equality, and that turned out to be a
// threshold an attacker steps over by adding noise. The account that prompted
// it was later seen posting 2,240 / 2,310 / 2,280 / 2,260 / 2,280 — a spread of
// roughly ±1.5% — and the streak never got past two, because the fourth
// identical delta it waits for never arrived. Nineteen consecutive syncs were
// accepted and the day closed at the daily cap.
//
// The original reasoning was right and the test was too literal. What it says is
// that a figure derived from a hardware counter cannot be independent of how much
// time elapsed. Equality of DELTAS is one way to see that; equality of RATES is
// the general form, and it survives jitter.
//
// So this measures steps per minute across each sync window and asks whether the
// spread of the streak stays inside a narrow band:
//
//     (max rate - min rate) / midpoint <= STUCK_RATE_TOLERANCE
//
// Spread rather than distance from a reference, because a reference has to be
// picked and both available choices are wrong. Fixing it to the first sample
// makes the verdict depend on which sample happened to start the run — the same
// incident data trips the rule or does not, at ±3%, depending on whether the
// streak begins at 11:44 or 11:59. Updating it to a running mean lets a slowly
// drifting rate stay "in band" indefinitely by walking the reference along with
// it. Min and max over the streak have neither problem and are order-independent.
//
// ── Why a span and not just a count ─────────────────────────────────────────
//
// Sample count alone is not a unit that means anything here, because sync cadence
// is the client's choice. Six samples from the widget worker is an hour and a
// half; six from the app's foreground sync can be twelve minutes, which is an
// ordinary steady walk. Requiring a wall-clock span as well makes the rule say
// what it means — the rate has not varied for an hour and a half — at any cadence.
//
// The thresholds are set so that being wrong is survivable rather than so that
// it is impossible. Ninety minutes of walking whose 15-minute rates stay within
// 5% is something a treadmill could produce; a road crossing, a traffic light or
// sitting down for a minute breaks it, which is why real outdoor walking does
// not. And the consequence of a false positive is 'stuck_source', which holds
// the total and explicitly never reaches the cheat path — then releases on the
// first sample that varies.
/** Fractional spread of steps/min a streak may hold before it is not a measurement. */
const STUCK_RATE_TOLERANCE = 0.05;
/** Consecutive in-band samples needed. */
const STUCK_RATE_SAMPLES = 6;
/** Wall-clock minutes the streak must also span, so cadence cannot shortcut it. */
const STUCK_RATE_MIN_SPAN_MIN = 90;
/**
 * Shortest window a rate may be computed from. Below this the divisor is small
 * enough that ordinary timing noise dominates, and a burst of rapid syncs would
 * produce wild rates that break streaks rather than reveal anything.
 */
const STUCK_RATE_MIN_WINDOW_MIN = 2;

// ── Evidence that survives an interruption ──────────────────────────────────
//
// Both detectors above gather their evidence as a STREAK: consecutive samples,
// reset to nothing by the first one that varies. That made the threshold a
// number the device only had to stay under. One account (21 Sep, a Xiaomi
// 23049PCD8I on the service stream) ran 2,240 / 2,250 / 2,260 / 2,260 / 2,260
// — five samples inside a 1.2% band — then posted 1,018, then ran 2,260 again,
// then broke again, and so on across the day. Five is one short of
// STUCK_RATE_SAMPLES, three identical deltas is one short of the fourth that
// STUCK_DELTA_REPEATS refuses, and every break put both counters back to zero.
// The exact delta 2,260 appeared six times that day and the ~150 steps/min rate
// eight times; not one sync was refused, and the day closed at the baseline
// roof of 30,000.
//
// The reasoning behind the thresholds was never about consecutiveness — it was
// that a counter measuring elapsed time does not return to the same rate, to
// the step, again and again. A device that does so with a pause in between has
// still done so. So the evidence is now kept for the whole day rather than for
// the current run: each stream carries the samples it has produced today
// (delta, rate, window), and every new sample is judged against ALL of them.
//
//   * The same exact delta, STUCK_DELTA_REPEATS times earlier today, anywhere
//     in the day — not only immediately before — provided those occurrences
//     span STUCK_RATE_MIN_SPAN_MIN, so that a burst of rapid syncs cannot
//     count as a day's worth of returns.
//   * A rate band: the largest set of today's samples, including this one,
//     whose rates sit inside STUCK_RATE_TOLERANCE of each other, holding
//     STUCK_RATE_SAMPLES and spanning STUCK_RATE_MIN_SPAN_MIN from its first
//     window to now. The band is found by sorting the rates and sliding a
//     window of the tolerance's width, so it is order-independent and does not
//     depend on which sample happened to arrive first or last.
//
// The consecutive detectors are kept as they were; the day-wide ones only ever
// add refusals. Nothing about the thresholds changes — a real walker's
// 15-minute windows spread far wider than 5% across a day, so the only thing
// this costs an honest user is the same treadmill case the streak rule
// already accepts, now also when the session is split in two.
//
// A refusal under this rule releases as before: the next sample that does not
// belong to the band goes through, and the steps reported while held are set
// aside. What is different is what happens after that release — the band is
// still there, so the next sample that returns to it is refused straight away
// rather than being allowed to rebuild a streak from nothing. The pattern is
// visible for as long as the device keeps producing it, which is the whole
// point.
/**
 * Samples kept per stream per day. A 15-minute cadence produces 96 a day; the
 * app's foreground sync adds few, since a sample needs STUCK_DELTA_MIN_STEPS
 * and a STUCK_RATE_MIN_WINDOW_MIN window. Oldest are dropped past this.
 */
const MAX_CADENCE_SAMPLES = 192;

// ── Evidence that survives midnight ─────────────────────────────────────────
//
// The day-wide detectors above still started every day from nothing, and that
// turned the evidence window into a daily allowance. One account (23 Sep, the
// same Xiaomi 23049PCD8I) ran ~150 steps/min on both streams from 08:00 local;
// the band completed at 09:30, by which time 13,389 steps had been accepted,
// and the baseline floor let the day close at 15,000 — goal met, coins paid.
// Every 15-minute window after that was refused, 72,416 raw steps in all — and
// nothing about the next morning would have been different: ninety minutes of
// a pattern the account had already been caught producing, credited fresh each
// day.
//
// The reasoning that made the evidence day-wide was that a counter measuring
// elapsed time does not keep returning to the same rate, to the step. A device
// that returns to it the next morning has still done so. So the samples a
// stream was REFUSED on over the last PRIOR_STUCK_DAYS are carried into the
// next day and judged alongside that day's own: the first sample that lands
// back in a band the account was already held for is refused at once, instead
// of after another ninety minutes of it.
//
// Only a hold that was unmistakable is carried. A day qualifies when one
// stream was refused on at least STUCK_RATE_SAMPLES samples spanning
// STUCK_RATE_MIN_SPAN_MIN — that is, the pattern kept going for another full
// evidence span AFTER the hold began, three hours of invariant cadence in all.
// A treadmill session that trips the rule is released by stepping off it and
// carries nothing; a device on a swing all day carries its whole band. And a
// carried band still only refuses samples that fall inside it: walking that
// varies the way a person does is unaffected, the day after a hold or any day.
//
// ── What a recurrence does to the rest of the day ───────────────────────────
//
// An ordinary hold releases on the first sample that varies, and accepts that
// sample as the first measurement since. Replayed with the carried band alone,
// the same day still closed at 7,919, because every sample that "varied" was
// the device's own partial window — stopping, restarting, a gap — at 683,
// 1,786, 1,408 and 1,594 steps, each accepted, and each followed straight back
// by the band. For an account caught once, a varying sample is some evidence of
// a person. For an account whose device has just returned to the pattern it
// was already held for, it is none: the device is running today, and its idle
// windows look exactly like walking.
//
// So a hold that rests on carried evidence CLOSES the day. It stands for every
// stream until midnight, and neither the holder varying nor the holder going
// quiet releases it. Steps accepted before the pattern returned still count;
// nothing after it does. Replayed, the same day closes at 2,119 — the two
// partial windows before the first return — instead of 15,000.
//
// The cost falls only on an account that was held for three hours of invariant
// cadence within the last week AND is back in that same band today: walking it
// genuinely does later that day is not counted. The row says so
// (`stuckClosed`), and an admin can credit it back.
/** Trailing days whose refused samples are carried forward. */
const PRIOR_STUCK_DAYS = 7;
/** Most carried samples judged per day; the newest are kept. */
const MAX_PRIOR_STUCK_SAMPLES = 96;

// ── One phone, two streams ──────────────────────────────────────────────────
//
// Both detectors above follow "the client's" raw totals across syncs, and the
// day's row kept exactly one such history. But one Android phone posts through
// TWO paths on the same 15-minute cadence, a few minutes apart: the foreground
// service with the live hardware count, and the widget worker with what Health
// Connect has on disk — which trails the sensor by a minute or two, because the
// platform pedometer writes its records in batches.
//
// Interleaved into one history, that reads as a device whose rate leaps every
// sync. One account ran a flat 2,250 steps per 15 minutes for three hours —
// nine identical deltas in a row on the service's own stream — and the merged
// history saw 131 steps/min from worker to service and 195 from service to
// worker, a 40% spread that reset the streak on every single sync. Neither
// detector got past two samples. Tracked on the service's stream alone, the
// same day is refused at the fifth sync.
//
// So the history is kept PER STREAM, keyed by the X-Client-Source header, and
// each stream is judged on its own deltas — which restores exactly the picture
// the detectors were designed around.
//
// That alone is not enough, because the two streams describe the SAME steps:
// holding the service's figure while the worker's Health Connect copy of it
// sails through would refuse nothing. A stuck stream therefore holds the whole
// day, every stream, and only the stream that earned the hold can release it —
// by producing a sample that varies. If the other stream could release it, the
// interleaving would do so on the very next sync.
//
// ── What a release hands back ───────────────────────────────────────────────
//
// The first version released the hold and then accepted the client's raw total
// in full, on the reasoning that a stuck sensor is a fault and the user did
// nothing. For a fault that is right; for a figure that was never a measurement
// it is not, and the two are indistinguishable from here. Replayed against that
// same account, a hold from the fifth sync onward ended with the raw 26,187
// arriving under a day ceiling of 26,839 the moment the pattern broke — every
// step it had held, handed over in one sync. A hold that only postpones is not
// a hold.
//
// So the steps a stream reported WHILE HELD are set aside for good. The day
// carries a running `stuckForfeit`, every later raw figure — from any stream —
// is read net of it, and counting resumes from the sample that broke the
// pattern. What was accepted before the hold is untouched, and the releasing
// delta itself is accepted: it is the first figure that varied, which is the
// only evidence of measurement there is.
//
// A false positive now costs something, and it is worth being honest about the
// shape of it: ninety minutes of treadmill at a cadence steady to within 5%,
// and then whatever is walked before the cadence changes. Stepping off the
// treadmill changes it. The forfeited figure is written on the day's row, so it
// is visible and an admin can credit it back.
//
// ── A holder that goes quiet ────────────────────────────────────────────────
//
// If the holding stream stops posting — the OS kills the foreground service —
// the hold would otherwise stand until midnight, refusing the worker's honest
// figures with no one left to release it. After this long without a word from
// the holder, any stream may release, forfeiting what the holder had reported
// up to its last sync. An hour is four missed syncs at the service's cadence,
// which is how long a genuinely killed service looks from the server.
/** Minutes the holding stream must be silent before another stream may release the day. */
const HOLD_STALE_MIN = 60;

// ── What THIS user walks, as opposed to what a human can walk ───────────────
//
// Every rule above this point asks the same question: "could a person have
// walked this?" None of them asks "could this person have walked this?", and
// that gap is what the step-spoofing incident actually exploited.
//
// The evidence. Thirteen accounts carried Health Connect origins with a
// randomised package suffix. Ten of them had ONE such origin, stable for weeks,
// and their days ran 43 to 13,830 steps — ordinary people, and the randomised
// suffix is just how the platform pedometer names itself. The other three
// rotated between four and nine origins, one of them five in a single day, and
// their days ran 15,488 to 50,000 with a mean of 31,048. One account posted six
// consecutive days averaging 34,682 — 26 km every day for a week.
//
// Not one of those days was refused. Every one of them was under MAX_DAILY_STEPS,
// and MAX_DAILY_STEPS is the only bound that spans a whole day. That constant is
// a backstop against the physically impossible, not a statement about anybody in
// particular: 50,000 steps is a marathon and a half. Against a population whose
// honest maximum is 13,830 it leaves a 3.6x corridor that is invisible to
// validation, and the corridor is where all of the fraud lived.
//
// So the ceiling has to know the user. The shape:
//
//   limit = clamp(BASELINE_FLOOR, MULTIPLIER * p90(trailing days), MAX_BASELINE)
//
// p90 rather than the mean, because the ceiling should be set by a good day and
// not dragged down by a quiet week. The multiplier is what keeps it a ceiling
// rather than a target — it has to sit far enough above normal that improving,
// travelling, or walking a half marathon does not hit it.
//
// Three properties this is built for:
//
//   * It cannot be jumped. A new account gets BASELINE_FLOOR and nothing more,
//     so day one is 15,000 and no argument about elapsed hours changes that.
//   * It can only be climbed slowly. The trailing window is fed by figures this
//     rule already accepted, so the ceiling at most multiplies once per window —
//     and a user pinned to their own ceiling every single day is a pattern that
//     reads clearly in the data, which the old corridor never produced.
//   * It has a hard roof. MAX_BASELINE_CEILING binds however good the history
//     looks, so a history that was poisoned before this rule existed cannot
//     unlock the full daily cap while it is being cleaned up.
//
// Being over it is 'clamped', never 'implausible'. The figure is possible for a
// human and this rule is a statement about a distribution, not about intent —
// a genuine ultramarathon gets clamped here and must not be punished for it.
/** Ceiling for an account with too little history to characterise. */
const BASELINE_FLOOR = 15_000;
/** How far above a user's own good day the ceiling sits. */
const BASELINE_MULTIPLIER = 1.75;
/** Hard roof, whatever the history says. */
const MAX_BASELINE_CEILING = 30_000;
/** Days of history below which only the floor applies. */
const BASELINE_MIN_DAYS = 7;
/** Trailing days the baseline is computed over. */
const BASELINE_WINDOW_DAYS = 28;

/**
 * The per-user daily ceiling, from that user's own recent days.
 *
 * Pure, and takes already-loaded totals rather than querying, so the policy is
 * testable without a database and the caller decides how the window is read.
 *
 * @param {number[]} recentDailyWalked - Walked steps (bonus excluded) for the
 *   trailing days, EXCLUDING the day being validated. Order does not matter.
 * @returns {number} The ceiling to apply.
 */
function computeStepBaseline(recentDailyWalked) {
  const days = (Array.isArray(recentDailyWalked) ? recentDailyWalked : [])
    .map(n => Number(n))
    .filter(n => Number.isFinite(n) && n >= 0);

  // Too new, or too sparse, to say anything about this account. The floor is the
  // whole rule for them — which is the right default: it is well above what any
  // honest user in the incident data reached, and well below the corridor.
  if (days.length < BASELINE_MIN_DAYS) return BASELINE_FLOOR;

  const sorted = [...days].sort((a, b) => a - b);
  // Nearest-rank p90: the smallest value at or above which the top decile sits.
  const p90 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];

  return Math.min(
    MAX_BASELINE_CEILING,
    Math.max(BASELINE_FLOOR, Math.ceil(p90 * BASELINE_MULTIPLIER)),
  );
}

/**
 * Follows the client's OWN step figures across syncs, so a source that has
 * stopped measuring can be recognised.
 *
 * Two independent detectors, either of which is sufficient:
 *
 *   * REPEATED DELTAS — the same delta to the exact step, several times running.
 *     Catches a counter being advanced by a fixed quantum regardless of how long
 *     the window was, which is the strongest possible evidence and needs no clock.
 *   * INVARIANT RATE — steps per minute holding inside a narrow band for an hour
 *     and a half. Catches the same fault once jitter has been added to defeat the
 *     equality test. See the note at STUCK_RATE_TOLERANCE.
 *
 * Kept as two rather than replaced by one, because they see different things: a
 * delta that repeats exactly across windows of DIFFERENT lengths has a constant
 * delta and a varying rate, so the rate test would miss it.
 *
 * Each is applied twice: to the current run of consecutive samples, as
 * originally written, and to every sample the stream has produced today. The
 * second is what stops a device from staying one sample under the threshold
 * and breaking the run on purpose — see the note at MAX_CADENCE_SAMPLES.
 *
 * Pure, and separate from validateSteps, because it is bookkeeping the caller has
 * to persist between requests rather than a judgement about this one. The caller
 * stores everything returned except `delta`, `rate`, `stuck` and `stuckReason` on
 * the day's row and hands it back on the next sync.
 *
 * Multi-device accounts fail OPEN: two phones posting their own totals produce
 * deltas that do not match each other and rates that jump around, so both streaks
 * reset and neither rule binds. That is the right direction to fail for a rule
 * whose effect is to stop counting a user's steps.
 *
 * @param {object} params
 * @param {number} params.incomingSteps - Raw client total for the day, before any clamping.
 * @param {number|Date} [params.at] - When this sync arrived. Defaults to now.
 * @param {number|null} params.lastIncomingSteps - Raw client total from the previous sync.
 * @param {number|Date|null} [params.lastIncomingAt] - When that total arrived.
 * @param {number} params.lastIncomingDelta - The delta that produced `repeatedDeltaCount`.
 * @param {number} params.repeatedDeltaCount - How many times that delta has now repeated.
 * @param {number} [params.cadenceStreak] - In-band rate samples so far.
 * @param {number|null} [params.cadenceRateMin] - Lowest rate in the current streak.
 * @param {number|null} [params.cadenceRateMax] - Highest rate in the current streak.
 * @param {number|Date|null} [params.cadenceStreakAt] - When the current streak began.
 * @param {Array<{delta: number, rate: number|null, from: number|Date|null,
 *   at: number|Date, stuck: boolean}>} [params.samples] - Every sample this
 *   stream produced today, oldest first, as returned by the previous call.
 * @param {Array<{delta: number, rate: number|null, from: number|Date|null,
 *   at: number|Date}>} [params.priorSamples] - Samples refused on earlier days,
 *   from selectPriorStuckSamples(). Judged as evidence alongside `samples`, never
 *   returned in the new history.
 * @returns {{ delta: number, rate: number|null, stuck: boolean, stuckReason: string|null,
 *   lastIncomingSteps: number, lastIncomingAt: number, lastIncomingDelta: number,
 *   repeatedDeltaCount: number, cadenceStreak: number, cadenceRateMin: number|null,
 *   cadenceRateMax: number|null, cadenceStreakAt: number|null,
 *   samples: Array<{delta: number, rate: number|null, from: number|null, at: number, stuck: boolean, total: number}>,
 *   sample: {delta: number, rate: number|null, from: number|null, at: number, stuck: boolean, total: number}|null,
 *   recurrent: boolean }}
 *   `sample` is the one this call recorded, or null when the sync was not one
 *   (a re-send, a drop, a gain too small to say anything). `recurrent` is true
 *   when the stuck verdict rests on `priorSamples` — see resolveDayHold.
 */
function trackClientCadence({
  incomingSteps,
  at = Date.now(),
  lastIncomingSteps = null,
  lastIncomingAt = null,
  lastIncomingDelta = 0,
  repeatedDeltaCount = 0,
  cadenceStreak = 0,
  cadenceRateMin = null,
  cadenceRateMax = null,
  cadenceStreakAt = null,
  samples = [],
  priorSamples = [],
}) {
  const ms = v => (v == null ? null : new Date(v).getTime());
  const incoming = Math.round(Number(incomingSteps) || 0);
  const now = ms(at) ?? Date.now();

  // Today's samples as plain numbers, whatever shape the caller stored them in.
  // Anything unreadable is dropped rather than allowed to poison a comparison.
  const history = readSamples(samples);

  // Refused samples carried in from earlier days — see the note at
  // PRIOR_STUCK_DAYS. Evidence for the day-wide detectors only: they never
  // join today's history, so they are not persisted back, cannot be mistaken
  // for today's totals, and do not decide what a small sync inherits.
  const prior = readSamples(priorSamples).map(s => ({ ...s, prior: true }));

  /** No streak of either kind. Used wherever the evidence has to start over. */
  const cleared = {
    lastIncomingSteps: incoming,
    lastIncomingAt: now,
    repeatedDeltaCount: 0,
    cadenceStreak: 0,
    cadenceRateMin: null,
    cadenceRateMax: null,
    cadenceStreakAt: null,
    samples: [],
    sample: null,
    stuck: false,
    stuckReason: null,
    recurrent: false,
  };

  // No previous raw total to measure against — the first sync of a day, or a row
  // written by a build too old to have recorded one. Seed and say nothing.
  if (lastIncomingSteps === null || lastIncomingSteps === undefined) {
    return { ...cleared, delta: 0, rate: null, lastIncomingDelta: 0 };
  }

  const delta = incoming - Math.round(Number(lastIncomingSteps) || 0);

  /**
   * Whether a hold the counters have already earned is still standing. Used by
   * the two branches below that are not samples, so that they neither extend
   * nor release what the real samples decided.
   *
   * The last sample's own verdict is the answer, once there is one: the
   * day-wide evidence never resets, so it cannot be re-derived from the streak
   * counters the way it used to be. Rows written before samples were kept fall
   * back to the streak counters.
   */
  const spanSoFar =
    cadenceStreakAt == null ? 0 : (now - ms(cadenceStreakAt)) / 60_000;
  const heldStuck = history.length
    ? history[history.length - 1].stuck
    : repeatedDeltaCount >= STUCK_DELTA_REPEATS ||
      (cadenceStreak >= STUCK_RATE_SAMPLES && spanSoFar >= STUCK_RATE_MIN_SPAN_MIN);
  const heldReason = heldStuck
    ? 'cadence streak still standing; this sync was too small to be evidence either way'
    : null;

  // ── The same figure again ────────────────────────────────────────────────
  //
  // A re-send says nothing about cadence, and must not be allowed to say
  // anything. It used to land in the "behind" branch below and clear both
  // streaks, so a retried POST — the foreground service re-posts a payload
  // whose response it never saw — released a hold outright, and the next three
  // identical deltas were accepted while the streak rebuilt from nothing.
  //
  // Nor do the markers move. The next delta is still measured from when this
  // figure FIRST arrived; measured from the re-send instead, the window shrinks
  // to a few minutes, the rate leaps out of band, and the re-send has broken the
  // streak by a different route.
  if (delta === 0) {
    return {
      delta,
      rate: null,
      lastIncomingSteps: incoming,
      lastIncomingAt: ms(lastIncomingAt) ?? now,
      lastIncomingDelta,
      repeatedDeltaCount,
      cadenceStreak,
      cadenceRateMin,
      cadenceRateMax,
      cadenceStreakAt: ms(cadenceStreakAt),
      samples: history,
      sample: null,
      stuck: heldStuck,
      stuckReason: heldReason,
      recurrent: false,
    };
  }

  // ── A device that is behind ──────────────────────────────────────────────
  // The figure went DOWN, so whatever produced it is not the counter the last
  // one came from, and both streaks genuinely start over. This is what makes
  // multi-device accounts fail open: a second phone posting its own lower total
  // on the same stream lands here.
  if (delta < 0) {
    return { ...cleared, delta, rate: null, lastIncomingDelta: delta };
  }

  // ── A gain too small to say anything ─────────────────────────────────────
  //
  // A phone idling on a desk reports +10 all day, and building a streak out of
  // that would freeze a real user's total over nothing.
  //
  // But it does not CLEAR a streak either, and that distinction matters. It used
  // to: any delta under the threshold reset both detectors, so a single small
  // sync released a hold outright. Replaying the real incident through this
  // showed exactly that — the run was held from 14:15, then a +119 sync at 16:31
  // cleared it and the total climbed again on the very next ceiling. One cheap
  // sync should not be able to buy back a rule that took ninety minutes of
  // evidence to trigger.
  //
  // So it is treated the way a too-short window is: not a sample. It neither
  // extends nor breaks anything, and only the markers move.
  if (delta < STUCK_DELTA_MIN_STEPS) {
    return {
      delta,
      rate: null,
      lastIncomingSteps: incoming,
      lastIncomingAt: now,
      lastIncomingDelta,
      repeatedDeltaCount,
      cadenceStreak,
      cadenceRateMin,
      cadenceRateMax,
      cadenceStreakAt: ms(cadenceStreakAt),
      samples: history,
      sample: null,
      stuck: heldStuck,
      stuckReason: heldReason,
      recurrent: false,
    };
  }

  // ── Detector 1: the same delta, exactly ───────────────────────────────────
  const repeated = delta === lastIncomingDelta ? repeatedDeltaCount + 1 : 0;

  // ── Detector 2: a rate that does not vary ─────────────────────────────────
  const prevAt = ms(lastIncomingAt);
  const windowMinutes = prevAt == null ? null : (now - prevAt) / 60_000;

  let streak = cadenceStreak;
  let rateMin = cadenceRateMin;
  let rateMax = cadenceRateMax;
  let streakAt = ms(cadenceStreakAt);
  let rate = null;

  if (windowMinutes != null && windowMinutes >= STUCK_RATE_MIN_WINDOW_MIN) {
    rate = delta / windowMinutes;

    const nextMin = rateMin == null ? rate : Math.min(rateMin, rate);
    const nextMax = rateMax == null ? rate : Math.max(rateMax, rate);
    const midpoint = (nextMin + nextMax) / 2;
    const spread = midpoint > 0 ? (nextMax - nextMin) / midpoint : 0;

    if (streak > 0 && spread <= STUCK_RATE_TOLERANCE) {
      streak += 1;
      rateMin = nextMin;
      rateMax = nextMax;
    } else {
      // Out of band, or nothing to extend. Either way this sample starts the run.
      streak = 1;
      rateMin = rate;
      rateMax = rate;
      streakAt = prevAt; // the streak covers the window, so it starts where that did
    }
  }
  // Windows too short to measure are skipped rather than treated as evidence
  // either way: they neither extend a streak nor break one. A burst of rapid
  // syncs is a normal thing for the app to do and must not be able to clear a
  // streak on its own, nor to build one out of timing noise.

  const spanMinutes = streakAt == null ? 0 : (now - streakAt) / 60_000;
  const rateStuck =
    streak >= STUCK_RATE_SAMPLES && spanMinutes >= STUCK_RATE_MIN_SPAN_MIN;
  const deltaStuck = repeated >= STUCK_DELTA_REPEATS;

  // ── The same two detectors, over the whole day ───────────────────────────
  //
  // Consecutiveness was never the evidence; recurrence was. A delta that has
  // already appeared STUCK_DELTA_REPEATS times today, or a rate this stream has
  // returned to STUCK_RATE_SAMPLES times across STUCK_RATE_MIN_SPAN_MIN, is the
  // same fault whether or not something else arrived in between. See the note
  // at MAX_CADENCE_SAMPLES.
  //
  // Unlike its consecutive form, the day-wide delta rule needs the span as
  // well. Four identical deltas in a row is evidence at any cadence — the
  // windows differ and the figure did not. Four scattered across a day are
  // evidence only if the day had time to produce four measurements between
  // them; from a client syncing every three minutes they are twelve minutes of
  // a steady stretch, which is the "sample count is not a unit" problem the
  // rate rule already answered with a span. Samples with no clock never
  // contribute here, so a caller that supplies none keeps the old behaviour.
  //
  // Carried samples count exactly like today's, and a match that includes one
  // needs no span of its own: the pattern was already watched for far longer
  // than the span asks, on the day it was carried from. That is also what lets
  // the settlement replay a day with hindsight (utils/stepCoinSettlement.js),
  // passing the day's own later refusals as carried evidence — their windows
  // lie AHEAD of the sample being judged, so no span could be measured from
  // them anyway.
  const evidence = [...prior, ...history];
  const sameDeltaBefore = evidence.filter(s => s.delta === delta);
  const sameDeltaSeen = sameDeltaBefore.length;
  const sameDeltaPrior = sameDeltaBefore.filter(s => s.prior).length;
  const sameDeltaStarts = sameDeltaBefore.map(s => s.from).filter(v => v != null);
  const sameDeltaSpanMinutes = sameDeltaStarts.length
    ? (now - Math.min(...sameDeltaStarts)) / 60_000
    : 0;
  const dayDeltaStuck =
    sameDeltaSeen >= STUCK_DELTA_REPEATS &&
    (sameDeltaPrior > 0 || sameDeltaSpanMinutes >= STUCK_RATE_MIN_SPAN_MIN);

  const band = rate == null ? null : recurringRateBand(evidence, rate, prevAt);
  const bandSpanMinutes =
    band == null || band.since == null ? 0 : (now - band.since) / 60_000;
  const bandStuck =
    band != null &&
    band.count >= STUCK_RATE_SAMPLES &&
    (band.prior > 0 || bandSpanMinutes >= STUCK_RATE_MIN_SPAN_MIN);

  const stuck = deltaStuck || rateStuck || dayDeltaStuck || bandStuck;

  // Whether the verdict rests on samples this account was refused on EARLIER
  // days — the same device, back on the same pattern. resolveDayHold closes the
  // day on it rather than holding until the next sample that varies; see the
  // note at PRIOR_STUCK_DAYS.
  const recurrentDelta = dayDeltaStuck && sameDeltaPrior > 0;
  const recurrentBand = bandStuck && band.prior > 0;
  const recurrent = recurrentDelta || recurrentBand;

  // A recurrence is reported ahead of everything else, because it is what
  // decides how the day is treated and it names the earlier days that did.
  let stuckReason = null;
  if (recurrentDelta) {
    stuckReason =
      `+${delta} steps, identical to the step to ${sameDeltaPrior} samples ` +
      'refused as a stuck source on earlier days — the pattern this account was ' +
      'already held for';
  } else if (recurrentBand) {
    stuckReason =
      `${band.min.toFixed(1)}–${band.max.toFixed(1)} steps/min, the band ` +
      `${band.prior} samples were refused in as a stuck source on earlier days — ` +
      'the pattern this account was already held for';
  } else if (deltaStuck) {
    stuckReason =
      `+${delta} steps reported ${repeated + 1} times in a row, identical to ` +
      'the step across differently-sized sync windows';
  } else if (rateStuck) {
    stuckReason =
      `${rateMin.toFixed(1)}–${rateMax.toFixed(1)} steps/min held across ` +
      `${streak} syncs over ${Math.round(spanMinutes)} minutes — a spread of ` +
      `${((rateMax - rateMin) / ((rateMin + rateMax) / 2) * 100).toFixed(1)}%, ` +
      'which a counter measuring elapsed time does not produce';
  } else if (dayDeltaStuck) {
    stuckReason =
      `+${delta} steps reported ${sameDeltaSeen + 1} times today, identical to ` +
      'the step across differently-sized sync windows';
  } else if (bandStuck) {
    stuckReason =
      `${band.min.toFixed(1)}–${band.max.toFixed(1)} steps/min returned to across ` +
      `${band.count} syncs over ${Math.round(bandSpanMinutes)} minutes — a spread of ` +
      `${((band.max - band.min) / ((band.min + band.max) / 2) * 100).toFixed(1)}%, ` +
      'which a counter measuring elapsed time does not produce';
  }

  // This sample joins the day's history whether or not it was refused: the
  // pattern has to stay visible to keep being refused, and to be released.
  //
  // `total` is the raw figure itself, kept so the day's samples can be compared
  // with another account's — see utils/sharedStepSource.js.
  const sample = { delta, rate, from: prevAt, at: now, stuck, total: incoming };
  const nextSamples = [...history, sample].slice(-MAX_CADENCE_SAMPLES);

  return {
    delta,
    rate,
    lastIncomingSteps: incoming,
    lastIncomingAt: now,
    lastIncomingDelta: delta,
    repeatedDeltaCount: repeated,
    cadenceStreak: streak,
    cadenceRateMin: rateMin,
    cadenceRateMax: rateMax,
    cadenceStreakAt: streakAt,
    samples: nextSamples,
    sample,
    stuck,
    stuckReason,
    recurrent,
  };
}

/**
 * The largest set of today's samples, together with the one arriving now,
 * whose rates all sit inside STUCK_RATE_TOLERANCE of each other.
 *
 * "Inside the tolerance" is the same test the consecutive streak uses —
 * (max - min) / midpoint — so the two rules agree on what a band is. Found by
 * sorting the candidate rates and sliding a window across them, which makes
 * the answer independent of the order the samples arrived in; anchoring the
 * band on the newest sample instead would let a slow drift stay inside it, and
 * anchoring on the oldest would make the verdict depend on which sample began
 * the day.
 *
 * @param {Array<{rate: number|null, from: number|null, prior?: boolean}>} history -
 *   Today's earlier samples, and any carried in from earlier days.
 * @param {number} rate - This sample's steps/min.
 * @param {number|null} from - When this sample's window opened.
 * @returns {{ count: number, min: number, max: number, since: number|null, prior: number }}
 *   `count` includes this sample; `since` is the earliest window start in the band;
 *   `prior` is how many of the band's samples were carried in.
 */
function recurringRateBand(history, rate, from) {
  const spread = (lo, hi) => (lo + hi > 0 ? (hi - lo) / ((lo + hi) / 2) : 0);

  // Only a sample within the tolerance of this one can share a band with it,
  // so everything else is discarded before sorting.
  const points = history
    .filter(s => s.rate != null && Number.isFinite(s.rate) && s.rate > 0)
    .filter(s => spread(Math.min(s.rate, rate), Math.max(s.rate, rate)) <= STUCK_RATE_TOLERANCE)
    .map(s => ({ rate: s.rate, from: s.from, self: false, prior: Boolean(s.prior) }));
  points.push({ rate, from, self: true, prior: false });
  points.sort((a, b) => a.rate - b.rate);

  let best = null;
  let hi = 0;
  for (let lo = 0; lo < points.length; lo++) {
    if (hi < lo) hi = lo;
    while (
      hi + 1 < points.length &&
      spread(points[lo].rate, points[hi + 1].rate) <= STUCK_RATE_TOLERANCE
    ) {
      hi += 1;
    }
    const window = points.slice(lo, hi + 1);
    if (!window.some(p => p.self)) continue;
    if (best == null || window.length > best.length) best = window;
  }

  const starts = best.map(p => p.from).filter(v => v != null);
  return {
    count: best.length,
    min: best[0].rate,
    max: best[best.length - 1].rate,
    since: starts.length ? Math.min(...starts) : null,
    prior: best.filter(p => p.prior).length,
  };
}

/**
 * Cadence samples as plain numbers, whatever shape the caller stored them in —
 * Date or epoch, hydrated subdocument or lean object. Anything unreadable is
 * dropped rather than allowed to poison a comparison.
 */
function readSamples(samples) {
  const ms = v => (v == null ? null : new Date(v).getTime());
  return (Array.isArray(samples) ? samples : [])
    .map(s => ({
      delta: Math.round(Number(s?.delta)),
      rate: s?.rate == null ? null : Number(s.rate),
      from: ms(s?.from),
      at: ms(s?.at),
      stuck: Boolean(s?.stuck),
      total: s?.total == null ? null : Math.round(Number(s.total)),
    }))
    .filter(s => Number.isFinite(s.delta) && s.at != null);
}

/**
 * The refused samples worth carrying into the next day, from earlier days' rows.
 *
 * Pure, like computeStepBaseline, so the policy is testable without a database
 * and the store only decides which rows to read. See the note at
 * PRIOR_STUCK_DAYS for what qualifies and why.
 *
 * Judged per stream per day: a stream qualifies when it was refused on at least
 * STUCK_RATE_SAMPLES samples spanning STUCK_RATE_MIN_SPAN_MIN that day, and
 * then all of its refused samples are carried. The streams are pooled, because
 * they describe the same counter — a device held on the service stream
 * yesterday is the same device when the worker reports it today.
 *
 * @param {Array<{cadenceBySource?: Object<string, {samples?: Array}>|Map}>} rows -
 *   The account's rows for the trailing days, EXCLUDING the day being written.
 * @returns {Array<{delta: number, rate: number|null, from: number|null, at: number}>}
 *   Oldest first, at most MAX_PRIOR_STUCK_SAMPLES.
 */
function selectPriorStuckSamples(rows) {
  const carried = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const map = row?.cadenceBySource;
    if (!map) continue;
    const streams =
      typeof map.values === 'function' ? [...map.values()] : Object.values(map);
    for (const stream of streams) {
      const refused = readSamples(stream?.samples).filter(s => s.stuck);
      if (refused.length < STUCK_RATE_SAMPLES) continue;
      const starts = refused.map(s => s.from ?? s.at);
      const span = (Math.max(...refused.map(s => s.at)) - Math.min(...starts)) / 60_000;
      if (span < STUCK_RATE_MIN_SPAN_MIN) continue;
      for (const s of refused) {
        carried.push({ delta: s.delta, rate: s.rate, from: s.from, at: s.at });
      }
    }
  }
  return carried.sort((a, b) => a.at - b.at).slice(-MAX_PRIOR_STUCK_SAMPLES);
}

/**
 * The stream a sync belongs to, for the per-stream cadence history.
 *
 * The X-Client-Source header names it — `native_service`, `worker`, `app` —
 * and the value is used as a map key on the day's row, so it is confined to
 * characters Mongo accepts in a path. Anything else, and a client that sent
 * nothing, share one bucket rather than each getting a fresh, evidence-free
 * history of their own.
 */
function cadenceSourceKey(clientSource) {
  const key = typeof clientSource === 'string' ? clientSource.trim() : '';
  return /^[A-Za-z0-9_-]{1,32}$/.test(key) ? key : 'other';
}

/**
 * Combines one stream's cadence verdict with the day-wide hold.
 *
 * Pure, like trackClientCadence, and for the same reason: the caller persists
 * `stuckSource`, `stuckSince` and `stuckForfeit` on the day's row and hands them
 * back on the next sync, and the rule is testable without a database. See the
 * note at HOLD_STALE_MIN for what it does and why.
 *
 * `streams` is every stream's persisted cadence state BEFORE this sync is
 * applied — the holder's last raw figure is what a release forfeits, and the
 * holder may be the stream syncing now.
 *
 * @param {object} params
 * @param {string} params.source - cadenceSourceKey() of the stream syncing now.
 * @param {object} params.cadence - trackClientCadence() result for that stream.
 * @param {Object<string, {lastIncomingSteps?: number|null, lastIncomingAt?: number|Date|null}>} [params.streams]
 * @param {string|null} [params.heldBy] - Stream currently holding the day, if any.
 * @param {number|Date|null} [params.heldSince] - When that hold began.
 * @param {number} [params.forfeit] - Raw steps already set aside on this day.
 * @param {boolean} [params.closed] - Whether a recurrence has already closed
 *   this day. See the note at PRIOR_STUCK_DAYS.
 * @param {number} params.existingWalked - Stored walked total (bonus excluded).
 * @param {number|Date} [params.at] - When this sync arrived. Defaults to now.
 * @returns {{ stuck: boolean, stuckReason: string|null, released: boolean,
 *   stuckSource: string|null, stuckSince: number|null, stuckForfeit: number,
 *   closed: boolean }}
 */
function resolveDayHold({
  source,
  cadence,
  streams = {},
  heldBy = null,
  heldSince = null,
  forfeit = 0,
  closed = false,
  existingWalked,
  at = Date.now(),
}) {
  const ms = v => (v == null ? null : new Date(v).getTime());
  const now = ms(at) ?? Date.now();
  const walked = Math.max(0, Math.round(Number(existingWalked) || 0));

  let holder = heldBy || null;
  let since = holder ? ms(heldSince) : null;
  let setAside = Math.max(0, Math.round(Number(forfeit) || 0));
  let released = false;
  let isClosed = Boolean(closed);

  // ── A day the account's known pattern came back on ───────────────────────
  // Nothing releases it — not the holder varying, not the holder going quiet,
  // not another stream. Checked first, so neither release path below can run.
  if (isClosed) {
    holder = holder || source;
    since = since ?? now;
    const minutesHeld = Math.round((now - since) / 60_000);
    return {
      released: false,
      stuckSource: holder,
      stuckSince: since,
      stuckForfeit: setAside,
      closed: true,
      stuck: true,
      stuckReason:
        cadence?.recurrent && cadence.stuckReason
          ? cadence.stuckReason
          : `day closed ${minutesHeld} min ago, when the ${holder} stream returned ` +
            'to a pattern this account was already held for on an earlier day; ' +
            'nothing after that is counted today',
    };
  }

  /**
   * What a stream reported while the day was held: its last raw figure, net of
   * what was already set aside, above the total the day was frozen at. Never
   * negative — a holder that reported LESS than the stored total forfeits
   * nothing, since nothing of its was refused.
   */
  const heldPortion = (stream) => {
    const lastRaw = stream?.lastIncomingSteps;
    if (lastRaw == null) return 0;
    return Math.max(0, Math.round(Number(lastRaw) || 0) - setAside - walked);
  };

  const release = () => {
    setAside += heldPortion(streams[holder]);
    holder = null;
    since = null;
    released = true;
  };

  // ── A holder nobody has heard from ───────────────────────────────────────
  // Another stream is syncing, and the holder has been silent long enough to be
  // dead. Released BEFORE this stream's own verdict is applied, so a stream that
  // is itself stuck takes the hold over cleanly rather than being refused under
  // a stale one.
  if (holder && holder !== source) {
    const lastHeard = ms(streams[holder]?.lastIncomingAt) ?? since;
    if (lastHeard != null && now - lastHeard >= HOLD_STALE_MIN * 60_000) {
      release();
    }
  }

  const state = () => ({
    released,
    stuckSource: holder,
    stuckSince: since,
    stuckForfeit: setAside,
    closed: isClosed,
  });

  // ── This stream's own verdict ────────────────────────────────────────────
  if (cadence?.stuck) {
    // An existing holder keeps the hold: its release condition is the one the
    // forfeit was measured against. A second stuck stream simply re-holds on
    // its own next sync once the first lets go.
    if (!holder) {
      holder = source;
      since = now;
    }
    // The same device, back on the pattern it was already held for. There is
    // nothing a later sample could show that would make it measurement again
    // today, so the day closes — see the note at PRIOR_STUCK_DAYS.
    if (cadence.recurrent) isClosed = true;
    return { ...state(), stuck: true, stuckReason: cadence.stuckReason || null };
  }

  // ── The holder is measuring again ────────────────────────────────────────
  // Only the stream that earned the hold can release it this way. What it
  // reported while held is set aside; the sample that broke the pattern is the
  // first measurement since, and goes through to the ceilings like any other.
  if (holder === source) {
    release();
    return { ...state(), stuck: false, stuckReason: null };
  }

  // ── Held by another stream ───────────────────────────────────────────────
  // This stream may be perfectly healthy on its own deltas. It is refused
  // anyway, because it is reporting the same steps the holder is — see the
  // note at HOLD_STALE_MIN.
  if (holder) {
    const minutesHeld = since == null ? null : Math.round((now - since) / 60_000);
    return {
      ...state(),
      stuck: true,
      stuckReason:
        `day held by the ${holder} stream` +
        (minutesHeld == null ? '' : ` for ${minutesHeld} min`) +
        `; this ${source} figure describes the same steps`,
    };
  }

  return { ...state(), stuck: false, stuckReason: null };
}

/**
 * Validates incoming step count and returns a safe value.
 *
 * @param {object} params
 * @param {number|null|undefined} params.incomingSteps - Raw step count from client
 * @param {number} params.existingSteps - Previously stored step count for today
 * @param {number} params.bonusSteps - Bonus steps (admin-credited, not from device)
 * @param {string|null} [params.timezone] - Client timezone, used to bound the
 *   first accepted value of the day by how much of their local day has elapsed.
 * @param {string|null} [params.syncDate] - "YYYY-MM-DD" the row being written, which
 *   is not necessarily today: POST /health/sync takes an explicit `date` and the
 *   Android widget worker re-posts the last seven days every 15 minutes. A past
 *   date is bounded by the whole day, today by the minutes elapsed so far. Omit and
 *   it assumes today, which is the old behaviour.
 * @param {number} params.dailyGoal - User's daily step goal (for context only)
 * @param {boolean} [params.allowCorrection] - When true, a decrease below the stored
 *   value is accepted instead of being silently raised back up. The client sets this
 *   only when it has detected that its own previously reported figure was too high.
 * @param {object|null} [params.cadence] - Result of trackClientCadence() for this
 *   sync. When it reports `stuck`, the client's deltas have stopped varying with
 *   the time between syncs, so the total is held where it is.
 * @param {string|null} [params.reader] - Which reader the client says produced this
 *   figure. Only used to decide whether the live-sensor bound below applies.
 * @param {number|null} [params.sensorWindowMinutes] - Minutes of walking this
 *   figure may cover, for a reader that measures live. See the ceiling.
 * @param {number|null} [params.stepBaseline] - This user's own daily ceiling, from
 *   computeStepBaseline() over their trailing days. Omit and only the population
 *   bounds apply, which is the pre-baseline behaviour — so an older caller that
 *   does not supply it is weakened, not broken.
 * @param {object|null} [params.sharedSource] - Result of resolveSharedSource()
 *   (utils/sharedStepSource.js). When it reports `held`, this account's counter
 *   is also feeding an older account, which is the one being paid for it, so
 *   the total is held where it is.
 *
 * @returns {{ clampedSteps: number, flagged: boolean,
 *   severity: 'none'|'clamped'|'implausible'|'stuck_source'|'shared_source', reason: string|null,
 *   corrected: boolean, correctedFrom: number|null }}
 *   `severity` grades WHY it was clamped: 'clamped' is routine (over a window
 *   ceiling but physically possible), 'implausible' is beyond human capacity for
 *   the elapsed day, 'stuck_source' is a device reporting a constant rather than a
 *   measurement, 'shared_source' is a counter that is also feeding another,
 *   older account. Only 'implausible' and 'shared_source' are evidence of
 *   cheating — see the note in the body before punishing on it. 'stuck_source'
 *   in particular must never be punished: it is a broken sensor, and the user
 *   did nothing.
 */
function validateSteps({
  incomingSteps,
  existingSteps,
  bonusSteps,
  timezone = null,
  syncDate = null,
  dailyGoal,
  allowCorrection = false,
  cadence = null,
  stepBaseline = null,
  reader = null,
  sensorWindowMinutes = null,
  sharedSource = null,
}) {
  // If no steps provided or negative, return 0
  if (
    incomingSteps === undefined ||
    incomingSteps === null ||
    incomingSteps < 0
  ) {
    return {
      clampedSteps: 0,
      flagged: false,
      severity: 'none',
      reason: null,
      corrected: false,
      correctedFrom: null,
    };
  }

  let steps = Math.round(incomingSteps);
  const existingWalked = Math.max(0, existingSteps - bonusSteps);

  let flagged = false;
  let reason = null;
  // 'none' | 'clamped' | 'implausible' — see the severity note further down.
  let severity = 'none';

  // ── Build every ceiling, then take the smallest ─────────────────────────────
  // Collected as {limit, reason} so the reason reported is the one that actually
  // bound the value. Nothing here assigns to `steps`, which is what makes it
  // impossible for one rule to raise what another lowered.
  const ceilings = [
    {
      limit: MAX_DAILY_STEPS,
      reason: `Exceeded daily cap (${steps} > ${MAX_DAILY_STEPS})`,
    },
  ];

  // ── The counter is paying another account ─────────────────────────────────
  //
  // Held exactly where it is, like a stuck source, and for a similar reason:
  // there is no rate to allow, because the figure is not this account's to
  // claim. Pushed first among the holds so that on a tie its reason is the one
  // reported — it names the other account, which is what an investigation
  // needs, where the stuck-source reason describes only the shape of the data.
  //
  // Graded 'shared_source' rather than 'stuck_source' because the two must not
  // be confused downstream: a stuck source is a fault and is never punished; a
  // shared one is a second account on one phone. See sharedStepSource.js.
  if (sharedSource?.held) {
    ceilings.push({
      limit: existingWalked,
      severity: 'shared_source',
      reason: sharedSource.reason || 'Step counter shared with another account',
    });
  }

  // ── The source has stopped measuring ──────────────────────────────────────
  // Hold the total exactly where it is. Not a rate — there is no rate to allow,
  // because the number arriving is not a function of elapsed time. Pushed before
  // the rate ceilings so that on a tie (a zero-length window makes the rate
  // ceiling `existingWalked` too) this is the reason reported, since it is the
  // one that explains what is actually wrong with the device.
  //
  // Carries its own severity so the ceiling that binds decides how it is graded.
  // Without that, a stuck device whose reported total has drifted past the daily
  // cap would be graded 'implausible' and handed to recordCheatFlag — punishing
  // someone for a sensor fault. See the severity note further down.
  if (cadence?.stuck) {
    ceilings.push({
      limit: existingWalked,
      severity: 'stuck_source',
      // The detector that fired says why, since the two see different faults and
      // an investigation branches on which one it was.
      reason: `Source not measuring: ${cadence.stuckReason || 'cadence stopped varying with elapsed time'}`,
    });
  }

  // ── A live sensor cannot deliver a backlog ────────────────────────────────
  //
  // The delta ceiling was removed from this file because it punished a legitimate
  // Health Connect backlog: HC reports the day cumulatively, so a phone that
  // finally reads it in the evening carries hours of real walking in one sync, and
  // rationing that at 220 steps a minute took 46 minutes to accept a figure it
  // would have taken instantly from a device that had stayed quiet.
  //
  // That reasoning holds for Health Connect and does NOT hold for the hardware
  // sensor. The foreground service listens live, so the steps it reports were
  // walked inside the window it was listening for — there is no backlog for it to
  // deliver. A figure from that reader is therefore bounded by human cadence in a
  // way an HC figure is not, and the distinction is the one the old rule failed to
  // draw: it applied the bound to both, so removing it removed it from both.
  //
  // What this catches: one account gained 8,328 steps across a 30-minute window,
  // labelled `native_sensor`, at 276 steps a minute. A live sensor cannot produce
  // that. It came from seedDayFromHealthConnect folding a Health Connect total
  // into the service's own count once a day, which arrives wearing the sensor's
  // label — see the note in stepOriginTrust.js.
  //
  // The window is the caller's, and must already account for the service having
  // been killed: an OEM that stops the foreground service leaves TYPE_STEP_COUNTER
  // running in hardware, so the next sync genuinely covers the whole silent
  // period. Passing a window that ignores that would clamp honest users on exactly
  // the phones that kill background services hardest.
  //
  // A client that would rather not be bounded can simply claim `health_connect`,
  // so this is not a defence against a patched build. It is a defence against an
  // honest client reporting a figure under a label that does not fit it.
  // `null` is "the caller cannot say", NOT a zero-length window. Number(null) is
  // 0 and passes every finite check, so without the explicit null test a caller
  // that omitted the window would pin the total exactly where it stood — which is
  // how a missing field turns into a silent, total freeze on a real user's day.
  if (
    reader === 'native_sensor' &&
    sensorWindowMinutes !== null &&
    sensorWindowMinutes !== undefined &&
    Number.isFinite(Number(sensorWindowMinutes)) &&
    Number(sensorWindowMinutes) >= 0
  ) {
    const window = Number(sensorWindowMinutes);
    const maxDelta = Math.ceil(window * MAX_STEPS_PER_MINUTE);
    ceilings.push({
      limit: Math.max(existingWalked, existingWalked + maxDelta),
      reason:
        `Live sensor cannot have counted this: +${steps - existingWalked} steps ` +
        `across ${Math.round(window)} min of listening ` +
        `(max ${maxDelta} at ${MAX_STEPS_PER_MINUTE}/min)`,
    });
  }

  // ── The day ceiling, which now actually binds ─────────────────────────────
  //
  // There were two rate ceilings here and the LOOSER of them won:
  //
  //   * a DELTA ceiling — "could these steps have been walked since we last
  //     accepted any?", measured from lastStepIncreaseAt; and
  //   * this DAY ceiling — "is this total plausible for how much of the day has
  //     elapsed?", measured from local midnight.
  //
  // Taking the looser was meant to stop the delta ceiling punishing a device that
  // had been diligent about syncing: Health Connect reports the day cumulatively,
  // so a phone that finally read it at 20:51 carried a 4,793-step correction that
  // the delta ceiling rationed out at 220 a minute across seven clamped syncs.
  // That reasoning was right about the delta ceiling and wrong about what to do
  // with it.
  //
  // What it produced: the delta ceiling allows `existingWalked + windowMinutes *
  // 220` and, because the burst rate applies to any window under an hour, a client
  // syncing every 15 minutes is allowed 3,300 steps EVERY TIME. That is 220 steps
  // a minute sustained for as long as it cares to keep talking — 316,800 in a day,
  // bounded by nothing but MAX_DAILY_STEPS. And since the looser bound won, the
  // day ceiling never got to say otherwise.
  //
  // A real account walked exactly through it. From 11:44 to 16:31 local, nineteen
  // syncs 15 minutes apart, each carrying about 2,270 steps — a flat 149 to 153
  // steps per minute for four and three quarter hours, 69% of the delta allowance
  // and never once touching it. From 14:30 onward every single sync exceeded the
  // day ceiling, and every single one was admitted because the delta ceiling was
  // looser. The day closed at exactly 50,000.
  //
  // So the delta ceiling is gone rather than demoted. The two are not symmetric
  // and never were:
  //
  //   * The day ceiling is a NECESSARY bound. No story about backlogs, watches or
  //     sync cadence makes more steps fit into a day than the day has room for, so
  //     nothing should be able to override it. It is a hard ceiling now.
  //   * The delta ceiling was a SUFFICIENT refinement for one arrival shape, and
  //     min-ing it back in is exactly the backlog bug described above. With the day
  //     ceiling hard it also has almost nothing left to do: the only region where
  //     it was tighter is the first minutes of a day, which FIRST_SYNC_BURST_
  //     ALLOWANCE already covers deliberately.
  //
  // Dropping it fixes the 20:51 backlog case outright — 4,793 steps in the evening
  // sits far below the day ceiling and is now accepted in one go — and closes the
  // cadence exploit at every window size, which is what taking the looser bound
  // could not do.
  if (steps > 0) {
    // The elapsed time is that of `syncDate`, not of today. This used to call
    // minutesSinceLocalMidnight() directly, which always answers for TODAY, while
    // the value being judged could belong to any of the last seven days: the
    // Android widget worker re-posts that whole window every 15 minutes. So a
    // past-date sync landing at 00:10 was measured against ten minutes, and a
    // genuine 12,000-step day with no row yet was clamped to the midnight
    // allowance, flagged as a cheat, and paid retroactive coins on the clamped
    // figure. minutesElapsedOnDate() gives a past date its full 1,440 minutes, at
    // which point the absolute daily cap is what binds — which is correct, since a
    // whole day genuinely did happen.
    const minutesOnDate = minutesElapsedOnDate(syncDate, timezone);
    const hoursOnDate = minutesOnDate / 60;
    const isWholeDay = minutesOnDate >= 24 * 60;
    const dayFraction = Math.min(1, Math.max(0, hoursOnDate / 24));
    const maxForDay = Math.ceil(
      FIRST_SYNC_BURST_ALLOWANCE +
        (MAX_DAILY_STEPS - FIRST_SYNC_BURST_ALLOWANCE) * dayFraction,
    );
    // Floored at what is already stored. A ceiling that lands below the accepted
    // total would push `steps` down, and Rule 3 would then raise it straight back
    // — a flag on every sync for the rest of the day and no change to the figure.
    // Ceilings stop growth; they do not claw back.
    ceilings.push({
      limit: Math.max(existingWalked, maxForDay),
      reason:
        `Total too high for the day: ${steps} steps in ` +
        `${hoursOnDate.toFixed(1)}h ` +
        `(${isWholeDay ? 'the full day' : 'since local midnight'}) ` +
        `(max plausible: ${maxForDay})`,
    });
  }

  // ── What this user walks ──────────────────────────────────────────────────
  //
  // The only bound here that is about the account rather than about the species.
  // See the note at BASELINE_FLOOR for what it is for and why the population
  // bounds could not do it.
  //
  // Deliberately does NOT grade itself, unlike the stuck-source rule. Forcing
  // 'clamped' here looked right — a figure over this account's distribution is
  // still physically possible, and a genuine ultramarathon must not reach the
  // cheat path — but it also swallowed the cases that ARE cheating: once a user
  // has a baseline, it is the lowest ceiling, so it would bind on a client
  // posting 999,999 and grade that 'clamped' too.
  //
  // The default grading already draws exactly the right line. It asks whether the
  // figure beats physicalDayBound — the daily cap, or 220 steps/min for the whole
  // elapsed day — which the ultramarathon does not and the fabricated total does.
  // So leave the grading alone and let it answer.
  if (steps > 0 && Number.isFinite(Number(stepBaseline)) && Number(stepBaseline) > 0) {
    const baseline = Math.round(Number(stepBaseline));
    ceilings.push({
      limit: Math.max(existingWalked, baseline),
      reason:
        `Above this account's usual range: ${steps} steps against a ceiling of ` +
        `${baseline} from its own recent days`,
    });
  }

  // ── How suspicious is this, really? ────────────────────────────────────────
  //
  // `flagged` alone cannot answer that, and wiring a punishment to it was the
  // mistake this severity split exists to correct.
  //
  // Being clamped is ROUTINE. The rate ceiling bounds a value by the time since
  // steps were last accepted, which is often seconds, while a client's figure can
  // legitimately jump by thousands in one go: a paired smartwatch flushes its
  // backlog into Health Connect, or the app is reopened after the OS killed it.
  // The server then walks the stored total up at the maximum rate over the next
  // few minutes, flagging on EVERY sync until it converges. Simulated against this
  // file, an honest user whose watch dumps 3,000 steps is flagged on 40 of 40
  // syncs — indistinguishable from a client posting 999,999. At a 3-flags-per-day
  // block threshold, that user is penalised inside the first minute.
  //
  // What separates the two is not whether we clamped, but whether the reported
  // figure is possible AT ALL for the day it claims. The watch backlog is real
  // steps that were really walked, so it sits far below the day's physical
  // ceiling; 999,999 does not. So:
  //
  //   'clamped'     — over a window ceiling but physically possible for the day.
  //                   Expected during normal operation. Never punish this.
  //   'implausible' — beyond what any human could have walked in the elapsed day,
  //                   or over the absolute daily cap. No real sensor produces this.
  //   'stuck_source' — the device is reporting a constant, not a measurement. A
  //                   fault, not a choice, so it is graded separately precisely so
  //                   that it can never reach the cheat path: a stuck counter
  //                   eventually drifts past the daily cap, and grading it by
  //                   magnitude alone would flag the user for their phone's bug.
  //   'shared_source' — the same counter is feeding another, older account,
  //                   which is the one being paid for it. A second account on
  //                   one phone, so it DOES reach the cheat path — and it must
  //                   not be mistaken for 'stuck_source', which never does.
  //
  // The day bound uses minutesElapsedOnDate, so a past-date sync is judged against
  // its whole day rather than against however little of today has elapsed — the
  // same correction the first-accepted-value ceiling needed.
  const dayBoundMinutes = minutesElapsedOnDate(syncDate, timezone);
  const physicalDayBound = Math.min(
    MAX_DAILY_STEPS,
    Math.ceil(dayBoundMinutes * MAX_STEPS_PER_MINUTE),
  );

  const binding = ceilings.reduce((a, b) => (b.limit < a.limit ? b : a));
  if (steps > binding.limit) {
    flagged = true;
    reason = binding.reason;
    // A ceiling may grade itself. Only the stuck-source rule does, because it is
    // the one case where the magnitude of the figure says nothing about how it
    // should be judged — the fault is in the shape of the data, not its size.
    severity =
      binding.severity ?? (steps > physicalDayBound ? 'implausible' : 'clamped');
    steps = binding.limit;
  }

  // ── Rule 3: No unreasonable decrease, unless it is an explicit correction ───
  //
  // Within a day steps normally only go up, and several devices may report for the
  // same user, so a lower figure is usually just a device that is behind. Keeping
  // the higher value is the right default.
  //
  // But applied unconditionally it made a wrong value permanent. The stored count
  // became a high-water mark that nothing could bring down: an inflated figure
  // stayed for the rest of the day, was handed back to the app as its baseline on
  // the next login, and got re-reported from there. There was no path by which a
  // corrected client could repair the record.
  //
  // `allowCorrection` provides that path. The client sets it only when the value it
  // is sending is materially lower than what it itself last sent today, i.e. when
  // it has detected and fixed its own over-count.
  //
  // This is not a cheat vector: it can only ever LOWER the stored count. Coin
  // awards are driven by a separate high-water mark, so a decrease neither refunds
  // nor re-mints coins — it just stops the wrong number being displayed forever.
  let corrected = false;
  let correctedFrom = null;
  if (steps < existingWalked - DECREASE_TOLERANCE && existingWalked > 0) {
    if (allowCorrection) {
      corrected = true;
      correctedFrom = existingWalked;
      reason = `Client-requested correction: ${existingWalked} → ${steps}`;
    } else {
      steps = existingWalked;
    }
  }

  steps = Math.max(0, steps);

  return {
    clampedSteps: steps,
    flagged,
    severity,
    reason,
    corrected,
    correctedFrom,
  };
}

module.exports = {
  validateSteps,
  trackClientCadence,
  cadenceSourceKey,
  resolveDayHold,
  computeStepBaseline,
  MAX_DAILY_STEPS,
  MAX_STEPS_PER_MINUTE,
  STUCK_DELTA_MIN_STEPS,
  STUCK_DELTA_REPEATS,
  STUCK_RATE_TOLERANCE,
  STUCK_RATE_SAMPLES,
  STUCK_RATE_MIN_SPAN_MIN,
  STUCK_RATE_MIN_WINDOW_MIN,
  MAX_CADENCE_SAMPLES,
  selectPriorStuckSamples,
  readSamples,
  PRIOR_STUCK_DAYS,
  MAX_PRIOR_STUCK_SAMPLES,
  HOLD_STALE_MIN,
  BASELINE_FLOOR,
  BASELINE_MULTIPLIER,
  MAX_BASELINE_CEILING,
  BASELINE_MIN_DAYS,
  BASELINE_WINDOW_DAYS,
};
