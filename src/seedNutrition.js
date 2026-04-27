// src/seedNutrition.js
// ─── Seed the Food catalog with 40 realistic items ───────────────────────────
// Run: node src/seedNutrition.js

require('dotenv').config();
const mongoose = require('mongoose');
const Food     = require('./models/Food.model');

// ─── Image URLs (Unsplash CDN — free, no attribution required for seed use) ──
const IMAGES = {
  masalaOats:     'https://images.unsplash.com/photo-1614961233913-a5113a4a34ed?w=400&q=80',
  paratha:        'https://images.unsplash.com/photo-1702224985568-29daa72db36e?w=400&q=80',
  eggs:           'https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=400&q=80',
  smoothie:       'https://images.unsplash.com/photo-1553530666-ba11a90bb0ae?w=400&q=80',
  chiaPudding:    'https://images.unsplash.com/photo-1528207776546-365bb710ee93?w=400&q=80',
  poha:           'https://images.unsplash.com/photo-1674491370823-b6b3a51cba7b?w=400&q=80',
  yogurtGranola:  'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=400&q=80',
  scrambledEggs:  'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=400&q=80',
  chicken:        'https://images.unsplash.com/photo-1598514983318-2f64f8f4796c?w=400&q=80',
  dal:            'https://images.unsplash.com/photo-1617692855022-9abb94d8bfa0?w=400&q=80',
  salad:          'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400&q=80',
  paneerTikka:    'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=400&q=80',
  rajma:          'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=400&q=80',
  tunaSalad:      'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&q=80',
  quinoaBowl:     'https://images.unsplash.com/photo-1512058564366-18510be2db19?w=400&q=80',
  friedRice:      'https://images.unsplash.com/photo-1603133872878-684f208fb84b?w=400&q=80',
  palakPaneer:    'https://images.unsplash.com/photo-1631452180520-eb03e5c9b63b?w=400&q=80',
  salmon:         'https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=400&q=80',
  chickenSoup:    'https://images.unsplash.com/photo-1547592166-23ac45744acd?w=400&q=80',
  chanaMasala:    'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=400&q=80',
  sweetPotato:    'https://images.unsplash.com/photo-1596097557992-e4c5b97de200?w=400&q=80',
  mutton:         'https://images.unsplash.com/photo-1574484284002-952d92456975?w=400&q=80',
  tofuStirfry:    'https://images.unsplash.com/photo-1546069901-d5bfd2cbfb1f?w=400&q=80',
  roti:           'https://images.unsplash.com/photo-1603133872878-684f208fb84b?w=400&q=80',
  mushroomSoup:   'https://images.unsplash.com/photo-1608500218890-c4f9a6777a53?w=400&q=80',
  roastedChana:   'https://images.unsplash.com/photo-1604908177522-4d2a7d13bd50?w=400&q=80',
  applePButter:   'https://images.unsplash.com/photo-1619525289570-2d766b7ef1ce?w=400&q=80',
  mixedNuts:      'https://images.unsplash.com/photo-1599599810694-b5b37304c041?w=400&q=80',
  proteinBar:     'https://images.unsplash.com/photo-1622484212850-eb596d769edc?w=400&q=80',
  sproutsChaat:   'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400&q=80',
  banana:         'https://images.unsplash.com/photo-1571771894821-ce9b6c11b08e?w=400&q=80',
  paneerCubes:    'https://images.unsplash.com/photo-1567108218003-de06ece01dd0?w=400&q=80',
  boiledCorn:     'https://images.unsplash.com/photo-1551754655-cd27e38d2076?w=400&q=80',
  hummus:         'https://images.unsplash.com/photo-1534078362425-387ae9668c17?w=400&q=80',
  hardBoiledEgg:  'https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=400&q=80',
  darkChoc:       'https://images.unsplash.com/photo-1548907040-4baa42d10919?w=400&q=80',
  makhana:        'https://images.unsplash.com/photo-1604908177522-4d2a7d13bd50?w=400&q=80',
};

