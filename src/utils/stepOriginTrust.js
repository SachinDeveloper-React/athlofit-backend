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

/**
 * Decides whether this sync's attribution can be believed.
 *
 * Pure. `history` is what the caller loaded for the days BEFORE the one being
 * validated — see loadOriginHistory in stepOriginTrustStore.
 *
 * @param {object} params
 * @param {string|null} params.reader - 'health_connect' | 'native_sensor' | etc.
 * @param {string|null} params.primaryOrigin - Package the steps were attributed to.
 * @param {object} params.history
 * @param {string[]|Set<string>} params.history.establishedOrigins - Origins already
 *   seen on enough prior days to count as this account's own.
 * @param {number} params.history.distinctPrimaries - How many distinct primary
 *   origins the account has reported across the window.
 * @returns {{ trusted: boolean, reason: string|null }}
 */
function resolveOriginTrust({ reader, primaryOrigin, history = {} }) {
  // A resolved SET rather than the raw day-count map. The counting is a per-day
  // fact, so it is done once and frozen on the day's row; passing the map here
  // would have meant recomputing it on every sync. See the note in the store.
  const established =
    history.establishedOrigins instanceof Set
      ? history.establishedOrigins
      : new Set(history.establishedOrigins || []);
  const distinctPrimaries = Number(history.distinctPrimaries) || 0;

  // ── No origin claim to check ──────────────────────────────────────────────
  //
  // The hardware step counter is a running total with no per-app breakdown, so
  // `native_sensor` never carries an origin and there is nothing here to be
  // suspicious of. The same goes for a build too old to send the block at all.
  //
  // Trusted, and that is a deliberate choice rather than an oversight. Refusing
  // to trust it would mean no sensor-only account — a phone without Health
  // Connect, which is a large share of them — could ever build a baseline, so
  // every one of them would sit on the floor permanently. That is a real cost
  // paid by real users to close an evasion path that is already open: a client
  // willing to lie about its reader is a patched client, and a patched client is
  // outside what any rule reading this block can reach.
  if (reader !== 'health_connect') {
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
};
