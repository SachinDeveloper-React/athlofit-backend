#!/usr/bin/env node
/**
 * repair-inflated-streaks.js
 *
 * Repairs streaks inflated by the backfill runaway fixed in utils/streak.js
 * (advanceStreak's forward-only guard).
 *
 * Before that fix, every seven-day backfill batch — posted by the Android
 * WidgetUpdateWorker every 15 minutes and by the JS background fetch — reopened
 * at `today - 6` while the cursor already sat on `today`. That read as a gap, an
 * active freeze protected it for free, and the six days that followed in the same
 * batch each added +1. Roughly +6 per batch, ~96 batches a day. One account
 * reached 1,057 days on an app nowhere near that old. The code no longer does
 * this; the numbers already written to the database do not fix themselves.
 *
 * Policy, deliberately conservative:
 *
 *   • The truth is recomputed from HealthActivity — the same goal-met days the
 *     app shows the user on the calendar. A streak is a run of consecutive
 *     goal-met dates, so that is what it is recounted as.
 *   • A stored value is only ever LOWERED, never raised. If a user's stored
 *     streak is already at or below what the records support, they are left
 *     completely alone.
 *   • Freeze- and life-protected gaps are not reconstructible from the records,
 *     so a user who was legitimately protected can lose those grace days here.
 *     That is the cost of using only evidence that exists; it is bounded by the
 *     protection caps (2 freezes, 2 lives) and is the conservative direction.
 *   • A claimed badge is never revoked — the coins are already spent. Badges
 *     unlocked above the corrected best streak are cleared only while unclaimed,
 *     and anything claimed-but-unearned is printed for a human to decide on.
 *
 * Dry run by default; nothing is written without --apply.
 *
 *   node scripts/repair-inflated-streaks.js                     # report on everyone
 *   node scripts/repair-inflated-streaks.js --user a@b.com      # report on one user
 *   node scripts/repair-inflated-streaks.js --apply             # write the fixes
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User.model');
const HealthActivity = require('../src/models/HealthActivity.model');
const Gamification = require('../src/models/Gamification.model');
const BadgeDefinition = require('../src/models/BadgeDefinition.model');
const {
  todayISO,
  daysBetween,
  isConsecutiveDay,
} = require('../src/utils/date');

// ─── Args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const userArg = (() => {
  const i = argv.indexOf('--user');
  return i !== -1 ? argv[i + 1] : null;
})();

/**
 * Recount the streak from a user's goal-met dates.
 *
 * @param {string[]} dates Goal-met "YYYY-MM-DD" dates, ascending, deduplicated.
 * @returns {{currentRun: number, longestRun: number, lastDate: string|null}}
 *   `currentRun` is the run ending on the most recent goal-met date.
 */
