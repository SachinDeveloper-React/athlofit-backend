#!/usr/bin/env node
// src/scripts/reconcileVoidedLedger.js
//
// ─── Bringing an already-reversed account in line with the current rule ─────
//
// reverseHeldSteps.js decides which of a corrected day's ledger rows go, with
// rowsToVoidFor. That rule was tightened after the first reversals had been
// applied: it used to take any passive row written within two minutes of a
// refused sync, and on a phone whose two streams post a minute or two apart
// that took rows the replay had accepted — two or three coins a day beyond
// the corrected figure. The archive still holds every removed row, so the
// account can be brought to exactly what the rule says now.
//
// For each corrected day it re-runs the replay, gathers the day's step-coin
// rows from the ledger AND the archive, asks rowsToVoidFor which of them
// should be gone, and then:
//
//   * restores any archived row the rule would keep — back into the ledger
//     under its original id, out of the archive, and the balance credited;
//   * archives any live row the rule would remove (the opposite mistake,
//     which the old matching could not make, but checked all the same).
//
// Then the rows that remain on a partially corrected day are REWRITTEN onto
// the replay's timeline: the totals they describe ("24,759 → 27,019"), and
// the amount paid for them. Removing rows one by one cannot reproduce what
// the live rule would have paid — a hold that is released credits the
// releasing sync net of what was set aside, which no single row carries — so
// after a removal the day's rows still named totals up to 30,000 and summed
// to a coin or two away from what the corrected day earns. Each remaining
// row is matched to its sync (by the total it was paid up to, else by the
// minute it was written) and then says what that sync did under the replay:
// stored total before and after, and coins for exactly that movement. The
// day's rows then telescope to coinsFor(corrected total), which is what the
// live rule pays a day, and the newest row names the day's figure. An
// accepted sync that has no row of its own — live it moved the total by a
// few steps and paid nothing; under the replay it is the one that released a
// hold and is credited what the hold set aside — gets a row written for it,
// dated at the sync, so the day's rows are the replay's and nothing else.
// The balance moves by the net change. Descriptions on rows that cannot be
// matched are left as they are.
//
// Then the running balance is re-chained (utils/coinLedger.js). Rows the
// admin removed by hand with voidCoinTransactions.js are left alone: they
// were not selected by this rule and are not its business.
//
// Dry-run by default.
//
// Usage:
//     node src/scripts/reconcileVoidedLedger.js --user <email|id> [--days 28] [--apply]
//     node src/scripts/reconcileVoidedLedger.js --all [--days 28] [--apply]

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User.model');
const Gamification = require('../models/Gamification.model');
const HealthActivity = require('../models/HealthActivity.model');
const StepProvenance = require('../models/StepProvenance.model');
const CoinTransaction = require('../models/CoinTransaction.model');
const CoinTransactionArchive = require('../models/CoinTransactionArchive.model');
const AdminActionLog = require('../models/AdminActionLog.model');
const { shiftDate } = require('../utils/stepBaselineStore');
const { toClientDate } = require('../utils/date');
const { rechainBalances } = require('../utils/coinLedger');
const { rowsToVoidFor, voidLedgerRows, STEP_COIN_SOURCES } = require('./reverseSpoofedSteps');
const { replayDay } = require('./reverseHeldSteps');
const { passiveCoinsForSteps } = require('../utils/passiveCoins');
const { getCachedAppConfig } = require('../utils/appConfigCache');
const { getEffectiveDailyCap } = require('../utils/dailyCoinCap');
const {
  DEFAULT_RATE_PER_100_STEPS,
  DEFAULT_DAILY_EARN_LIMIT,
} = require('../constants/coinDefaults');

const money = v => Number(v || 0).toFixed(3);
const pad = (v, w) => String(v ?? '').padEnd(w).slice(0, w);

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

/** An archived row as the ledger row it was. */
const original = a => ({
  _id: a.originalId,
  user: a.user,
  type: a.type,
  amount: a.amount,
  balanceAfter: a.balanceAfter,
  source: a.source,
  description: a.description,
  metadata: a.metadata || {},
  createdAt: a.originalCreatedAt,
  updatedAt: a.originalCreatedAt,
  __archive: a._id,
});

/**
 * The rewrite of one day's remaining passive rows onto the replay timeline:
 * the updates to make, the rows to create for accepted syncs that have none,
 * and the net coin change. Pure — nothing is written.
 */
