const HealthActivity = require('../models/HealthActivity.model');
const BmiRecord      = require('../models/BmiRecord.model');
const Gamification   = require('../models/Gamification.model');
const User           = require('../models/User.model');
const Challenge      = require('../models/Challenge.model');
const UserChallenge  = require('../models/UserChallenge.model');
const { success, error } = require('../utils/response');
const { buildDateRange, toDayLabel, toDateWithDayLabel, todayISO, isConsecutiveDay, resolveClientDate, isValidISODate, toClientDate } = require('../utils/date');
const { syncChallengeProgress } = require('./challenge.controller');
const { sendPushToUser } = require('../utils/pushNotification');
const { createNotification } = require('../utils/createNotification');
const { logCoinTransaction } = require('../utils/logCoinTransaction');
const { validateSteps } = require('../utils/stepValidation');
const { getCachedAppConfig } = require('../utils/appConfigCache');
const { checkTimezoneManipulation } = require('../utils/timezoneGuard');
const { recordCheatFlag, isCoinBlocked } = require('../utils/cheatPenalty');
const { computePassiveCoinDelta } = require('../utils/passiveCoins');
const { resolveGoalMet } = require('../utils/goalMet');

// ─── Unverified user daily coin cap ──────────────────────────────────────────
function getEffectiveDailyCap(user, configMax, unverifiedCap) {
  const isVerified = user.emailVerified;
  if (!isVerified) {
    const cap = unverifiedCap ?? 50;
    return Math.min(cap, configMax);
  }
  return configMax;
}

// ─── GET /health/weekly-steps?from=YYYY-MM-DD&to=YYYY-MM-DD ──────────────────
const getWeeklySteps = async (req, res, next) => {
  try {
    const { from, to } = req.query;

    if (!from || !to) {
      return error(res, 'from and to query params are required', 400);
    }

    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
      return error(res, 'from and to must be valid ISO date strings (YYYY-MM-DD)', 400);
    }

    // Build expected date range (fills gaps with 0)
    const dates = buildDateRange(from, to);

    // Query DB for records in range
    const records = await HealthActivity.find({
      user: req.user._id,
      date: { $gte: from, $lte: to },
    }).select('date steps bonusSteps goalSnapshot');

    // Map to lookup
    const recordMap = {};
    records.forEach(r => { recordMap[r.date] = { steps: r.steps, bonusSteps: r.bonusSteps || 0, goalSnapshot: r.goalSnapshot }; });

    // Build response matching WeeklyStepEntry[] in app
    const data = dates.map(date => ({
      date: toDateWithDayLabel(date),       // "10 (Fri)", "11 (Sat)" etc.
      fullDate: date,
      steps: recordMap[date]?.steps ?? 0,
      bonusSteps: recordMap[date]?.bonusSteps ?? 0,
      // Use the goal that was active on that day; fall back to current goal
      // for days that have no record yet (future/unsynced days).
      goalSnapshot: recordMap[date]?.goalSnapshot || req.user.dailyStepGoal || 10000,
    }));

    return success(res, 'Weekly steps fetched', data);
  } catch (err) {
    next(err);
  }
};