function recount(dates) {
  if (dates.length === 0)
    return { currentRun: 0, longestRun: 0, lastDate: null };

  let run = 1;
  let longest = 1;
  for (let i = 1; i < dates.length; i++) {
    run = isConsecutiveDay(dates[i - 1], dates[i]) ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  return {
    currentRun: run,
    longestRun: longest,
    lastDate: dates[dates.length - 1],
  };
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(
    `✅ Connected to MongoDB — ${
      APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'
    }\n`,
  );

  const today = todayISO();
  const badgeDefs = await BadgeDefinition.find({})
    .sort({ threshold: 1 })
    .lean();

  // ── Which gamification docs to walk ──────────────────────────────────────
  let filter = {};
  if (userArg) {
    const user = await User.findOne({
      $or: [
        { email: userArg },
        { _id: mongoose.Types.ObjectId.isValid(userArg) ? userArg : null },
      ],
    });
    if (!user) {
      console.error(`❌ User not found: ${userArg}`);
      process.exit(1);
    }
    filter = { user: user._id };
  }

  let scanned = 0;
  let repaired = 0;
  let badgesCleared = 0;
  const claimedButUnearned = [];

  const cursor = Gamification.find(filter).cursor();

  for (let gam = await cursor.next(); gam != null; gam = await cursor.next()) {
    scanned++;

    const user = await User.findById(gam.user)
      .select('email fullName createdAt')
      .lean();

    // Every goal-met day on record, ascending. The unique {user, date} index
    // means these are already one row per day, but dedupe defensively.
    const rows = await HealthActivity.find({ user: gam.user, goalMet: true })
      .select('date')
      .sort({ date: 1 })
      .lean();
    const dates = [...new Set(rows.map(r => r.date))].sort();

    const { currentRun, longestRun, lastDate } = recount(dates);

    // A streak can never be older than the account itself. Kept as a second,
    // independent ceiling: it catches an inflated value even for a user whose
    // HealthActivity rows were pruned or never written.
    const accountAgeDays = user?.createdAt
      ? (daysBetween(
          new Date(user.createdAt).toISOString().slice(0, 10),
          today,
        ) ?? 0) + 1
      : Infinity;

    const storedStreak = gam.streakDays || 0;
    const storedBest = gam.bestStreakDays || 0;

    // Only ever lower.
    const newStreak = Math.min(storedStreak, currentRun, accountAgeDays);
    const newBest = Math.min(
      storedBest,
      Math.max(longestRun, newStreak),
      accountAgeDays,
    );
    // The cursor must not sit ahead of the last day actually earned.
    const newLastActive =
      lastDate && gam.lastActiveDate && gam.lastActiveDate > lastDate
        ? lastDate
        : gam.lastActiveDate;

    const streakChanged = newStreak !== storedStreak || newBest !== storedBest;
    const cursorChanged = newLastActive !== gam.lastActiveDate;

    // Badges above the corrected best streak were never actually earned.
    const overreached = badgeDefs.filter(def => def.threshold > newBest);
    const toClear = [];
    for (const def of overreached) {
      const entry = (gam.badgeList || []).find(b => b.key === def.key);
      if (!entry || !entry.unlocked) continue;
      if (entry.coinsClaimed) {
        claimedButUnearned.push({
          email: user?.email || String(gam.user),
          badge: def.key,
          threshold: def.threshold,
          coins: def.coinReward,
        });
        continue; // paid out — a human decides, this script does not claw back
      }
      toClear.push({ def, entry });
    }

    if (!streakChanged && !cursorChanged && toClear.length === 0) continue;

    repaired++;
    console.log('───────────────────────────────────────────────────────────');
    console.log(
      `👤 ${user?.email || gam.user} ${
        user?.fullName ? `(${user.fullName})` : ''
      }`,
    );
    console.log(
      `   account created : ${
        user?.createdAt
          ? new Date(user.createdAt).toISOString().slice(0, 10)
          : 'unknown'
      } (${accountAgeDays === Infinity ? '?' : accountAgeDays} days old)`,
    );
    console.log(
      `   goal-met days   : ${dates.length} recorded, last ${
        lastDate || 'never'
      }`,
    );
    console.log(
      `   streak          : ${storedStreak} → ${newStreak}   (records support ${currentRun})`,
    );
    console.log(
      `   best streak     : ${storedBest} → ${newBest}   (longest run on record ${longestRun})`,
    );
    if (cursorChanged) {
      console.log(
        `   lastActiveDate  : ${gam.lastActiveDate} → ${newLastActive}`,
      );
    }
    for (const { def } of toClear) {
      console.log(
        `   badge cleared   : ${def.key} (needs ${def.threshold} days, unclaimed)`,
      );
    }

    if (!APPLY) continue;

    gam.streakDays = newStreak;
    gam.bestStreakDays = newBest;
    gam.lastActiveDate = newLastActive;
    // Freeze grants are tracked against the streak value; leaving it inflated
    // would stop the user earning freezes again on the corrected streak.
    gam.lastFreezeGrantStreak = Math.min(
      gam.lastFreezeGrantStreak || 0,
      newStreak,
    );
    for (const { entry } of toClear) {
      entry.unlocked = false;
      entry.unlockedAt = null;
      entry.payoutEligible = false;
      badgesCleared++;
    }
    await gam.save();
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Scanned  : ${scanned} account(s)`);
  console.log(
    `Repaired : ${repaired} account(s)${
      APPLY ? '' : ' (dry run — nothing written)'
    }`,
  );
  if (APPLY) console.log(`Badges cleared: ${badgesCleared}`);
  if (claimedButUnearned.length) {
    console.log(
      '\n⚠️  Claimed badges above the corrected best streak — NOT touched:',
    );
    for (const c of claimedButUnearned) {
      console.log(
        `   ${c.email} — ${c.badge} (${c.threshold}d, ${c.coins} coins already paid)`,
      );
    }
  }
  if (!APPLY && repaired > 0) {
    console.log('\nRe-run with --apply to write these changes.');
  }

  await mongoose.disconnect();
}

main().catch(async err => {
  console.error('❌ Repair failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
