// src/migrations/tagFoodGoals.js
// ─── One-time migration: auto-tag existing foods with dietary goals ──────────
// Run with: node src/migrations/tagFoodGoals.js
//
// Logic (per 100g serving normalized):
//   weight_loss   → low calorie (≤150 kcal) OR high fiber (≥5g) OR low fat (≤3g)
//   muscle_gain   → high protein (≥15g per serving)
//   endurance     → high carbs (≥30g per serving) AND moderate protein
//   maintenance   → balanced macro profile (not extreme in any direction)
//
// A food can have multiple goal tags.

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Food = require('../models/Food.model');
const { connectDB } = require('../config/db');

function determineGoals(food) {
  const goals = [];
  const { calories, protein, carbs, fat, fiber } = food;

  // Normalize to per-100g if serving size differs
  const servingSize = food.servingSize || 100;
  const factor = 100 / servingSize;
  const cal100  = calories * factor;
  const pro100  = protein * factor;
  const carb100 = carbs * factor;
  const fat100  = fat * factor;
  const fib100  = (fiber || 0) * factor;

  // ── Weight Loss: low calorie, high fiber, low fat ───────────────────────
  if (cal100 <= 150 || fib100 >= 5 || fat100 <= 3) {
    goals.push('weight_loss');
  }

  // ── Muscle Gain: high protein ───────────────────────────────────────────
  if (pro100 >= 15) {
    goals.push('muscle_gain');
  }

  // ── Endurance: high carbs with moderate-to-good protein ─────────────────
  if (carb100 >= 30 && pro100 >= 5) {
    goals.push('endurance');
  }

  // ── Maintenance: balanced (not extreme calorie, reasonable macros) ──────
  if (cal100 >= 80 && cal100 <= 350 && pro100 >= 5 && carb100 >= 10 && fat100 <= 25) {
    goals.push('maintenance');
  }

  // If nothing matched, tag as maintenance (safe default)
  if (goals.length === 0) {
    goals.push('maintenance');
  }

  return goals;
}

async function run() {
  await connectDB();
  console.log('Connected to DB. Starting food goal tagging...\n');

  const cursor = Food.find({ isActive: true }).cursor();
  let updated = 0;
  let skipped = 0;

  for (let food = await cursor.next(); food != null; food = await cursor.next()) {
    const goals = determineGoals(food);

    // Only update if goals differ from current
    const currentGoals = (food.goals || []).sort().join(',');
    const newGoals = goals.sort().join(',');

    if (currentGoals !== newGoals) {
      food.goals = goals;
      await food.save();
      updated++;
      if (updated <= 10) {
        console.log(`  ✓ ${food.name}: [${goals.join(', ')}]`);
      }
    } else {
      skipped++;
    }
  }

  console.log(`\nDone! Updated: ${updated}, Skipped (already tagged): ${skipped}`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
