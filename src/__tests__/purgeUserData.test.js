// The property that matters here is not "does it delete things" — it is what
// happens when one delete FAILS. A partial purge that still removes the user
// document leaves the remaining rows orphaned under an id that resolves to
// nobody, and the retry can never find them again because the cron searches for
// due requests by querying users. That is the exact compliance failure the
// deletion feature exists to fix, reintroduced as a partial success reported as
// a finished one.
//
// Names are `mock`-prefixed because jest hoists mock factories above the file,
// and a factory may only close over variables with that prefix.

const mockCalls = [];
const mockFailing = new Set();

const mockMakeModel = (name) => ({
  deleteMany: async () => {
    mockCalls.push(`${name}.deleteMany`);
    if (mockFailing.has(name)) throw new Error('simulated failure');
    return { deletedCount: 1 };
  },
  updateMany: async () => {
    mockCalls.push(`${name}.updateMany`);
    if (mockFailing.has(name)) throw new Error('simulated failure');
    return { modifiedCount: 1 };
  },
  deleteOne: async () => {
    mockCalls.push(`${name}.deleteOne`);
    return { deletedCount: 1 };
  },
  findById: () => ({
    select: async () => ({ _id: 'u1', avatarUrl: 'https://cdn/avatar.png' }),
  }),
});

jest.mock('../models/HealthActivity.model', () => mockMakeModel('HealthActivity'));
jest.mock('../models/BmiRecord.model', () => mockMakeModel('BmiRecord'));
jest.mock('../models/MealLog.model', () => mockMakeModel('MealLog'));
jest.mock('../models/NutritionPreference.model', () => mockMakeModel('NutritionPreference'));
jest.mock('../models/SearchLog.model', () => mockMakeModel('SearchLog'));
jest.mock('../models/CoinTransaction.model', () => mockMakeModel('CoinTransaction'));
jest.mock('../models/Gamification.model', () => mockMakeModel('Gamification'));
jest.mock('../models/UserChallenge.model', () => mockMakeModel('UserChallenge'));
jest.mock('../models/Notification.model', () => mockMakeModel('Notification'));
jest.mock('../models/RefreshToken.model', () => mockMakeModel('RefreshToken'));
jest.mock('../models/CheatFlag.model', () => mockMakeModel('CheatFlag'));
jest.mock('../models/BonusSteps.model', () => mockMakeModel('BonusSteps'));
jest.mock('../models/Referral.model', () => mockMakeModel('Referral'));
jest.mock('../models/Order.model', () => mockMakeModel('Order'));
jest.mock('../models/SupportTicket.model', () => mockMakeModel('SupportTicket'));
jest.mock('../models/User.model', () => mockMakeModel('User'));

jest.mock('../utils/uploadImage', () => ({
  deleteImage: async () => { mockCalls.push('avatar.delete'); },
}));

const { purgeUserData } = require('../utils/purgeUserData');

beforeEach(() => {
  mockCalls.length = 0;
  mockFailing.clear();
});

describe('purgeUserData — clean run', () => {
  it('reports no errors and removes the user last', async () => {
    const r = await purgeUserData('u1');
    expect(r.errors).toEqual([]);
    // Ordering matters even on success: while the user exists the account is
    // still findable by an admin and the run is still resumable.
    expect(mockCalls[mockCalls.length - 1]).toBe('User.deleteOne');
  });

  it('retains orders and support tickets, scrubbing them instead of deleting', async () => {
    await purgeUserData('u1');
    // Financial and dispute records outlive the account; the person does not.
    expect(mockCalls).toContain('Order.updateMany');
    expect(mockCalls).not.toContain('Order.deleteMany');
    expect(mockCalls).toContain('SupportTicket.updateMany');
    expect(mockCalls).not.toContain('SupportTicket.deleteMany');
  });

  it('deletes the avatar from object storage', async () => {
    // Outside Mongo, so nothing else would ever remove it.
    await purgeUserData('u1');
    expect(mockCalls).toContain('avatar.delete');
  });

  it('revokes refresh tokens rather than retaining them', async () => {
    await purgeUserData('u1');
    expect(mockCalls).toContain('RefreshToken.deleteMany');
  });
});

describe('purgeUserData — partial failure', () => {
  it('keeps the user document so the run stays retryable', async () => {
    mockFailing.add('HealthActivity');
    const r = await purgeUserData('u1');

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/healthActivity/);
    // The critical assertion. Deleting the user here would orphan the health
    // rows permanently — with the user gone there is nothing left to retry
    // against, and the data the user asked to erase stays forever.
    expect(mockCalls).not.toContain('User.deleteOne');
  });

  it('still attempts every other collection rather than aborting', async () => {
    mockFailing.add('HealthActivity');
    const r = await purgeUserData('u1');
    // A failure early in the list must not stop the rest — otherwise one bad
    // collection blocks the whole purge indefinitely.
    expect(mockCalls).toContain('CoinTransaction.deleteMany');
    expect(mockCalls).toContain('Order.updateMany');
    expect(Object.keys(r.deleted).length).toBeGreaterThan(10);
  });

  it('collects every failure, not just the first', async () => {
    mockFailing.add('HealthActivity');
    mockFailing.add('CoinTransaction');
    const r = await purgeUserData('u1');
    expect(r.errors).toHaveLength(2);
    expect(mockCalls).not.toContain('User.deleteOne');
  });
});
