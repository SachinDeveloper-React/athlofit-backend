// src/__tests__/backwardCompatibility.integration.test.js
// Integration tests for backward compatibility (Properties 4 & 5)
//
// **Property 4: Backward Compatibility**
// Config endpoint always includes all existing top-level sections
// (coin, steps, rewards, features, maintenance, support) with unchanged structure.
//
// **Property 5: Existing Source Preservation**
// Streak bonus, login reward, and referral bonus operations produce identical
// results before and after this change.
//
// **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 9.3**

// Mock all external dependencies before requiring modules
jest.mock('../models/AppConfig.model');
jest.mock('../models/Gamification.model');
jest.mock('../models/BadgeDefinition.model');
jest.mock('../models/HealthActivity.model');
jest.mock('../utils/pushNotification', () => ({ sendPushToUser: jest.fn() }));
jest.mock('../utils/createNotification', () => ({ createNotification: jest.fn() }));
jest.mock('../utils/date', () => ({ todayISO: jest.fn(() => '2025-01-15') }));

const fc = require('fast-check');
const { getAppConfig } = require('../controllers/config.controller');
const { claimReward } = require('../controllers/gamification.controller');
const AppConfig = require('../models/AppConfig.model');

// --- Helpers ---

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function buildDefaultConfigDoc(coinConfigOverride) {
  return {
    key: 'global',
    coin: {
      conversionRate: 10,
      dailyEarnLimit: 10,
      maxDailyRewards: 250,
      coinsPerStepKm: 1,
      purchaseEnabled: true,
      referrerBonus: 200,
      refereeBonus: 100,
    },
    steps: {
      defaultDailyGoal: 8000,
      maxDailyGoal: 30000,
    },
    rewards: {
      stepGoalCoins: 50,
      hydrationGoalCoins: 20,
      hydrationGoalMl: 2000,
    },
    features: {
      shopEnabled: true,
      ordersEnabled: true,
      healthAnalyticsEnabled: true,
      referralEnabled: true,
      leaderboardEnabled: true,
    },
    maintenance: {
      enabled: false,
      message: 'We are under maintenance. Back soon!',
    },
    support: {
      email: 'support@athlofit.com',
      website: 'www.athlofit.com/faq',
    },
    coin_config: coinConfigOverride ?? {
      steps: { rate_per_100_steps: 0.00095 },
      rewards: { daily_step_goal_reached: { enabled: true, coin_value: 50 } },
    },
  };
}

// --- Property 4: Backward Compatibility ---
// **Validates: Requirements 9.3**

