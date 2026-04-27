const mongoose = require('mongoose');
require('dotenv').config();

const Achievement = require('./src/models/Achievement.model');

async function seed() {
  await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true });

  const achievements = [
    { key: 'first_10k', title: 'First 10K', description: 'Walk 10,000 steps in a single day.', reward: 100, criteriaType: 'STEPS_DAILY', targetValue: 10000, icon: 'Footprints' },
    { key: 'marathon', title: 'Marathon Walker', description: 'Accumulate 42,000 lifetime steps.', reward: 500, criteriaType: 'STEPS_TOTAL', targetValue: 42000, icon: 'Award' },
    { key: 'shopaholic', title: 'Shopaholic', description: 'Complete 3 orders.', reward: 200, criteriaType: 'ORDERS_COUNT', targetValue: 3, icon: 'ShoppingBag' },
    { key: 'hydration_master', title: 'Hydration Master', description: 'Drink 10,000ml of water total.', reward: 150, criteriaType: 'WATER_TOTAL', targetValue: 10000, icon: 'Droplets' }
  ];

  for (let ach of achievements) {
    await Achievement.findOneAndUpdate({ key: ach.key }, ach, { upsert: true });
  }

  console.log('Achievements seeded!');
  process.exit(0);
}

seed().catch(console.error);
