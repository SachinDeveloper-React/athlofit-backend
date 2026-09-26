// src/__tests__/claimReward.test.js
// Unit tests for claimReward steps_daily logic with coin_config

const { claimReward } = require('../controllers/gamification.controller');

// Mock all external dependencies
jest.mock('../models/AppConfig.model');
jest.mock('../models/Gamification.model');
jest.mock('../models/BadgeDefinition.model');
jest.mock('../models/HealthActivity.model');
jest.mock('../utils/pushNotification', () => ({ sendPushToUser: jest.fn() }));
jest.mock('../utils/createNotification', () => ({ createNotification: jest.fn() }));
jest.mock('../utils/logCoinTransaction', () => ({ logCoinTransaction: jest.fn() }));
jest.mock('../models/PendingCoin.model', () => ({ create: jest.fn(async (doc) => doc) }));

const AppConfig = require('../models/AppConfig.model');
const Gamification = require('../models/Gamification.model');
const BadgeDefinition = require('../models/BadgeDefinition.model');
const HealthActivity = require('../models/HealthActivity.model');
const PendingCoin = require('../models/PendingCoin.model');
const { logCoinTransaction } = require('../utils/logCoinTransaction');

// Mock todayISO to control the "today" value in tests
jest.mock('../utils/date', () => ({
  todayISO: jest.fn(() => '2025-01-15'),
  resolveCoinDay: jest.fn(() => '2025-01-15'),
}));

// --- Helpers ---

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function buildReq({ userId = 'user123', rewardId = 'steps_daily', dailyStepGoal = 10000 } = {}) {
  return {
    user: { _id: userId, dailyStepGoal, emailVerified: true },
    body: { rewardId },
  };
}