function rewritePlanFor({ live, timeline, rate, cap, userId, date }) {
  const passive = live
    .filter(t => String(t.source).startsWith('PASSIVE_STEPS'))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const accepted = timeline.filter(e => !e.refused && e.after > e.before);
  const used = new Set();
  const plan = [];
  let net = 0;
  for (const t of passive) {
    const paidUpTo = Math.round(Number(t.metadata?.steps));
    const writtenAt = new Date(t.createdAt).getTime();
    let entry = accepted.find((e, i) => !used.has(i) && e.raw === paidUpTo);
    if (!entry) {
      let best = null;
      accepted.forEach((e, i) => {
        if (used.has(i)) return;
        const gap = Math.abs(new Date(e.at).getTime() - writtenAt);
        if (gap <= 2 * 60_000 && (best == null || gap < best.gap)) best = { e, gap };
      });
      entry = best?.e;
    }
    if (!entry) continue;
    used.add(accepted.indexOf(entry));
    const amount = parseFloat(
      Math.max(0, passiveCoinsForSteps(entry.after, rate, cap) - passiveCoinsForSteps(entry.before, rate, cap)).toFixed(4),
    );
    const delta = entry.after - entry.before;
    const description =
      `Auto Step Coins — ${entry.before.toLocaleString()} → ${entry.after.toLocaleString()} (+${delta.toLocaleString()} steps)`;
    const changed =
      Math.abs(amount - (Number(t.amount) || 0)) > 0.0005 ||
      t.description !== description ||
      Math.round(Number(t.metadata?.steps)) !== entry.after;
    if (!changed) continue;
    net += amount - (Number(t.amount) || 0);
    plan.push({
      _id: t._id,
      from: { amount: t.amount, description: t.description },
      to: { amount, description, steps: entry.after, previousSteps: entry.before, stepDelta: delta },
    });
  }

  // Accepted syncs the ledger has no row for, that the replay pays.
  const create = [];
  accepted.forEach((entry, i) => {
    if (used.has(i)) return;
    const amount = parseFloat(
      Math.max(0, passiveCoinsForSteps(entry.after, rate, cap) - passiveCoinsForSteps(entry.before, rate, cap)).toFixed(4),
    );
    if (amount <= 0) return;
    const delta = entry.after - entry.before;
    net += amount;
    create.push({
      user: userId,
      type: 'EARNED',
      source: 'PASSIVE_STEPS',
      amount,
      balanceAfter: 0, // re-chained after the write
      description:
        `Auto Step Coins — ${entry.before.toLocaleString()} → ${entry.after.toLocaleString()} (+${delta.toLocaleString()} steps)`,
      metadata: {
        steps: entry.after,
        previousSteps: entry.before,
        stepDelta: delta,
        date,
        trigger: 'reconcile',
      },
      createdAt: new Date(entry.at),
      updatedAt: new Date(entry.at),
    });
  });
  return { plan, create, net: parseFloat(net.toFixed(4)) };
}