// ─── POST /health/sync ────────────────────────────────────────────────────────
// Mobile app can push a daily snapshot at any time; upserts by date
const syncHealthData = async (req, res, next) => {
  try {
    const {
      date,
      steps,
      distance,
      calories,
      activeMinutes,
      heartRate,
      heartRateMin,
      heartRateMax,
      bloodPressureSystolic,
      bloodPressureDiastolic,
      hydration,
      sleepHours,
      bloodGlucose,
      weight,
      goalMet,
      timezone, // FIX #3: Client sends timezone (e.g., "Asia/Kolkata" or offset like "+05:30")
      // Set by the client when the figure it is sending is materially LOWER than
      // what it itself last sent today — i.e. it detected and fixed its own
      // over-count. Lets validateSteps accept the decrease instead of raising it
      // back to the stored high-water mark. See stepValidation.js Rule 3.
      stepsCorrection,
    } = req.body;

    // FIX #3: Use client timezone for "today" calculation when available.
    // This ensures coins are awarded based on the user's local day, not server time.
    //
    // `date` decides which document this write lands on, so it is validated
    // rather than trusted. It used to be taken verbatim: any string at all became
    // a document key under the unique {user, date} index, so a malformed value
    // silently created a junk row that no reader would ever match. The sibling
    // admin route and GET /health/weekly-steps both already validate this format.
    if (date !== undefined && date !== null && !isValidISODate(date)) {
      return error(res, 'Invalid date — expected YYYY-MM-DD', 400);
    }
    const today = date || resolveClientDate(timezone);

    // ── Apply pending step goal if effective date has arrived ─────────────────
    // When a user changes their goal, it's stored as pending and only becomes
    // the active dailyStepGoal on or after the effective date.
    if (
      req.user.pendingStepGoal &&
      req.user.pendingGoalEffectiveDate &&
      today >= req.user.pendingGoalEffectiveDate
    ) {
      await User.findByIdAndUpdate(req.user._id, {
        $set: { dailyStepGoal: req.user.pendingStepGoal },
        $unset: { pendingStepGoal: 1, pendingGoalEffectiveDate: 1 },
      });
      // Use the newly applied goal for today's sync
      req.user.dailyStepGoal = req.user.pendingStepGoal;
      req.user.pendingStepGoal = null;
      req.user.pendingGoalEffectiveDate = null;
    }

    // ── Guard: reject syncs for dates before the user's account was created ──
    // This prevents historical Health Connect / HealthKit data from leaking
    // into a newly created account (the background sync always pushes yesterday,
    // but yesterday might pre-date the account).
    // Resolved in the SAME timezone as `today`, so the two are comparable.
    //
    // This was `.toISOString().slice(0, 10)` — the UTC day — compared against a
    // client-local `today`. Mixing the two breaks the guard in both directions,
    // depending on which side of UTC the user is:
    //
    //  - East of UTC (e.g. IST): the UTC day can still be yesterday, so the guard
    //    reads a signup date EARLIER than the real one and lets a sync for the day
    //    before signup through — the pre-account data leak it exists to stop.
    //  - West of UTC (e.g. the Americas): the UTC day can already be tomorrow, so
    //    the guard reads a signup date LATER than the real one and rejects the
    //    user's genuine first-day sync as "before account creation".
    const accountCreatedDate = req.user.createdAt
      ? toClientDate(req.user.createdAt, timezone)
      : null;
    if (accountCreatedDate && today < accountCreatedDate) {
      return success(res, 'Skipped — date is before account creation', {
        skipped: true,
      });
    }

    const dailyGoal = req.user.dailyStepGoal || 10000;

    // ── FIX #2: Server-side step validation / anti-cheat ─────────────────────
    // Validate the incoming step count against rate-of-change limits and
    // previous known values. Flags or rejects suspicious submissions.
    const existing = await HealthActivity.findOne({ user: req.user._id, date: today });

    // ── Removed: the fresh-account stale-sync guard ──────────────────────────
    //
    // It rejected a background sync outright when the account was under an hour old
    // and reported more than max(2000, accountAgeMinutes * 180) steps. It has been
    // deleted rather than restored, for three reasons:
    //
    //  1. It threw real data away. Someone who installs the app at 18:00 having
    //     already walked 8,000 steps has a five-minute-old account and an allowance
    //     of 2,000, so their genuine first sync was discarded entirely — showing 0
    //     steps on day one, which is the worst possible first impression.
    //  2. It contradicted the rest of the system. Every reader here deliberately
    //     counts from local midnight (see HealthSyncHelper: "Always read from
    //     startOfDay"), so steps walked earlier today are the user's steps whether
    //     or not the app was installed when they walked them.
    //  3. What it was actually for is already covered, and covered better. Data from
    //     previous DAYS is stopped by the account-creation guard above, and an
    //     implausible same-day total is bounded by the first-accepted-value ceiling
    //     in stepValidation, which reasons from elapsed time rather than from how
    //     recently the account was created.
    //
    // Deleting dead code that we have decided against beats leaving it commented
    // out; git history keeps the original if it is ever wanted back.

    const stepValidation = validateSteps({
      incomingSteps: steps,
      existingSteps: existing?.steps || 0,
      bonusSteps: existing?.bonusSteps || 0,
      // The rate window is measured from the last ACCEPTED step increase, not from
      // updatedAt. updatedAt is bumped by any write to this row — a hydration-only
      // sync included — which both punished honest users and let a client reset the
      // window on demand by syncing more often. See stepValidation.js.
      lastStepIncreaseAt: existing?.lastStepIncreaseAt || null,
      timezone,
      // The date this sync is writing to, which is not necessarily today — the
      // Android widget worker re-posts the last seven days every 15 minutes. The
      // first-accepted-value ceiling needs it to bound a past date by the whole
      // day instead of by however many minutes of TODAY have elapsed.
      syncDate: today,
      dailyGoal,
      allowCorrection: stepsCorrection === true,
    });

    // Use the clamped (safe) step value instead of raw client input
    const validatedSteps = stepValidation.clampedSteps;

    // Corrections are rare and only ever reduce the stored count, so they are worth
    // a log line: a burst of them points at a client still over-reporting.
    if (stepValidation.corrected) {
      console.warn(
        `[HealthSync] Step correction accepted for user ${req.user._id} on ${today}: ` +
        `${stepValidation.correctedFrom} → ${validatedSteps}`
      );
    }

    // NOTE: there used to be a second, walked-only goal flag here
    // (`isGoalMet = goalMet ?? validatedSteps >= dailyGoal`) that gated the coin
    // award while `totalGoalMet` below drove everything else. Having two
    // definitions of "goal met" is what let the two disagree; there is now only
    // `totalGoalMet`, computed once bonus steps are known.

    // ── Merge strategy: only overwrite a field if the incoming value is
    // meaningful (> 0). This prevents a background sync that only has steps
    // from zeroing out vitals (HR, BP, glucose, weight) that were recorded
    // manually or by a different source earlier in the day.

    const merge = (incoming, stored) =>
      (incoming !== undefined && incoming !== null && incoming > 0)
        ? incoming
        : (stored ?? 0);

    // Hydration supports explicit reset to 0 — unlike other fields where 0
    // means "no data from device this sync cycle", hydration 0 is a deliberate
    // user action (undo/reset). So we bypass the merge guard for it.
    const resolveHydration = (incoming, stored) =>
      (incoming !== undefined && incoming !== null && incoming === 0)
        ? 0 // explicit reset
        : merge(incoming, stored);

    // Preserve bonus steps — the device only knows about walked steps, so
    // total = device steps + bonus steps credited by admin/system.
    //
    // MULTI-DEVICE: walked steps never regress within a day unless the client
    // explicitly asked to repair its own over-count. If device A synced 5,000 and
    // device B then reports 3,000, the server keeps 5,000 — B is simply behind.
    // Passive coins do not re-award, because the watermark is already at 5,000.
    //
    // This used to read `merge(validatedSteps, previousWalked)` under a comment
    // claiming merge() "picks max(incoming, existing-bonus)". It does not — merge()
    // is `incoming > 0 ? incoming : stored`, which takes ANY non-zero incoming
    // value, including a lower one. The no-regression property was real, but it
    // came from validateSteps() having already raised a too-low figure back to
    // existingWalked in a different file, so the guarantee this line depends on was
    // neither stated nor visible here. Anything that touched Rule 3's correction
    // logic would have silently turned this into a downgrade path.
    //
    // Stating it directly instead: take the higher value, except when the client
    // flagged a correction, which is the one case a decrease is intended. Same
    // behaviour as before for every input, but the invariant now lives where it is
    // relied upon rather than two files away.
    const bonusSteps = existing?.bonusSteps || 0;
    const previousWalked = Math.max(0, (existing?.steps || 0) - bonusSteps);
    const deviceSteps = stepValidation.corrected
      ? validatedSteps                                // deliberate downward repair
      : Math.max(validatedSteps, previousWalked);     // never regress
    const totalSteps = deviceSteps + bonusSteps;

    // Opens the next rate window only when walked steps actually moved up. A
    // hydration-only sync, a vitals-only sync, or a re-send of the same count all
    // leave it alone, so they cannot shrink the window a later real sync is
    // measured against.
    const stepsIncreased = deviceSteps > previousWalked;

    // Re-evaluate goal met with total steps (walked + bonus).
    const totalGoalMet = resolveGoalMet({
      totalSteps,
      dailyGoal,
      clientGoalMet: goalMet,
    });

    const updateFields = {
      // Steps = walked (from device) + bonus (from admin/system)
      steps:                  totalSteps,
      bonusSteps:             bonusSteps, // preserve, don't overwrite
      distance:               merge(distance,               existing?.distance),
      calories:               merge(calories,               existing?.calories),
      activeMinutes:          merge(activeMinutes,          existing?.activeMinutes),
      // Vitals — keep existing value if incoming is 0 (device may not have
      // a reading for this sync cycle)
      heartRate:              merge(heartRate,              existing?.heartRate),
      heartRateMin:           merge(heartRateMin,           existing?.heartRateMin),
      heartRateMax:           merge(heartRateMax,           existing?.heartRateMax),
      bloodPressureSystolic:  merge(bloodPressureSystolic,  existing?.bloodPressureSystolic),
      bloodPressureDiastolic: merge(bloodPressureDiastolic, existing?.bloodPressureDiastolic),
      hydration:              resolveHydration(hydration, existing?.hydration),
      sleepHours:             merge(sleepHours,             existing?.sleepHours),
      bloodGlucose:           merge(bloodGlucose,           existing?.bloodGlucose),
      weight:                 merge(weight,                 existing?.weight),
      goalMet: totalGoalMet,
      // Snapshot the goal that was active on this day — only set once so that
      // changing the goal later does NOT retroactively alter past days.
      goalSnapshot: existing?.goalSnapshot > 0 ? existing.goalSnapshot : dailyGoal,
      // Only advanced on a real increase — see `stepsIncreased` above.
      ...(stepsIncreased ? { lastStepIncreaseAt: new Date() } : {}),
    };

    // FIX #7: Batch independent DB operations with Promise.all.
    // The HealthActivity upsert, AppConfig read, and Gamification read are
    // all independent — run them in parallel to save ~2 DB round-trips.
    // NOTE: `gam` MUST be `let` — the atomic coin-award blocks below reassign it
    // (gam = atomicResult / passiveResult / resetDoc). Declaring it `const` throws
    // "Assignment to constant variable" the moment any coins are awarded, which
    // aborts the sync and is a primary cause of step coins not being credited.
    let gam;
    let cfg;
    {
      const [, cfgDoc, gamDoc] = await Promise.all([
        HealthActivity.findOneAndUpdate(
          { user: req.user._id, date: today },
          { $set: updateFields },
          { upsert: true, new: true }
        ),
        getCachedAppConfig(),
        Gamification.findOne({ user: req.user._id }).then(
          doc => doc || Gamification.create({ user: req.user._id })
        ),
      ]);
      cfg = cfgDoc;
      gam = gamDoc;
    }

    // ── Anti-cheat: record a flag only for an IMPLAUSIBLE submission ──────────
    // Only device-originated steps reach here; bonus/admin steps are never
    // validated against these rules.
    //
    // The trigger is `severity`, not `flagged`. Being clamped is routine — the
    // rate ceiling measures against the time since steps were last accepted, so a
    // smartwatch flushing its backlog into Health Connect is clamped and flagged on
    // every sync until the server catches up. Punishing that is what made this
    // system unusable and got it commented out wholesale; simulated against the
    // current rules, an honest watch-backlog user is flagged on 40 of 40 syncs,
    // identically to a client posting 999,999. 'implausible' means the figure
    // exceeds what anyone could walk in the elapsed day, which no real sensor
    // produces.
    //
    // Whether a recorded flag actually costs the user anything is a separate
    // decision, held in `features.cheatPenaltyEnabled` (default false). With it
    // off, flags are recorded silently so the data exists to judge by.
    //
    // Moved below the config read because it needs `cfg`; it is bookkeeping and
    // does not have to precede the activity upsert.
    let cheatPenaltyResult = null;
    if (stepValidation.severity === 'implausible') {
      cheatPenaltyResult = await recordCheatFlag({
        userId: req.user._id,
        reason: stepValidation.reason,
        incomingSteps: steps,
        clampedSteps: validatedSteps,
        existingSteps: existing?.steps || 0,
        date: today,
        penaltyEnabled: cfg.features?.cheatPenaltyEnabled === true,
      });
    }

    // Update streak if goal was met (depends on Gamification doc, so runs after)
    if (totalGoalMet) {
      await _updateStreak(req.user._id, today, gam);
    }

    // FIX #3: Use resolveClientDate for "actualToday" — respects the user's timezone
    let actualToday = resolveClientDate(timezone);

    // ── FIX: Timezone manipulation detection ─────────────────────────────────
    // Check if this user is changing timezones suspiciously often.
    // If flagged, ignore client timezone and use server time instead.
    const tzCheck = checkTimezoneManipulation(gam, timezone);
    if (tzCheck.blocked) {
      // Override: use server IST instead of client timezone
      actualToday = todayISO();
      console.warn(`[TZ-Guard] User ${req.user._id}: ${tzCheck.reason}`);
    }

    // Coins are ONLY awarded for today's actual date — never for past-day background syncs.
    // With client timezone, we no longer need the 24-hour tolerance hack.
    const isTodaySync = (today === actualToday);
    // BUG-FIX: Do NOT set lastActiveDate here unconditionally.
    // lastActiveDate must only be set when the step goal is met (handled by
    // _updateStreak above). Setting it on every sync — even when the goal hasn't
    // been reached — causes _updateStreak to see isSameDay=true on the later
    // sync that DOES meet the goal, skipping the streak increment entirely.
    // This was the root cause of streaks staying at 0 despite completing goals.

    // Reset daily coins counter ONLY when we're sure it's a new coin-day.
    // This MUST be atomic + persisted: the goal/passive awards below use
    // findOneAndUpdate($inc coinsEarnedToday), which increments the DB value.
    // A purely in-memory reset (gam.coinsEarnedToday = 0) would be clobbered by
    // those $inc ops running against yesterday's stale value, causing the daily
    // counter to accumulate across days and prematurely hit the cap — blocking
    // step coins. We also reset the passive watermark for the new day here.
    if (isTodaySync && gam.lastCoinDate !== actualToday) {
      const resetDoc = await Gamification.findOneAndUpdate(
        { user: req.user._id, lastCoinDate: { $ne: actualToday } },
        { $set: { coinsEarnedToday: 0, lastCoinDate: actualToday, lastPassiveCoinSteps: 0 } },
        { new: true }
      );
      // If we won the reset, use the fresh doc; otherwise another concurrent
      // sync already reset it — re-read to get the current state.
      gam = resetDoc || (await Gamification.findOne({ user: req.user._id })) || gam;
    }

    let goalCoinsAwarded = false;
    let awardedGoalCoins = 0;

    // ── Anti-cheat: check if user is blocked from earning coins ──────────────
    // Safe to consult unconditionally: `coinBlockedUntil` is written only by
    // recordCheatFlag, and only when features.cheatPenaltyEnabled is on. While that
    // stays false nothing sets it, so this reads not-blocked for everyone — the
    // same answer the hardcoded stub gave, without the stub hiding the mechanism.
    const coinBlockStatus = isCoinBlocked(req.user);
    const userCoinBlocked = coinBlockStatus.isBlocked;

    // ── Revert hydration reward if water was reset below goal ─────────────────
    // When the user explicitly resets hydration (sends 0), and they had already
    // claimed the daily water coins, un-claim them so the Earn Coins card
    // reflects the reverted state.
    const resolvedHydration = updateFields.hydration;
    const hydrationGoalMl = cfg.rewards?.hydrationGoalMl ?? 2000;

    if (
      isTodaySync &&
      resolvedHydration < hydrationGoalMl &&
      gam.lastWaterCoinDate === today
    ) {
      // Deduct the hydration reward coins that were previously awarded
      const hydrationCoins = cfg.rewards?.hydrationGoalCoins ?? 20;
      gam.coinsBalance = Math.max(0, Math.round(gam.coinsBalance - hydrationCoins));
      gam.coinsEarnedToday = Math.max(0, Math.round((gam.coinsEarnedToday || 0) - hydrationCoins));
      gam.lastWaterCoinDate = null; // allow re-claim when goal is met again

      // Log the reversal transaction
      logCoinTransaction({
        userId: req.user._id,
        type: 'DEDUCTED',
        amount: hydrationCoins,
        balanceAfter: gam.coinsBalance,
        source: 'HYDRATION_GOAL_REVERTED',
        description: 'Water intake reset — hydration reward reversed',
        metadata: { date: today, rewardId: 'hydration_daily' },
      });

      await gam.save();
    }

    // ── Revert hydration CHALLENGES if water was reset below their target ────
    // When the user resets hydration (sends 0 or drops below challenge targets),
    // revert completed hydration challenges for today and deduct coins if rewarded.
    if (isTodaySync && resolvedHydration === 0) {
      const hydrationChallenges = await Challenge.find({
        isActive: true,
        criteriaType: 'HYDRATION',
      }).select('_id title coinReward frequency');

      if (hydrationChallenges.length > 0) {
        const challengeIds = hydrationChallenges.map(c => c._id);
        // For daily challenges, periodKey = today; for weekly, get the week key
        const dailyPeriodKey = today;

        // Find all user challenges that were completed today for hydration
        const completedToday = await UserChallenge.find({
          user: req.user._id,
          challenge: { $in: challengeIds },
          periodKey: dailyPeriodKey,
          isCompleted: true,
        });

        let totalDeducted = 0;

        for (const uc of completedToday) {
          const challenge = hydrationChallenges.find(c => c._id.toString() === uc.challenge.toString());
          if (!challenge) continue;

          if (uc.isRewarded) {
            // Deduct the coins that were earned for this challenge
            const coinReward = challenge.coinReward || 0;
            if (coinReward > 0) {
              gam.coinsBalance = Math.max(0, Math.round(gam.coinsBalance - coinReward));
              gam.coinsEarnedToday = Math.max(0, Math.round((gam.coinsEarnedToday || 0) - coinReward));
              totalDeducted += coinReward;

              logCoinTransaction({
                userId: req.user._id,
                type: 'DEDUCTED',
                amount: coinReward,
                balanceAfter: gam.coinsBalance,
                source: 'CHALLENGE_REVERTED',
                description: `Challenge reverted — "${challenge.title}" (hydration reset)`,
                metadata: { date: today, challengeId: challenge._id },
              });
            }
          }

          // Revert the challenge progress
          await UserChallenge.findByIdAndUpdate(uc._id, {
            $set: {
              currentValue: 0,
              isCompleted: false,
              completedAt: null,
              isRewarded: false,
              rewardedAt: null,
            },
          });
        }

        if (totalDeducted > 0) {
          await gam.save();
        }
      }
    }

    // Gated on totalGoalMet (walked + bonus), not isGoalMet (walked only).
    //
    // Everything else in the system already treats the goal as met on the total:
    // `goalMet` is persisted from totalGoalMet, _updateStreak runs on it, the
    // challenge sync reads the total, and POST /gamification/coins/earn verifies
    // against `todayActivity.steps` — which is the total. Gating only this award
    // on walked steps meant a user pushed over the line by admin-credited bonus
    // steps got the streak, the goalMet flag and challenge credit, was denied the
    // automatic coin award, and could then claim the very same reward by hand.
    // Both paths share stepGoalCoinDate as their idempotency key, so aligning
    // them means the auto award takes it and the manual claim correctly no-ops.
    if (totalGoalMet && gam.stepGoalCoinDate !== today && isTodaySync && !userCoinBlocked) {
      // FIX #1: Use atomic findOneAndUpdate to prevent race condition.
      // Two concurrent syncs can't both pass this check — only one wins the
      // atomic condition { stepGoalCoinDate: { $ne: today } }.
      const stepGoalCoins = cfg.rewards.stepGoalCoins ?? 50;
      const effectiveCap = getEffectiveDailyCap(req.user, cfg.coin.maxDailyRewards ?? 500, cfg.coin.unverifiedDailyCap);
      const remainingAllowance = effectiveCap - (gam.coinsEarnedToday || 0);
      const actualStepGoalCoins = Math.round(Math.min(stepGoalCoins, Math.max(0, remainingAllowance)));

      const atomicResult = await Gamification.findOneAndUpdate(
        {
          user: req.user._id,
          // Atomic condition: only update if stepGoalCoinDate is NOT today
          $or: [
            { stepGoalCoinDate: { $ne: today } },
            { stepGoalCoinDate: null },
          ],
        },
        {
          $set: { stepGoalCoinDate: today },
          $inc: {
            coinsBalance: actualStepGoalCoins,
            coinsEarnedToday: actualStepGoalCoins,
          },
          $push: {
            claimHistory: {
              $each: [{
                rewardId: 'steps_daily_auto',
                amount: actualStepGoalCoins,
                source: 'Daily Step Goal — Auto Reward',
                createdAt: new Date(),
              }],
              $slice: -50, // keep last 50 entries
            },
          },
        },
        { new: true }
      );

      if (atomicResult) {
        // We won the race — coins were awarded atomically
        gam = atomicResult; // refresh local reference
        goalCoinsAwarded = actualStepGoalCoins > 0;
        awardedGoalCoins = actualStepGoalCoins;

        // Mark the goal bonus as paid for THIS date, so a later re-sync of the
        // same date as a past date cannot pay it a second time. stepGoalCoinDate
        // on the Gamification doc holds only one date and is overwritten daily.
        await HealthActivity.updateOne(
          { user: req.user._id, date: today },
          { $set: { retroGoalCoinAwarded: true } }
        ).catch(() => { /* non-fatal: retro path re-checks anyway */ });

        // Log coin transaction
        if (actualStepGoalCoins > 0) {
          logCoinTransaction({
            userId: req.user._id,
            type: 'EARNED',
            amount: actualStepGoalCoins,
            balanceAfter: gam.coinsBalance,
            source: 'DAILY_STEP_GOAL_AUTO',
            description: `Daily Step Goal — ${dailyGoal.toLocaleString()} steps reached`,
            metadata: { steps: validatedSteps ?? 0, date: today, rewardId: 'steps_daily_auto' },
          });
        }

        // ── Persist + push: step goal reached ──────────────────────────────
        createNotification(req.user._id, {
          type:    'GOAL',
          title:   '🎯 Daily Step Goal Reached!',
          message: `You hit your ${dailyGoal.toLocaleString()} step goal and earned ${actualStepGoalCoins} coins!`,
          data:    { screen: 'Steps' },
        });
      }
      // If atomicResult is null, another concurrent request already awarded coins — no-op.
    }

    // Passive step-based coins — awarded for ALL steps regardless of goal status.
    // Uses a watermark (lastPassiveCoinSteps) to only award coins for NEW steps.
    // The daily cap (dailyEarnLimit) prevents over-earning.
    if (!userCoinBlocked && isTodaySync) {
      const dailyEarnLimit = getEffectiveDailyCap(req.user, cfg.coin.dailyEarnLimit, cfg.coin.unverifiedDailyCap);
      const rate = cfg.coin_config?.steps?.rate_per_100_steps ?? 0.5;

      // Watermark-based calculation.
      // lastPassiveCoinSteps = the step count at which coins were last calculated.
      // Only award coins for steps ABOVE this watermark.
      const watermark = gam.lastPassiveCoinSteps || 0;
      const currentSteps = validatedSteps ?? 0;

      // If this is a new day (lastCoinDate changed), the watermark from yesterday
      // is stale — reset it so we don't penalise the user.
      const effectiveWatermark = (gam.lastCoinDate === actualToday) ? watermark : 0;

      if (currentSteps > effectiveWatermark) {
          const newStepsSinceWatermark = currentSteps - effectiveWatermark;

          // Passive cap is STEP-DERIVED and independent of goal/hydration coins.
          // Award = passiveCoinsFor(currentSteps) - passiveCoinsFor(watermark),
          // each clamped to dailyEarnLimit. Using coinsEarnedToday here was a bug:
          // it includes goal (+50) and hydration coins, so hitting the step goal
          // instantly exceeded the small passive cap and blocked all step coins.
          const { coins: actualAdded } = computePassiveCoinDelta({
            currentSteps,
            watermark: effectiveWatermark,
            rate,
            dailyEarnLimit,
          });

          if (actualAdded > 0) {
            {
              // FIX #1 (passive coins): Atomic update to prevent race condition
              const passiveResult = await Gamification.findOneAndUpdate(
                {
                  user: req.user._id,
                  // Atomic guard: only update if the watermark hasn't moved past us
                  $or: [
                    { lastPassiveCoinSteps: { $lte: effectiveWatermark } },
                    { lastPassiveCoinSteps: null },
                    { lastPassiveCoinSteps: { $exists: false } },
                  ],
                },
                {
                  $set: {
                    lastCoinDate: actualToday,
                    lastPassiveCoinSteps: currentSteps,
                    // Fold the time marker into the atomic $set so we don't need
                    // a follow-up gam.save() (which could clobber the atomic
                    // coinsBalance with a stale in-memory value).
                    lastPassiveCoinTime: new Date(),
                  },
                  $inc: {
                    coinsBalance: actualAdded,
                    coinsEarnedToday: actualAdded,
                  },
                },
                { new: true }
              );

              if (passiveResult) {
                gam = passiveResult; // refresh local reference

                // Mirror the payout onto this DATE's own watermark.
                //
                // lastPassiveCoinSteps (on the Gamification doc) only tracks one
                // day at a time, so once the day rolls over it can no longer say
                // how much was paid for the day just ended. Without this, a date
                // that received same-day coins and was then re-synced as a PAST
                // date got its retro watermark read as 0 and was paid all over
                // again — the exact "normal coins first, then retroactive coins
                // after midnight" case the retro guard was meant to cover.
                await HealthActivity.updateOne(
                  { user: req.user._id, date: today },
                  { $max: { stepCoinWatermark: currentSteps } }
                ).catch(() => { /* non-fatal: retro path re-checks anyway */ });

                // ── Always log transaction when coins are awarded ────────────────
                // Previously throttled to 3-hour intervals, which caused gaps in
                // the user's transaction history (steps were awarded but not logged).

                logCoinTransaction({
                  userId: req.user._id,
                  type: 'EARNED',
                  amount: actualAdded,
                  balanceAfter: gam.coinsBalance,
                  source: 'PASSIVE_STEPS',
                  description: `Auto Step Coins — ${effectiveWatermark.toLocaleString()} → ${currentSteps.toLocaleString()} (+${newStepsSinceWatermark.toLocaleString()} steps)`,
                  metadata: { steps: currentSteps, previousSteps: effectiveWatermark, stepDelta: newStepsSinceWatermark, date: today, trigger: 'sync' },
                });
                // lastPassiveCoinTime was already persisted atomically above.
              }
              // If passiveResult is null, another concurrent sync already moved the watermark — no-op.
            }
          }
        }
      }

    // Ensure lastActiveDate is persisted if _updateStreak or other code modified it
    if (isTodaySync && gam.isModified('lastActiveDate')) {
      await gam.save();
    }

    // ── RETROACTIVE COIN AWARD — past-date syncs (max 7 days back) ───────────
    // When a background sync pushes steps for a past date (e.g., user was offline),
    // award passive coins + step goal coins for that date — but only if:
    //   1. The date is within 7 days of today (allows offline users to claim rewards)
    //   2. User is not coin-blocked
    //   3. Coins haven't already been awarded for that date — enforced by an atomic
    //      claim on that date's HealthActivity watermark, not by reading back a
    //      CoinTransaction row that may not have been written yet.
    let retroCoinsAwarded = 0;
    if (!isTodaySync && !userCoinBlocked && totalSteps > 0) {
      const { daysBetween } = require('../utils/date');
      const daysAgo = daysBetween(today, actualToday); // positive = today is in the past

      if (daysAgo != null && daysAgo > 0 && daysAgo <= 7) {
        const rate = cfg.coin_config?.steps?.rate_per_100_steps ?? 0.5;
        const dailyEarnLimit = getEffectiveDailyCap(req.user, cfg.coin.dailyEarnLimit, cfg.coin.unverifiedDailyCap);
        const stepGoalCoins = cfg.rewards?.stepGoalCoins ?? 50;

        // Walked steps only. Bonus steps are admin-credited and do not earn
        // passive coins — same rule the same-day path applies.
        const retroWalkedSteps = deviceSteps;

        // ── Atomically CLAIM the award before paying it ────────────────────
        //
        // This used to be a check-then-act: read a CoinTransaction with
        // metadata.date === today, and if none existed, $inc the balance. Two
        // problems made that a real double-payout:
        //
        //  1. The row it checked for is written by logCoinTransaction, which was
        //     called WITHOUT await — so it had usually not been inserted yet when
        //     a second request ran the check.
        //  2. The $inc had no conditional guard of its own, unlike the same-day
        //     goal and passive awards (which use $or conditions on
        //     stepGoalCoinDate / lastPassiveCoinSteps). Nothing serialised it.
        //
        // Two concurrent background syncs for the same past date could therefore
        // both see "not yet awarded" and both increment the balance.
        //
        // The claim now lives on the HealthActivity document for that date, which
        // is the only per-date record available, and it is the same
        // condition-in-the-query pattern the same-day awards use. `new: false`
        // returns the PRE-image so we can see exactly what had already been paid.
        // A loser gets null and no-ops.
        // The null / $exists:false arms matter for documents written before
        // stepCoinWatermark existed on the schema. A missing field does not match
        // `$lt` against a number in MQL (different BSON type brackets) and Mongoose
        // only applies defaults on insert, so without them the claim would never
        // match any pre-existing row and retro awards would silently stop. Same
        // three-arm pattern the passive-coin guard above uses.
        const claimConditions = [
          { stepCoinWatermark: { $lt: retroWalkedSteps } },
          { stepCoinWatermark: null },
          { stepCoinWatermark: { $exists: false } },
        ];
        // `$ne: true` already matches a missing field, so this needs no extra arm.
        if (totalGoalMet) claimConditions.push({ retroGoalCoinAwarded: { $ne: true } });

        const claimUpdate = { $max: { stepCoinWatermark: retroWalkedSteps } };
        if (totalGoalMet) claimUpdate.$set = { retroGoalCoinAwarded: true };

        const preClaim = await HealthActivity.findOneAndUpdate(
          { user: req.user._id, date: today, $or: claimConditions },
          claimUpdate,
          { new: false } // pre-image: what had already been paid for this date
        );

        if (preClaim) {
          const previousWatermark = Math.max(0, preClaim.stepCoinWatermark || 0);
          const goalAlreadyPaid = preClaim.retroGoalCoinAwarded === true;

          const { coins: retroPassive } = computePassiveCoinDelta({
            currentSteps: retroWalkedSteps,
            watermark: previousWatermark,
            rate,
            dailyEarnLimit,
          });

          const retroGoalCoins = (totalGoalMet && !goalAlreadyPaid) ? stepGoalCoins : 0;
          const totalRetro = parseFloat((retroPassive + retroGoalCoins).toFixed(4));

          if (totalRetro > 0) {
            const retroResult = await Gamification.findOneAndUpdate(
              { user: req.user._id },
              { $inc: { coinsBalance: totalRetro } },
              { new: true }
            );

            if (retroResult) {
              gam = retroResult;
              retroCoinsAwarded = totalRetro;

              // Awaited, so the transaction log is durable before we respond.
              // These are the user's coin-history rows; dropping them on a slow
              // write left balances that no transaction explained.
              if (retroPassive > 0) {
                await logCoinTransaction({
                  userId: req.user._id,
                  type: 'EARNED',
                  amount: retroPassive,
                  balanceAfter: gam.coinsBalance - retroGoalCoins,
                  source: 'PASSIVE_STEPS_RETRO',
                  description: `Retroactive Step Coins (${today}) — ${retroWalkedSteps.toLocaleString()} steps`,
                  metadata: {
                    steps: retroWalkedSteps,
                    previousSteps: previousWatermark,
                    stepDelta: retroWalkedSteps - previousWatermark,
                    date: today,
                    daysAgo,
                    trigger: 'retro_sync',
                  },
                });
              }

              if (retroGoalCoins > 0) {
                await logCoinTransaction({
                  userId: req.user._id,
                  type: 'EARNED',
                  amount: retroGoalCoins,
                  balanceAfter: gam.coinsBalance,
                  source: 'DAILY_STEP_GOAL_RETRO',
                  description: `Retroactive Step Goal (${today}) — ${dailyGoal.toLocaleString()} steps reached`,
                  metadata: { steps: retroWalkedSteps, date: today, daysAgo, trigger: 'retro_sync' },
                });
              }
            } else {
              // Balance update failed after the claim was taken. Release it so a
              // later sync can retry rather than silently swallowing the award.
              await HealthActivity.updateOne(
                { user: req.user._id, date: today },
                {
                  $set: {
                    stepCoinWatermark: previousWatermark,
                    retroGoalCoinAwarded: goalAlreadyPaid,
                  },
                }
              ).catch(() => { /* best effort */ });
            }
          }
        }
      }
    }

    // Await challenge sync so we can include newly completed challenges in the response
    const { newlyCompleted } = await syncChallengeProgress(req.user._id).catch(() => ({ newlyCompleted: [] }));

    return success(res, 'Health data synced', {
      // The date this sync was actually written to, in the user's local day. The
      // client compares this against its own local date before pushing totalSteps
      // to the notification and widget. It used to be missing, so those checks
      // compared against `undefined`, never passed, and the widget silently stopped
      // following the server total.
      date: today,
      goalCoinsAwarded,
      coinsBalance: gam.coinsBalance,
      stepGoalCoins: awardedGoalCoins,
      bonusSteps,       // bonus steps credited for today (so app can show total)
      totalSteps,       // walked + bonus combined
      deviceSteps,      // walked only — what the client should compare its own figure against
      newlyCompleted,   // array of { title, emoji, coinReward }
      retroCoinsAwarded: retroCoinsAwarded > 0 ? retroCoinsAwarded : undefined,
      // Confirms a requested downward correction was applied, so the client can
      // stop re-sending the flag.
      stepCorrection: stepValidation.corrected ? {
        applied: true,
        from: stepValidation.correctedFrom,
        to: validatedSteps,
      } : undefined,
      // FIX #2: Inform client if steps were flagged/clamped
      stepValidation: stepValidation.flagged ? {
        flagged: true,
        reason: stepValidation.reason,
        originalSteps: steps,
        acceptedSteps: validatedSteps,
      } : undefined,
      // Anti-cheat: inform the client if coins are blocked. The app consumes this
      // (useSyncHealth → CoinBlockedBanner), and its absence is what hides the
      // banner, so it must stay `undefined` rather than a falsy object.
      coinBlocked: userCoinBlocked ? {
        blocked: true,
        blockedUntil: coinBlockStatus.blockedUntil,
        daysRemaining: coinBlockStatus.daysRemaining,
      } : undefined,
      // Anti-cheat: today's flag count, for the client-side warning popup.
      //
      // Sent only while penalties are enabled. With them off a flag is recorded as
      // evidence and costs the user nothing, so telling them they have been warned
      // would be accusing them of something we have explicitly decided not to act
      // on — and the warning text itself promises a block that will not happen.
      cheatWarning: (cheatPenaltyResult && cfg.features?.cheatPenaltyEnabled === true) ? {
        flagCount: cheatPenaltyResult.flagCount,
        blocked: cheatPenaltyResult.blocked,
        blockedUntil: cheatPenaltyResult.coinBlockedUntil,
      } : undefined,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /health/history ──────────────────────────────────────────────────────
const getHealthHistory = async (req, res, next) => {
  try {
    const { from, to, limit = 30 } = req.query;

    const query = { user: req.user._id };
    if (from && to) query.date = { $gte: from, $lte: to };

    const records = await HealthActivity.find(query)
      .sort({ date: -1 })
      .limit(Number(limit));

    return success(res, 'Health history fetched', records);
  } catch (err) {
    next(err);
  }
};

// ─── GET /health/today ────────────────────────────────────────────────────────
const getTodayHealth = async (req, res, next) => {
  try {
    // Use client timezone (query param) to determine "today" in the user's local time.
    // This ensures the correct day's health record is returned regardless of the
    // server's timezone. Falls back to server IST if no timezone is provided.
    const timezone = req.query.timezone || req.headers['x-timezone'] || null;
    const today = resolveClientDate(timezone);
    const record = await HealthActivity.findOne({ user: req.user._id, date: today });
    return success(res, 'Today health data fetched', record);
  } catch (err) {
    next(err);
  }
};

// ─── Internal: update streak ─────────────────────────────────────────────────
// FIX #2: Accepts an optional pre-fetched gamification doc to avoid a redundant
// Gamification.findOne when the caller already has the document in memory.
async function _updateStreak(userId, date, existingGam = null) {
  const BadgeDefinition = require('../models/BadgeDefinition.model');
  const gam = existingGam || await Gamification.findOne({ user: userId });
  if (!gam) return;

  const wasConsecutive = isConsecutiveDay(gam.lastActiveDate, date);
  const isSameDay = gam.lastActiveDate === date;

  let dirty = false;

  if (!isSameDay) {
    if (!gam.lastActiveDate) {
      // First-ever sync or lastActiveDate was cleared — preserve existing streak
      // rather than resetting it. Only set lastActiveDate going forward.
      gam.lastActiveDate = date;
      dirty = true;
      if (gam.streakDays === 0) {
        gam.streakDays = 1;
        dirty = true;
      }
    } else if (wasConsecutive) {
      gam.streakDays += 1;
      gam.lastActiveDate = date;
      dirty = true;

      // Grant freeze/life protections after streak grows.
      const { getStreakConfig, grantProtections } = require('../utils/streak');
      const sCfg = await getStreakConfig();
      grantProtections(gam, sCfg);
    } else {
      // Known gap — attempt freeze/life protection before breaking.
      const { getStreakConfig, attemptProtect } = require('../utils/streak');
      const sCfg = await getStreakConfig();
      const protection = attemptProtect(gam, sCfg);

      if (protection.protected) {
        // Streak saved! Mark today as active, do NOT reset.
        gam.lastActiveDate = date;
      } else {
        // Streak broken — attemptProtect already set streakDays to 0.
        // Now start a new streak at 1 for today's activity.
        gam.streakDays = 1;
        gam.lastActiveDate = date;

        // Send motivational push notification (fire-and-forget).
        try {
          createNotification(userId, {
            type: 'STREAK',
            title: "💪 Don't worry — start fresh!",
            message: 'Your streak broke, but every step counts. Get back on track today!',
            data: { screen: 'Tracker' },
          });
        } catch (_) { /* non-critical */ }
      }
      dirty = true;
    }

    if (gam.streakDays > gam.bestStreakDays) {
      gam.bestStreakDays = gam.streakDays;
      dirty = true;
    }
    // Load active badge definitions and award any newly unlocked badges
    const badgeDefs = await BadgeDefinition.find({ isActive: true }).sort({ order: 1 });
    const prevUnlocked = new Set((gam.badgeList || []).filter(b => b.unlockedAt).map(b => b.key));
    gam.awardBadges(badgeDefs);
    // Check if awardBadges changed anything
    const newlyUnlocked = badgeDefs.filter(def => {
      const badge = (gam.badgeList || []).find(b => b.key === def.key);
      return badge?.unlockedAt && !prevUnlocked.has(def.key);
    });
    if (newlyUnlocked.length > 0) dirty = true;

    if (dirty) await gam.save();

    // Push for any badge newly unlocked this sync
    for (const def of newlyUnlocked) {
      createNotification(userId, {
        type:    'GOAL',
        title:   `${def.emoji} Badge Unlocked: ${def.title}!`,
        message: `You hit a ${def.threshold}-day streak and earned ${def.coinReward} coins!`,
        data:    { screen: 'Achievements' },
      });
    }
  }
}

// ─── GET /health/analytics ───────────────────────────────────────────────────
// Returns real aggregated metrics from HealthActivity records.
// For each timeframe: computes chart data points, totals, and trend vs prior period.
const getAnalyticsDashboard = async (req, res, next) => {
  try {
    const { period = 'day' } = req.query;
    const timeframe = period.charAt(0).toUpperCase() + period.slice(1).toLowerCase();

    const userId = req.user._id;
    const dailyGoal = req.user.dailyStepGoal || 10000;
    const CALORIE_GOAL = 2500;
    const ACTIVITY_GOAL = 60; // mins

    // ── Helper: compute avg or sum from array of numbers (skip zeros) ───────
    const avg = (arr) => {
      const nonZero = arr.filter(v => v > 0);
      return nonZero.length ? nonZero.reduce((s, v) => s + v, 0) / nonZero.length : 0;
    };
    const sum = (arr) => arr.reduce((s, v) => s + v, 0);
    const trend = (curr, prev) => {
      if (!prev) return 0;
      return +((((curr - prev) / prev) * 100).toFixed(1));
    };
    const round1 = (n) => Math.round(n * 10) / 10;

    // ── Date helpers ─────────────────────────────────────────────────────────
    const toISO = (d) => d.toISOString().slice(0, 10);

    const now = new Date();

    let labels = [];
    let currentDates = [];  // YYYY-MM-DD strings for current period
    let priorDates = [];    // YYYY-MM-DD strings for prior period (for trend)

    switch (timeframe) {
      case 'Day': {
        // Current = today; Prior = yesterday
        const todayStr = toISO(now);
        const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
        currentDates = [todayStr];
        priorDates = [toISO(yesterday)];
        labels = ['6am', '9am', '12pm', '3pm', '6pm', '9pm'];
        break;
      }
      case 'Week': {
        // Current = last 7 days; Prior = 7 days before that
        for (let i = 6; i >= 0; i--) {
          const d = new Date(now); d.setDate(now.getDate() - i);
          currentDates.push(toISO(d));
        }
        for (let i = 13; i >= 7; i--) {
          const d = new Date(now); d.setDate(now.getDate() - i);
          priorDates.push(toISO(d));
        }
        labels = currentDates.map(dt => {
          const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          return days[new Date(dt).getDay()];
        });
        break;
      }
      case 'Month': {
        // Current = last 28 days split into 4 weeks; Prior = 28 days before that
        for (let i = 27; i >= 0; i--) {
          const d = new Date(now); d.setDate(now.getDate() - i);
          currentDates.push(toISO(d));
        }
        for (let i = 55; i >= 28; i--) {
          const d = new Date(now); d.setDate(now.getDate() - i);
          priorDates.push(toISO(d));
        }
        labels = ['W1', 'W2', 'W3', 'W4'];
        break;
      }
      case 'Year': {
        // Current = last 12 months; Prior = 12 months before that
        const curMonthStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
        const priorMonthStart = new Date(now.getFullYear(), now.getMonth() - 23, 1);
        // Build ISO dates month by month
        for (let m = 0; m < 12; m++) {
          const start = new Date(curMonthStart.getFullYear(), curMonthStart.getMonth() + m, 1);
          const end = new Date(curMonthStart.getFullYear(), curMonthStart.getMonth() + m + 1, 0);
          for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            currentDates.push(toISO(new Date(d)));
          }
        }
        for (let m = 0; m < 12; m++) {
          const start = new Date(priorMonthStart.getFullYear(), priorMonthStart.getMonth() + m, 1);
          const end = new Date(priorMonthStart.getFullYear(), priorMonthStart.getMonth() + m + 1, 0);
          for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            priorDates.push(toISO(new Date(d)));
          }
        }
        labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
          .slice(0, 12);
        // Reduce to 4 quarterly labels for chart
        labels = ['Q1', 'Q2', 'Q3', 'Q4'];
        break;
      }
      default:
        return error(res, 'Invalid analytics period requested', 400);
    }

    // ── Fetch real DB records for both periods ───────────────────────────────
    const allDates = [...currentDates, ...priorDates];
    const allRecordsRaw = await HealthActivity.find({
      user: userId,
      date: { $in: allDates },
    }).select('date steps distance calories activeMinutes heartRate heartRateMin heartRateMax bloodPressureSystolic bloodPressureDiastolic hydration goalMet');

    // Build lookup by date
    const byDate = {};
    allRecordsRaw.forEach(r => { byDate[r.date] = r; });

    const pick = (date, field) => byDate[date]?.[field] ?? 0;

    // ── Current period arrays ────────────────────────────────────────────────
    const cur = {
      steps:    currentDates.map(d => pick(d, 'steps')),
      calories: currentDates.map(d => pick(d, 'calories')),
      distance: currentDates.map(d => pick(d, 'distance')),
      time:     currentDates.map(d => pick(d, 'activeMinutes')),
      heart:    currentDates.map(d => pick(d, 'heartRate')),
      sys:      currentDates.map(d => pick(d, 'bloodPressureSystolic')),
      dia:      currentDates.map(d => pick(d, 'bloodPressureDiastolic')),
    };

    // ── Prior period arrays (for trend only) ─────────────────────────────────
    const pri = {
      steps:    priorDates.map(d => pick(d, 'steps')),
      calories: priorDates.map(d => pick(d, 'calories')),
      distance: priorDates.map(d => pick(d, 'distance')),
      time:     priorDates.map(d => pick(d, 'activeMinutes')),
      heart:    priorDates.map(d => pick(d, 'heartRate')),
    };

    // ── Build chart data sets per timeframe ──────────────────────────────────
    let chartDataSets;

    if (timeframe === 'Day') {
      // For "Day" we can't split into 6 hour-slots from daily records,
      // so we show the single current day value as a flat line across 6 points.
      const todaySteps = cur.steps[0] || 0;
      const todayCal   = cur.calories[0] || 0;
      const todayDist  = round1(cur.distance[0] || 0);
      const todayTime  = cur.time[0] || 0;
      const todayHR    = cur.heart[0] || 0;
      const todaySys   = cur.sys[0] || 0;
      // Distribute steps across 6 time points (cumulative approximation)
      const stepPoints = [0.05, 0.12, 0.30, 0.50, 0.75, 1.0].map(f => Math.round(todaySteps * f));
      const calPoints  = [0.05, 0.15, 0.35, 0.55, 0.78, 1.0].map(f => Math.round(todayCal * f));
      const distPoints = [0.05, 0.12, 0.30, 0.50, 0.75, 1.0].map(f => round1(todayDist * f));
      const timePoints = [0.05, 0.15, 0.35, 0.55, 0.78, 1.0].map(f => Math.round(todayTime * f));
      chartDataSets = {
        steps:    stepPoints,
        heart:    new Array(6).fill(todayHR || 0),
        bp:       new Array(6).fill(todaySys || 0),
        calories: calPoints,
        distance: distPoints,
        time:     timePoints,
      };
    } else if (timeframe === 'Week') {
      chartDataSets = {
        steps:    cur.steps,
        heart:    cur.heart,
        bp:       cur.sys,
        calories: cur.calories,
        distance: cur.distance.map(round1),
        time:     cur.time,
      };
    } else if (timeframe === 'Month') {
      // Group daily data into 4 weeks
      const weeks = [
        currentDates.slice(0, 7),
        currentDates.slice(7, 14),
        currentDates.slice(14, 21),
        currentDates.slice(21, 28),
      ];
      chartDataSets = {
        steps:    weeks.map(w => sum(w.map(d => pick(d, 'steps')))),
        heart:    weeks.map(w => Math.round(avg(w.map(d => pick(d, 'heartRate'))))),
        bp:       weeks.map(w => Math.round(avg(w.map(d => pick(d, 'bloodPressureSystolic'))))),
        calories: weeks.map(w => sum(w.map(d => pick(d, 'calories')))),
        distance: weeks.map(w => round1(sum(w.map(d => pick(d, 'distance'))))),
        time:     weeks.map(w => sum(w.map(d => pick(d, 'activeMinutes')))),
      };
    } else {
      // Year: group by quarter using RELATIVE index within the 12-month window.
      // BUG-019: Using absolute getMonth() breaks for windows spanning two calendar
      // years (e.g. May 2024–Apr 2025). Use position in currentDates array instead.
      const monthGroups = [[], [], [], []]; // Q1, Q2, Q3, Q4
      currentDates.forEach((d, relativeIndex) => {
        const q = Math.floor(relativeIndex / Math.ceil(currentDates.length / 4));
        const safeQ = Math.min(q, 3); // clamp to 0-3
        monthGroups[safeQ].push(d);
      });
      chartDataSets = {
        steps:    monthGroups.map(g => sum(g.map(d => pick(d, 'steps')))),
        heart:    monthGroups.map(g => Math.round(avg(g.map(d => pick(d, 'heartRate'))))),
        bp:       monthGroups.map(g => Math.round(avg(g.map(d => pick(d, 'bloodPressureSystolic'))))),
        calories: monthGroups.map(g => sum(g.map(d => pick(d, 'calories')))),
        distance: monthGroups.map(g => round1(sum(g.map(d => pick(d, 'distance'))))),
        time:     monthGroups.map(g => sum(g.map(d => pick(d, 'activeMinutes')))),
      };
    }

    // ── Compute summary metrics ──────────────────────────────────────────────
    const totalSteps    = sum(cur.steps);
    const totalCalories = sum(cur.calories);
    const totalDistance = round1(sum(cur.distance));
    const totalTime     = sum(cur.time);
    const avgHR         = Math.round(avg(cur.heart));
    const avgSys        = Math.round(avg(cur.sys));
    const avgDia        = Math.round(avg(cur.dia));
    const bpStr         = avgSys > 0 ? `${avgSys}/${avgDia}` : '—';

    const prevSteps    = sum(pri.steps);
    const prevCalories = sum(pri.calories);
    const prevDistance = round1(sum(pri.distance));
    const prevTime     = sum(pri.time);
    const prevHR       = Math.round(avg(pri.heart));

    const metrics = {
      steps:         { value: totalSteps,    trend: trend(totalSteps, prevSteps) },
      heartRate:     { value: avgHR,         trend: trend(avgHR, prevHR) },
      bloodPressure: { value: bpStr,         trend: 0 },
      calories:      { value: totalCalories, trend: trend(totalCalories, prevCalories) },
      distance:      { value: totalDistance, trend: trend(totalDistance, prevDistance) },
      activityTime:  { value: totalTime,     trend: trend(totalTime, prevTime) },
    };

    // ── Ring goals (based on per-day average vs goals) ───────────────────────
    const daysCount = currentDates.length || 1;
    const avgStepsPerDay = totalSteps / daysCount;
    const avgCalPerDay   = totalCalories / daysCount;
    const avgTimePerDay  = totalTime / daysCount;

    const rings = {
      stepsGoalPercent:    Math.min(1, round1(avgStepsPerDay / dailyGoal)),
      caloriesGoalPercent: Math.min(1, round1(avgCalPerDay / CALORIE_GOAL)),
      timeGoalPercent:     Math.min(1, round1(avgTimePerDay / ACTIVITY_GOAL)),
    };

    return success(res, 'Analytics dashboard data fetched', {
      timeframe, metrics, chartDataSets, labels, rings,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /health/analytics/sync ──────────────────────────────────────────────
const syncAnalyticsDashboard = async (req, res, next) => {
  try {
    return success(res, 'Health analytics synced from device explicitly', {
      success: true,
      message: 'Server acknowledged sync ping'
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /health/bmi ─────────────────────────────────────────────────────────
// Body: { weight: number (kg), height: number (m) }
// Calculates BMI, determines category, and saves the record.
const saveBmi = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { weight, height } = req.body;

    if (!weight || weight <= 0) return error(res, 'weight (kg) is required and must be positive', 400);
    if (!height || height <= 0) return error(res, 'height (m) is required and must be positive', 400);

    const bmi = parseFloat((weight / (height * height)).toFixed(1));

    let category;
    if (bmi < 18.5)       category = 'underweight';
    else if (bmi < 25.0)  category = 'normal';
    else if (bmi < 30.0)  category = 'overweight';
    else                   category = 'obese';

    const record = await BmiRecord.findOneAndUpdate(
      { user: userId, date: todayISO() },
      {
        $set: {
          weight:   parseFloat(weight.toFixed(1)),
          height:   parseFloat((height * 100).toFixed(1)),
          bmi,
          category,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Also update today's HealthActivity with the latest weight
    await HealthActivity.findOneAndUpdate(
      { user: userId, date: todayISO() },
      { $set: { weight: parseFloat(weight.toFixed(1)) } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Update User model with height and weight
    await User.findByIdAndUpdate(
      userId,
      { $set: { weight: parseFloat(weight.toFixed(1)), height: parseFloat((height * 100).toFixed(0)) } }
    );

    return success(res, 'BMI saved', record.toJSON(), 201);
  } catch (err) {
    next(err);
  }
};

// ─── GET /health/bmi?limit=10 ─────────────────────────────────────────────────
// Returns the most recent BMI records for the authenticated user.
const getBmiHistory = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));

    const records = await BmiRecord.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(limit);

    return success(res, 'BMI history fetched', records);
  } catch (err) {
    next(err);
  }
};

// ─── GET /health/calendar?year=YYYY&month=MM ─────────────────────────────────
// Returns per-day step data for a given month, plus completed-days count.
// Used by the Calendar Indicator on the Analytics screen.
const getCalendarActivity = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const dailyGoal = req.user.dailyStepGoal || 10000;

    const now = new Date();
    const year  = parseInt(req.query.year  || String(now.getFullYear()), 10);
    const month = parseInt(req.query.month || String(now.getMonth() + 1), 10); // 1-based

    if (month < 1 || month > 12) return error(res, 'month must be 1–12', 400);

    // Build YYYY-MM-DD range for the requested month
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate(); // day 0 of next month = last day of this month
    const to   = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const records = await HealthActivity.find({
      user: userId,
      date: { $gte: from, $lte: to },
    }).select('date steps goalMet').lean();

    // Build a map for O(1) lookup
    const recordMap = {};
    records.forEach(r => { recordMap[r.date] = { steps: r.steps || 0, goalMet: r.goalMet || false }; });

    // Build full month array (all days, even those with no data)
    const days = [];
    for (let d = 1; d <= lastDay; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const rec = recordMap[dateStr];
      const steps = rec?.steps ?? 0;
      const goalMet = rec?.goalMet ?? false;
      // Intensity: 0 = no data, 1 = low (<25%), 2 = medium (<50%), 3 = high (<100%), 4 = goal met
      let intensity = 0;
      if (steps > 0) {
        const pct = steps / dailyGoal;
        if (goalMet || pct >= 1)      intensity = 4;
        else if (pct >= 0.75)         intensity = 3;
        else if (pct >= 0.5)          intensity = 2;
        else                          intensity = 1;
      }
      days.push({ date: dateStr, steps, goalMet, intensity });
    }

    // Count days where goal was met
    const completedDays = days.filter(d => d.goalMet).length;
    // Count days with any activity
    const activeDays = days.filter(d => d.steps > 0).length;

    // Build list of months from user's account creation to now
    const user = await User.findById(userId).select('createdAt').lean();
    const accountCreatedAt = user?.createdAt ? new Date(user.createdAt) : new Date();
    const months = [];
    const cursor = new Date(accountCreatedAt.getFullYear(), accountCreatedAt.getMonth(), 1);
    const endMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    while (cursor <= endMonth) {
      months.push({
        year:  cursor.getFullYear(),
        month: cursor.getMonth() + 1, // 1-based
        label: cursor.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    return success(res, 'Calendar activity fetched', {
      year,
      month,
      dailyGoal,
      completedDays,
      activeDays,
      totalDays: lastDay,
      days,
      availableMonths: months,
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /health/period-stats ─────────────────────────────────────────────────
// Returns step totals + change vs prior equivalent period for 7 / 14 / 30 days.
// Used by the Period Stats card on the Analytics screen.
const getPeriodStats = async (req, res, next) => {
  try {
    const userId    = req.user._id;
    const now       = new Date();
    const toISO     = (d) => d.toISOString().slice(0, 10);
    const todayStr  = toISO(now);

    // Build date string N days ago
    const daysAgo = (n) => {
      const d = new Date(now);
      d.setDate(now.getDate() - n);
      return toISO(d);
    };

    // Fetch the last 60 days in one query — covers all three periods + their priors
    const from60 = daysAgo(59); // 60 days inclusive
    const records = await HealthActivity.find({
      user: userId,
      date: { $gte: from60, $lte: todayStr },
    }).select('date steps').lean();

    // Build O(1) lookup: date → steps
    const stepMap = {};
    records.forEach(r => { stepMap[r.date] = r.steps || 0; });

    const sumRange = (startDaysAgo, endDaysAgo) => {
      let total = 0;
      for (let i = endDaysAgo; i >= startDaysAgo; i--) {
        total += stepMap[daysAgo(i)] ?? 0;
      }
      return total;
    };

    // ── 7-day period ──────────────────────────────────────────────────────────
    const steps7     = sumRange(0, 6);   // last 7 days  (today = daysAgo(0))
    const steps7prev = sumRange(7, 13);  // prior 7 days
    const change7    = steps7 - steps7prev;

    // ── 14-day period ─────────────────────────────────────────────────────────
    const steps14     = sumRange(0, 13);
    const steps14prev = sumRange(14, 27);
    const change14    = steps14 - steps14prev;

    // ── 30-day period ─────────────────────────────────────────────────────────
    const steps30     = sumRange(0, 29);
    const steps30prev = sumRange(30, 59);
    const change30    = steps30 - steps30prev;

    return success(res, 'Period stats fetched', {
      periods: [
        {
          label:      '7 Days',
          days:       7,
          totalSteps: steps7,
          change:     change7,
          prevTotal:  steps7prev,
        },
        {
          label:      '14 Days',
          days:       14,
          totalSteps: steps14,
          change:     change14,
          prevTotal:  steps14prev,
        },
        {
          label:      '30 Days',
          days:       30,
          totalSteps: steps30,
          change:     change30,
          prevTotal:  steps30prev,
        },
      ],
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /health/day-detail?date=YYYY-MM-DD ──────────────────────────────────
// Returns full health snapshot for a single day — used by StepDetailScreen.
const getDayDetail = async (req, res, next) => {
  try {
    const userId    = req.user._id;
    const date      = req.query.date || todayISO();

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return error(res, 'date must be YYYY-MM-DD', 400);
    }

    const record = await HealthActivity.findOne({ user: userId, date }).lean();

    // Use the goal that was active on that specific day (goalSnapshot).
    // Fall back to the user's current goal only if the record pre-dates the
    // goalSnapshot field or has no record at all.
    const dailyGoal = (record?.goalSnapshot > 0 ? record.goalSnapshot : null)
      ?? req.user.dailyStepGoal
      ?? 10000;

    const steps          = record?.steps          ?? 0;
    const calories       = record?.calories       ?? 0;
    const distance       = record?.distance       ?? 0;
    const activeMinutes  = record?.activeMinutes  ?? 0;
    const heartRate      = record?.heartRate      ?? 0;
    const heartRateMin   = record?.heartRateMin   ?? 0;
    const heartRateMax   = record?.heartRateMax   ?? 0;
    const hydration      = record?.hydration      ?? 0;
    const sleepHours     = record?.sleepHours     ?? 0;
    const bloodGlucose   = record?.bloodGlucose   ?? 0;
    const weight         = record?.weight         ?? 0;
    const goalMet        = record?.goalMet        ?? false;

    const progressPct = dailyGoal > 0 ? Math.min(100, Math.round((steps / dailyGoal) * 100)) : 0;

    // Derive intensity level (same logic as calendar)
    let intensity = 0;
    if (steps > 0) {
      const pct = steps / dailyGoal;
      if (goalMet || pct >= 1)  intensity = 4;
      else if (pct >= 0.75)     intensity = 3;
      else if (pct >= 0.5)      intensity = 2;
      else                      intensity = 1;
    }

    return success(res, 'Day detail fetched', {
      date,
      dailyGoal,
      steps,
      calories,
      distance,
      activeMinutes,
      heartRate,
      heartRateMin,
      heartRateMax,
      hydration,
      sleepHours,
      bloodGlucose,
      weight,
      goalMet,
      progressPct,
      intensity,
      hasData: !!record,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getWeeklySteps,
  syncHealthData,
  getHealthHistory,
  getTodayHealth,
  getAnalyticsDashboard,
  syncAnalyticsDashboard,
  getCalendarActivity,
  getPeriodStats,
  getDayDetail,
  saveBmi,
  getBmiHistory,
};