function buildGamDoc(overrides = {}) {
  return {
    coinsBalance: 0,
    coinsEarnedToday: 0,
    lastCoinDate: null,
    stepGoalCoinDate: null,
    lastWaterCoinDate: null,
    streakDays: 0,
    badgeList: [],
    claimHistory: [],
    migrateOldBadges: jest.fn(),
    isBadgeUnlocked: jest.fn(() => false),
    unlockBadge: jest.fn(),
    isBadgeClaimed: jest.fn(() => false),
    isBadgePayoutEligible: jest.fn(() => true),
    markBadgeClaimed: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Simulates MongoDB's $set/$inc/$push against the in-memory `gam` fixture, and
// wires it up as both Gamification.findOne and Gamification.findOneAndUpdate —
// mirroring what awardCappedCoins actually calls now that claimReward writes
// atomically instead of mutating `gam` in memory and calling `gam.save()`.
// The CAS filter (`coinsEarnedToday: <value just read>`) is honoured so a test
// that wants to exercise a lost race can still do so by mutating `gam` between
// the read and the write.
function mockGam(gam) {
  Gamification.findOne = jest.fn().mockResolvedValue(gam);
  Gamification.findOneAndUpdate = jest.fn(async (filter, update) => {
    if (filter.coinsEarnedToday !== undefined && filter.coinsEarnedToday !== (gam.coinsEarnedToday || 0)) {
      return null;
    }
    if (update.$set) Object.assign(gam, update.$set);
    if (update.$inc) {
      for (const [key, delta] of Object.entries(update.$inc)) {
        gam[key] = (gam[key] || 0) + delta;
      }
    }
    if (update.$push) {
      for (const [key, pushOp] of Object.entries(update.$push)) {
        const items = pushOp.$each ?? [pushOp];
        gam[key] = [...(gam[key] || []), ...items];
        if (pushOp.$slice) gam[key] = gam[key].slice(pushOp.$slice);
      }
    }
    return gam;
  });
  return gam;
}

function buildConfig(coinConfigOverrides = {}) {
  const defaultCoinConfig = {
    steps: { rate_per_100_steps: 0.00095 },
    rewards: {
      daily_step_goal_reached: { enabled: true, coin_value: 50 },
    },
  };

  return {
    coin: { maxDailyRewards: 250 },
    // One bonus, two fields, kept equal — see configuredStepGoalBonus.
    rewards: { stepGoalCoins: 50, hydrationGoalCoins: 20, hydrationGoalMl: 2000 },
    coin_config: { ...defaultCoinConfig, ...coinConfigOverrides },
  };
}

// --- Setup ---

beforeEach(() => {
  jest.clearAllMocks();

  // Default: BadgeDefinition returns no badges
  BadgeDefinition.find = jest.fn().mockReturnValue({
    sort: jest.fn().mockResolvedValue([]),
  });
});

// --- Tests ---

describe('claimReward - steps_daily', () => {
  // The bonus is read from rewards.stepGoalCoins — the field the admin panel
  // edits — through configuredStepGoalBonus; coin_value is a mirror the config
  // update path keeps equal. See the note in utils/stepGoalAward.js.
  describe('successful claim reads the bonus from rewards.stepGoalCoins', () => {
    it('awards rewards.stepGoalCoins when user meets step goal', async () => {
      const cfg = buildConfig();
      cfg.rewards.stepGoalCoins = 75;
      cfg.coin_config.rewards.daily_step_goal_reached.coin_value = 75;

      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      const gam = buildGamDoc({ coinsBalance: 100, coinsEarnedToday: 50 });
      mockGam(gam);

      // User has met step goal (12000 steps >= 10000 goal)
      HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 12000, hydration: 0 });

      const req = buildReq();
      const res = mockRes();
      const next = jest.fn();

      await claimReward(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'Claimed 75 coins!',
          data: expect.objectContaining({ newBalance: 175, rewardId: 'steps_daily' }),
        })
      );
      expect(gam.coinsBalance).toBe(175);
      expect(gam.coinsEarnedToday).toBe(125);
      expect(gam.stepGoalCoinDate).toBe('2025-01-15');
      // Credited atomically via Gamification.findOneAndUpdate ($inc), not a
      // full-document gam.save() — see the comment in claimReward.
      expect(Gamification.findOneAndUpdate).toHaveBeenCalled();
    });

    it('does not pay a coin_value the admin field no longer says (the 13-coin bug)', async () => {
      // The live document on 21 Sep: rewards.stepGoalCoins set to 0 by the
      // admin, coin_value still holding 13.25. The claim paid 13 every evening.
      const cfg = buildConfig();
      cfg.rewards.stepGoalCoins = 0;
      cfg.coin_config.rewards.daily_step_goal_reached.coin_value = 13.25;

      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      const gam = buildGamDoc();
      mockGam(gam);

      HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 30000, hydration: 0 });

      const req = buildReq();
      const res = mockRes();
      const next = jest.fn();

      await claimReward(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].message).toMatch(/disabled/i);
      expect(gam.coinsBalance).toBe(0);
      expect(Gamification.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('still pays when coin_config is missing entirely', async () => {
      const cfg = buildConfig();
      // Remove coin_config entirely: only the admin field is left.
      cfg.coin_config = undefined;
      cfg.rewards.stepGoalCoins = 30;

      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      const gam = buildGamDoc();
      mockGam(gam);

      HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 15000, hydration: 0 });

      const req = buildReq();
      const res = mockRes();
      const next = jest.fn();

      await claimReward(req, res, next);

      // cfg.rewards.stepGoalCoins = 30 is the bonus.
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'Claimed 30 coins!',
        })
      );
      expect(gam.coinsBalance).toBe(30);
    });
  });

  describe('claim rejection when enabled is false', () => {
    it('returns 400 with disabled message when enabled is false', async () => {
      const cfg = buildConfig();
      cfg.coin_config.rewards.daily_step_goal_reached.enabled = false;

      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      const gam = buildGamDoc();
      mockGam(gam);

      HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 15000, hydration: 0 });

      const req = buildReq();
      const res = mockRes();
      const next = jest.fn();

      await claimReward(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: 'Daily step goal reward is currently disabled',
        })
      );
      // Balance should not change
      expect(gam.coinsBalance).toBe(0);
      expect(gam.save).not.toHaveBeenCalled();
    });
  });

  describe('duplicate claim rejection (same calendar day)', () => {
    it('returns 400 when reward already claimed today', async () => {
      const cfg = buildConfig();
      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      // User already claimed today (stepGoalCoinDate === today)
      const gam = buildGamDoc({ stepGoalCoinDate: '2025-01-15', coinsEarnedToday: 50 });
      mockGam(gam);

      HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 12000, hydration: 0 });

      const req = buildReq();
      const res = mockRes();
      const next = jest.fn();

      await claimReward(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: 'Reward already claimed',
        })
      );
      expect(gam.save).not.toHaveBeenCalled();
    });

    it('allows claim on a different day after previous claim', async () => {
      const cfg = buildConfig();
      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      // Previous claim was yesterday
      const gam = buildGamDoc({ stepGoalCoinDate: '2025-01-14', coinsEarnedToday: 0 });
      mockGam(gam);

      HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 10500, hydration: 0 });

      const req = buildReq();
      const res = mockRes();
      const next = jest.fn();

      await claimReward(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'Claimed 50 coins!',
        })
      );
      expect(gam.stepGoalCoinDate).toBe('2025-01-15');
    });
  });

  describe('daily cap enforcement on step goal reward', () => {
    it('caps reward when remaining allowance is less than the bonus', async () => {
      const cfg = buildConfig();
      cfg.rewards.stepGoalCoins = 100;
      cfg.coin_config.rewards.daily_step_goal_reached.coin_value = 100;
      cfg.coin.maxDailyRewards = 250;

      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      // User has already earned 200 coins today; remaining = 250 - 200 = 50
      const gam = buildGamDoc({ coinsBalance: 500, coinsEarnedToday: 200 });
      mockGam(gam);

      HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 10000, hydration: 0 });

      const req = buildReq();
      const res = mockRes();
      const next = jest.fn();

      await claimReward(req, res, next);

      // Should only get 50 coins (capped by remaining allowance)
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'Claimed 50 coins!',
          data: expect.objectContaining({ newBalance: 550 }),
        })
      );
      expect(gam.coinsBalance).toBe(550);
      expect(gam.coinsEarnedToday).toBe(250);
    });

    it('awards 0 coins when daily cap is already reached', async () => {
      const cfg = buildConfig();
      cfg.rewards.stepGoalCoins = 50;
      cfg.coin_config.rewards.daily_step_goal_reached.coin_value = 50;
      cfg.coin.maxDailyRewards = 250;

      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      // User has already maxed out daily rewards
      const gam = buildGamDoc({ coinsBalance: 500, coinsEarnedToday: 250 });
      mockGam(gam);

      HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 12000, hydration: 0 });

      const req = buildReq();
      const res = mockRes();
      const next = jest.fn();

      await claimReward(req, res, next);

      // Award goes through but with 0 actual coins (capped)
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'Claimed 0 coins!',
        })
      );
      expect(gam.coinsBalance).toBe(500); // unchanged
      expect(gam.coinsEarnedToday).toBe(250); // unchanged
    });

    it('awards the full bonus when under the daily cap', async () => {
      const cfg = buildConfig();
      cfg.rewards.stepGoalCoins = 50;
      cfg.coin_config.rewards.daily_step_goal_reached.coin_value = 50;
      cfg.coin.maxDailyRewards = 250;

      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      // User has only earned 100 today; remaining = 150
      const gam = buildGamDoc({ coinsBalance: 300, coinsEarnedToday: 100 });
      mockGam(gam);

      HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 11000, hydration: 0 });

      const req = buildReq();
      const res = mockRes();
      const next = jest.fn();

      await claimReward(req, res, next);

      // Full 50 coins awarded (150 remaining > 50 reward)
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'Claimed 50 coins!',
          data: expect.objectContaining({ newBalance: 350 }),
        })
      );
      expect(gam.coinsBalance).toBe(350);
      expect(gam.coinsEarnedToday).toBe(150);
    });
  });
});

