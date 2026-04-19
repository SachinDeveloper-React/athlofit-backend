// src/controllers/referral.controller.js
const User = require('../models/User.model');
const Referral = require('../models/Referral.model');
const Gamification = require('../models/Gamification.model');
const AppConfig = require('../models/AppConfig.model');
const { success, error } = require('../utils/response');

async function getLiveConfig() {
  let cfg = await AppConfig.findOne({ key: 'global' });
  if (!cfg) cfg = await AppConfig.create({ key: 'global' });
  return cfg;
}

// ─── GET /referral/me ─────────────────────────────────────────────────────────
// Returns current user's referral code and stats
const getReferralStats = async (req, res, next) => {
  try {
    const userId = req.user._id;

    // Ensure user has a referral code — generate one if missing (legacy accounts)
    let referralCode = req.user.referralCode;
    if (!referralCode) {
      const crypto = require('crypto');
      referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      await User.findByIdAndUpdate(userId, { referralCode });
    }

    const cfg = await getLiveConfig();
    const REFERRER_BONUS = cfg.coin.referrerBonus;
    const REFEREE_BONUS  = cfg.coin.refereeBonus;

    const referrals = await Referral.find({ referrer: userId })
      .populate('referee', 'name avatarUrl createdAt')
      .sort({ createdAt: -1 });

    const totalReferred = referrals.length;
    const bonusCoinsEarned = referrals
      .filter(r => r.referrerBonusAwarded)
      .reduce((acc, r) => acc + r.referrerBonus, 0);

    return success(res, 'Referral stats fetched', {
      referralCode,
      totalReferred,
      bonusCoinsEarned,
      referrerBonus: REFERRER_BONUS,
      refereeBonus:  REFEREE_BONUS,
      referrals: referrals.map(r => ({
        id: r._id,
        name: r.referee?.name || 'Unknown',
        avatarUrl: r.referee?.avatarUrl || null,
        joinedAt: r.createdAt,
        bonusAwarded: r.referrerBonusAwarded,
        referrerBonus: r.referrerBonus,
      })),
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /referral/apply ─────────────────────────────────────────────────────
// Body: { referralCode }
// Apply a referral code — awards bonus coins to both referrer and referee
const applyReferralCode = async (req, res, next) => {
  try {
    const refereeId = req.user._id;
    const { referralCode } = req.body;

    if (!referralCode || typeof referralCode !== 'string') {
      return error(res, 'referralCode is required', 400);
    }

    const code = referralCode.trim().toUpperCase();

    // 1. Check if the referee has already used a referral code
    const alreadyUsed = await Referral.findOne({ referee: refereeId });
    if (alreadyUsed) {
      return error(res, 'You have already used a referral code', 400);
    }

    // 2. Find the referrer by referral code
    const referrer = await User.findOne({ referralCode: code });
    if (!referrer) {
      return error(res, 'Invalid referral code', 404);
    }

    // 3. Can't refer yourself
    if (referrer._id.toString() === refereeId.toString()) {
      return error(res, 'You cannot use your own referral code', 400);
    }

    // 4. Load live bonus amounts from DB config
    const cfg = await getLiveConfig();
    const REFERRER_BONUS = cfg.coin.referrerBonus;
    const REFEREE_BONUS  = cfg.coin.refereeBonus;

    // 5. Create referral record — store live bonus amounts so history is accurate
    const referral = await Referral.create({
      referrer: referrer._id,
      referee: refereeId,
      referralCode: code,
      referrerBonus: REFERRER_BONUS,
      refereeBonus:  REFEREE_BONUS,
    });

    // 6. Award coins to referrer
    let referrerGam = await Gamification.findOne({ user: referrer._id });
    if (!referrerGam) {
      referrerGam = await Gamification.create({ user: referrer._id });
    }
    referrerGam.coinsBalance = Math.round(referrerGam.coinsBalance + REFERRER_BONUS);
    referrerGam.claimHistory.push({
      rewardId: `referral_${referral._id}`,
      amount: REFERRER_BONUS,
      source: `Referral Bonus — ${req.user.name} joined`,
      createdAt: new Date(),
    });
    if (referrerGam.claimHistory.length > 50) referrerGam.claimHistory.shift();
    await referrerGam.save();

    // 7. Award coins to referee (current user)
    let refereeGam = await Gamification.findOne({ user: refereeId });
    if (!refereeGam) {
      refereeGam = await Gamification.create({ user: refereeId });
    }
    refereeGam.coinsBalance = Math.round(refereeGam.coinsBalance + REFEREE_BONUS);
    refereeGam.claimHistory.push({
      rewardId: `referral_welcome_${referral._id}`,
      amount: REFEREE_BONUS,
      source: `Welcome Bonus — Used referral code`,
      createdAt: new Date(),
    });
    if (refereeGam.claimHistory.length > 50) refereeGam.claimHistory.shift();
    await refereeGam.save();

    // 8. Mark bonuses as awarded
    referral.referrerBonusAwarded = true;
    referral.refereeBonusAwarded = true;
    await referral.save();

    return success(res, `Referral code applied! You earned ${REFEREE_BONUS} bonus coins 🎉`, {
      refereeNewBalance: refereeGam.coinsBalance,
      refereeBonus: REFEREE_BONUS,
      referrerName: referrer.name,
    });
  } catch (err) {
    // Handle duplicate referee (race condition)
    if (err.code === 11000) {
      return error(res, 'You have already used a referral code', 400);
    }
    next(err);
  }
};

module.exports = { getReferralStats, applyReferralCode };