describe('Property 4: Backward Compatibility — Config endpoint includes all existing sections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /config/app always includes all 7 top-level sections regardless of coin_config values', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          rate_per_100_steps: fc.double({ min: 0.00001, max: 1.0, noNaN: true }),
          enabled: fc.boolean(),
          coin_value: fc.nat({ max: 10000 }),
        }),
        async ({ rate_per_100_steps, enabled, coin_value }) => {
          const cfgDoc = buildDefaultConfigDoc({
            steps: { rate_per_100_steps },
            rewards: { daily_step_goal_reached: { enabled, coin_value } },
          });

          AppConfig.findOne = jest.fn().mockResolvedValue(cfgDoc);

          const req = {};
          const res = mockRes();
          const next = jest.fn();

          await getAppConfig(req, res, next);

          expect(next).not.toHaveBeenCalled();
          expect(res.status).toHaveBeenCalledWith(200);

          const config = res.json.mock.calls[0][0].data.config;

          // All 7 sections must exist
          expect(config).toHaveProperty('coin');
          expect(config).toHaveProperty('steps');
          expect(config).toHaveProperty('rewards');
          expect(config).toHaveProperty('features');
          expect(config).toHaveProperty('maintenance');
          expect(config).toHaveProperty('support');
          expect(config).toHaveProperty('coin_config');
        }
      ),
      { numRuns: 50 }
    );
  });

  it('coin section keys remain unchanged regardless of coin_config values', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          rate_per_100_steps: fc.double({ min: 0.00001, max: 1.0, noNaN: true }),
          enabled: fc.boolean(),
          coin_value: fc.nat({ max: 10000 }),
        }),
        async ({ rate_per_100_steps, enabled, coin_value }) => {
          const cfgDoc = buildDefaultConfigDoc({
            steps: { rate_per_100_steps },
            rewards: { daily_step_goal_reached: { enabled, coin_value } },
          });

          AppConfig.findOne = jest.fn().mockResolvedValue(cfgDoc);

          const res = mockRes();
          await getAppConfig({}, res, jest.fn());

          const config = res.json.mock.calls[0][0].data.config;

          // coin section structure unchanged
          expect(config.coin).toEqual({
            conversionRate: 10,
            dailyEarnLimit: 10,
            maxDailyRewards: 250,
            coinsPerStepKm: 1,
            purchaseEnabled: true,
            referrerBonus: 200,
            refereeBonus: 100,
          });

          // steps section structure unchanged
          expect(config.steps).toEqual({
            defaultDailyGoal: 8000,
            maxDailyGoal: 30000,
          });

          // rewards section structure unchanged
          expect(config.rewards).toEqual({
            stepGoalCoins: 50,
            hydrationGoalCoins: 20,
            hydrationGoalMl: 2000,
          });

          // features section structure unchanged
          expect(config.features).toEqual({
            shopEnabled: true,
            ordersEnabled: true,
            healthAnalyticsEnabled: true,
            referralEnabled: true,
            leaderboardEnabled: true,
          });

          // maintenance section structure unchanged
          expect(config.maintenance).toEqual({
            enabled: false,
            message: 'We are under maintenance. Back soon!',
          });

          // support section structure unchanged
          expect(config.support).toEqual({
            email: 'support@athlofit.com',
            website: 'www.athlofit.com/faq',
          });
        }
      ),
      { numRuns: 50 }
    );
  });

  it('referral bonus values (referrerBonus, refereeBonus) are always present in config', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          rate_per_100_steps: fc.double({ min: 0.00001, max: 1.0, noNaN: true }),
          coin_value: fc.nat({ max: 10000 }),
        }),
        async ({ rate_per_100_steps, coin_value }) => {
          const cfgDoc = buildDefaultConfigDoc({
            steps: { rate_per_100_steps },
            rewards: { daily_step_goal_reached: { enabled: true, coin_value } },
          });

          AppConfig.findOne = jest.fn().mockResolvedValue(cfgDoc);

          const res = mockRes();
          await getAppConfig({}, res, jest.fn());

          const config = res.json.mock.calls[0][0].data.config;

          // Referral bonus values must always be served
          expect(typeof config.coin.referrerBonus).toBe('number');
          expect(typeof config.coin.refereeBonus).toBe('number');
          expect(config.coin.referrerBonus).toBe(200);
          expect(config.coin.refereeBonus).toBe(100);
        }
      ),
      { numRuns: 30 }
    );
  });
});

// --- Property 5: Existing Source Preservation ---
// **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 5.7**

