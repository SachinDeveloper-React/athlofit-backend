// src/utils/stepOriginTrust.js
//
// Whether the source a day's steps were attributed to is one this account has
// actually been using, or one that appeared today.
//
// ── The attack this is for ──────────────────────────────────────────────────
//
// Health Connect is a shared store, and anything on the phone may write to it.
// A step-spoofing app installs itself under a package name it generates at
// install time — the ones found here all looked like
// `com.android.healthconnect.phone.j<32 hex>`, which reads as a system component
// and is unrecognisable enough that nobody would question it — writes a large
// number of step records, and our reader picks it up like any other origin.
//
// StepOriginDedup then makes it PRIMARY, because primary means "the origin with
// the highest count" and nothing else. Everything the user genuinely walked, as
// recorded by a real app, is judged a mirror of it and contributes zero. One
// account's real 2,101 steps from Google Fit were discarded in favour of an
// injected 5,522 in exactly this way.
//
// ── What separated the honest accounts from the fraudulent ones ─────────────
//
// Thirteen accounts carried origins of that shape. The package prefix did not
// separate them at all — ten of the thirteen were ordinary users whose days ran
// 43 to 13,830 steps, because the randomised suffix is simply how the platform
// pedometer names itself on those devices. Blocking the prefix would have zeroed
// ten real users, one of whom logs 438 steps a day.
//
// What separated them was CHURN. Each of the ten honest accounts had exactly one
// such origin, stable for as long as the account had data — seven days in one
// case. The three fraudulent accounts rotated: four, eight and nine distinct
// origins, one of them five in a single day. A real pedometer does not change
// its identity; a spoofer reinstalled under a fresh name does.
//
// So trust is a question about an origin's HISTORY with this account, not about
// its name.
//
// ── What this is actually worth ─────────────────────────────────────────────
//
// It has to be said plainly, because a rule that reasons about self-reported
// evidence can be mistaken for a stronger guarantee than it is. The origin and
// the reader arrive inside the client's `stepSource` block. A patched build can
// claim whatever it likes, and this rule would believe it.
//
// What it does buy:
//
//   * It closes the observed attack. That attack is an unmodified copy of this
//     app faithfully reporting what a third-party spoofer wrote into Health
//     Connect — the reporting is honest, the data is not — and it is the version
//     of the attack available from an app store to anyone.
//   * It closes the RATCHET, which is the part that matters most. The per-user
//     baseline in stepValidation is built from days this account has already had
//     accepted, so a patient spoofer sitting just under their ceiling would raise
//     it, and raise it again, until the roof. Untrusted days are excluded from
//     that history (see stepBaselineStore), so a rotating origin never earns a
//     larger allowance no matter how long it keeps at it.
//
// What it does not buy: anything against a modified client. That is a different
// threat class, and what bounds it is the baseline ceiling, which is computed
// entirely server-side from figures the server itself accepted.
//
// ── Deliberately not a blocklist ────────────────────────────────────────────
//
// There is no package pattern anywhere in this file. A blocklist is one rebuild
// behind forever, and — as above — the one obvious pattern here was mostly
// honest users. Rotation is the behaviour that cannot be renamed away.

/**
 * Distinct prior days an origin must appear on before it counts as this
 * account's own.
 *
 * Three, so that an origin present only for a day or two — which is what a
 * reinstalled spoofer looks like — never establishes. The cost to an honest user
 * is that their first days do not feed their baseline, which is invisible in
 * practice: the baseline needs more days than that before it says anything at
 * all, and the floor applies meanwhile.
 */
const ORIGIN_TRUST_MIN_DAYS = 3;

/**
 * Distinct primary origins allowed across the window before the account is
 * treated as churning and nothing is trusted.
 *
 * Three leaves room for everything an honest phone does — a platform pedometer,
 * a fitness app alongside it, and one genuine switch — while sitting below the
 * four, eight and nine seen on the fraudulent accounts. It is a backstop for the
 * case where a rotation happens to be slow enough that individual origins would
 * each establish on their own.
 */
const ORIGIN_CHURN_MAX = 3;

