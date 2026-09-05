// src/__tests__/configFlow.integration.test.js
// Integration test: AppConfig model → GET /config/app → PATCH /config/app → GET /config/app
// Verifies the end-to-end config flow for coin_config propagation.

const { getAppConfig, updateAppConfig } = require('../controllers/config.controller');
const AppConfig = require('../models/AppConfig.model');
const {
  DEFAULT_RATE_PER_100_STEPS,
} = require('../constants/coinDefaults');

jest.mock('../models/AppConfig.model');

// updateAppConfig now reports what a day of rewards can actually pay, which
// means reading the live challenge set. Without a mock the query has no
// connection to buffer against and the request hangs past the test timeout.
jest.mock('../models/Challenge.model', () => ({
  find: jest.fn(() => ({
    select: jest.fn(() => ({
      lean: jest.fn().mockResolvedValue([
        { type: 'daily', coinReward: 30 },
        { type: 'daily', coinReward: 60 },
        { type: 'weekly', coinReward: 200 },
      ]),
    })),
  })),
}));

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

      // Fallback defaults from the controller's ?? operators. This used to be
      // 0.00095 here and 0.5 in every other reader, so a document missing the
      // field made the app show a rate 526x below what the server paid — the
      // whole point of constants/coinDefaults.js.
      expect(config.coin_config.steps.rate_per_100_steps).toBe(
        DEFAULT_RATE_PER_100_STEPS,
      );
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

    it('rejects invalid coin_value (NaN)', async () => {
      const req = {
        body: {
          coin_config: {
            rewards: { daily_step_goal_reached: { coin_value: 'abc' } },
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

  // The update gate is the one config block where a wrong value is invisible
  // from the outside: `force` has no dismiss in the app, and "no prompt at all"
  // is indistinguishable from "no prompt was wanted". Both directions are
  // pinned here.
  describe('forceUpdate gate', () => {
    const withGate = (forceUpdate) =>
      buildDefaultConfigDoc({ forceUpdate });

    const androidGate = (android) =>
      withGate({ enabled: true, android, ios: {} });

    it('GET exposes the stored gate so the admin panel can read it back', async () => {
      // This block used to be omitted from the response entirely. That is how
      // android sat on '0.0.77' — the package.json version, against clients
      // reporting versionName '1.77' — for as long as it did: every client
      // compared as newer, no prompt ever fired, and nothing anywhere showed
      // the stored value.
      AppConfig.findOne = jest.fn().mockResolvedValue(
        androidGate({
          minVersion: '1.77',
          latestVersion: '1.78',
          updateUrl: 'https://play.google.com/store/apps/details?id=com.athlofit.athlofit',
        }),
      );

      const res = mockRes();
      await getAppConfig({}, res, jest.fn());

      const gate = res.json.mock.calls[0][0].data.config.forceUpdate;
      expect(gate.android.minVersion).toBe('1.77');
      expect(gate.android.latestVersion).toBe('1.78');
      expect(gate.android.updateUrl).toContain('com.athlofit.athlofit');
    });

    it('GET reports an absent gate as empty rather than throwing', async () => {
      // Documents predating the feature have no forceUpdate block at all.
      AppConfig.findOne = jest.fn().mockResolvedValue(buildDefaultConfigDoc());

      const res = mockRes();
      await getAppConfig({}, res, jest.fn());

      const gate = res.json.mock.calls[0][0].data.config.forceUpdate;
      expect(gate.android.minVersion).toBe('');
      expect(gate.ios.latestVersion).toBe('');
    });

    it('rejects a minVersion raised above the STORED latestVersion', async () => {
      // The trap this whole validation exists for. The admin panel sends one
      // field at a time, so a lone minVersion looks fine in isolation and only
      // contradicts what is already in the database. versionGate then clamps it
      // back down at read time, so the save succeeds, nothing changes, and no
      // device is ever prompted.
      AppConfig.findOne = jest
        .fn()
        .mockResolvedValue(
          androidGate({ minVersion: '1.70', latestVersion: '1.77' }),
        );
      AppConfig.findOneAndUpdate = jest.fn();

      const res = mockRes();
      await updateAppConfig(
        { body: { forceUpdate: { android: { minVersion: '1.80' } } } },
        res,
        jest.fn(),
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].message).toContain('cannot exceed latestVersion');
      expect(AppConfig.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects a version that is not dotted-numeric', async () => {
      // resolveUpdateRequirement refuses to act on an unparseable version, so a
      // typo like 'v1.78' would store cleanly and then silently gate nobody.
      AppConfig.findOne = jest
        .fn()
        .mockResolvedValue(
          androidGate({ minVersion: '1.70', latestVersion: '1.77' }),
        );
      AppConfig.findOneAndUpdate = jest.fn();

      const res = mockRes();
      await updateAppConfig(
        { body: { forceUpdate: { android: { latestVersion: 'v1.78' } } } },
        res,
        jest.fn(),
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].message).toContain('dotted numeric version');
      expect(AppConfig.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('accepts a floor and a latest raised together', async () => {
      const stored = androidGate({ minVersion: '1.70', latestVersion: '1.77' });
      AppConfig.findOne = jest.fn().mockResolvedValue(stored);
      AppConfig.findOneAndUpdate = jest.fn().mockResolvedValue(stored);

      const res = mockRes();
      await updateAppConfig(
        {
          body: {
            forceUpdate: {
              android: { minVersion: '1.77', latestVersion: '1.78' },
            },
          },
        },
        res,
        jest.fn(),
      );

      expect(res.status).toHaveBeenCalledWith(200);
      const setMap = AppConfig.findOneAndUpdate.mock.calls[0][1].$set;
      expect(setMap['forceUpdate.android.minVersion']).toBe('1.77');
      expect(setMap['forceUpdate.android.latestVersion']).toBe('1.78');
    });

    it('lets an unrelated field be saved even when a stored version is malformed', async () => {
      // Only incoming fields are shape-checked. If a pre-existing bad value
      // could block edits to this block, a config could be wedged with no way
      // to correct it through the API.
      const stored = androidGate({ minVersion: 'garbage', latestVersion: '' });
      AppConfig.findOne = jest.fn().mockResolvedValue(stored);
      AppConfig.findOneAndUpdate = jest.fn().mockResolvedValue(stored);

      const res = mockRes();
      await updateAppConfig(
        { body: { forceUpdate: { android: { updateUrl: 'https://example.com' } } } },
        res,
        jest.fn(),
      );

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
