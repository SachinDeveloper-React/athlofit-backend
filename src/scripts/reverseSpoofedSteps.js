#!/usr/bin/env node
// src/scripts/reverseSpoofedSteps.js
//
// ─── Undoing the days a rotating step source produced ────────────────────────
//
// Health Connect is a shared store: anything installed on the phone may write
// step records into it, and the reader's dedup used to hand the baseline to
// whichever origin reported the most. A step-spoofing app installs under a
// package name it generates at install time, writes a large number of records,
// takes the baseline by definition, and everything the user actually walked —
// recorded by a real app — is then measured against the injected timeline,
// judged a duplicate of it, and contributes nothing.
//
// Three accounts did this. Their days ran 15,488 to 50,000 steps with a mean of
// 31,048; one posted six consecutive days averaging 34,682, which is 26 km every
// day for a week. Meanwhile ten OTHER accounts carried origins of exactly the
// same suspicious-looking shape and were entirely honest — their days ran 43 to
// 13,830 steps, because the randomised package suffix is simply how the platform
// pedometer names itself on those phones.
//
// That is why nothing in this script keys off a package name. What separated the
// two groups was ROTATION: the honest accounts each had one origin, stable for as
// long as they had data; the fraudulent ones cycled through four, eight and nine.
// The same rule the server now applies live (utils/stepOriginTrust.js) is what
// selects days here, so the tool and the running system agree about what is
// suspect rather than being two opinions that can drift.
//
// ── What it changes ─────────────────────────────────────────────────────────
//
//   1. HealthActivity.steps        — back to what a source with history recorded.
//   2. HealthActivity.originTrusted — false, so the day can never feed a future
//                                     baseline ceiling. This matters even for days
//                                     whose steps cannot be corrected: it is what
//                                     stops the poisoned history ratcheting the
//                                     account's own allowance upward.
//   3. Step coins                  — the difference between what was paid for the
//                                     inflated figure and what the corrected one
//                                     earns, deducted and logged.
//   4. UserChallenge progress      — recomputed for every period the corrected
//                                     days fall in, with rewards clawed back where
//                                     a challenge is no longer met. A 50,000-step
//                                     day completes "Weekly Walker" on its own.
//
// ── Why it will not decide anything important on its own ────────────────────
//
// Dry-run by default: it prints the full origin breakdown per day, with how many
// distinct days each origin has been seen on, and changes nothing. --apply is a
// separate, deliberate step, and it is meant to be taken after reading the report
// rather than instead of reading it.
//
// A day with no origin that has any history is reported as UNVERIFIABLE and
// SKIPPED. There is no honest figure to fall back to for such a day — inventing
// one would be the same class of mistake as the injection — so correcting it is
// a decision a person makes with --zero-unverifiable, not a default.
//
// Usage:
//     node src/scripts/reverseSpoofedSteps.js                      # report, all users
//     node src/scripts/reverseSpoofedSteps.js --user <email|id>    # one account
//     node src/scripts/reverseSpoofedSteps.js --apply              # write the changes
//     node src/scripts/reverseSpoofedSteps.js --apply --cap-unverifiable
//     node src/scripts/reverseSpoofedSteps.js --apply --zero-unverifiable
//     node src/scripts/reverseSpoofedSteps.js --user <id> --force   # reviewed account
//                                                                  # under the churn threshold
//     node src/scripts/reverseSpoofedSteps.js --user <id> --zero-days --from 2026-08-28 --to 2026-09-21 --apply
//                                                                  # reviewed account: every day
//                                                                  # in the range to zero
//     node src/scripts/reverseSpoofedSteps.js ... --void-ledger    # remove the paid entries
//                                                                  # (archived) instead of
//                                                                  # writing one DEDUCTED row
//
// ── --zero-days ─────────────────────────────────────────────────────────────
//
// The selection rule above is deliberately narrow: it acts on days it can
// prove, and skips days it cannot. An account that has been REVIEWED can be
// past that. One account posted 19 distinct Health Connect origins in two
// weeks, the whole of each day injected at midnight, its device sending
// 30–41,000 a day against a 15,000 clamp — and its first two days, 44,000
// and 43,000, predate the provenance ledger entirely, so no rule can see
// them. --zero-days takes every day of ONE named account in a date range to
// zero, through the same applyPlan as everything else: steps, watermark,
// goal, originTrusted, the paid entries (void mode), the notifications, the
// challenges. It requires --user, --from and --to, so it cannot be run wide.

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User.model');
const HealthActivity = require('../models/HealthActivity.model');
const StepProvenance = require('../models/StepProvenance.model');
const Gamification = require('../models/Gamification.model');
const CoinTransaction = require('../models/CoinTransaction.model');
const CoinTransactionArchive = require('../models/CoinTransactionArchive.model');
const Notification = require('../models/Notification.model');
const AdminActionLog = require('../models/AdminActionLog.model');
const UserChallenge = require('../models/UserChallenge.model');
const Challenge = require('../models/Challenge.model');
const { getCachedAppConfig } = require('../utils/appConfigCache');
const { passiveCoinsForSteps } = require('../utils/passiveCoins');
const { getEffectiveDailyCap } = require('../utils/dailyCoinCap');
const { shiftDate } = require('../utils/stepBaselineStore');
const { rechainBalances } = require('../utils/coinLedger');
const {
  ORIGIN_TRUST_MIN_DAYS,
  ORIGIN_CHURN_MAX,
  UNATTRIBUTED_MIN_WINDOW_MIN,
} = require('../utils/stepOriginTrust');
const {
  computeStepBaseline,
  MAX_STEPS_PER_MINUTE,
} = require('../utils/stepValidation');
const {
  DEFAULT_RATE_PER_100_STEPS,
  DEFAULT_DAILY_EARN_LIMIT,
} = require('../constants/coinDefaults');

