#!/usr/bin/env node
// src/scripts/reverseHeldSteps.js
//
// ─── Undoing the days the live rules would now refuse ────────────────────────
//
// Two rules were added to the sync path after 21 Sep, and both describe days
// that had already been paid:
//
//   * SHARED COUNTER — one phone's step counter posting to several accounts
//     (an app clone under a second Android profile). The accounts report the
//     same totals at the same instants; live, the older account is paid and
//     the newer held. See utils/sharedStepSource.js.
//   * DAY-WIDE CADENCE — a source returning to the same rate, or the same
//     delta to the step, again and again with breaks in between. Live, the
//     stream is held on the return that completes the evidence. See the note
//     at MAX_CADENCE_SAMPLES in utils/stepValidation.js.
//
// This tool replays both against the per-day provenance ledger (kept 90 days)
// and reverses what they would have refused: steps on the row, the coins paid
// for them, and any challenge the corrected figure no longer completes. It
// writes through the same applyPlan as reverseSpoofedSteps.js, so the two
// tools correct a day in exactly the same way.
//
// ── What a shared day becomes ───────────────────────────────────────────────
//
// The whole of the newer account's day, to zero. The live rule lets the first
// two shared samples through because it cannot yet see the second copy; that
// is a limit of deciding in real time, not a judgement that those steps were
// the account's own. Here the whole day is visible at once, and every sample
// of it matched. The older account keeps its day, exactly as it does live, and
// its row is stamped with who the other account was.
//
// Three matches are required rather than the live rule's two. Live, a false
// positive costs a day and is visible and reversible; here it costs coins
// already in a balance, so the bar is one sample higher.
//
// ── What a cadence day becomes ──────────────────────────────────────────────
//
// What the day would have stored had the rule been running: each stream's
// increases replayed through the tracker, the day hold and the validator, in
// arrival order. The ledger records only increases, so a stream that fell
// behind another has longer windows here than it had live — which only ever
// makes the replay hold LESS, never more. Days where the replay refuses under
// --min-refused steps are reported and left alone: the rule accepts that it
// will occasionally hold a treadmill session, and a reversal should not act
// on a single window.
//
// Every corrected day is also marked originTrusted:false, so it drops out of
// the baseline window and the ceiling it ratcheted up comes back down.
//
// ── What "reversed" means here ──────────────────────────────────────────────
//
// The entries are REMOVED, not offset. The passive rows paid for the refused
// syncs, the goal bonus for a goal no longer met, the challenge reward for a
// challenge no longer completed, and the notifications that announced them
// are taken out — filed in CoinTransactionArchive first — and the balance
// drops by exactly their sum. The user's history, the admin ledger and its
// totals, the analytics and the leaderboard (ranked on balance) all stop
// showing them at once. See the note at ledgerRowsToVoid in
// reverseSpoofedSteps.js. --keep-ledger writes the older shape instead: the
// rows stay and one DEDUCTED row carries the total.
//
// Dry-run by default. --apply is a separate step, after reading the report.
//
// Usage:
//     node src/scripts/reverseHeldSteps.js                        # last 28 days, all users
//     node src/scripts/reverseHeldSteps.js --days 60
//     node src/scripts/reverseHeldSteps.js --from 2026-09-01 --to 2026-09-21
//     node src/scripts/reverseHeldSteps.js --user <email|id>      # one account (partners still found)
//     node src/scripts/reverseHeldSteps.js --shared-only | --cadence-only
//     node src/scripts/reverseHeldSteps.js --min-refused 1000
//     node src/scripts/reverseHeldSteps.js --apply
//     node src/scripts/reverseHeldSteps.js --apply --keep-ledger   # offset, do not remove

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User.model');
const HealthActivity = require('../models/HealthActivity.model');
const StepProvenance = require('../models/StepProvenance.model');
const { getCachedAppConfig } = require('../utils/appConfigCache');
const { getEffectiveDailyCap } = require('../utils/dailyCoinCap');
const { shiftDate } = require('../utils/stepBaselineStore');
const { toClientDate } = require('../utils/date');
const {
  validateSteps,
  trackClientCadence,
  cadenceSourceKey,
  resolveDayHold,
  STUCK_DELTA_MIN_STEPS,
} = require('../utils/stepValidation');
const {
  sharedSampleMatches,
  matchesNeeded,
  accountCreatedMs,
  SHARED_MIN_STEPS,
  SHARED_MATCH_WINDOW_MIN,
  SHARED_OFFSET_MAX,
} = require('../utils/sharedStepSource');
const {
  planCoinReversal,
  planChallengeReversal,
  applyPlan,
  ledgerRowsToVoid,
} = require('./reverseSpoofedSteps');
const {
  DEFAULT_RATE_PER_100_STEPS,
  DEFAULT_DAILY_EARN_LIMIT,
} = require('../constants/coinDefaults');

