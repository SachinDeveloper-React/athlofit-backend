#!/usr/bin/env node
// src/scripts/backfillUnpaidStepCoins.js
//
// ─── Pay passive step coins that were earned and never credited ─────────────
//
// Written for the regression in db317c3, fixed in e7c0200: the live sync's
// compare-and-swap matched `coinsEarnedToday` with a bare equality, which does
// not match a document that never had the field written. The award was skipped
// silently — the sync returned 200, the steps stored, the coins did not move.
//
// ── Why this cannot double-pay ──────────────────────────────────────────────
//
// It does not assume anything about what the bug did or did not pay. It asks
// the same question the system asks: for each day, how many of its steps have
// already been paid for? That is `HealthActivity.stepCoinWatermark`, which
// BOTH writers mirror to — the live sync and the 3-hourly cron. Owed is the
// difference between what the day is worth and what the watermark says was
// already settled, which is zero for every day already paid.
//
// This matters more than it sounds. The cron never had the bug — its filter
// guards the step watermark only — so it ran every three hours and recovered
// most of what the live sync skipped, just late. A backfill that assumed the
// coins were missing would have paid them a second time.
//
// The claim is the same conditional `$max` the retro path in
// health.controller.js uses, so the script is idempotent, safe to re-run, and
// safe to run twice at once: the watermark moves exactly once per day's worth
// of steps, before any coins move.
//
// ── Usage ───────────────────────────────────────────────────────────────────
//
//     node src/scripts/backfillUnpaidStepCoins.js                  # dry run, last 7 days
//     node src/scripts/backfillUnpaidStepCoins.js --days=14        # dry run, wider
//     node src/scripts/backfillUnpaidStepCoins.js --user=<id|email>
//     node src/scripts/backfillUnpaidStepCoins.js --commit         # actually pay
//
// Dry run by default, and it prints exactly what it would pay. Read that first.

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User.model');
const HealthActivity = require('../models/HealthActivity.model');
const Gamification = require('../models/Gamification.model');
const AppConfig = require('../models/AppConfig.model');
const { computePassiveCoinDelta } = require('../utils/passiveCoins');
const { getEffectiveDailyCap } = require('../utils/dailyCoinCap');
const { isCoinBlocked } = require('../utils/cheatPenalty');
const { isStepsTrackingEnabled } = require('../utils/stepsTracking');
const { isStepCoinSettlementEnabled } = require('../utils/stepCoinSettlement');
const { logCoinTransaction } = require('../utils/logCoinTransaction');
const { todayISO } = require('../utils/date');
const { shiftDate } = require('../utils/stepBaselineStore');
const {
  DEFAULT_RATE_PER_100_STEPS,
  DEFAULT_DAILY_EARN_LIMIT,
  DEFAULT_MAX_DAILY_REWARDS,
} = require('../constants/coinDefaults');

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const money = (n) => Number(n).toFixed(4).replace(/\.?0+$/, '');

