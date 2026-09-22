#!/usr/bin/env node
// src/scripts/voidCoinTransactions.js
//
// ─── Removing specific coin entries from one account ────────────────────────
//
// The step-reversal tools decide WHICH days were wrong and undo them. This is
// the smaller tool for the case where the admin already knows which entries
// were wrong: a bonus paid while its config said 0, a reward claimed through a
// bug, a source that should never have paid. It selects EARNED rows on one
// account by source (and optionally reward id and date), and removes them the
// way a reversal does — copied to CoinTransactionArchive, deleted from the
// ledger, the balance lowered by exactly their sum, the day's goal
// notification removed for a step-goal bonus, and an entry in the account's
// admin action log. See the note at ledgerRowsToVoid in reverseSpoofedSteps.js
// for why removal rather than a DEDUCTED row.
//
// The first use: one account claimed the daily step-goal bonus six evenings
// running while `rewards.stepGoalCoins` was 0 — the claim endpoint read the
// other, stale config field (see utils/stepGoalAward.js).
//
// Dry-run by default. --apply is a separate step, after reading the list.
//
// Usage:
//     node src/scripts/voidCoinTransactions.js --user <email|id> --source DAILY_STEP_GOAL
//     node src/scripts/voidCoinTransactions.js --user <email|id> --source DAILY_STEP_GOAL \
//         --reward-id steps_daily --from 2026-09-01 --to 2026-09-21 \
//         --reason "step-goal bonus claimed while configured at 0" --apply

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User.model');
const Gamification = require('../models/Gamification.model');
const CoinTransaction = require('../models/CoinTransaction.model');
const Notification = require('../models/Notification.model');
const AdminActionLog = require('../models/AdminActionLog.model');
const { voidLedgerRows, dayWindowMs } = require('./reverseSpoofedSteps');
const { rechainBalances } = require('../utils/coinLedger');

const money = v => Number(v || 0).toFixed(2);
const pad = (v, w) => String(v ?? '').padEnd(w).slice(0, w);

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const userArg = argValue(args, '--user');
  const source = argValue(args, '--source');
  const rewardId = argValue(args, '--reward-id');
  const from = argValue(args, '--from');
  const to = argValue(args, '--to');
  const reason = argValue(args, '--reason') || `entries removed by admin (${source})`;
  const timezone = argValue(args, '--timezone') || 'Asia/Kolkata';

  if (!userArg || !source) {
    console.error('Usage: --user <email|id> --source <SOURCE> [--reward-id id] [--from d] [--to d] [--reason "..."] [--apply]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const user = userArg.includes('@')
    ? await User.findOne({ email: userArg }).select('_id email').lean()
    : await User.findById(userArg).select('_id email').lean();
  if (!user) {
    console.error(`No user matches "${userArg}"`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const filter = { user: user._id, type: 'EARNED', source };
  if (rewardId) filter['metadata.rewardId'] = rewardId;
  if (from || to) {
    filter['metadata.date'] = {};
    if (from) filter['metadata.date'].$gte = from;
    if (to) filter['metadata.date'].$lte = to;
  }
  const rows = await CoinTransaction.find(filter).sort({ createdAt: 1 }).lean();
  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  console.log(
    `\n${apply ? 'APPLYING' : 'DRY RUN — nothing will be written'}   ` +
      `${user.email}  ${user._id}\n  source ${source}` +
      (rewardId ? `  reward ${rewardId}` : '') +
      (from || to ? `  dates ${from || '…'} → ${to || '…'}` : '') +
      `\n  reason: ${reason}\n`,
  );
  console.log(`    ${pad('written', 22)}${pad('date', 12)}${pad('amount', 9)}description`);
  for (const r of rows) {
    console.log(
      `    ${pad(new Date(r.createdAt).toISOString().slice(0, 19), 22)}` +
        `${pad(r.metadata?.date || '', 12)}${pad(money(r.amount), 9)}${r.description}`,
    );
  }
  console.log(`\n  ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}, ${money(total)} coins`);

  if (!rows.length) {
    console.log('  Nothing to remove.');
    await mongoose.disconnect();
    return;
  }

  if (!apply) {
    console.log('\nNothing was written. Re-run with --apply.');
    await mongoose.disconnect();
    return;
  }

  const removed = await voidLedgerRows({
    userId: user._id,
    rows,
    script: 'voidCoinTransactions',
    reason,
  });

  const gam = await Gamification.findOne({ user: user._id });
  const before = Number(gam?.coinsBalance) || 0;
  const applied = Math.min(before, removed);
  if (gam) {
    gam.coinsBalance = parseFloat((before - applied).toFixed(4));
    await gam.save();
  }
  await rechainBalances(user._id);

  // A step-goal bonus announced itself; take the announcement with it.
  let notifications = 0;
  if (String(source).startsWith('DAILY_STEP_GOAL')) {
    const or = rows
      .map(r => r.metadata?.date && dayWindowMs(r.metadata.date, timezone))
      .filter(Boolean)
      .map(win => ({
        type: { $in: ['GOAL', 'COIN'] },
        title: /step goal|daily goal/i,
        createdAt: { $gte: new Date(win.start), $lt: new Date(win.end) },
      }));
    if (or.length) {
      const res = await Notification.deleteMany({ user: user._id, $or: or });
      notifications = res.deletedCount || 0;
    }
  }

  try {
    const admin = await User.findOne({ role: 'admin' }).select('_id').lean();
    if (admin) {
      await AdminActionLog.create({
        admin: admin._id,
        adminName: 'voidCoinTransactions (script)',
        targetUser: user._id,
        action: 'COIN_DEBIT',
        reason,
        metadata: {
          source,
          rewardId: rewardId || null,
          dates: rows.map(r => r.metadata?.date).filter(Boolean),
          removedRows: rows.length,
          removedNotifications: notifications,
          coinsRemoved: parseFloat(applied.toFixed(4)),
          script: 'voidCoinTransactions',
        },
      });
    }
  } catch (err) {
    console.error('[voidCoinTransactions] action log failed:', err.message);
  }

  console.log(
    `\n  ✔ applied — ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} archived and removed; ` +
      `coins ${money(before)} → ${money(gam?.coinsBalance)}` +
      (applied < removed ? ` (${money(removed - applied)} short — balance cannot go below zero)` : '') +
      `; ${notifications} notification(s) removed`,
  );
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async err => {
    console.error('voidCoinTransactions failed:', err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