/**
 * Shared samples a pair needs here — one more than the live rule asks at the
 * same offset (matchesNeeded), for the reason in the header: this takes coins
 * out of a balance, so the bar is one sample higher.
 */
const reversalMatchesNeeded = offset => matchesNeeded(offset) + 1;
/** The exact-offset figure, for callers and tests that want the number. */
const REVERSAL_SHARED_MIN_MATCHES = reversalMatchesNeeded(0);
/** Steps the replay must refuse on a day before that day is corrected. */
const DEFAULT_MIN_REFUSED = 1_500;
const DEFAULT_DAYS = 28;

const n = v => Number(v || 0).toLocaleString('en-US');
const pad = (v, w) => String(v ?? '').padEnd(w).slice(0, w);
const money = v => Number(v || 0).toFixed(2);
const ms = v => (v == null ? null : new Date(v).getTime());

// ─── Shared counters on one date ────────────────────────────────────────────

/** The samples a ledger row's entries amount to: increases of at least a sample. */
function sampleTotalsOf(row) {
  return (row.entries || [])
    .filter(e => Number(e.delta) >= STUCK_DELTA_MIN_STEPS && Number(e.to) >= SHARED_MIN_STEPS)
    .map(e => ({ total: Math.round(Number(e.to)), at: ms(e.at) }))
    .filter(s => s.at != null);
}

/**
 * Which accounts on this date shared a counter, and who keeps it.
 *
 * Pure. Takes the date's ledger rows and returns one group per counter: the
 * oldest account as `keeper`, every other as `held` with how many of its
 * samples matched. Bucketed by time first so the pairing is linear in samples
 * rather than quadratic in users; a pair is confirmed with
 * sharedSampleMatches, the same test the live rule uses, so the two agree
 * about what a match is — including a constant offset between the totals.
 *
 * @param {Array<{user: any, entries: Array<{at: any, to: number, delta: number}>}>} rows
 * @param {{ minMatches?: (offset: number) => number }} [opts]
 * @returns {Array<{ keeper: string, held: Array<{ user: string, matches: number, offset: number, firstMatchAt: number }> }>}
 */