describe('claimReward - with step-coin settlement on', () => {
  // The step goal is a step coin: claimed and capped as before, but paid only
  // once the day is verified. Water is not, and is paid now as always.
  const settlementConfig = () => {
    const cfg = buildConfig();
    cfg.features = { stepCoinSettlement: true };
    return cfg;
  };

  it('records the step goal as pending instead of paying it', async () => {
    AppConfig.findOne = jest.fn().mockResolvedValue(settlementConfig());
    const gam = buildGamDoc({ coinsBalance: 100, coinsEarnedToday: 20 });
    mockGam(gam);
    HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 12000, hydration: 0 });

    const res = mockRes();
    await claimReward(buildReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].message).toMatch(/once today's steps are verified/);
    expect(res.json.mock.calls[0][0].data).toMatchObject({ newBalance: 100, coinsPendingAdded: 50 });
    // Not in the balance, but the day's allowance and the claim are spent —
    // so the cap and idempotency behave exactly as for a paid award.
    expect(gam.coinsBalance).toBe(100);
    expect(gam.coinsEarnedToday).toBe(70);
    expect(gam.stepGoalCoinDate).toBe('2025-01-15');

    expect(PendingCoin.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user123',
        date: '2025-01-15',
        source: 'DAILY_STEP_GOAL',
        amount: 50,
        metadata: expect.objectContaining({ goal: 10000, steps: 12000 }),
      }),
    );
    expect(logCoinTransaction).not.toHaveBeenCalled();
  });

  it('still pays the water goal straight away', async () => {
    AppConfig.findOne = jest.fn().mockResolvedValue(settlementConfig());
    const gam = buildGamDoc({ coinsBalance: 100 });
    mockGam(gam);
    HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 0, hydration: 2500 });

    const res = mockRes();
    await claimReward(buildReq({ rewardId: 'hydration_daily' }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(gam.coinsBalance).toBe(120);
    expect(PendingCoin.create).not.toHaveBeenCalled();
    expect(logCoinTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'HYDRATION_GOAL', amount: 20 }),
    );
  });
});
