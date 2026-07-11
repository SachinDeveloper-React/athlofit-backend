// src/__tests__/configFlow.integration.test.js
// Integration test: AppConfig model → GET /config/app → PATCH /config/app → GET /config/app
// Verifies the end-to-end config flow for coin_config propagation.

const { getAppConfig, updateAppConfig } = require('../controllers/config.controller');
const AppConfig = require('../models/AppConfig.model');

jest.mock('../models/AppConfig.model');

// --- Helpers ---

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function buildDefaultConfigDoc(overrides = {}) {
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
    coin_config: {
      steps: {
        rate_per_100_steps: 0.00095,
      },
      rewards: {
        daily_step_goal_reached: {
          enabled: true,
          coin_value: 50,
        },
      },
    },
    ...overrides,
  };
}

// --- Tests ---

describe('Config Flow Integration: GET → PATCH → GET', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /config/app returns coin_config with defaults', () => {
    it('returns coin_config section with correct default values', async () => {
      const cfgDoc = buildDefaultConfigDoc();
      AppConfig.findOne = jest.fn().mockResolvedValue(cfgDoc);

      const req = {};
      const res = mockRes();
      const next = jest.fn();

      await getAppConfig(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);

      const responseBody = res.json.mock.calls[0][0];
      expect(responseBody.success).toBe(true);
      expect(responseBody.data.config).toBeDefined();

      const config = responseBody.data.config;

      // Verify coin_config is present with defaults
      expect(config.coin_config).toBeDefined();
      expect(config.coin_config.steps.rate_per_100_steps).toBe(0.00095);
      expect(config.coin_config.rewards.daily_step_goal_reached).toEqual({
        enabled: true,
        coin_value: 50,
      });

      // Verify other top-level sections are still present (backward compatibility)
      expect(config.coin).toBeDefined();
      expect(config.steps).toBeDefined();
      expect(config.rewards).toBeDefined();
      expect(config.features).toBeDefined();
      expect(config.maintenance).toBeDefined();
      expect(config.support).toBeDefined();
    });

    it('applies safe fallbacks when coin_config is missing from document', async () => {
      // Simulate a document that was created before coin_config field was added
      const cfgDoc = buildDefaultConfigDoc();
      cfgDoc.coin_config = undefined;

      AppConfig.findOne = jest.fn().mockResolvedValue(cfgDoc);

      const req = {};
      const res = mockRes();
      const next = jest.fn();

      await getAppConfig(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);

      const config = res.json.mock.calls[0][0].data.config;

      // Fallback defaults from the controller's ?? operators
      expect(config.coin_config.steps.rate_per_100_steps).toBe(0.00095);
      expect(config.coin_config.rewards.daily_step_goal_reached.enabled).toBe(true);
      expect(config.coin_config.rewards.daily_step_goal_reached.coin_value).toBe(50);
    });

    it('seeds a new config doc if none exists', async () => {
      const cfgDoc = buildDefaultConfigDoc();
      AppConfig.findOne = jest.fn().mockResolvedValue(null);
      AppConfig.create = jest.fn().mockResolvedValue(cfgDoc);

      const req = {};
      const res = mockRes();
      const next = jest.fn();

      await getAppConfig(req, res, next);

      expect(AppConfig.create).toHaveBeenCalledWith({ key: 'global' });
      expect(res.status).toHaveBeenCalledWith(200);

      const config = res.json.mock.calls[0][0].data.config;
      expect(config.coin_config).toBeDefined();
      expect(config.coin_config.steps.rate_per_100_steps).toBe(0.00095);
    });
  });

  describe('PATCH /config/app with coin_config updates', () => {
    it('updates coin_config.steps.rate_per_100_steps successfully', async () => {
      const updatedDoc = buildDefaultConfigDoc();
      updatedDoc.coin_config.steps.rate_per_100_steps = 0.005;

      AppConfig.findOneAndUpdate = jest.fn().mockResolvedValue(updatedDoc);

      const req = {
        body: {
          coin_config: {
            steps: {
              rate_per_100_steps: 0.005,
            },
          },
        },
      };
      const res = mockRes();
      const next = jest.fn();

      await updateAppConfig(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);

      // Verify findOneAndUpdate was called with the correct flat $set map
      const updateCall = AppConfig.findOneAndUpdate.mock.calls[0];
      expect(updateCall[0]).toEqual({ key: 'global' });
      expect(updateCall[1].$set['coin_config.steps.rate_per_100_steps']).toBe(0.005);
    });

    it('updates coin_config.rewards.daily_step_goal_reached fields', async () => {
      const updatedDoc = buildDefaultConfigDoc();
      updatedDoc.coin_config.rewards.daily_step_goal_reached = {
        enabled: false,
        coin_value: 100,
      };

      AppConfig.findOneAndUpdate = jest.fn().mockResolvedValue(updatedDoc);

      const req = {
        body: {
          coin_config: {
            rewards: {
              daily_step_goal_reached: {
                enabled: false,
                coin_value: 100,
              },
            },
          },
        },
      };
      const res = mockRes();
      const next = jest.fn();

      await updateAppConfig(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);

      const setMap = AppConfig.findOneAndUpdate.mock.calls[0][1].$set;
      expect(setMap['coin_config.rewards.daily_step_goal_reached.enabled']).toBe(false);
      expect(setMap['coin_config.rewards.daily_step_goal_reached.coin_value']).toBe(100);
    });

    it('rejects invalid rate_per_100_steps (negative)', async () => {
      const req = {
        body: {
          coin_config: { steps: { rate_per_100_steps: -0.5 } },
        },
      };
      const res = mockRes();
      const next = jest.fn();

      await updateAppConfig(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].success).toBe(false);
      expect(res.json.mock.calls[0][0].message).toContain('rate_per_100_steps');
      expect(AppConfig.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects invalid rate_per_100_steps (> 1000)', async () => {
      const req = {
        body: {
          coin_config: { steps: { rate_per_100_steps: 1500 } },
        },
      };
      const res = mockRes();
      const next = jest.fn();

      await updateAppConfig(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].success).toBe(false);
      expect(AppConfig.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects invalid coin_value (negative integer)', async () => {
      const req = {
        body: {
          coin_config: {
            rewards: { daily_step_goal_reached: { coin_value: -10 } },
          },
        },
      };
      const res = mockRes();
      const next = jest.fn();

      await updateAppConfig(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].success).toBe(false);
      expect(res.json.mock.calls[0][0].message).toContain('coin_value');
      expect(AppConfig.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects non-integer coin_value', async () => {
      const req = {
        body: {
          coin_config: {
            rewards: { daily_step_goal_reached: { coin_value: 50.5 } },
          },
        },
      };
      const res = mockRes();
      const next = jest.fn();

      await updateAppConfig(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].success).toBe(false);
      expect(AppConfig.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('Full round-trip: PATCH then GET shows updated values', () => {
    it('GET returns new coin_config values after PATCH updates them', async () => {
      // Step 1: Initial GET - returns defaults
      const initialDoc = buildDefaultConfigDoc();
      AppConfig.findOne = jest.fn().mockResolvedValue(initialDoc);

      const res1 = mockRes();
      await getAppConfig({}, res1, jest.fn());

      const initialConfig = res1.json.mock.calls[0][0].data.config;
      expect(initialConfig.coin_config.steps.rate_per_100_steps).toBe(0.00095);
      expect(initialConfig.coin_config.rewards.daily_step_goal_reached.coin_value).toBe(50);

      // Step 2: PATCH with new values
      const updatedDoc = buildDefaultConfigDoc({
        coin_config: {
          steps: { rate_per_100_steps: 0.01 },
          rewards: { daily_step_goal_reached: { enabled: true, coin_value: 200 } },
        },
      });
      AppConfig.findOneAndUpdate = jest.fn().mockResolvedValue(updatedDoc);

      const patchReq = {
        body: {
          coin_config: {
            steps: { rate_per_100_steps: 0.01 },
            rewards: { daily_step_goal_reached: { coin_value: 200 } },
          },
        },
      };
      const res2 = mockRes();
      await updateAppConfig(patchReq, res2, jest.fn());

      expect(res2.status).toHaveBeenCalledWith(200);

      // Step 3: Subsequent GET returns updated values
      AppConfig.findOne = jest.fn().mockResolvedValue(updatedDoc);

      const res3 = mockRes();
      await getAppConfig({}, res3, jest.fn());

      const updatedConfig = res3.json.mock.calls[0][0].data.config;
      expect(updatedConfig.coin_config.steps.rate_per_100_steps).toBe(0.01);
      expect(updatedConfig.coin_config.rewards.daily_step_goal_reached.coin_value).toBe(200);
      expect(updatedConfig.coin_config.rewards.daily_step_goal_reached.enabled).toBe(true);
    });

    it('partial PATCH of coin_config does not affect unrelated config sections', async () => {
      // PATCH only coin_config fields
      const updatedDoc = buildDefaultConfigDoc({
        coin_config: {
          steps: { rate_per_100_steps: 0.002 },
          rewards: { daily_step_goal_reached: { enabled: true, coin_value: 50 } },
        },
      });
      AppConfig.findOneAndUpdate = jest.fn().mockResolvedValue(updatedDoc);

      const patchReq = {
        body: {
          coin_config: { steps: { rate_per_100_steps: 0.002 } },
        },
      };
      const res = mockRes();
      await updateAppConfig(patchReq, res, jest.fn());

      // Subsequent GET
      AppConfig.findOne = jest.fn().mockResolvedValue(updatedDoc);
      const res2 = mockRes();
      await getAppConfig({}, res2, jest.fn());

      const config = res2.json.mock.calls[0][0].data.config;

      // coin_config updated
      expect(config.coin_config.steps.rate_per_100_steps).toBe(0.002);

      // Other sections intact (backward compatibility)
      expect(config.coin.conversionRate).toBe(10);
      expect(config.coin.dailyEarnLimit).toBe(10);
      expect(config.steps.defaultDailyGoal).toBe(8000);
      expect(config.rewards.stepGoalCoins).toBe(50);
      expect(config.features.shopEnabled).toBe(true);
      expect(config.maintenance.enabled).toBe(false);
      expect(config.support.email).toBe('support@athlofit.com');
    });
  });
});