const FOODS = [
  // ──────────────────────────────── BREAKFAST ───────────────────────────────
  {
    name: 'Masala Oats',
    description: 'Rolled oats cooked with vegetables and Indian spices.',
    calories: 220, protein: 8, carbs: 38, fat: 4, fiber: 5, sugar: 3,
    servingSize: 200, servingUnit: 'g', dietType: 'vegan', category: 'breakfast',
    imageUrl: IMAGES.masalaOats,
  },
  {
    name: 'Paneer Paratha',
    description: 'Whole-wheat flatbread stuffed with spiced cottage cheese.',
    calories: 310, protein: 12, carbs: 40, fat: 11, fiber: 3, sugar: 2,
    servingSize: 1, servingUnit: 'serving', dietType: 'veg', category: 'breakfast',
    imageUrl: IMAGES.paratha,
  },
  {
    name: 'Boiled Egg White (2 pcs)',
    description: 'Hard-boiled egg whites — high protein, zero fat.',
    calories: 34, protein: 7, carbs: 0, fat: 0, fiber: 0, sugar: 0,
    servingSize: 2, servingUnit: 'piece', dietType: 'non-veg', category: 'breakfast',
    imageUrl: IMAGES.eggs,
  },
  {
    name: 'Banana Smoothie',
    description: 'Blended banana with low-fat milk and a dash of honey.',
    calories: 195, protein: 5, carbs: 38, fat: 2, fiber: 2, sugar: 28,
    servingSize: 300, servingUnit: 'ml', dietType: 'veg', category: 'breakfast',
    imageUrl: IMAGES.smoothie,
  },
  {
    name: 'Chia Pudding',
    description: 'Chia seeds soaked in almond milk, topped with berries.',
    calories: 180, protein: 6, carbs: 22, fat: 8, fiber: 10, sugar: 6,
    servingSize: 200, servingUnit: 'ml', dietType: 'vegan', category: 'breakfast',
    imageUrl: IMAGES.chiaPudding,
  },
  {
    name: 'Poha',
    description: 'Flattened rice stir-fried with onions, peas and peanuts.',
    calories: 245, protein: 5, carbs: 45, fat: 5, fiber: 3, sugar: 4,
    servingSize: 200, servingUnit: 'g', dietType: 'vegan', category: 'breakfast',
    imageUrl: IMAGES.poha,
  },
  {
    name: 'Greek Yogurt with Granola',
    description: 'Full-fat Greek yogurt topped with crunchy granola.',
    calories: 290, protein: 14, carbs: 34, fat: 9, fiber: 2, sugar: 18,
    servingSize: 250, servingUnit: 'g', dietType: 'veg', category: 'breakfast',
    imageUrl: IMAGES.yogurtGranola,
  },
  {
    name: 'Scrambled Eggs (2 eggs)',
    description: 'Two whole eggs scrambled with butter and herbs.',
    calories: 180, protein: 12, carbs: 1, fat: 14, fiber: 0, sugar: 0,
    servingSize: 2, servingUnit: 'piece', dietType: 'non-veg', category: 'breakfast',
    imageUrl: IMAGES.scrambledEggs,
  },

  // ─────────────────────────────────── LUNCH ────────────────────────────────
  {
    name: 'Grilled Chicken Breast',
    description: 'Skinless chicken breast grilled with olive oil and herbs.',
    calories: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0, sugar: 0,
    servingSize: 100, servingUnit: 'g', dietType: 'non-veg', category: 'lunch',
    imageUrl: IMAGES.chicken,
  },
  {
    name: 'Dal Tadka',
    description: 'Yellow lentils tempered with cumin, garlic and tomatoes.',
    calories: 230, protein: 14, carbs: 35, fat: 5, fiber: 8, sugar: 3,
    servingSize: 250, servingUnit: 'ml', dietType: 'vegan', category: 'lunch',
    imageUrl: IMAGES.dal,
  },
  {
    name: 'Mixed Veg Salad',
    description: 'Cucumber, tomato, carrot, lettuce with lemon dressing.',
    calories: 85, protein: 3, carbs: 16, fat: 1, fiber: 4, sugar: 8,
    servingSize: 200, servingUnit: 'g', dietType: 'vegan', category: 'lunch',
    imageUrl: IMAGES.salad,
  },
  {
    name: 'Paneer Tikka',
    description: 'Marinated cottage cheese cubes grilled in tandoor.',
    calories: 280, protein: 18, carbs: 10, fat: 18, fiber: 1, sugar: 4,
    servingSize: 150, servingUnit: 'g', dietType: 'veg', category: 'lunch',
    imageUrl: IMAGES.paneerTikka,
  },
  {
    name: 'Rajma Chawal',
    description: 'Kidney bean curry with steamed basmati rice.',
    calories: 410, protein: 16, carbs: 72, fat: 6, fiber: 10, sugar: 4,
    servingSize: 1, servingUnit: 'serving', dietType: 'vegan', category: 'lunch',
    imageUrl: IMAGES.rajma,
  },
  {
    name: 'Tuna Salad',
    description: 'Canned tuna with spring onions, celery and light mayo.',
    calories: 190, protein: 28, carbs: 5, fat: 6, fiber: 1, sugar: 2,
    servingSize: 200, servingUnit: 'g', dietType: 'non-veg', category: 'lunch',
    imageUrl: IMAGES.tunaSalad,
  },
  {
    name: 'Quinoa Bowl',
    description: 'Cooked quinoa with roasted vegetables and tahini dressing.',
    calories: 330, protein: 12, carbs: 50, fat: 9, fiber: 7, sugar: 5,
    servingSize: 1, servingUnit: 'serving', dietType: 'vegan', category: 'lunch',
    imageUrl: IMAGES.quinoaBowl,
  },
  {
    name: 'Egg Fried Rice',
    description: 'Stir-fried rice with eggs, spring onions and soy sauce.',
    calories: 375, protein: 14, carbs: 58, fat: 10, fiber: 2, sugar: 3,
    servingSize: 1, servingUnit: 'serving', dietType: 'non-veg', category: 'lunch',
    imageUrl: IMAGES.friedRice,
  },
  {
    name: 'Palak Paneer',
    description: 'Cottage cheese cubes in creamy spinach gravy.',
    calories: 260, protein: 14, carbs: 12, fat: 17, fiber: 3, sugar: 3,
    servingSize: 200, servingUnit: 'g', dietType: 'veg', category: 'lunch',
    imageUrl: IMAGES.palakPaneer,
  },

  // ─────────────────────────────────── DINNER ───────────────────────────────
  {
    name: 'Grilled Salmon Fillet',
    description: 'Atlantic salmon fillet grilled with lemon and dill.',
    calories: 208, protein: 28, carbs: 0, fat: 10, fiber: 0, sugar: 0,
    servingSize: 150, servingUnit: 'g', dietType: 'non-veg', category: 'dinner',
    imageUrl: IMAGES.salmon,
  },
  {
    name: 'Chicken Soup',
    description: 'Clear broth soup with shredded chicken and vegetables.',
    calories: 145, protein: 18, carbs: 10, fat: 3, fiber: 2, sugar: 4,
    servingSize: 350, servingUnit: 'ml', dietType: 'non-veg', category: 'dinner',
    imageUrl: IMAGES.chickenSoup,
  },
  {
    name: 'Chana Masala',
    description: 'Spiced chickpea curry with tomatoes, onion and garam masala.',
    calories: 270, protein: 13, carbs: 45, fat: 5, fiber: 12, sugar: 6,
    servingSize: 250, servingUnit: 'g', dietType: 'vegan', category: 'dinner',
    imageUrl: IMAGES.chanaMasala,
  },
  {
    name: 'Baked Sweet Potato',
    description: 'Oven-baked sweet potato with a sprinkle of cinnamon.',
    calories: 130, protein: 2, carbs: 30, fat: 0, fiber: 4, sugar: 6,
    servingSize: 150, servingUnit: 'g', dietType: 'vegan', category: 'dinner',
    imageUrl: IMAGES.sweetPotato,
  },
  {
    name: 'Mutton Curry (light)',
    description: 'Slow-cooked mutton in a mildly spiced gravy.',
    calories: 310, protein: 26, carbs: 8, fat: 18, fiber: 1, sugar: 3,
    servingSize: 200, servingUnit: 'g', dietType: 'non-veg', category: 'dinner',
    imageUrl: IMAGES.mutton,
  },
  {
    name: 'Tofu Stir-fry',
    description: 'Extra-firm tofu stir-fried with bell peppers and tamari.',
    calories: 195, protein: 15, carbs: 10, fat: 11, fiber: 2, sugar: 5,
    servingSize: 200, servingUnit: 'g', dietType: 'vegan', category: 'dinner',
    imageUrl: IMAGES.tofuStirfry,
  },
  {
    name: 'Methi Roti',
    description: 'Whole-wheat flatbread made with fresh fenugreek leaves.',
    calories: 120, protein: 4, carbs: 22, fat: 2, fiber: 3, sugar: 0,
    servingSize: 1, servingUnit: 'piece', dietType: 'vegan', category: 'dinner',
    imageUrl: IMAGES.roti,
  },
  {
    name: 'Mushroom Soup',
    description: 'Creamy mushroom and garlic soup with vegetable broth.',
    calories: 155, protein: 4, carbs: 14, fat: 9, fiber: 2, sugar: 5,
    servingSize: 300, servingUnit: 'ml', dietType: 'veg', category: 'dinner',
    imageUrl: IMAGES.mushroomSoup,
  },

  // ─────────────────────────────────── SNACKS ───────────────────────────────
  {
    name: 'Roasted Chana',
    description: 'Dry-roasted Bengal gram — high protein, low oil.',
    calories: 165, protein: 9, carbs: 26, fat: 3, fiber: 7, sugar: 1,
    servingSize: 50, servingUnit: 'g', dietType: 'vegan', category: 'snacks',
    imageUrl: IMAGES.roastedChana,
  },
  {
    name: 'Apple with Peanut Butter',
    description: 'One medium apple with one tablespoon of peanut butter.',
    calories: 190, protein: 4, carbs: 26, fat: 8, fiber: 4, sugar: 18,
    servingSize: 1, servingUnit: 'serving', dietType: 'vegan', category: 'snacks',
    imageUrl: IMAGES.applePButter,
  },
  {
    name: 'Mixed Nuts (30g)',
    description: 'Almonds, walnuts and cashews — great heart-healthy snack.',
    calories: 185, protein: 5, carbs: 8, fat: 16, fiber: 2, sugar: 2,
    servingSize: 30, servingUnit: 'g', dietType: 'vegan', category: 'snacks',
    imageUrl: IMAGES.mixedNuts,
  },
  {
    name: 'Protein Bar',
    description: 'Commercial whey protein bar with 20g protein.',
    calories: 220, protein: 20, carbs: 22, fat: 6, fiber: 3, sugar: 8,
    servingSize: 1, servingUnit: 'piece', dietType: 'non-veg', category: 'snacks',
    imageUrl: IMAGES.proteinBar,
  },
  {
    name: 'Sprouts Chaat',
    description: 'Mixed sprouted legumes with chaat masala and lemon.',
    calories: 115, protein: 8, carbs: 18, fat: 1, fiber: 5, sugar: 2,
    servingSize: 150, servingUnit: 'g', dietType: 'vegan', category: 'snacks',
    imageUrl: IMAGES.sproutsChaat,
  },
  {
    name: 'Banana',
    description: 'Medium ripe banana — quick energy source.',
    calories: 89, protein: 1, carbs: 23, fat: 0, fiber: 3, sugar: 12,
    servingSize: 1, servingUnit: 'piece', dietType: 'vegan', category: 'snacks',
    imageUrl: IMAGES.banana,
  },
  {
    name: 'Paneer Cubes',
    description: 'Raw cottage cheese cubes — great post-workout snack.',
    calories: 265, protein: 18, carbs: 1, fat: 20, fiber: 0, sugar: 0,
    servingSize: 100, servingUnit: 'g', dietType: 'veg', category: 'snacks',
    imageUrl: IMAGES.paneerCubes,
  },
  {
    name: 'Boiled Corn',
    description: 'Steamed sweet corn with lemon and spices.',
    calories: 90, protein: 3, carbs: 19, fat: 1, fiber: 2, sugar: 3,
    servingSize: 100, servingUnit: 'g', dietType: 'vegan', category: 'snacks',
    imageUrl: IMAGES.boiledCorn,
  },
  {
    name: 'Hummus with Veggie Sticks',
    description: 'Chickpea hummus served with carrot and cucumber sticks.',
    calories: 155, protein: 5, carbs: 18, fat: 7, fiber: 5, sugar: 4,
    servingSize: 1, servingUnit: 'serving', dietType: 'vegan', category: 'snacks',
    imageUrl: IMAGES.hummus,
  },
  {
    name: 'Hard-Boiled Egg',
    description: 'One whole hard-boiled egg — easy portable protein.',
    calories: 78, protein: 6, carbs: 1, fat: 5, fiber: 0, sugar: 1,
    servingSize: 1, servingUnit: 'piece', dietType: 'non-veg', category: 'snacks',
    imageUrl: IMAGES.hardBoiledEgg,
  },
  {
    name: 'Dark Chocolate (70%)',
    description: '2 squares of 70% dark chocolate — antioxidant-rich treat.',
    calories: 110, protein: 1, carbs: 12, fat: 7, fiber: 2, sugar: 8,
    servingSize: 20, servingUnit: 'g', dietType: 'vegan', category: 'snacks',
    imageUrl: IMAGES.darkChoc,
  },
  {
    name: 'Makhana (Fox Nuts)',
    description: 'Dry-roasted lotus seeds — light, crunchy and low-cal.',
    calories: 100, protein: 4, carbs: 20, fat: 0, fiber: 2, sugar: 0,
    servingSize: 30, servingUnit: 'g', dietType: 'vegan', category: 'snacks',
    imageUrl: IMAGES.makhana,
  },
];

async function seedNutrition() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // Clear existing
    await Food.deleteMany({});
    console.log('🗑️  Cleared existing food catalog');

    // Insert all
    const inserted = await Food.insertMany(FOODS);
    console.log(`🌱 Inserted ${inserted.length} food items`);

    // Summary by category
    const cats = ['breakfast', 'lunch', 'dinner', 'snacks'];
    for (const cat of cats) {
      const count = inserted.filter(f => f.category === cat).length;
      console.log(`   📌 ${cat}: ${count} items`);
    }

    console.log('\n✅ Nutrition seed complete!');
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

seedNutrition();