async function main() {
  const commit = flag('commit');
  const days = Math.min(90, Math.max(1, parseInt(arg('days', '7'), 10) || 7));
  const only = arg('user');

  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set — refusing to guess a database.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });

  const to = todayISO();
  const from = shiftDate(to, days - 1);

  const cfg = (await AppConfig.findOne({ key: 'global' }).lean()) || {};
  const rate = cfg.coin_config?.steps?.rate_per_100_steps ?? DEFAULT_RATE_PER_100_STEPS;
  const dailyEarnLimitCfg = cfg.coin?.dailyEarnLimit ?? DEFAULT_DAILY_EARN_LIMIT;
  const maxDailyRewardsCfg = cfg.coin?.maxDailyRewards ?? DEFAULT_MAX_DAILY_REWARDS;

  console.log(`\n${commit ? '⚠️  COMMIT MODE — coins will be credited' : 'DRY RUN — nothing will be written'}`);
  console.log(`range ${from} → ${to}   rate ${rate}/100 steps   stepCap ${dailyEarnLimitCfg}   dayCap ${maxDailyRewardsCfg}`);

  // Settlement changes what "paid" means: with it on, step coins are recorded
  // as pending and verified after the day ends. Crediting a balance directly
  // here would route around that verification, so it needs saying out loud.
  if (isStepCoinSettlementEnabled(cfg)) {
    console.log(
      '\n⚠️  features.stepCoinSettlement is ON. This script credits the balance\n' +
        '    directly, bypassing day-end verification. Only proceed for days you\n' +
        '    are satisfied were genuine.',
    );
    if (commit && !flag('bypass-settlement')) {
      console.log('    Refusing. Re-run with --bypass-settlement to override.\n');
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  // Candidate days: any day in range whose steps exceed what was paid for.
  // `$expr` rather than a fixed number, because the comparison is between two
  // fields of the same document. Missing watermark is treated as 0 — those are
  // documents written before the field existed, which is exactly the
  // population most likely to be owed something.
  const match = {
    date: { $gte: from, $lte: to },
    steps: { $gt: 0 },
    $expr: {
      $gt: [
        { $subtract: ['$steps', { $ifNull: ['$bonusSteps', 0] }] },
        { $ifNull: ['$stepCoinWatermark', 0] },
      ],
    },
  };

  if (only) {
    const u = mongoose.isValidObjectId(only)
      ? await User.findById(only).select('_id').lean()
      : await User.findOne({ email: String(only).toLowerCase().trim() }).select('_id').lean();
    if (!u) {
      console.error(`No user matched ${only}`);
      await mongoose.disconnect();
      process.exit(1);
    }
    match.user = u._id;
  }

  const rows = await HealthActivity.find(match)
    .select('user date steps bonusSteps stepCoinWatermark')
    .sort({ user: 1, date: 1 })
    .lean();

  if (!rows.length) {
    console.log('\nNothing owed in this range. (The 3-hourly cron recovers most gaps on its own.)\n');
    await mongoose.disconnect();
    return;
  }

  // Batch-load the users these days belong to, for the per-user gates and the
  // verified/unverified cap.
  const userIds = [...new Set(rows.map((r) => String(r.user)))];
  const users = await User.find({ _id: { $in: userIds } })
    .select('_id email emailVerified coinBlockedUntil stepsTracking')
    .lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  let paidTotal = 0;
  let paidDays = 0;
  const skips = { blocked: 0, stepsPaused: 0, noUser: 0, nothingOwed: 0, raceLost: 0 };
  const perUser = new Map();

  for (const row of rows) {
    const uid = String(row.user);
    const user = userMap.get(uid);
    if (!user) { skips.noUser++; continue; }
    if (isCoinBlocked(user).isBlocked) { skips.blocked++; continue; }
    if (!isStepsTrackingEnabled(user)) { skips.stepsPaused++; continue; }

    // Walked steps only. Bonus steps are admin-credited and never earned
    // passive coins — the same rule both live writers apply.
    const walked = Math.max(0, (row.steps || 0) - (row.bonusSteps || 0));
    const watermark = Math.max(0, row.stepCoinWatermark || 0);

    const stepCap = getEffectiveDailyCap(user, dailyEarnLimitCfg, cfg.coin?.unverifiedDailyCap);
    const dayCap = getEffectiveDailyCap(user, maxDailyRewardsCfg, cfg.coin?.unverifiedDailyCap);

    const { coins: owedByStepCap } = computePassiveCoinDelta({
      currentSteps: walked,
      watermark,
      rate,
      dailyEarnLimit: stepCap,
    });

    // The overall ceiling applies to a past day too, but it cannot be charged
    // against `coinsEarnedToday` — that counter is TODAY's. The date's own
    // step earnings are reconstructed instead, exactly as the retro path in
    // health.controller.js does for the same reason.
    const alreadyThisDay = computePassiveCoinDelta({
      currentSteps: watermark,
      watermark: 0,
      rate,
      dailyEarnLimit: stepCap,
    }).coins;
    const dayRoom = Math.max(0, dayCap - alreadyThisDay);
    const owed = parseFloat(Math.min(owedByStepCap, dayRoom).toFixed(4));

    if (owed <= 0) { skips.nothingOwed++; continue; }

    if (!commit) {
      paidTotal += owed;
      paidDays++;
      const e = perUser.get(uid) || { email: user.email, coins: 0, days: 0 };
      e.coins += owed;
      e.days++;
      perUser.set(uid, e);
      continue;
    }

    // Claim the steps BEFORE paying for them, conditionally. If another writer
    // (the cron, a live sync, a second copy of this script) moved the
    // watermark first, this matches nothing and the day is left alone — the
    // same ordering the retro path uses, so a crash mid-run cannot double-pay.
    const claim = await HealthActivity.findOneAndUpdate(
      {
        user: row.user,
        date: row.date,
        $or: [
          { stepCoinWatermark: { $lt: walked } },
          { stepCoinWatermark: null },
          { stepCoinWatermark: { $exists: false } },
        ],
      },
      { $max: { stepCoinWatermark: walked } },
      { new: false },
    );
    if (!claim) { skips.raceLost++; continue; }

    // Re-derive from the PRE-image: between the scan and the claim another
    // writer may have paid part of this day, and paying the scan's figure
    // would pay that part twice.
    const claimedFrom = Math.max(0, claim.stepCoinWatermark || 0);
    const { coins: finalOwed } = computePassiveCoinDelta({
      currentSteps: walked,
      watermark: claimedFrom,
      rate,
      dailyEarnLimit: stepCap,
    });
    const payable = parseFloat(Math.min(finalOwed, dayRoom).toFixed(4));
    if (payable <= 0) { skips.nothingOwed++; continue; }

    const updated = await Gamification.findOneAndUpdate(
      { user: row.user },
      { $inc: { coinsBalance: payable } },
      { new: true, upsert: true },
    );

    await logCoinTransaction({
      userId: row.user,
      type: 'EARNED',
      amount: payable,
      balanceAfter: updated.coinsBalance,
      source: 'PASSIVE_STEPS_RETRO',
      description:
        `Auto Step Coins — backfill for ${row.date} ` +
        `(${claimedFrom.toLocaleString()} → ${walked.toLocaleString()} steps)`,
      metadata: {
        date: row.date,
        steps: walked,
        previousSteps: claimedFrom,
        trigger: 'backfill_unpaid_step_coins',
      },
    });

    paidTotal += payable;
    paidDays++;
    const e = perUser.get(uid) || { email: user.email, coins: 0, days: 0 };
    e.coins += payable;
    e.days++;
    perUser.set(uid, e);
  }

  const ranked = [...perUser.values()].sort((a, b) => b.coins - a.coins);
  console.log(`\n${commit ? 'PAID' : 'WOULD PAY'}: ${money(paidTotal)} coins across ${paidDays} day(s), ${ranked.length} user(s)\n`);

  for (const u of ranked.slice(0, 25)) {
    console.log(`  ${String(u.email || '').padEnd(34)} ${money(u.coins).padStart(10)} coins   ${u.days} day(s)`);
  }
  if (ranked.length > 25) console.log(`  … and ${ranked.length - 25} more`);

  console.log(
    `\nskipped — blocked:${skips.blocked} stepsPaused:${skips.stepsPaused} ` +
      `nothingOwed:${skips.nothingOwed} raceLost:${skips.raceLost} noUser:${skips.noUser}`,
  );
  if (!commit) console.log('\nRe-run with --commit to credit these.\n');
  else console.log('');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