async function reconcileUser(userId, { from, to, apply, rate, configCap, unverifiedCap }) {
  const user = await User.findById(userId).select('email emailVerified').lean();
  const cap = getEffectiveDailyCap(user, configCap, unverifiedCap);
  const acts = await HealthActivity.find({
    user: userId,
    date: { $gte: from, $lte: to },
    originTrusted: false,
  }).lean();
  const corrected = acts.filter(a => a.sharedHeld || (a.stuckForfeit || 0) > 0);
  if (!corrected.length) return null;

  console.log('\n' + '═'.repeat(78));
  console.log(`${user?.email || '(no email)'}  ${userId}`);
  console.log('═'.repeat(78));
  console.log(
    `    ${pad('date', 12)}${pad('steps', 8)}${pad('live', 6)}${pad('archived', 10)}` +
      `${pad('restore', 12)}${pad('remove', 12)}${pad('rewrite', 14)}coins: rows → formula`,
  );

  const restoreAll = [];
  const removeAll = [];
  const rewriteAll = [];
  const createAll = [];
  let rewriteNet = 0;
  for (const a of corrected.sort((x, y) => (x.date < y.date ? -1 : 1))) {
    const live = await CoinTransaction.find({
      user: userId,
      type: 'EARNED',
      source: { $in: STEP_COIN_SOURCES },
      'metadata.date': a.date,
    }).lean();
    const archived = await CoinTransactionArchive.find({
      user: userId,
      archivedBy: 'reverseHeldSteps',
      source: { $in: STEP_COIN_SOURCES },
      'metadata.date': a.date,
    }).lean();
    const all = [...live, ...archived.map(original)];

    let refusedSyncs = [];
    let timeline = [];
    let restored = Math.max(0, (a.steps || 0) - (a.bonusSteps || 0));
    if (a.sharedHeld) {
      restored = 0;
    } else {
      const prov = await StepProvenance.findOne({ user: userId, date: a.date }).lean();
      if (!prov) continue;
      const replay = replayDay(prov);
      refusedSyncs = replay.holds.map(h => ({ at: h.at, raw: h.raw }));
      timeline = replay.timeline;
    }
    const day = {
      date: a.date,
      restoredSteps: restored,
      bonusSteps: a.bonusSteps || 0,
      goalSnapshot: a.goalSnapshot || 0,
      refusedSyncs,
    };
    const should = rowsToVoidFor(day, all);
    if (should == null) continue;
    const shouldIds = new Set(should.map(r => String(r._id)));

    const restore = archived.filter(x => !shouldIds.has(String(x.originalId)));
    const remove = live.filter(x => shouldIds.has(String(x._id)));
    restoreAll.push(...restore);
    removeAll.push(...remove);

    // The rows the day will hold once restored/removed, rewritten onto the
    // replay. Only a partially corrected day has a timeline to rewrite onto.
    const removeIds = new Set(remove.map(r => String(r._id)));
    const remaining = [...live.filter(r => !removeIds.has(String(r._id))), ...restore.map(original)];
    const { plan, create, net } = timeline.length
      ? rewritePlanFor({ live: remaining, timeline, rate, cap, userId, date: a.date })
      : { plan: [], create: [], net: 0 };
    rewriteAll.push(...plan);
    createAll.push(...create);
    rewriteNet += net;

    const rowsAfter =
      remaining
        .filter(r => String(r.source).startsWith('PASSIVE_STEPS'))
        .reduce((s, r) => {
          const p = plan.find(x => String(x._id) === String(r._id));
          return s + (p ? p.to.amount : Number(r.amount) || 0);
        }, 0) + create.reduce((s, r) => s + r.amount, 0);
    const formula = passiveCoinsForSteps(restored, rate, cap);

    console.log(
      `    ${pad(a.date, 12)}${pad(restored.toLocaleString(), 8)}${pad(live.length, 6)}` +
        `${pad(archived.length, 10)}` +
        `${pad(restore.length ? `${restore.length} (+${money(restore.reduce((s, r) => s + r.amount, 0))})` : '', 12)}` +
        `${pad(remove.length ? `${remove.length} (-${money(remove.reduce((s, r) => s + r.amount, 0))})` : '', 12)}` +
        `${pad(plan.length || create.length ? `${plan.length}${create.length ? `+${create.length}new` : ''} (${net >= 0 ? '+' : ''}${money(net)})` : '', 14)}` +
        `${money(rowsAfter)} → ${money(formula)}${Math.abs(rowsAfter - formula) > 0.0005 ? '  ✗' : ''}`,
    );
  }

  const restoreSum = restoreAll.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const removeSum = removeAll.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const netAll = restoreSum - removeSum + rewriteNet;
  console.log(
    `\n  restore ${restoreAll.length} row(s) = +${money(restoreSum)}   remove ${removeAll.length} row(s) = -${money(removeSum)}   ` +
      `rewrite ${rewriteAll.length} + create ${createAll.length} row(s) = ${rewriteNet >= 0 ? '+' : ''}${money(rewriteNet)}   net ${netAll >= 0 ? '+' : ''}${money(netAll)}`,
  );

  if (!apply) return { restoreSum, removeSum, rewriteNet };

  if (restoreAll.length) {
    const docs = restoreAll.map(original).map(({ __archive, ...doc }) => doc);
    await CoinTransaction.insertMany(docs, { ordered: false });
    await CoinTransactionArchive.deleteMany({ _id: { $in: restoreAll.map(a => a._id) } });
  }
  if (removeAll.length) {
    await voidLedgerRows({
      userId,
      rows: removeAll,
      script: 'reconcileVoidedLedger',
      reason: 'row paid for a sync the replay refuses',
    });
  }
  if (createAll.length) {
    await CoinTransaction.insertMany(createAll, { ordered: false });
  }
  if (rewriteAll.length) {
    await CoinTransaction.bulkWrite(
      rewriteAll.map(p => ({
        updateOne: {
          filter: { _id: p._id },
          update: {
            $set: {
              amount: p.to.amount,
              description: p.to.description,
              'metadata.steps': p.to.steps,
              'metadata.previousSteps': p.to.previousSteps,
              'metadata.stepDelta': p.to.stepDelta,
            },
          },
        },
      })),
      { ordered: false },
    );
  }

  const gam = await Gamification.findOne({ user: userId });
  const before = Number(gam?.coinsBalance) || 0;
  if (gam) {
    gam.coinsBalance = parseFloat(Math.max(0, before + netAll).toFixed(4));
    await gam.save();
  }
  const chain = await rechainBalances(userId);

  try {
    const admin = await User.findOne({ role: 'admin' }).select('_id').lean();
    if (admin && (restoreAll.length || removeAll.length || rewriteAll.length || createAll.length)) {
      await AdminActionLog.create({
        admin: admin._id,
        adminName: 'reconcileVoidedLedger (script)',
        targetUser: userId,
        action: netAll >= 0 ? 'COIN_CREDIT' : 'COIN_DEBIT',
        reason: 'reversal reconciled: rows matched to refused syncs, remaining rows rewritten onto the replay',
        metadata: {
          restoredRows: restoreAll.length,
          restoredCoins: parseFloat(restoreSum.toFixed(4)),
          removedRows: removeAll.length,
          removedCoins: parseFloat(removeSum.toFixed(4)),
          rewrittenRows: rewriteAll.length,
          createdRows: createAll.length,
          rewriteNet: parseFloat(rewriteNet.toFixed(4)),
          net: parseFloat(netAll.toFixed(4)),
          script: 'reconcileVoidedLedger',
        },
      });
    }
  } catch (err) {
    console.error('[reconcile] action log failed:', err.message);
  }

  console.log(
    `  ✔ applied — coins ${money(before)} → ${money(gam?.coinsBalance)}; ` +
      `balance chain rewritten on ${chain.changed} of ${chain.rows} row(s)`,
  );
  return { restoreSum, removeSum, rewriteNet };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const userArg = argValue(args, '--user');
  const all = args.includes('--all');
  const todayIST = toClientDate(new Date(), 'Asia/Kolkata');
  const to = argValue(args, '--to') || shiftDate(todayIST, 1);
  const from = argValue(args, '--from') || shiftDate(to, (Number(argValue(args, '--days')) || 28) - 1);

  if (!userArg && !all) {
    console.error('Usage: --user <email|id> | --all   [--days 28] [--apply]');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  // The same rate and caps the award used — see reverseSpoofedSteps.js.
  const cfg = await getCachedAppConfig().catch(() => null);
  const rate = cfg?.coin_config?.steps?.rate_per_100_steps ?? DEFAULT_RATE_PER_100_STEPS;
  const configCap = cfg?.coin?.dailyEarnLimit ?? DEFAULT_DAILY_EARN_LIMIT;
  const unverifiedCap = cfg?.coin?.unverifiedDailyCap;
  console.log(
    `\n${apply ? 'APPLYING' : 'DRY RUN — nothing will be written'}   ${from} → ${to}   (rate ${rate}/100 steps)`,
  );

  let userIds;
  if (userArg) {
    const user = userArg.includes('@')
      ? await User.findOne({ email: userArg }).select('_id').lean()
      : { _id: userArg };
    if (!user) {
      console.error(`No user matches "${userArg}"`);
      await mongoose.disconnect();
      process.exit(1);
    }
    userIds = [String(user._id)];
  } else {
    userIds = (await CoinTransactionArchive.distinct('user', { archivedBy: 'reverseHeldSteps' })).map(String);
  }

  for (const id of userIds) await reconcileUser(id, { from, to, apply, rate, configCap, unverifiedCap });
  if (!apply) console.log('\nNothing was written. Re-run with --apply.');
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async err => {
    console.error('reconcileVoidedLedger failed:', err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
