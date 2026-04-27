// node src/seedChallenges.js
require('dotenv').config();
const mongoose = require('mongoose');
const Challenge = require('./models/Challenge.model');

const CHALLENGES = [
  // ════════════════════════════════════════════════════════════════════════════
  //  DAILY — FITNESS
  // ════════════════════════════════════════════════════════════════════════════
  {
    title: 'Step Starter',
    description: 'Walk 5,000 steps today — a great start!',
    emoji: '👟', color: '#0099FF', category: 'fitness',
    type: 'daily', criteriaType: 'STEPS', targetValue: 5000, coinReward: 30, order: 1,
  },
  {
    title: 'Step Master',
    description: 'Walk 10,000 steps today and hit your full goal.',
    emoji: '🏃', color: '#0077CC', category: 'fitness',
    type: 'daily', criteriaType: 'STEPS', targetValue: 10000, coinReward: 60, order: 2,
  },
  {
    title: 'Calorie Torch',
    description: 'Burn 300 active calories today.',
    emoji: '🔥', color: '#F97316', category: 'fitness',
    type: 'daily', criteriaType: 'CALORIES', targetValue: 300, coinReward: 40, order: 3,
  },
  {
    title: '4000 Kcal Burner',
    description: 'Burn 4,000 active calories today — elite level!',
    emoji: '💥', color: '#DC2626', category: 'fitness',
    type: 'daily', criteriaType: 'CALORIES', targetValue: 4000, coinReward: 150, order: 4,
  },
  {
    title: 'Active 30',
    description: 'Stay active for at least 30 minutes today.',
    emoji: '⏱️', color: '#F59E0B', category: 'fitness',
    type: 'daily', criteriaType: 'ACTIVE_MINUTES', targetValue: 30, coinReward: 35, order: 5,
  },
  {
    title: 'Active Hour',
    description: 'Stay active for 60 minutes today.',
    emoji: '💪', color: '#D97706', category: 'fitness',
    type: 'daily', criteriaType: 'ACTIVE_MINUTES', targetValue: 60, coinReward: 60, order: 6,
  },
  {
    title: 'Daily Distance',
    description: 'Cover 3 km today.',
    emoji: '🗺️', color: '#10B981', category: 'fitness',
    type: 'daily', criteriaType: 'DISTANCE', targetValue: 3, coinReward: 35, order: 7,
  },

  // ════════════════════════════════════════════════════════════════════════════
  //  DAILY — HYDRATION
  // ════════════════════════════════════════════════════════════════════════════
  {
    title: 'Hydration Starter',
    description: 'Drink 1,000 ml of water today.',
    emoji: '💧', color: '#06B6D4', category: 'hydration',
    type: 'daily', criteriaType: 'HYDRATION', targetValue: 1000, coinReward: 20, order: 8,
  },
  {
    title: 'Hydration Hero',
    description: 'Drink 2,000 ml of water today — stay hydrated!',
    emoji: '🌊', color: '#0891B2', category: 'hydration',
    type: 'daily', criteriaType: 'HYDRATION', targetValue: 2000, coinReward: 35, order: 9,
  },
  {
    title: 'Water Champion',
    description: 'Drink 3,000 ml of water today.',
    emoji: '🏆', color: '#0E7490', category: 'hydration',
    type: 'daily', criteriaType: 'HYDRATION', targetValue: 3000, coinReward: 50, order: 10,
  },

  // ════════════════════════════════════════════════════════════════════════════
  //  DAILY — NUTRITION
  // ════════════════════════════════════════════════════════════════════════════
  {
    title: 'Meal Logger',
    description: 'Log at least 3 meals today.',
    emoji: '🍽️', color: '#10B981', category: 'nutrition',
    type: 'daily', criteriaType: 'MEALS_LOGGED', targetValue: 3, coinReward: 25, order: 11,
  },
  {
    title: 'Full Day Logger',
    description: 'Log all 4 meals today (breakfast, lunch, dinner, snacks).',
    emoji: '📋', color: '#059669', category: 'nutrition',
    type: 'daily', criteriaType: 'MEALS_LOGGED', targetValue: 4, coinReward: 40, order: 12,
  },
  {
    title: 'Calorie Goal',
    description: 'Log 1,500 kcal in meals today.',
    emoji: '🥗', color: '#22C55E', category: 'nutrition',
    type: 'daily', criteriaType: 'NUTRITION_CALORIES', targetValue: 1500, coinReward: 30, order: 13,
  },
  {
    title: 'Protein Power',
    description: 'Log 100g of protein in meals today.',
    emoji: '🥩', color: '#EF4444', category: 'nutrition',
    type: 'daily', criteriaType: 'NUTRITION_PROTEIN', targetValue: 100, coinReward: 45, order: 14,
  },
  {
    title: 'Egg Champion',
    description: 'Log eggs in your meals today.',
    emoji: '🥚', color: '#F59E0B', category: 'nutrition',
    type: 'daily', criteriaType: 'SPECIFIC_FOOD', targetFood: 'egg', targetValue: 1, coinReward: 20, order: 15,
  },

  // ════════════════════════════════════════════════════════════════════════════
  //  WEEKLY — FITNESS
  // ════════════════════════════════════════════════════════════════════════════
  {
    title: 'Weekly Walker',
    description: 'Walk 50,000 steps this week.',
    emoji: '🚶', color: '#6366F1', category: 'fitness',
    type: 'weekly', criteriaType: 'STEPS', targetValue: 50000, coinReward: 200, order: 16,
  },
  {
    title: 'Step Legend',
    description: 'Walk 70,000 steps this week — elite performance!',
    emoji: '🦸', color: '#4F46E5', category: 'fitness',
    type: 'weekly', criteriaType: 'STEPS', targetValue: 70000, coinReward: 300, order: 17,
  },
  {
    title: 'Distance Warrior',
    description: 'Cover 30 km this week.',
    emoji: '🏅', color: '#8B5CF6', category: 'fitness',
    type: 'weekly', criteriaType: 'DISTANCE', targetValue: 30, coinReward: 150, order: 18,
  },
  {
    title: 'Active Week',
    description: 'Stay active for 150 minutes this week.',
    emoji: '💪', color: '#EF4444', category: 'fitness',
    type: 'weekly', criteriaType: 'ACTIVE_MINUTES', targetValue: 150, coinReward: 180, order: 19,
  },
  {
    title: 'Weekly Calorie Burn',
    description: 'Burn 2,000 active calories this week.',
    emoji: '🔥', color: '#F97316', category: 'fitness',
    type: 'weekly', criteriaType: 'CALORIES', targetValue: 2000, coinReward: 160, order: 20,
  },

  // ════════════════════════════════════════════════════════════════════════════
  //  WEEKLY — HYDRATION
  // ════════════════════════════════════════════════════════════════════════════
  {
    title: 'Hydration Week',
    description: 'Drink 14,000 ml of water this week.',
    emoji: '🌊', color: '#0EA5E9', category: 'hydration',
    type: 'weekly', criteriaType: 'HYDRATION', targetValue: 14000, coinReward: 120, order: 21,
  },

  // ════════════════════════════════════════════════════════════════════════════
  //  WEEKLY — NUTRITION
  // ════════════════════════════════════════════════════════════════════════════
  {
    title: '5-Day Nutrition Streak',
    description: 'Log meals on 5 different days this week.',
    emoji: '📅', color: '#10B981', category: 'nutrition',
    type: 'weekly', criteriaType: 'NUTRITION_DAYS', targetValue: 5, coinReward: 150, order: 22,
  },
  {
    title: 'Weekly Protein Goal',
    description: 'Log 500g of protein across all meals this week.',
    emoji: '💪', color: '#DC2626', category: 'nutrition',
    type: 'weekly', criteriaType: 'NUTRITION_PROTEIN', targetValue: 500, coinReward: 200, order: 23,
  },
  {
    title: '30-Day Egg Challenge',
    description: 'Log eggs in your meals this week (4 days minimum).',
    emoji: '🥚', color: '#F59E0B', category: 'nutrition',
    type: 'weekly', criteriaType: 'SPECIFIC_FOOD', targetFood: 'egg', targetValue: 4, coinReward: 100, order: 24,
  },
  {
    title: 'Weekly Calorie Log',
    description: 'Log 10,000 kcal in meals across the week.',
    emoji: '🥗', color: '#22C55E', category: 'nutrition',
    type: 'weekly', criteriaType: 'NUTRITION_CALORIES', targetValue: 10000, coinReward: 130, order: 25,
  },
];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  let created = 0, updated = 0;
  for (const c of CHALLENGES) {
    const result = await Challenge.findOneAndUpdate(
      { title: c.title, type: c.type },
      { $set: c },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    if (result.createdAt?.getTime() === result.updatedAt?.getTime()) created++;
    else updated++;
    console.log(`  ${c.type.padEnd(6)} [${c.category.padEnd(10)}] ${c.emoji} ${c.title}`);
  }

  console.log(`\n✅ Done — ${created} created, ${updated} updated`);
  await mongoose.disconnect();
}

seed().catch(console.error);