/** Coin sources that were paid for a day's step count, and can be clawed back. */
const STEP_COIN_SOURCES = [
  'PASSIVE_STEPS',
  'PASSIVE_STEPS_RETRO',
  'DAILY_STEP_GOAL',
  'DAILY_STEP_GOAL_AUTO',
  'DAILY_STEP_GOAL_RETRO',
];

/**
 * Share of an account's days an origin must appear on before its figure is
 * trusted as the honest one.
 *
 * A real pedometer or fitness app is present on most days; a rotating identity is
 * present for one or two. "Most" is the whole idea, so a half is the honest
 * threshold for it rather than a number picked to make a particular account come
 * out a particular way.
 *
 * It was 0.6 while the tool only saw days with a named origin. Detecting the
 * unattributed jumps as well grew the denominator — the same account went from 5
 * days to 9 — and pushed the bar past the genuine source that had been found
 * correctly before: Google Fit, present on 5 of the 9, stopped qualifying at 60%
 * and every day fell back to UNVERIFIABLE.
 *
 * At a half it separates both accounts the way the evidence does. On the first,
 * Google Fit (5 of 9) qualifies and the eight injected origins (1-2 days each) do
 * not. On the second nothing qualifies — its most persistent origin appears on 3
 * of 8 days and is itself one of the rotation — which is the honest answer, and
 * those days go to the cap rather than to a guess.
 */
const RESTORE_MIN_SHARE = 0.5;

const n = v => Number(v || 0).toLocaleString('en-US');
const pad = (v, w) => String(v ?? '').padEnd(w).slice(0, w);
const money = v => Number(v || 0).toFixed(2);

// ─── The week a date belongs to ──────────────────────────────────────────────
//
// challenge.controller.js computes this for TODAY, from `new Date()`. A reversal
// has to ask the same question about a date in the past, so the arithmetic is
// repeated here against a given date rather than the clock. Kept deliberately
// identical in shape — Sunday-start, the same ISO week-year handling — because a
// week boundary that disagrees with the live code would revert the wrong period.

function getISOWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function weeklyPeriodKeyFor(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const local = new Date(y, m - 1, d);
  const week = getISOWeek(local);
  const utc = new Date(Date.UTC(y, m - 1, d));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Sunday-start week bounds for a date, as ISO strings. */
function weekBoundsFor(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  const start = new Date(day);
  start.setDate(start.getDate() - day.getDay());
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = x =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { start: fmt(start), end: fmt(end) };
}

// ─── Phase 1: which days came from a source with no history ─────────────────

/**
 * Ledger entries whose steps nothing accounts for.
 *
 * An entry qualifies when it named no origin AND moved the day by more than the
 * time before it could hold. The window is the gap since the previous entry,
 * widened by whatever the client reported as its offline stretch — the same two
 * inputs the live rule uses, read here from what the ledger already recorded.
 *
 * ── The first entry of a day covers the whole day so far ──────────────────
 *
 * It has no previous entry to measure from, and falling back to the minimum
 * window made every one of them unexplainable: honest first syncs of 675, 733
 * and 1,019 steps were flagged against a one-minute window. A day's opening sync
 * carries whatever was walked since local midnight, so that is the window it gets
 * — which is also exactly what the live rule does, since a row with no previous
 * total falls through to the elapsed-on-date cap.
 */
function unattributedEntries(entries, { date, timezone } = {}) {
  const out = [];
  let previousAt = dayStartMs(date, timezone);

  for (const e of entries) {
    const at = e?.at ? new Date(e.at).getTime() : null;
    const gapMinutes =
      previousAt != null && at != null ? Math.max(0, (at - previousAt) / 60_000) : null;
    const offline = Number(e?.offlineMinutes);
    const window = Math.max(
      UNATTRIBUTED_MIN_WINDOW_MIN,
      gapMinutes ?? 0,
      Number.isFinite(offline) && offline > 0 ? offline : 0,
    );

    const delta = Number(e?.delta) || 0;
    if (!e?.primaryOrigin && delta > Math.ceil(window * MAX_STEPS_PER_MINUTE)) {
      out.push({ delta, reader: e.reader || 'unknown', windowMinutes: Math.round(window) });
    }
    if (at != null) previousAt = at;
  }
  return out;
}

/**
 * Local midnight of `date`, in epoch ms, or null when it cannot be resolved.
 *
 * Only used as the starting mark for the day's first entry, so a timezone this
 * cannot parse falls back to null and that entry is measured against the minimum
 * window — the old behaviour, for the one entry it applies to.
 */
function dayStartMs(date, timezone) {
  if (!date) return null;
  try {
    // Resolve the zone's offset at that date by comparing the same instant
    // formatted in UTC and in the zone.
    const noonUtc = new Date(`${date}T12:00:00.000Z`);
    const asZone = new Date(
      noonUtc.toLocaleString('en-US', { timeZone: timezone || 'UTC' }),
    );
    const asUtc = new Date(noonUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
    const offsetMs = asZone.getTime() - asUtc.getTime();
    return new Date(`${date}T00:00:00.000Z`).getTime() - offsetMs;
  } catch {
    return null;
  }
}


/**
 * Builds an account's origin history and decides which of its days are suspect.
 *
 * Two different day-counts are kept, because trust and RESTORATION are different
 * questions:
 *
 *   * `primaryDays` counts days an origin was the PRIMARY. This is what the live
 *     trust rule reasons about, and it is what detects the rotation.
 *   * `seenDays` counts days an origin appeared at all, primary or not. This is
 *     what restoration needs, and the distinction is load-bearing: on the
 *     fraudulent accounts the genuine app was NEVER primary — the injected origin
 *     always outranked it — so a primary-only count would find no honest source
 *     on any day and declare every one of them unverifiable.
 */
function analyseAccount(rows) {
  const primaryDays = {};
  const seenDays = {};

  for (const row of rows) {
    const primariesToday = new Set();
    for (const entry of row.entries || []) {
      if (entry?.primaryOrigin) primariesToday.add(entry.primaryOrigin);
    }
    for (const o of primariesToday) primaryDays[o] = (primaryDays[o] || 0) + 1;

    const seenToday = new Set();
    for (const o of row.origins || []) {
      if (o?.packageName) seenToday.add(o.packageName);
    }
    for (const o of primariesToday) seenToday.add(o);
    for (const o of seenToday) seenDays[o] = (seenDays[o] || 0) + 1;
  }

  const distinctPrimaries = Object.keys(primaryDays).length;
  const churning = distinctPrimaries > ORIGIN_CHURN_MAX;
  const totalDays = rows.length;

  // ── An origin worth restoring from ────────────────────────────────────────
  //
  // PERSISTENCE, and nothing else. Established by total appearances rather than
  // by having won the dedup, for the reason above, and additionally by being
  // present across most of the account's history.
  //
  // The first version also excluded anything that had ever been primary, on the
  // theory that on a churning account being primary is what the injection
  // achieved. The dry run showed that backwards: on the worst account Google Fit
  // was primary on four of five days and was the genuine source, so the exclusion
  // threw away the only honest figure there was and every day came out
  // UNVERIFIABLE. Being persistent is what distinguishes a real app from a
  // rotating identity; being primary distinguishes nothing.
  const threshold = Math.max(
    ORIGIN_TRUST_MIN_DAYS,
    Math.ceil(totalDays * RESTORE_MIN_SHARE),
  );
  const restorable = new Set(
    Object.entries(seenDays)
      .filter(([, days]) => days >= threshold)
      .map(([pkg]) => pkg),
  );

  return {
    primaryDays,
    seenDays,
    distinctPrimaries,
    churning,
    restorable,
    totalDays,
    threshold,
  };
}

/**
 * The days on this account that a source with no history produced.
 *
 * ── Only a CHURNING account is ever in scope ────────────────────────────────
 *
 * This gate was missing in the first version and the dry run caught it. Without
 * it, a day was flagged whenever its primary origin had not yet been seen on
 * ORIGIN_TRUST_MIN_DAYS days — which is true of every day on an account that is
 * simply NEW. One honest user with three days of data and two perfectly ordinary
 * origins came out with all three days flagged and 1,946 steps proposed for
 * removal.
 *
 * Being new is not evidence of anything. The finding this whole exercise rests on
 * is that the honest accounts and the fraudulent ones were separated by ROTATION
 * and by nothing else: ten honest accounts had one origin each, three fraudulent
 * ones cycled through four, eight and nine. An account that is not rotating has
 * no day worth taking steps away from, however little history it has.
 *
 * The live trust rule can afford the looser test because its only consequence is
 * to keep a day out of a future baseline window. This script deletes steps and
 * takes back coins, so it needs the discriminator that actually discriminates.
 */
function suspectDays(rows, analysis, { force = false } = {}) {
  if (!analysis.churning && !force) return [];

  const out = [];
  for (const row of rows) {
    const primaries = new Set(
      (row.entries || []).map(e => e?.primaryOrigin).filter(Boolean),
    );
    const untrusted = [...primaries].filter(
      p => analysis.churning || (analysis.primaryDays[p] || 0) < ORIGIN_TRUST_MIN_DAYS,
    );

    // ── Steps that named no source at all ─────────────────────────────────
    //
    // The first version keyed only on untrusted PRIMARY origins, and a day whose
    // entries name nobody has none — so it was skipped outright. That is exactly
    // the shape the laundering paths produce, and it hid the two worst recent
    // days on these very accounts: 1,725 → 15,931 under `reader: unknown`, and
    // 1,143 → 9,471 under the sensor's label after a Health Connect seed. Both
    // days have `origins: []` and would have been invisible here.
    //
    // Judged on TIME, not size, exactly as the live rule is. A big delta is
    // ordinary after a phone has been offline — flushing a whole day in one sync
    // is what coming back online looks like — so the test is whether the elapsed
    // window could hold it. A flat size threshold marked 14.8% of honest days.
    const unattributed = unattributedEntries(row.entries || [], {
      date: row.date,
      timezone: row.timezone,
    });

    if (!untrusted.length && !unattributed.length) continue;

    // The largest figure from a source that has history with this account.
    //
    // Largest, not the primary's — several legitimate origins can coexist (a
    // pedometer and a fitness app), the dedup already takes the biggest of them
    // as its baseline, and restoring to a smaller one would delete steps the user
    // really walked. The dry run caught that too: an account with Sweatcoin at
    // 2,238 and a platform pedometer at 3,648 would have been "restored" to 2,238.
    const candidates = (row.origins || []).filter(o =>
      analysis.restorable.has(o.packageName),
    );
    const restoredSteps = candidates.length
      ? Math.max(...candidates.map(o => Number(o.steps) || 0))
      : null;

    out.push({
      date: row.date,
      recordedTotal: Number(row.totalSteps) || 0,
      untrusted,
      unattributed,
      candidates,
      restoredSteps,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Fills in a figure for the days no source can account for.
 *
 * ── Why this is not zero ────────────────────────────────────────────────────
 *
 * A day with no persistent origin behind it is one we know is wrong and cannot
 * measure. Three things can be done with it, and two of them are bad:
 *
 *   * Leave it. The fabricated figure stands in the data and in every leaderboard
 *     and streak built on it.
 *   * Zero it. We know the day is wrong; we do NOT know the user walked nothing.
 *     Zero is an invented number, which is the same class of mistake as the
 *     injection, only pointing the other way.
 *   * Cap it at what the FIXED system would have allowed. This invents nothing —
 *     it applies today's rule to a day that predates it — and every error it can
 *     make is in the user's favour, because it only ever lowers a total to a
 *     ceiling that a real user of that account could have reached.
 *
 * The ceiling is computeStepBaseline over the account's own trailing days, with
 * every suspect day excluded: a poisoned history must not be allowed to widen the
 * allowance being used to correct it. An account with too little clean history
 * gets BASELINE_FLOOR, which is the same answer the live rule gives it.
 *
 * Only ever lowers. A day already under its ceiling keeps its figure and is
 * merely marked untrusted.
 */
function capUnverifiable(days, rows) {
  const suspect = new Set(days.map(d => d.date));
  // Walked steps only, matching loadStepBaseline exactly. Bonus steps are credited
  // by an admin or by the system and say nothing about what this account walks —
  // letting them in would widen the ceiling as a side effect of a support gesture,
  // and would make the tool disagree with the rule it is meant to apply.
  const cleanByDate = new Map(
    rows
      .filter(r => !suspect.has(r.date))
      .map(r => [
        r.date,
        Math.max(0, (Number(r.walkedSteps) || 0) - (Number(r.bonusSteps) || 0)),
      ]),
  );

  for (const day of days) {
    if (day.restoredSteps != null) continue;

    const trailing = [...cleanByDate.entries()]
      .filter(([date]) => date < day.date && date >= shiftDate(day.date, 28))
      .map(([, steps]) => steps);

    const ceiling = computeStepBaseline(trailing);
    day.cappedAt = ceiling;
    day.restoredSteps = Math.min(day.recordedTotal, ceiling);
  }
  return days;
}

// ─── Phase 2: what the corrections cost ─────────────────────────────────────

async function planCoinReversal({ userId, date, restoredWalked, goalSnapshot, rate, cap }) {
  const paidTxns = await CoinTransaction.find({
    user: userId,
    type: 'EARNED',
    source: { $in: STEP_COIN_SOURCES },
    'metadata.date': date,
  }).lean();

  const paid = paidTxns.reduce((s, t) => s + (Number(t.amount) || 0), 0);

  // What the corrected figure actually earns. Passive coins come straight from
  // the shared formula; the goal bonus is all-or-nothing against the goal that
  // was active on the day, which HealthActivity snapshots for exactly this kind
  // of question.
  const owedPassive = passiveCoinsForSteps(restoredWalked, rate, cap);
  const goalTxns = paidTxns.filter(t => t.source.startsWith('DAILY_STEP_GOAL'));
  const goalPaid = goalTxns.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const goalStillMet = goalSnapshot > 0 && restoredWalked >= goalSnapshot;
  const owedGoal = goalStillMet ? goalPaid : 0;

  const owed = owedPassive + owedGoal;
  const deduct = Math.max(0, parseFloat((paid - owed).toFixed(4)));

  return { paid, owed, deduct, goalStillMet, txnCount: paidTxns.length };
}

async function planChallengeReversal({ userId, dates, correctedByDate }) {
  const challenges = await Challenge.find({ criteriaType: 'STEPS' }).lean();
  if (!challenges.length) return [];

  const plans = [];
  const seenPeriods = new Set();

  for (const date of dates) {
    for (const challenge of challenges) {
      const periodKey =
        challenge.type === 'daily' ? date : weeklyPeriodKeyFor(date);
      const key = `${challenge._id}:${periodKey}`;
      if (seenPeriods.has(key)) continue;
      seenPeriods.add(key);

      const row = await UserChallenge.findOne({
        user: userId,
        challenge: challenge._id,
        periodKey,
      }).lean();
      if (!row) continue;

      // Recompute from the corrected figures, exactly as the live sync does:
      // a daily challenge reads that day's row, a weekly one sums the week.
      let corrected;
      if (challenge.type === 'daily') {
        corrected = correctedByDate.get(date);
        if (corrected == null) continue;
      } else {
        const { start, end } = weekBoundsFor(date);
        const week = await HealthActivity.find({
          user: userId,
          date: { $gte: start, $lte: end },
        })
          .select('date steps')
          .lean();
        corrected = week.reduce((sum, a) => {
          const fixed = correctedByDate.get(a.date);
          return sum + (fixed == null ? Number(a.steps) || 0 : fixed);
        }, 0);
      }

      const stillMet = corrected >= challenge.targetValue;
      if (stillMet) continue;
      if (!row.isCompleted && !row.isRewarded) continue;

      plans.push({
        challengeId: challenge._id,
        title: challenge.title,
        periodKey,
        was: row.currentValue,
        now: corrected,
        target: challenge.targetValue,
        clawback: row.isRewarded ? Number(row.rewardedAmount) || 0 : 0,
        rewardedAt: row.rewardedAt || null,
      });
    }
  }
  return plans;
}

// ─── Phase 3: apply ─────────────────────────────────────────────────────────

// ─── Removing the entries themselves ────────────────────────────────────────
//
// A reversal has two possible shapes, and they answer different questions.
//
// The first keeps every EARNED row and adds one DEDUCTED row for the total.
// That is a faithful ledger — the money came in, the money went out — and it
// is what reverseSpoofedSteps writes by default.
//
// The second removes the entries that were never earned: the "+2.09 Auto Step
// Coins" rows for a window the phone was shaken through, the goal bonus for a
// goal that was not met, the challenge reward for a challenge that was not
// completed, and the notifications that announced them. After it, the
// account's history reads as if those syncs had been refused at the time,
// which is exactly the state the live rules now produce. Every reader stops
// showing the entries at once — the user's history, the admin ledger and its
// earned/spent totals, the per-day earnings, the analytics — because the rows
// are no longer there to show, rather than because each query remembered to
// filter them.
//
// Removed rows are copied to CoinTransactionArchive first, verbatim, with the
// reason and the tool. Nothing is forgotten; it is filed. And the balance is
// lowered by exactly the sum of what was removed, so the ledger that remains
// still adds up to the balance the way it did before.
//
// Which rows a day loses:
//   * a day restored to zero — every step-coin row for that date;
//   * a day restored to a lower figure — the passive rows paid for the syncs
//     the replay refused (matched on the total the row was paid up to, or the
//     minute it was written), plus the goal bonus if the goal is no longer met.
//     A day with no list of refused syncs cannot be matched this way and keeps
//     the DEDUCTED-row shape instead.

/**
 * Local midnight of `date` in `timezone` and the midnight after it, as epoch
 * ms — the window a day's notifications were written in.
 */
function dayWindowMs(date, timezone) {
  const start = dayStartMs(date, timezone);
  if (start == null) return null;
  return { start, end: start + 24 * 60 * 60_000 };
}

/**
 * Which of a day's paid step-coin rows a correction removes. See the note
 * above. Pure: `paid` is the day's EARNED step-coin rows, already loaded.
 *
 * @returns {Array<object>|null} the rows to remove, or null when the day
 *   cannot be matched (a partial day with no list of refused syncs).
 */
function rowsToVoidFor(day, paid) {
  if (!paid.length) return [];
  if (day.restoredSteps === 0) return paid;
  if (!Array.isArray(day.refusedSyncs)) return null;

  const window = 2 * 60_000;
  const refused = day.refusedSyncs.map(r => ({
    raw: Math.round(Number(r.raw)),
    at: r.at == null ? null : new Date(r.at).getTime(),
  }));
  const goalGone =
    day.goalSnapshot > 0 && day.restoredSteps + (day.bonusSteps || 0) < day.goalSnapshot;

  const goalRows = paid.filter(t => String(t.source).startsWith('DAILY_STEP_GOAL'));
  const passiveRows = paid.filter(t => !String(t.source).startsWith('DAILY_STEP_GOAL'));

  // One passive row per refused sync, and no more. A row is the one paid for
  // a sync when it was paid up to exactly that sync's total; only when no row
  // says so is the nearest row written within two minutes taken instead. It
  // used to be "either", and that removed rows the replay had ACCEPTED: the
  // two streams on one phone post a minute or two apart, so the worker's row
  // sat inside the window of the service's refused sync and went with it —
  // two to three coins a day more than the corrected figure warranted.
  const taken = new Set();
  const chosen = [];
  for (const r of refused) {
    let match = passiveRows.find(
      t => !taken.has(String(t._id)) && Math.round(Number(t.metadata?.steps)) === r.raw,
    );
    if (!match && r.at != null) {
      let best = null;
      for (const t of passiveRows) {
        if (taken.has(String(t._id))) continue;
        const gap = Math.abs(new Date(t.createdAt).getTime() - r.at);
        if (gap <= window && (best == null || gap < best.gap)) best = { t, gap };
      }
      match = best?.t;
    }
    if (!match) continue;
    taken.add(String(match._id));
    chosen.push(match);
  }

  return [...chosen, ...(goalGone ? goalRows : [])];
}

/**
 * The ledger rows a corrected day should lose — rowsToVoidFor over the day's
 * paid rows.
 *
 * @returns {Promise<Array<object>|null>} lean CoinTransaction rows, or null
 *   when the day cannot be matched.
 */
async function ledgerRowsToVoid({ userId, day }) {
  const paid = await CoinTransaction.find({
    user: userId,
    type: 'EARNED',
    source: { $in: STEP_COIN_SOURCES },
    'metadata.date': day.date,
  }).lean();
  return rowsToVoidFor(day, paid);
}

/**
 * Copies rows to the archive and deletes them from the ledger.
 *
 * @returns {Promise<number>} coins removed
 */
async function voidLedgerRows({ userId, rows, script, reason }) {
  if (!rows.length) return 0;
  await CoinTransactionArchive.insertMany(
    rows.map(t => ({
      originalId: t._id,
      user: t.user,
      type: t.type,
      amount: t.amount,
      balanceAfter: t.balanceAfter,
      source: t.source,
      description: t.description,
      metadata: t.metadata || {},
      originalCreatedAt: t.createdAt || null,
      archivedAt: new Date(),
      archivedBy: script,
      archiveReason: reason,
      archiveDate: t.metadata?.date || t.metadata?.periodKey || null,
    })),
  );
  await CoinTransaction.deleteMany({ _id: { $in: rows.map(t => t._id) } });
  return rows.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
}

/**
 * Writes one account's corrections. Shared with reverseHeldSteps.js, which
 * selects days by a different rule and hands them here in the same shape, so
 * the two tools cannot disagree about how a correction is written.
 *
 * `description` and `script` label the ledger row; a day may carry `rowUpdate`
 * with extra fields to set on its HealthActivity row alongside the correction.
 *
 * With `voidLedger`, the entries are removed rather than offset — see the note
 * at ledgerRowsToVoid — and the notifications that announced them are deleted.
 * `timezone` locates the day's notifications.
 */
async function applyPlan({
  userId,
  days,
  untrustedOnly,
  coinDeduct,
  challengePlans,
  description = null,
  script = 'reverseSpoofedSteps',
  voidLedger = false,
  timezone = 'Asia/Kolkata',
}) {
  // ── Every suspect day is marked, even the ones that cannot be corrected ────
  //
  // This was missed in the first pass: only the correctable days were written,
  // so the six days on the account with no persistent honest source kept feeding
  // future baseline windows. Those are exactly the days that must not — 29,872 to
  // 42,163 steps each, on an account cycling through nine identities. Marking
  // them costs nothing and takes nothing away: `originTrusted` only ever excludes
  // a day from a ceiling calculation.
  for (const day of untrustedOnly) {
    await HealthActivity.updateOne(
      { user: userId, date: day.date },
      { $set: { originTrusted: false } },
    );
  }

  for (const day of days) {
    const update = { originTrusted: false, ...(day.rowUpdate || {}) };
    if (day.restoredSteps != null) {
      // `steps` is walked + bonus; the correction only touches the walked part.
      const bonus = day.bonusSteps || 0;
      update.steps = day.restoredSteps + bonus;
      update.stepCoinWatermark = day.restoredSteps;
      if (day.goalSnapshot > 0) {
        update.goalMet = day.restoredSteps + bonus >= day.goalSnapshot;
      }
      if (!update.goalMet) update.retroGoalCoinAwarded = false;
    }
    await HealthActivity.updateOne(
      { user: userId, date: day.date },
      { $set: update },
    );
  }

  const gam = await Gamification.findOne({ user: userId });
  let totalClawback =
    coinDeduct + challengePlans.reduce((s, p) => s + p.clawback, 0);
  const balance = {
    before: Number(gam?.coinsBalance) || 0,
    after: Number(gam?.coinsBalance) || 0,
    applied: 0,
    requested: parseFloat(totalClawback.toFixed(4)),
    removedRows: 0,
    removedNotifications: 0,
  };

  // ── Void mode: take the entries out, and let the removal be the deduction ──
  let voided = false;
  if (voidLedger) {
    const rows = [];
    let unmatched = 0;
    for (const day of days) {
      if (day.restoredSteps == null) continue;
      const found = await ledgerRowsToVoid({ userId, day });
      if (found == null) {
        unmatched += 1;
        continue;
      }
      rows.push(...found);
    }
    for (const plan of challengePlans) {
      if (!(plan.clawback > 0)) continue;
      rows.push(
        ...(await CoinTransaction.find({
          user: userId,
          type: 'EARNED',
          source: 'CHALLENGE',
          'metadata.challengeId': plan.challengeId,
          'metadata.periodKey': plan.periodKey,
        }).lean()),
      );
    }

    // Every day matched, so the removal IS the correction: no DEDUCTED row is
    // written, and the balance drops by exactly what was removed. A day that
    // could not be matched leaves the whole account on the offset shape, so
    // the two never mix on one account.
    if (unmatched === 0) {
      voided = true;
      const removed = await voidLedgerRows({
        userId,
        rows,
        script,
        reason: description || 'step reversal',
      });
      balance.removedRows = rows.length;
      totalClawback = removed;
      balance.requested = parseFloat(removed.toFixed(4));

      // The notifications that announced what was removed: the day's goal
      // (auto-awarded or claimed) where the goal is no longer met, and the
      // challenge completion for a reverted challenge.
      const or = [];
      for (const day of days) {
        if (day.restoredSteps == null) continue;
        const goalGone =
          day.goalSnapshot > 0 &&
          day.restoredSteps + (day.bonusSteps || 0) < day.goalSnapshot;
        if (!goalGone) continue;
        const win = dayWindowMs(day.date, timezone);
        if (!win) continue;
        or.push({
          type: { $in: ['GOAL', 'COIN'] },
          title: /step goal|daily goal/i,
          createdAt: { $gte: new Date(win.start), $lt: new Date(win.end) },
        });
      }
      for (const plan of challengePlans) {
        if (!(plan.clawback > 0) || !plan.rewardedAt) continue;
        const at = new Date(plan.rewardedAt).getTime();
        or.push({
          type: 'CHALLENGE',
          message: new RegExp(plan.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          createdAt: { $gte: new Date(at - 10 * 60_000), $lte: new Date(at + 10 * 60_000) },
        });
      }
      if (or.length) {
        const res = await Notification.deleteMany({ user: userId, $or: or });
        balance.removedNotifications = res.deletedCount || 0;
      }
    }
  }

  if (gam && totalClawback > 0 && voided) {
    const before = Number(gam.coinsBalance) || 0;
    const applied = Math.min(before, totalClawback);
    gam.coinsBalance = parseFloat((before - applied).toFixed(4));
    await gam.save();
    balance.after = gam.coinsBalance;
    balance.applied = parseFloat(applied.toFixed(4));
  }
  // The rows that remain must still read as a chain ending at the balance.
  if (voided) await rechainBalances(userId);

  // Filed in the admin action log, attributed to the first admin account, so
  // the account's audit trail says why its balance moved even though no
  // ledger row does. Skipped, not failed, when there is no admin to attribute.
  if (voided) {
    try {
      const admin = await User.findOne({ role: 'admin' }).select('_id name').lean();
      if (admin) {
        await AdminActionLog.create({
          admin: admin._id,
          adminName: `${script} (script)`,
          targetUser: userId,
          action: 'STEPS_REVERSAL',
          reason: description || 'step reversal',
          metadata: {
            dates: days.map(d => d.date),
            removedRows: balance.removedRows,
            removedNotifications: balance.removedNotifications,
            coinsRemoved: balance.applied,
            script,
          },
        });
      }
    } catch (err) {
      console.error('[applyPlan] action log failed:', err.message);
    }
  }

  if (gam && totalClawback > 0 && !voided) {
    // Clamped at zero: the balance has `min: 0` and a user may already have spent
    // what they were wrongly paid. Recovering it from a later purchase is a
    // support decision, not something a batch job should do silently.
    const before = Number(gam.coinsBalance) || 0;
    const applied = Math.min(before, totalClawback);
    gam.coinsBalance = parseFloat((before - applied).toFixed(4));
    await gam.save();
    balance.after = gam.coinsBalance;
    balance.applied = parseFloat(applied.toFixed(4));

    await CoinTransaction.create({
      user: userId,
      type: 'DEDUCTED',
      amount: parseFloat(applied.toFixed(4)),
      balanceAfter: gam.coinsBalance,
      source: 'STEPS_REVERTED',
      description:
        description ||
        `Step coins reversed — ${days.length} day(s) corrected after an ` +
          'unrecognised step source was found',
      metadata: {
        dates: days.map(d => d.date),
        requested: parseFloat(totalClawback.toFixed(4)),
        applied: parseFloat(applied.toFixed(4)),
        shortfall: parseFloat((totalClawback - applied).toFixed(4)),
        script,
      },
    });
  }

  for (const plan of challengePlans) {
    await UserChallenge.updateOne(
      { user: userId, challenge: plan.challengeId, periodKey: plan.periodKey },
      {
        $set: {
          currentValue: plan.now,
          isCompleted: false,
          completedAt: null,
          isRewarded: false,
          rewardedAt: null,
          rewardedAmount: 0,
        },
      },
    );
  }

  // What actually happened to the balance, for the caller to print: a
  // reversal whose deduction was clamped at zero, or found no Gamification
  // row, should say so rather than look like one that worked.
  return balance;
}

// ─── Report ─────────────────────────────────────────────────────────────────

function printAccount(report) {
  const { email, userId, analysis, days, coin, challengePlans } = report;
  console.log('');
  console.log('═'.repeat(78));
  console.log(`${email || '(no email)'}  ${userId}`);
  console.log('═'.repeat(78));
  console.log(
    `  ${analysis.distinctPrimaries} distinct primary origins` +
      `${analysis.churning ? `  — CHURNING (max ${ORIGIN_CHURN_MAX})` : ''}`,
  );

  console.log('\n  Origins on this account:');
  const rows = Object.entries(analysis.seenDays).sort((a, b) => b[1] - a[1]);
  for (const [pkg, seen] of rows) {
    const primary = analysis.primaryDays[pkg] || 0;
    const tag = analysis.restorable.has(pkg) ? 'restorable' : '';
    console.log(
      `    ${pad(pkg, 56)} seen ${String(seen).padStart(3)}d  primary ${String(primary).padStart(3)}d  ${tag}`,
    );
  }

  console.log('\n  Days:');
  console.log(
    `    ${pad('date', 12)}${pad('recorded', 11)}${pad('restored', 14)}source`,
  );
  for (const d of days) {
    const restored = d.restoredSteps == null ? 'UNVERIFIABLE' : n(d.restoredSteps);
    const why = [
      d.untrusted.length ? `${d.untrusted.length} unestablished origin(s)` : null,
      d.unattributed?.length
        ? `${d.unattributed.length} unattributed jump(s): ` +
          d.unattributed
            .map(u => `+${n(u.delta)} as '${u.reader}' in ${u.windowMinutes}min`)
            .join(', ')
        : null,
    ].filter(Boolean).join('; ');
    const src = d.zeroed
      ? 'reviewed account — every day in range to zero (--zero-days)'
      : d.candidates.length
        ? d.candidates.map(c => c.packageName).join(', ')
        : d.cappedAt != null
          ? `capped at ${n(d.cappedAt)} — ${why}`
          : `no source with history — ${why}`;
    console.log(
      `    ${pad(d.date, 12)}${pad(n(d.recordedTotal), 11)}${pad(restored, 14)}${src}`,
    );
  }

  const removed = days.reduce(
    (s, d) => s + (d.restoredSteps == null ? 0 : d.recordedTotal - d.restoredSteps),
    0,
  );
  console.log(`\n  Steps removed: ${n(removed)}`);
  console.log(
    `  Coins: paid ${money(coin.paid)}, owed ${money(coin.owed)}, ` +
      `deduct ${money(coin.deduct)} across ${coin.txnCount} transaction(s)`,
  );

  if (challengePlans.length) {
    console.log('  Challenges to revert:');
    for (const p of challengePlans) {
      console.log(
        `    ${pad(p.periodKey, 12)}${pad(p.title, 28)}` +
          `${n(p.was)} → ${n(p.now)} (target ${n(p.target)})` +
          `${p.clawback ? `  claw back ${money(p.clawback)}` : ''}`,
      );
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const zeroUnverifiable = args.includes('--zero-unverifiable');
  // Caps the days no source can account for at what the fixed system would have
  // allowed, rather than zeroing them or leaving them. See capUnverifiable.
  const capUnverifiableFlag = args.includes('--cap-unverifiable');
  // Bypasses the churn gate, and only ever for one explicitly named account. An
  // account can sit just under the threshold — one of the three had exactly three
  // distinct primaries — and reviewing it is a person's job. Automatic selection
  // stays conservative; this is how a reviewed case gets acted on.
  const force = args.includes('--force');
  const userArgIdx = args.indexOf('--user');
  const userArg = userArgIdx >= 0 ? args[userArgIdx + 1] : null;
  // Removes the paid entries rather than offsetting them — see the note at
  // ledgerRowsToVoid. Off by default here, on by default in reverseHeldSteps.
  const voidLedger = args.includes('--void-ledger');
  // Every day of one reviewed account in a range, to zero. See the header.
  const zeroDays = args.includes('--zero-days');
  const fromIdx = args.indexOf('--from');
  const toIdx = args.indexOf('--to');
  const fromArg = fromIdx >= 0 ? args[fromIdx + 1] : null;
  const toArg = toIdx >= 0 ? args[toIdx + 1] : null;
  if (zeroDays && (!userArg || !fromArg || !toArg)) {
    console.error('--zero-days needs --user <email|id> --from YYYY-MM-DD --to YYYY-MM-DD');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const cfg = await getCachedAppConfig().catch(() => null);
  // Read from exactly where health.controller.js reads them. The rate lives under
  // `coin_config.steps`, not under `coin` — a reversal computed from a different
  // rate than the award used would deduct the wrong amount, silently.
  const rate =
    cfg?.coin_config?.steps?.rate_per_100_steps ?? DEFAULT_RATE_PER_100_STEPS;
  const configCap = cfg?.coin?.dailyEarnLimit ?? DEFAULT_DAILY_EARN_LIMIT;
  const unverifiedCap = cfg?.coin?.unverifiedDailyCap;

  console.log(
    `\n${apply ? 'APPLYING' : 'DRY RUN — nothing will be written'}` +
      `   (rate ${rate}/100 steps, daily cap ${configCap})`,
  );

  let userFilter = {};
  if (userArg) {
    const user = userArg.includes('@')
      ? await User.findOne({ email: userArg }).select('_id').lean()
      : { _id: userArg };
    if (!user) {
      console.error(`No user matches "${userArg}"`);
      await mongoose.disconnect();
      process.exit(1);
    }
    userFilter = { user: user._id };
  }

  const userIds = await StepProvenance.distinct('user', userFilter);
  const reports = [];

  for (const userId of userIds) {
    // The passive cap is per-account: unverified emails get the lower of the two
    // limits. Resolving it globally would deduct against a ceiling the award
    // never actually used.
    const user = await User.findById(userId).select('email emailVerified').lean();
    const cap = getEffectiveDailyCap(user, configCap, unverifiedCap);

    const rows = await StepProvenance.find({ user: userId })
      // `delta` and `reader` feed the unattributed-jump test; without them it can
      // never fire and the laundering paths stay invisible.
      .select(
        'date timezone totalSteps walkedSteps bonusSteps origins ' +
          'entries.primaryOrigin entries.delta ' +
          'entries.reader entries.at entries.offlineMinutes',
      )
      .lean();
    const analysis = analyseAccount(rows);
    let found;
    if (zeroDays) {
      // Every day with steps in the range, from the stored rows rather than
      // the ledger: the days that predate provenance are exactly the ones this
      // exists for.
      const stored = await HealthActivity.find({
        user: userId,
        date: { $gte: fromArg, $lte: toArg },
        steps: { $gt: 0 },
      })
        .select('date steps')
        .lean();
      found = stored.map(a => ({
        date: a.date,
        recordedTotal: a.steps,
        restoredSteps: 0,
        candidates: [],
        untrusted: [],
        unattributed: [],
        cappedAt: null,
        zeroed: true,
      }));
    } else {
      found = suspectDays(rows, analysis, { force: force && Boolean(userArg) });
      if (fromArg || toArg) {
        found = found.filter(
          d => (!fromArg || d.date >= fromArg) && (!toArg || d.date <= toArg),
        );
      }
    }
    if (!found.length) continue;

    // Pull the goal that was active on each day and the bonus steps, so the
    // correction touches the walked figure only and the goal bonus is judged
    // against the goal the user actually had at the time.
    const activities = await HealthActivity.find({
      user: userId,
      date: { $in: found.map(d => d.date) },
    })
      .select('date steps bonusSteps goalSnapshot')
      .lean();
    const byDate = new Map(activities.map(a => [a.date, a]));

    const days = found.map(d => {
      const a = byDate.get(d.date);
      return {
        ...d,
        bonusSteps: Number(a?.bonusSteps) || 0,
        goalSnapshot: Number(a?.goalSnapshot) || 0,
        storedSteps: Number(a?.steps) || 0,
      };
    });

    if (capUnverifiableFlag) capUnverifiable(days, rows);

    const actionable = days.filter(
      d => d.restoredSteps != null || zeroUnverifiable,
    );
    for (const d of actionable) {
      if (d.restoredSteps == null) d.restoredSteps = 0;
    }

    let coin = { paid: 0, owed: 0, deduct: 0, txnCount: 0 };
    for (const d of actionable) {
      const c = await planCoinReversal({
        userId,
        date: d.date,
        restoredWalked: d.restoredSteps,
        goalSnapshot: d.goalSnapshot,
        rate,
        cap,
      });
      coin = {
        paid: coin.paid + c.paid,
        owed: coin.owed + c.owed,
        deduct: coin.deduct + c.deduct,
        txnCount: coin.txnCount + c.txnCount,
      };
    }

    const correctedByDate = new Map(
      actionable.map(d => [d.date, d.restoredSteps + d.bonusSteps]),
    );
    const challengePlans = await planChallengeReversal({
      userId,
      dates: actionable.map(d => d.date),
      correctedByDate,
    });

    const report = {
      userId,
      email: user?.email,
      analysis,
      days,
      actionable,
      coin,
      challengePlans,
    };
    reports.push(report);
    printAccount(report);

    if (apply) {
      const untrustedOnly = days.filter(d => !actionable.includes(d));
      const balance = await applyPlan({
        userId,
        days: actionable,
        untrustedOnly,
        coinDeduct: coin.deduct,
        challengePlans,
        voidLedger,
        timezone: rows.find(r => r.timezone)?.timezone || 'Asia/Kolkata',
        description: zeroDays
          ? `Step coins reversed — ${actionable.length} day(s) zeroed on a reviewed account`
          : null,
      });
      console.log(
        `\n  ✔ applied — ${actionable.length} day(s) corrected, ` +
          `${untrustedOnly.length} more marked untrusted; ` +
          `coins ${money(balance.before)} → ${money(balance.after)}` +
          (balance.applied < balance.requested
            ? ` (${money(balance.requested - balance.applied)} short — balance cannot go below zero)`
            : '') +
          (voidLedger
            ? `; ${balance.removedRows} ledger row(s) and ${balance.removedNotifications} notification(s) removed (archived)`
            : ''),
      );
    }
  }

  const skipped = reports.reduce(
    (s, r) => s + r.days.filter(d => d.restoredSteps == null).length,
    0,
  );

  console.log('\n' + '─'.repeat(78));
  console.log(
    `${reports.length} account(s), ` +
      `${reports.reduce((s, r) => s + r.actionable.length, 0)} day(s) to correct, ` +
      `${money(reports.reduce((s, r) => s + r.coin.deduct, 0))} coins to deduct`,
  );
  if (skipped) {
    console.log(
      `${skipped} day(s) UNVERIFIABLE and skipped — no origin on those days has ` +
        'any history with the account. Re-run with --zero-unverifiable only if ' +
        'you have decided those days are wholly fabricated.',
    );
  }
  if (!apply) console.log('Nothing was written. Re-run with --apply.');

  await mongoose.disconnect();
}

// Only run when invoked directly, so the pure halves above can be imported and
// tested without opening a database connection. The selection rules are the part
// that decides whose steps get taken away, so they are the part that most needs
// to be testable in isolation.
if (require.main === module) {
  main().catch(async err => {
    console.error('reverseSpoofedSteps failed:', err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  analyseAccount,
  suspectDays,
  capUnverifiable,
  unattributedEntries,
  weeklyPeriodKeyFor,
  weekBoundsFor,
  dayStartMs,
  dayWindowMs,
  // The write half, shared with reverseHeldSteps.js.
  planCoinReversal,
  planChallengeReversal,
  applyPlan,
  ledgerRowsToVoid,
  rowsToVoidFor,
  voidLedgerRows,
  STEP_COIN_SOURCES,
};
