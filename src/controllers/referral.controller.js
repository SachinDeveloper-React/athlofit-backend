// src/controllers/referral.controller.js
const User = require('../models/User.model');
const Referral = require('../models/Referral.model');
const Gamification = require('../models/Gamification.model');
const { success, error } = require('../utils/response');

// ─── GET /referral/me ─────────────────────────────────────────────────────────
// Returns current user's referral code and stats
const getReferralStats = async (req, res, next) => {
  try {
    const userId = req.user._id;

    // Get referral records where this user is the referrer
    const referrals = await Referral.find({ referrer: userId })
      .populate('referee', 'name avatarUrl createdAt')
      .sort({ createdAt: -1 });

    const totalReferred = referrals.length;
    const bonusCoinsEarned = referrals
      .filter(r => r.referrerBonusAwarded)
      .reduce((acc, r) => acc + r.referrerBonus, 0);

    return success(res, 'Referral stats fetched', {
      referralCode: req.user.referralCode,
      totalReferred,
      bonusCoinsEarned,
      referrerBonus: 100,  // coins awarded to referrer per successful referral
      refereeBonus: 50,    // coins awarded to referee for using a code
      referrals: referrals.map(r => ({
        id: r._id,
        name: r.referee?.name || 'Unknown',
        avatarUrl: r.referee?.avatarUrl || null,
        joinedAt: r.createdAt,
        bonusAwarded: r.referrerBonusAwarded,
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

    // 4. Create referral record
    const referral = await Referral.create({
      referrer: referrer._id,
      referee: refereeId,
      referralCode: code,
    });

    // 5. Award coins to referrer
    let referrerGam = await Gamification.findOne({ user: referrer._id });
    if (!referrerGam) {
      referrerGam = await Gamification.create({ user: referrer._id });
    }
    referrerGam.coinsBalance = Math.round(referrerGam.coinsBalance + 100);
    referrerGam.claimHistory.push({
      rewardId: `referral_${referral._id}`,
      amount: 100,
      source: `Referral Bonus — ${req.user.name} joined`,
      createdAt: new Date(),
    });
    if (referrerGam.claimHistory.length > 50) referrerGam.claimHistory.shift();
    await referrerGam.save();

    // 6. Award coins to referee (current user)
    let refereeGam = await Gamification.findOne({ user: refereeId });
    if (!refereeGam) {
      refereeGam = await Gamification.create({ user: refereeId });
    }
    refereeGam.coinsBalance = Math.round(refereeGam.coinsBalance + 50);
    refereeGam.claimHistory.push({
      rewardId: `referral_welcome_${referral._id}`,
      amount: 50,
      source: `Welcome Bonus — Used referral code`,
      createdAt: new Date(),
    });
    if (refereeGam.claimHistory.length > 50) refereeGam.claimHistory.shift();
    await refereeGam.save();

    // 7. Mark bonuses as awarded
    referral.referrerBonusAwarded = true;
    referral.refereeBonusAwarded = true;
    await referral.save();

    return success(res, 'Referral code applied! You earned 50 bonus coins 🎉', {
      refereeNewBalance: refereeGam.coinsBalance,
      refereeBonus: 50,
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
