// athlofit-backend/src/seedCoupons.js
// Run: node src/seedCoupons.js
// Seeds sample coupons into the database.

require('dotenv').config();
const mongoose = require('mongoose');
const Coupon = require('./models/Coupon.model');

const COUPONS = [
  {
    code: 'WELCOME50',
    description: '50% off your first order (up to 500 coins)',
    discountType: 'percentage',
    discountValue: 50,
    maxDiscountCoins: 500,
    minCartCoins: 0,
    perUserLimit: 1,
    usageLimit: null,
    isActive: true,
  },
  {
    code: 'FLAT250',
    description: 'Flat 250 coins off on orders above 3,000 coins',
    discountType: 'flat_coins',
    discountValue: 250,
    maxDiscountCoins: null,
    minCartCoins: 3000,
    perUserLimit: 1,
    usageLimit: null,
    isActive: true,
  },
  {
    code: 'SAVE20',
    description: '20% off (up to 1,000 coins)',
    discountType: 'percentage',
    discountValue: 20,
    maxDiscountCoins: 1000,
    minCartCoins: 0,
    perUserLimit: 1,
    usageLimit: null,
    isActive: true,
  },
  {
    code: 'BIGDEAL',
    description: 'Flat 1,000 coins off on orders above 5,000 coins',
    discountType: 'flat_coins',
    discountValue: 1000,
    maxDiscountCoins: null,
    minCartCoins: 5000,
    perUserLimit: 1,
    usageLimit: null,
    isActive: true,
  },
  {
    code: 'HEALTH30',
    description: '30% off for fitness enthusiasts (up to 750 coins)',
    discountType: 'percentage',
    discountValue: 30,
    maxDiscountCoins: 750,
    minCartCoins: 0,
    perUserLimit: 1,
    usageLimit: null,
    isActive: true,
  },
];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  for (const c of COUPONS) {
    await Coupon.findOneAndUpdate(
      { code: c.code },
      { $set: c },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    console.log(`✓ Upserted coupon: ${c.code}`);
  }

  console.log('\nAll coupons seeded!');
  await mongoose.disconnect();
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