/** Trailing days the origin history is read over. Matches the baseline window. */
const ORIGIN_WINDOW_DAYS = 28;

// ── Steps that arrive without saying where they came from ───────────────────
//
// The first version of this file trusted every reader that was not
// `health_connect`, on the reasoning that only Health Connect has an origin to
// be suspicious of. Two accounts showed that to be a hole, and it is worth being
// precise about the shape of it, because the same data arrives under three
// different labels:
//
//   * `health_connect` — the honest case, checked above.
//   * `native_sensor` — but the foreground service folds a Health Connect total
//     into its own count once a day (seedDayFromHealthConnect), so a figure that
//     originated in Health Connect can arrive wearing the sensor's label. One
//     account gained 8,328 steps in a 30-minute window this way, at 276 steps a
//     minute, and the histogram gave it away: hours that had already passed
//     before the service's first sync were populated, which a live sensor cannot
//     do and only the Health Connect seed can.
//   * `unknown` — the app's own sync posts this when its resolve has not run
//     yet. Another account moved 1,725 → 15,931 in one such sync, with no origin
//     list, no method and a histogram that summed to exactly the 1,725 the sensor
//     had reported. The 14,206 was Health Connect's, and nothing said so.
//
// So the question is not "which reader" but "did anything account for these
// steps". An unattributed sync is not itself suspicious — 28% of all ledger
// entries carry no reader, because a cold open races the first resolve.
//
// ── Size is the wrong test; TIME is the right one ───────────────────────────
//
// This began as a flat threshold: an unattributed sync over 2,000 steps was
// untrusted. Measured against the honest accounts that turned out to mark 14.8%
// of their days — because a large delta is completely ordinary after a phone has
// been offline, and the ledger is full of them. A user with no data for five days
// comes back and flushes a whole day in one sync, and there is nothing wrong with
// that at all.
//
// What separates the two is not how big the delta is but whether the elapsed time
// can hold it. The same physical argument the live-sensor ceiling uses:
//
//     delta <= windowMinutes * MAX_STEPS_PER_MINUTE
//
// A day flushed after five days offline has a window of five days and passes
// easily. The entries that fail are the ones like +16,475 with `offlineMinutes:
// 15` — a quarter of an hour that cannot hold sixteen thousand steps, which is
// what the Health Connect seed folding into the sensor's count looks like.
//
// That change drops the false positives from 14.8% of honest days to a fraction
// of it while still catching every laundered jump, and it removes an arbitrary
// constant in favour of a bound the rest of the file already reasons with.
//
// The consequence stays deliberately cheap either way: the day is kept out of
// future baseline windows and nothing is clamped, so being wrong costs an account
// a slower baseline and nothing else.

// Imported rather than repeated. Three rules now reason from this same physical
// bound — the live-sensor ceiling, this one, and the reversal tool — and a copy
// per file is how they end up silently disagreeing the first time one is tuned.
// coinDefaults.js carries the same lesson from the last time it happened.
const { MAX_STEPS_PER_MINUTE } = require('./stepValidation');

/**
 * Smallest window an unattributed delta is measured against.
 *
 * Without a floor, a caller that reports a zero or missing window would make
 * every delta unexplainable. One minute is small enough to still catch the
 * laundering — 220 steps — and large enough that a missing field is not itself
 * a verdict.
 */
const UNATTRIBUTED_MIN_WINDOW_MIN = 1;

/**
 * Decides whether this sync's attribution can be believed.
 *
 * Pure. `history` is what the caller loaded for the days BEFORE the one being
 * validated — see loadOriginHistory in stepOriginTrustStore.
 *
 * @param {object} params
 * @param {string|null} params.reader - 'health_connect' | 'native_sensor' | etc.
 * @param {string|null} params.primaryOrigin - Package the steps were attributed to.
 * @param {number} [params.delta] - How much this sync moved the day's total.
 * @param {number|null} [params.windowMinutes] - Minutes the delta could plausibly
 *   cover: time since this account last reported, widened by however long the
 *   client says it was offline, and capped at the elapsed part of the day being
 *   written. Both are only consulted for readers that named no source.
 * @param {object} params.history
 * @param {string[]|Set<string>} params.history.establishedOrigins - Origins already
 *   seen on enough prior days to count as this account's own.
 * @param {number} params.history.distinctPrimaries - How many distinct primary
 *   origins the account has reported across the window.
 * @returns {{ trusted: boolean, reason: string|null }}
 */
