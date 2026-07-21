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

const AppConfig = require('../models/AppConfig.model');
const Gamification = require('../models/Gamification.model');
const BadgeDefinition = require('../models/BadgeDefinition.model');
const HealthActivity = require('../models/HealthActivity.model');

// Mock todayISO to control the "today" value in tests
jest.mock('../utils/date', () => ({
  todayISO: jest.fn(() => '2025-01-15'),
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
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
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
    rewards: { stepGoalCoins: 30, hydrationGoalCoins: 20, hydrationGoalMl: 2000 },
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
  describe('successful claim reads coin_value from coin_config', () => {
    it('awards coin_value from coin_config when user meets step goal', async () => {
      const cfg = buildConfig();
      cfg.coin_config.rewards.daily_step_goal_reached.coin_value = 75;

      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      const gam = buildGamDoc({ coinsBalance: 100, coinsEarnedToday: 50 });
      Gamification.findOne = jest.fn().mockResolvedValue(gam);

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
      expect(gam.save).toHaveBeenCalled();
    });

    it('falls back to cfg.rewards.stepGoalCoins when coin_config is missing', async () => {
      const cfg = buildConfig();
      // Remove coin_config entirely to test fallback
      cfg.coin_config = undefined;

      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      const gam = buildGamDoc();
      Gamification.findOne = jest.fn().mockResolvedValue(gam);

      HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 15000, hydration: 0 });

      const req = buildReq();
      const res = mockRes();
      const next = jest.fn();

      await claimReward(req, res, next);

      // Falls back to cfg.rewards.stepGoalCoins = 30
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
      Gamification.findOne = jest.fn().mockResolvedValue(gam);

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
      Gamification.findOne = jest.fn().mockResolvedValue(gam);

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
      Gamification.findOne = jest.fn().mockResolvedValue(gam);

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
    it('caps reward when remaining allowance is less than coin_value', async () => {
      const cfg = buildConfig();
      cfg.coin_config.rewards.daily_step_goal_reached.coin_value = 100;
      cfg.coin.maxDailyRewards = 250;

      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      // User has already earned 200 coins today; remaining = 250 - 200 = 50
      const gam = buildGamDoc({ coinsBalance: 500, coinsEarnedToday: 200 });
      Gamification.findOne = jest.fn().mockResolvedValue(gam);

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
      cfg.coin_config.rewards.daily_step_goal_reached.coin_value = 50;
      cfg.coin.maxDailyRewards = 250;

      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      // User has already maxed out daily rewards
      const gam = buildGamDoc({ coinsBalance: 500, coinsEarnedToday: 250 });
      Gamification.findOne = jest.fn().mockResolvedValue(gam);

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

    it('awards full coin_value when under the daily cap', async () => {
      const cfg = buildConfig();
      cfg.coin_config.rewards.daily_step_goal_reached.coin_value = 50;
      cfg.coin.maxDailyRewards = 250;

      AppConfig.findOne = jest.fn().mockResolvedValue(cfg);

      // User has only earned 100 today; remaining = 150
      const gam = buildGamDoc({ coinsBalance: 300, coinsEarnedToday: 100 });
      Gamification.findOne = jest.fn().mockResolvedValue(gam);

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