function findSharedGroups(rows, { minMatches = reversalMatchesNeeded } = {}) {
  const samplesByUser = new Map();
  for (const row of rows || []) {
    const user = String(row.user);
    const samples = sampleTotalsOf(row);
    if (samples.length) samplesByUser.set(user, samples);
  }

  // Candidate pairs: any two accounts with samples inside the window of each
  // other and inside the offset bound. Confirmed below against their whole
  // sample lists.
  const window = SHARED_MATCH_WINDOW_MIN * 60_000;
  const byBucket = new Map();
  for (const [user, samples] of samplesByUser) {
    for (const s of samples) {
      const bucket = Math.floor(s.at / window);
      if (!byBucket.has(bucket)) byBucket.set(bucket, []);
      byBucket.get(bucket).push({ user, at: s.at, total: s.total });
    }
  }
  const candidatePairs = new Set();
  for (const [bucket, posts] of byBucket) {
    // A window straddles a bucket edge, so each post is compared with its own
    // bucket and the next one.
    const nearby = [...posts, ...(byBucket.get(bucket + 1) || [])];
    for (const a of posts) {
      for (const b of nearby) {
        if (a.user === b.user) continue;
        if (Math.abs(a.at - b.at) > window) continue;
        if (Math.abs(a.total - b.total) > SHARED_OFFSET_MAX) continue;
        candidatePairs.add([a.user, b.user].sort().join('|'));
      }
    }
  }

  // Union-find over confirmed pairs, so three copies of one app land in one
  // group rather than three overlapping pairs.
  const parent = new Map();
  const find = u => {
    if (!parent.has(u)) parent.set(u, u);
    while (parent.get(u) !== u) {
      parent.set(u, parent.get(parent.get(u)));
      u = parent.get(u);
    }
    return u;
  };
  const union = (a, b) => parent.set(find(a), find(b));
  const pairMatches = new Map();

  for (const key of candidatePairs) {
    const [a, b] = key.split('|');
    const { matches, offset } = sharedSampleMatches(samplesByUser.get(a), samplesByUser.get(b));
    if (matches < minMatches(offset)) continue;
    pairMatches.set(key, { matches, offset });
    union(a, b);
  }

  const members = new Map();
  for (const key of pairMatches.keys()) {
    for (const u of key.split('|')) {
      const root = find(u);
      if (!members.has(root)) members.set(root, new Set());
      members.get(root).add(u);
    }
  }

  const groups = [];
  for (const set of members.values()) {
    const users = [...set].sort((a, b) => {
      const ta = accountCreatedMs(a);
      const tb = accountCreatedMs(b);
      if (ta != null && tb != null && ta !== tb) return ta - tb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const keeper = users[0];
    const held = users.slice(1).map(user => {
      // Matched against the keeper where possible, else the most it matched
      // anyone in the group — a third copy may have been offline while the
      // first two were posting.
      let best = { matches: 0, offset: 0 };
      for (const other of users) {
        if (other === user) continue;
        const pair = pairMatches.get([user, other].sort().join('|'));
        if (pair && pair.matches > best.matches) best = pair;
      }
      const firstMatchAt = Math.min(...samplesByUser.get(user).map(s => s.at));
      return { user, matches: best.matches, offset: best.offset, firstMatchAt };
    });
    groups.push({ keeper, held });
  }
  return groups;
}

// ─── One day, through the live rules ────────────────────────────────────────

/**
 * What a day would have stored under the current cadence rules.
 *
 * Pure. Feeds the ledger's increases, in arrival order, through exactly the
 * wiring health.controller.js uses — per-stream tracker, day hold, forfeit,
 * validateSteps — carrying the state the row would have carried. The `to` of
 * each increase stands in for the stream's raw figure, which it equals on any
 * sync that was not itself clamped; on one that was, it is lower, and the
 * replay can only refuse less.
 *
 * @param {{ date: string, timezone?: string, walkedSteps: number, entries: Array }} row
 * @returns {{ recorded: number, replayed: number, refused: number,
 *   holds: Array<{ at: string, source: string, raw: number, reason: string }>,
 *   timeline: Array<{ at: string, source: string, raw: number, before: number, after: number, refused: boolean }> }}
 *   `timeline` is every sync in order with the stored total before and after
 *   it under the replay — what a ledger row for that sync should describe.
 */
function replayDay(row) {
  const entries = [...(row.entries || [])]
    .filter(e => e.at != null && Number.isFinite(Number(e.to)))
    .sort((a, b) => ms(a.at) - ms(b.at));

  let stored = 0;
  let streams = {};
  let held = { by: null, since: null, forfeit: 0 };
  const holds = [];
  const timeline = [];

  for (const e of entries) {
    const at = ms(e.at);
    const raw = Math.round(Number(e.to));
    const source = cadenceSourceKey(e.clientSource);
    const cadence = trackClientCadence({ incomingSteps: raw, at, ...(streams[source] || {}) });
    const hold = resolveDayHold({
      source,
      cadence,
      streams,
      heldBy: held.by,
      heldSince: held.since,
      forfeit: held.forfeit,
      existingWalked: stored,
      at,
    });
    const r = validateSteps({
      incomingSteps: Math.max(0, raw - hold.stuckForfeit),
      existingSteps: stored,
      bonusSteps: 0,
      timezone: row.timezone || null,
      syncDate: row.date,
      dailyGoal: 10_000,
      cadence: { ...cadence, stuck: hold.stuck, stuckReason: hold.stuckReason },
    });
    const before = stored;
    if (r.clampedSteps > stored) stored = r.clampedSteps;
    if (hold.stuck) {
      holds.push({ at: new Date(at).toISOString(), source, raw, reason: hold.stuckReason });
    }
    timeline.push({
      at: new Date(at).toISOString(),
      source,
      raw,
      before,
      after: stored,
      refused: Boolean(hold.stuck),
    });
    const { delta, rate, stuck, stuckReason, sample, ...persisted } = cadence;
    streams = { ...streams, [source]: persisted };
    held = { by: hold.stuckSource, since: hold.stuckSince, forfeit: hold.stuckForfeit };
  }

  const recorded = Math.max(0, Math.round(Number(row.walkedSteps) || 0));
  const replayed = Math.min(recorded, stored);
  return { recorded, replayed, refused: recorded - replayed, holds, timeline };
}

// ─── Report ─────────────────────────────────────────────────────────────────

function printAccount({ email, userId, days, coin, challengePlans, removal }) {
  console.log('');
  console.log('═'.repeat(78));
  console.log(`${email || '(no email)'}  ${userId}`);
  console.log('═'.repeat(78));
  console.log(`    ${pad('date', 12)}${pad('recorded', 11)}${pad('restored', 11)}why`);
  for (const d of days) {
    const why =
      d.kind === 'shared'
        ? `counter shared with ${d.keeper} (${d.matches} matching samples` +
          `${d.offset ? `, ${Math.abs(d.offset)} steps apart` : ''}) — newer account`
        : `${d.holds.length} refused sync(s), first ${d.holds[0]?.at.slice(11, 19)} on ${d.holds[0]?.source}: ${d.holds[0]?.reason}`;
    console.log(`    ${pad(d.date, 12)}${pad(n(d.recordedTotal), 11)}${pad(n(d.restoredSteps), 11)}${why}`);
  }
  const removed = days.reduce((s, d) => s + (d.recordedTotal - d.restoredSteps), 0);
  console.log(`\n  Steps removed: ${n(removed)}`);
  console.log(
    `  Coins: paid ${money(coin.paid)}, owed ${money(coin.owed)}, ` +
      `deduct ${money(coin.deduct)} across ${coin.txnCount} transaction(s)`,
  );
  if (removal) {
    // What void mode does, which is what the balance actually drops by.
    console.log(
      `  Ledger: remove ${removal.rows} entr${removal.rows === 1 ? 'y' : 'ies'} ` +
        `(${money(removal.coins)} coins) from the coin history; ` +
        `${removal.unmatchedDays ? `${removal.unmatchedDays} day(s) could not be matched and would use a DEDUCTED row` : 'every day matched'}`,
    );
  }
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

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const sharedOnly = args.includes('--shared-only');
  const cadenceOnly = args.includes('--cadence-only');
  const minRefused = Number(argValue(args, '--min-refused')) || DEFAULT_MIN_REFUSED;
  const keepLedger = args.includes('--keep-ledger');
  const userArg = argValue(args, '--user');

  // Yesterday is the default end: today's row is still being written, and the
  // live watermark on the Gamification document would sit above a corrected
  // figure for the rest of the day. Name --to today explicitly to include it.
  const todayIST = toClientDate(new Date(), 'Asia/Kolkata');
  // shiftDate SUBTRACTS days.
  const to = argValue(args, '--to') || shiftDate(todayIST, 1);
  const from =
    argValue(args, '--from') ||
    shiftDate(to, (Number(argValue(args, '--days')) || DEFAULT_DAYS) - 1);

  await mongoose.connect(process.env.MONGO_URI);

  const cfg = await getCachedAppConfig().catch(() => null);
  const rate = cfg?.coin_config?.steps?.rate_per_100_steps ?? DEFAULT_RATE_PER_100_STEPS;
  const configCap = cfg?.coin?.dailyEarnLimit ?? DEFAULT_DAILY_EARN_LIMIT;
  const unverifiedCap = cfg?.coin?.unverifiedDailyCap;

  console.log(
    `\n${apply ? 'APPLYING' : 'DRY RUN — nothing will be written'}` +
      `   ${from} → ${to}   (rate ${rate}/100 steps, daily cap ${configCap}, ` +
      `min refused ${minRefused})`,
  );

  let onlyUser = null;
  if (userArg) {
    const user = userArg.includes('@')
      ? await User.findOne({ email: userArg }).select('_id').lean()
      : { _id: userArg };
    if (!user) {
      console.error(`No user matches "${userArg}"`);
      await mongoose.disconnect();
      process.exit(1);
    }
    onlyUser = String(user._id);
  }

  // ── Phase 1: select days, one date at a time ──────────────────────────────
  // Every account's rows for the date are read even under --user, because the
  // other half of a shared counter is another account.
  const daysByUser = new Map();
  const keepersByUser = new Map();
  const addDay = (user, day) => {
    if (!daysByUser.has(user)) daysByUser.set(user, []);
    daysByUser.get(user).push(day);
  };

  for (let date = from; date <= to; date = shiftDate(date, -1)) {
    const rows = await StepProvenance.find({ date })
      .select('user date timezone walkedSteps entries.at entries.to entries.delta entries.clientSource')
      .lean();
    if (!rows.length) continue;

    const sharedHeld = new Map();
    if (!cadenceOnly) {
      for (const group of findSharedGroups(rows)) {
        for (const h of group.held) sharedHeld.set(h.user, { ...h, keeper: group.keeper });
        if (!keepersByUser.has(group.keeper)) keepersByUser.set(group.keeper, []);
        keepersByUser.get(group.keeper).push({
          date,
          sharedWith: group.held[0].user,
          matches: Math.max(...group.held.map(h => h.matches)),
        });
      }
    }

    for (const row of rows) {
      const user = String(row.user);
      if (onlyUser && user !== onlyUser) continue;
      const recorded = Math.max(0, Math.round(Number(row.walkedSteps) || 0));
      if (recorded <= 0) continue;

      const shared = sharedHeld.get(user);
      if (shared) {
        addDay(user, {
          date,
          kind: 'shared',
          timezone: row.timezone || null,
          recordedTotal: recorded,
          restoredSteps: 0,
          keeper: shared.keeper,
          matches: shared.matches,
          offset: shared.offset || 0,
          holds: [],
          refusedSyncs: [],
          rowUpdate: {
            sharedWith: shared.keeper,
            sharedHeld: true,
            sharedMatches: shared.matches,
            sharedSince: new Date(shared.firstMatchAt),
          },
        });
        continue;
      }
      if (sharedOnly) continue;

      const replay = replayDay(row);
      if (replay.refused < minRefused) continue;
      addDay(user, {
        date,
        kind: 'cadence',
        timezone: row.timezone || null,
        recordedTotal: recorded,
        restoredSteps: replay.replayed,
        holds: replay.holds,
        // What ledgerRowsToVoid matches the day's passive rows against.
        refusedSyncs: replay.holds.map(h => ({ at: h.at, raw: h.raw })),
        rowUpdate: {
          stuckForfeit: replay.refused,
          stuckSource: replay.holds[0]?.source || null,
        },
      });
    }
  }

  // ── Phase 2: cost, report, apply — per account ────────────────────────────
  let accounts = 0;
  let totalDays = 0;
  let totalDeduct = 0;

  for (const [userId, found] of daysByUser) {
    const user = await User.findById(userId).select('email emailVerified').lean();
    const cap = getEffectiveDailyCap(user, configCap, unverifiedCap);

    const activities = await HealthActivity.find({
      user: userId,
      date: { $in: found.map(d => d.date) },
    })
      .select('date steps bonusSteps goalSnapshot')
      .lean();
    const byDate = new Map(activities.map(a => [a.date, a]));
    const days = found
      .map(d => {
        const a = byDate.get(d.date);
        return {
          ...d,
          bonusSteps: Number(a?.bonusSteps) || 0,
          goalSnapshot: Number(a?.goalSnapshot) || 0,
          storedSteps: Number(a?.steps) || 0,
        };
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    let coin = { paid: 0, owed: 0, deduct: 0, txnCount: 0 };
    for (const d of days) {
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
    const challengePlans = await planChallengeReversal({
      userId,
      dates: days.map(d => d.date),
      correctedByDate: new Map(days.map(d => [d.date, d.restoredSteps + d.bonusSteps])),
    });

    // The entries void mode would take out, so the report says what the
    // balance will actually drop by rather than what the formula estimates.
    let removal = null;
    if (!keepLedger) {
      removal = { rows: 0, coins: 0, unmatchedDays: 0 };
      for (const d of days) {
        const rows = await ledgerRowsToVoid({ userId, day: d });
        if (rows == null) {
          removal.unmatchedDays += 1;
          continue;
        }
        removal.rows += rows.length;
        removal.coins += rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      }
      removal.coins += challengePlans.reduce((s, p) => s + (p.clawback || 0), 0);
    }

    printAccount({ email: user?.email, userId, days, coin, challengePlans, removal });
    accounts += 1;
    totalDays += days.length;
    totalDeduct += removal && removal.unmatchedDays === 0 ? removal.coins : coin.deduct;

    if (apply) {
      const sharedDays = days.filter(d => d.kind === 'shared').length;
      const balance = await applyPlan({
        userId,
        days,
        untrustedOnly: [],
        coinDeduct: coin.deduct,
        challengePlans,
        voidLedger: !keepLedger,
        timezone: days.find(d => d.timezone)?.timezone || 'Asia/Kolkata',
        description:
          `Step coins reversed — ${days.length} day(s) corrected: ` +
          [
            sharedDays ? `${sharedDays} counted from a step counter shared with another account` : null,
            days.length - sharedDays
              ? `${days.length - sharedDays} from a source that had stopped measuring`
              : null,
          ]
            .filter(Boolean)
            .join(', '),
        script: 'reverseHeldSteps',
      });
      console.log(
        `\n  ✔ applied — ${days.length} day(s) corrected; ` +
          `coins ${money(balance.before)} → ${money(balance.after)}` +
          (balance.applied < balance.requested
            ? ` (${money(balance.requested - balance.applied)} short — balance cannot go below zero)`
            : '') +
          (keepLedger
            ? ''
            : `; ${balance.removedRows} ledger row(s) and ${balance.removedNotifications} ` +
              'notification(s) removed (archived)'),
      );
    }
  }

  // The older account of each shared pair keeps its steps, and its row says
  // who the other was — the same stamp the live rule writes.
  if (apply) {
    for (const [keeper, stamps] of keepersByUser) {
      if (onlyUser && keeper !== onlyUser) continue;
      for (const s of stamps) {
        await HealthActivity.updateOne(
          { user: keeper, date: s.date },
          { $set: { sharedWith: s.sharedWith, sharedMatches: s.matches } },
        );
      }
    }
  }

  console.log('\n' + '─'.repeat(78));
  console.log(
    `${accounts} account(s), ${totalDays} day(s) to correct, ` +
      `${money(totalDeduct)} coins to deduct` +
      (keepersByUser.size
        ? `; ${keepersByUser.size} older account(s) keep their shared days`
        : ''),
  );
  if (!apply) {
    console.log(
      'Nothing was written. Re-run with --apply — with npm the flag goes after ' +
        'the separator:  npm run reverse:held -- --apply',
    );
  } else if (accounts) {
    console.log(
      'Streaks are not recomputed here. Run  npm run repair:streaks -- --apply  ' +
        'so days whose goal is no longer met stop counting.',
    );
  }

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async err => {
    console.error('reverseHeldSteps failed:', err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  findSharedGroups,
  replayDay,
  sampleTotalsOf,
  reversalMatchesNeeded,
  REVERSAL_SHARED_MIN_MATCHES,
  DEFAULT_MIN_REFUSED,
};