function resolveOriginTrust({
  reader,
  primaryOrigin,
  delta = 0,
  windowMinutes = null,
  history = {},
}) {
  // A resolved SET rather than the raw day-count map. The counting is a per-day
  // fact, so it is done once and frozen on the day's row; passing the map here
  // would have meant recomputing it on every sync. See the note in the store.
  const established =
    history.establishedOrigins instanceof Set
      ? history.establishedOrigins
      : new Set(history.establishedOrigins || []);
  const distinctPrimaries = Number(history.distinctPrimaries) || 0;

  // ── Readers that carry no origin claim ────────────────────────────────────
  //
  // The hardware step counter is a running total with no per-app breakdown, so
  // `native_sensor` has no origin to give, and neither does a build too old to
  // send the block. Trusting them is a deliberate choice: refusing would mean no
  // sensor-only account — a phone without Health Connect, which is a large share
  // of them — could ever build a baseline, so every one would sit on the floor
  // permanently.
  //
  // But trusting them UNCONDITIONALLY was the hole. Steps that originated in
  // Health Connect reach this function under both of these labels, and a sync
  // that moves the day materially while accounting for nothing is the one case
  // where the label cannot be taken at face value. See the note on time above.
  //
  // A client willing to lie about its reader is still outside what this can
  // reach; that is what the baseline ceiling is for. What this closes is the
  // honest client faithfully reporting a figure it cannot explain.
  if (reader !== 'health_connect') {
    const moved = Math.max(0, Math.round(Number(delta) || 0));
    const window = Math.max(
      UNATTRIBUTED_MIN_WINDOW_MIN,
      Number.isFinite(Number(windowMinutes)) && Number(windowMinutes) > 0
        ? Number(windowMinutes)
        : 0,
    );
    const explainable = Math.ceil(window * MAX_STEPS_PER_MINUTE);

    if (moved > explainable) {
      return {
        trusted: false,
        reason:
          `+${moved} steps arrived from '${reader || 'an unnamed reader'}' with ` +
          `nothing accounting for them — ${Math.round(window)} min of elapsed ` +
          `time holds at most ${explainable}`,
      };
    }
    return { trusted: true, reason: null };
  }

  // Health Connect said so but named nobody. Nothing to establish against, and
  // unlike the sensor this reader is expected to name its source — so this is a
  // gap in the evidence rather than a source that has none.
  if (!primaryOrigin) {
    return {
      trusted: false,
      reason: 'Health Connect reported no primary origin for these steps',
    };
  }

  // ── The account is churning ───────────────────────────────────────────────
  // Checked before the per-origin rule, because when an account is cycling
  // through identities the fact that one of them has lasted a few days says
  // nothing — that is what a slow rotation looks like from inside.
  if (distinctPrimaries > ORIGIN_CHURN_MAX) {
    return {
      trusted: false,
      reason:
        `Account has reported ${distinctPrimaries} different primary step sources ` +
        `in ${ORIGIN_WINDOW_DAYS} days (max ${ORIGIN_CHURN_MAX}) — no source is established`,
    };
  }

  if (!established.has(primaryOrigin)) {
    return {
      trusted: false,
      reason:
        `Step source ${primaryOrigin} is new to this account ` +
        `(not seen on ${ORIGIN_TRUST_MIN_DAYS} of the last ${ORIGIN_WINDOW_DAYS} days)`,
    };
  }

  return { trusted: true, reason: null };
}

module.exports = {
  resolveOriginTrust,
  ORIGIN_TRUST_MIN_DAYS,
  ORIGIN_CHURN_MAX,
  ORIGIN_WINDOW_DAYS,
  UNATTRIBUTED_MIN_WINDOW_MIN,
};