describe('Property 5: Existing Source Preservation — hydration, streak, and referral unmodified', () => {
  const Gamification = require('../models/Gamification.model');
  const BadgeDefinition = require('../models/BadgeDefinition.model');
  const HealthActivity = require('../models/HealthActivity.model');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('hydration_daily claim flow is unchanged', () => {
    it('hydration_daily reward uses cfg.rewards.hydrationGoalCoins, not coin_config', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Vary coin_config values to prove they don't affect hydration reward
          fc.record({
            rate_per_100_steps: fc.double({ min: 0.00001, max: 1.0, noNaN: true }),
            step_coin_value: fc.nat({ max: 10000 }),
          }),
          async ({ rate_per_100_steps, step_coin_value }) => {
            const cfgDoc = buildDefaultConfigDoc({
              steps: { rate_per_100_steps },
              rewards: { daily_step_goal_reached: { enabled: true, coin_value: step_coin_value } },
            });

            const mockGam = {
              user: 'user123',
              coinsBalance: 100,
              coinsEarnedToday: 0,
              streakDays: 5,
              lastCoinDate: null,
              lastWaterCoinDate: null,
              claimHistory: [],
              migrateOldBadges: jest.fn(),
              isBadgeUnlocked: jest.fn().mockReturnValue(false),
              unlockBadge: jest.fn(),
              save: jest.fn().mockResolvedValue(true),
            };

            AppConfig.findOne = jest.fn().mockResolvedValue(cfgDoc);
            Gamification.findOne = jest.fn().mockResolvedValue(mockGam);
            Gamification.create = jest.fn().mockResolvedValue(mockGam);
            BadgeDefinition.find = jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });

            // User met hydration goal (2100ml >= 2000ml threshold)
            HealthActivity.findOne = jest.fn().mockResolvedValue({
              steps: 5000,
              hydration: 2100,
            });

            const req = {
              user: { _id: 'user123', dailyStepGoal: 10000 },
              body: { rewardId: 'hydration_daily' },
            };
            const res = mockRes();
            const next = jest.fn();

            await claimReward(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);

            const responseBody = res.json.mock.calls[0][0];
            expect(responseBody.success).toBe(true);

            // Reward amount is always hydrationGoalCoins (20), not affected by coin_config
            expect(responseBody.data.newBalance).toBe(120); // 100 + 20
          }
        ),
        { numRuns: 30 }
      );
    });

    it('hydration_daily claim rejects when water goal not met, regardless of coin_config', async () => {
      const cfgDoc = buildDefaultConfigDoc({
        steps: { rate_per_100_steps: 0.5 },
        rewards: { daily_step_goal_reached: { enabled: true, coin_value: 9999 } },
      });

      const mockGam = {
        user: 'user123',
        coinsBalance: 100,
        coinsEarnedToday: 0,
        streakDays: 5,
        lastCoinDate: null,
        lastWaterCoinDate: null,
        claimHistory: [],
        migrateOldBadges: jest.fn(),
        isBadgeUnlocked: jest.fn().mockReturnValue(false),
        unlockBadge: jest.fn(),
        save: jest.fn().mockResolvedValue(true),
      };

      AppConfig.findOne = jest.fn().mockResolvedValue(cfgDoc);
      Gamification.findOne = jest.fn().mockResolvedValue(mockGam);
      BadgeDefinition.find = jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });

      // User has NOT met hydration goal (500ml < 2000ml)
      HealthActivity.findOne = jest.fn().mockResolvedValue({
        steps: 5000,
        hydration: 500,
      });

      const req = {
        user: { _id: 'user123', dailyStepGoal: 10000 },
        body: { rewardId: 'hydration_daily' },
      };
      const res = mockRes();
      const next = jest.fn();

      await claimReward(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].success).toBe(false);
      expect(res.json.mock.calls[0][0].message).toContain('not yet reached');
    });
  });

  describe('streak bonus logic is unaffected by coin_config changes', () => {
    it('streak badge reward uses BadgeDefinition.coinReward, not coin_config values', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            rate_per_100_steps: fc.double({ min: 0.00001, max: 1.0, noNaN: true }),
            step_coin_value: fc.nat({ max: 10000 }),
            badge_coin_reward: fc.integer({ min: 1, max: 500 }),
            streak_threshold: fc.integer({ min: 1, max: 30 }),
          }),
          async ({ rate_per_100_steps, step_coin_value, badge_coin_reward, streak_threshold }) => {
            const cfgDoc = buildDefaultConfigDoc({
              steps: { rate_per_100_steps },
              rewards: { daily_step_goal_reached: { enabled: true, coin_value: step_coin_value } },
            });

            const badgeKey = 'streak_test';
            const badgeDefs = [
              {
                _id: 'badge1',
                key: badgeKey,
                title: 'Test Badge',
                threshold: streak_threshold,
                coinReward: badge_coin_reward,
                isActive: true,
              },
            ];

            const mockGam = {
              user: 'user123',
              coinsBalance: 100,
              coinsEarnedToday: 0,
              streakDays: streak_threshold, // meets threshold
              lastCoinDate: null,
              lastWaterCoinDate: null,
              claimHistory: [],
              migrateOldBadges: jest.fn(),
              isBadgeUnlocked: jest.fn().mockReturnValue(false), // not yet claimed
              unlockBadge: jest.fn(),
              save: jest.fn().mockResolvedValue(true),
            };

            AppConfig.findOne = jest.fn().mockResolvedValue(cfgDoc);
            Gamification.findOne = jest.fn().mockResolvedValue(mockGam);
            Gamification.create = jest.fn().mockResolvedValue(mockGam);
            BadgeDefinition.find = jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue(badgeDefs) });
            HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 5000, hydration: 0 });

            const req = {
              user: { _id: 'user123', dailyStepGoal: 10000 },
              body: { rewardId: `streak_${badgeKey}` },
            };
            const res = mockRes();
            const next = jest.fn();

            await claimReward(req, res, next);

            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);

            const responseBody = res.json.mock.calls[0][0];
            expect(responseBody.success).toBe(true);

            // The reward amount is badge_coin_reward from BadgeDefinition, not from coin_config
            const expectedBalance = 100 + Math.min(badge_coin_reward, 250); // capped at maxDailyRewards
            expect(responseBody.data.newBalance).toBe(expectedBalance);

            // unlockBadge was called (streak logic path preserved)
            expect(mockGam.unlockBadge).toHaveBeenCalledWith(badgeKey);
          }
        ),
        { numRuns: 30 }
      );
    });

    it('streak badge claim rejected if streak not met, regardless of coin_config', async () => {
      const cfgDoc = buildDefaultConfigDoc({
        steps: { rate_per_100_steps: 0.9 },
        rewards: { daily_step_goal_reached: { enabled: true, coin_value: 5000 } },
      });

      const badgeDefs = [
        {
          _id: 'badge1',
          key: 'streak_7',
          title: '7-Day Streak',
          threshold: 7,
          coinReward: 100,
          isActive: true,
        },
      ];

      const mockGam = {
        user: 'user123',
        coinsBalance: 50,
        coinsEarnedToday: 0,
        streakDays: 3, // does NOT meet 7-day threshold
        lastCoinDate: null,
        lastWaterCoinDate: null,
        claimHistory: [],
        migrateOldBadges: jest.fn(),
        isBadgeUnlocked: jest.fn().mockReturnValue(false),
        unlockBadge: jest.fn(),
        save: jest.fn().mockResolvedValue(true),
      };

      AppConfig.findOne = jest.fn().mockResolvedValue(cfgDoc);
      Gamification.findOne = jest.fn().mockResolvedValue(mockGam);
      BadgeDefinition.find = jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue(badgeDefs) });
      HealthActivity.findOne = jest.fn().mockResolvedValue({ steps: 5000, hydration: 0 });

      const req = {
        user: { _id: 'user123', dailyStepGoal: 10000 },
        body: { rewardId: 'streak_streak_7' },
      };
      const res = mockRes();
      const next = jest.fn();

      await claimReward(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].success).toBe(false);
      expect(res.json.mock.calls[0][0].message).toContain('not yet reached');
    });
  });

  describe('referral bonus values served via config are preserved', () => {
    it('config always serves referrerBonus and refereeBonus from coin section regardless of coin_config', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            rate_per_100_steps: fc.double({ min: 0.00001, max: 1.0, noNaN: true }),
            enabled: fc.boolean(),
            coin_value: fc.nat({ max: 10000 }),
          }),
          async ({ rate_per_100_steps, enabled, coin_value }) => {
            const cfgDoc = buildDefaultConfigDoc({
              steps: { rate_per_100_steps },
              rewards: { daily_step_goal_reached: { enabled, coin_value } },
            });

            AppConfig.findOne = jest.fn().mockResolvedValue(cfgDoc);

            const res = mockRes();
            await getAppConfig({}, res, jest.fn());

            const config = res.json.mock.calls[0][0].data.config;

            // Referral bonus values always come from coin section, never from coin_config
            expect(config.coin.referrerBonus).toBe(200);
            expect(config.coin.refereeBonus).toBe(100);

            // Referral values are independent of coin_config
            expect(config.coin_config).not.toHaveProperty('referrerBonus');
            expect(config.coin_config).not.toHaveProperty('refereeBonus');
          }
        ),
        { numRuns: 30 }
      );
    });

    it('config coin section keys match expected schema for referral bonuses', () => {
      const cfgDoc = buildDefaultConfigDoc();

      AppConfig.findOne = jest.fn().mockResolvedValue(cfgDoc);

      return getAppConfig({}, mockRes(), jest.fn()).then(() => {
        const res = mockRes();
        AppConfig.findOne = jest.fn().mockResolvedValue(cfgDoc);
        return getAppConfig({}, res, jest.fn()).then(() => {
          const config = res.json.mock.calls[0][0].data.config;
          const expectedCoinKeys = [
            'conversionRate',
            'dailyEarnLimit',
            'maxDailyRewards',
            'coinsPerStepKm',
            'purchaseEnabled',
            'referrerBonus',
            'refereeBonus',
          ];
          expect(Object.keys(config.coin).sort()).toEqual(expectedCoinKeys.sort());
        });
      });
    });
  });

  describe('earnCoins (step-based) endpoint is unchanged structurally', () => {
    const { earnCoins } = require('../controllers/gamification.controller');

    it('earnCoins still applies daily cap from cfg.coin.maxDailyRewards, not coin_config', async () => {
      const cfgDoc = buildDefaultConfigDoc({
        steps: { rate_per_100_steps: 0.5 },
        rewards: { daily_step_goal_reached: { enabled: true, coin_value: 9999 } },
      });

      const mockGam = {
        user: 'user123',
        coinsBalance: 50,
        coinsEarnedToday: 200, // already earned 200 of max 250
        lastCoinDate: '2025-01-15', // matches mocked todayISO so it won't reset
        claimHistory: [],
        save: jest.fn().mockResolvedValue(true),
      };

      AppConfig.findOne = jest.fn().mockResolvedValue(cfgDoc);
      Gamification.findOne = jest.fn().mockResolvedValue(mockGam);

      const req = {
        user: { _id: 'user123' },
        body: { coinsToAdd: 100 }, // wants 100 but only 50 remaining
      };
      const res = mockRes();
      const next = jest.fn();

      await earnCoins(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);

      const data = res.json.mock.calls[0][0].data;
      // Capped at 50 (250 max - 200 already earned)
      expect(data.coinsEarnedToday).toBe(250);
      expect(data.coinsBalance).toBe(100); // 50 + 50 capped
    });
  });
});
