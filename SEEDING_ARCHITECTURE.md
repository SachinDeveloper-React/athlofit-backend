# Database Seeding Architecture

This document explains the architecture and flow of the AthloFit database seeding system.

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    npm run seed:complete                     │
│                     (seedComplete.js)                        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ├─► 1. seedNutrition.js
                       │   └─► Foods (40+)
                       │   └─► Food Synonyms (10)
                       │
                       ├─► 2. seedChallenges.js
                       │   └─► Challenges (25)
                       │
                       ├─► 3. seedShop.js
                       │   └─► Categories (5)
                       │   └─► Products (12)
                       │
                       ├─► 4. seedSynonyms.js
                       │   └─► Food Synonyms (10)
                       │
                       ├─► 5. seedBadges.js
                       │   └─► Badge Definitions (6)
                       │
                       └─► 6. seedAll.js
                           ├─► Users (3)
                           ├─► Gamification (3)
                           ├─► Health Activities (90)
                           ├─► BMI Records (30)
                           ├─► Nutrition Preferences (3)
                           ├─► Meal Logs (~60)
                           ├─► Notifications (~20)
                           ├─► Referrals (1)
                           ├─► Achievements (4)
                           ├─► App Config (1)
                           ├─► FAQs (6)
                           ├─► Legal Content (2)
                           └─► Support Tickets (3)
```

## 📦 Seed Script Hierarchy

### Level 1: Independent Seeds
These can run independently and have no dependencies:

```
seedNutrition.js    → Foods, Food Synonyms
seedChallenges.js   → Challenges
seedShop.js         → Categories, Products
seedBadges.js       → Badge Definitions
seedSynonyms.js     → Food Synonyms
```

### Level 2: Dependent Seed
This depends on Level 1 seeds:

```
seedAll.js          → Everything else
├─ Checks for Foods (from seedNutrition.js)
├─ Checks for Challenges (from seedChallenges.js)
└─ Checks for Shop data (from seedShop.js)
```

### Level 3: Orchestrator
Runs everything in the correct order:

```
seedComplete.js     → Runs all seeds sequentially
```

## 🔄 Data Flow

```
┌──────────────┐
│   MongoDB    │
└──────┬───────┘
       │
       ├─► Clear existing data (deleteMany)
       │
       ├─► Insert seed data (create/insertMany)
       │
       └─► Verify counts (countDocuments)
```

## 🔗 Model Dependencies

```
User
 ├─► Gamification (user reference)
 ├─► HealthActivity (user reference)
 ├─► BmiRecord (user reference)
 ├─► NutritionPreference (user reference)
 ├─► MealLog (user reference)
 ├─► Notification (user reference)
 ├─► Referral (referrer/referee references)
 └─► SupportTicket (user reference)

Food
 └─► MealLog (foodRef reference)

Challenge
 └─► UserChallenge (challenge reference)

Category
 └─► Product (category reference)
```

## 📋 Execution Order

The `seedComplete.js` orchestrator ensures this order:

1. **Nutrition** → Creates food catalog
2. **Challenges** → Creates challenge definitions
3. **Shop** → Creates categories and products
4. **Synonyms** → Creates food synonyms
5. **Badges** → Creates badge definitions
6. **Core Data** → Creates everything else (with references)

## 🎯 Design Principles

### 1. Idempotency
Every seed script can be run multiple times safely:
```javascript
// Clear before seeding
await Model.deleteMany({});

// Insert fresh data
await Model.create(data);
```

### 2. Dependency Checking
`seedAll.js` checks for dependencies:
```javascript
const foods = await Food.find({});
if (foods.length > 0) {
  await seedMealLogs(users, foods);
} else {
  console.log('⚠️  No foods found. Run seedNutrition.js first.');
}
```

### 3. Referential Integrity
Seeds maintain proper relationships:
```javascript
// Create users first
const users = await seedUsers();

// Then create dependent data
await seedGamification(users);
await seedHealthActivities(users);
```

### 4. Realistic Data
All data is production-like:
- Proper date ranges
- Realistic values
- Valid relationships
- Meaningful content

## 🛠️ Script Structure

Each seed script follows this pattern:

```javascript
// 1. Import dependencies
require('dotenv').config();
const mongoose = require('mongoose');
const Model = require('./models/Model.model');

// 2. Define seed data
const DATA = [ /* ... */ ];

// 3. Seed function
async function seed() {
  try {
    // Connect
    await mongoose.connect(process.env.MONGO_URI);
    
    // Clear
    await Model.deleteMany({});
    
    // Insert
    const created = await Model.insertMany(DATA);
    
    // Report
    console.log(`✅ Created ${created.length} records`);
    
    // Disconnect
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  }
}

// 4. Execute
seed();
```

## 🔍 Verification Flow

```
npm run seed:verify
       │
       ├─► Check seed files exist
       ├─► Check model files exist
       ├─► Check .env exists
       ├─► Check npm scripts configured
       └─► Check documentation exists
       │
       └─► Report: ✅ All checks passed
```

## 📊 Data Volume

```
Small Seeds (< 10 records)
├─ Users: 3
├─ Gamification: 3
├─ Badge Definitions: 6
├─ Categories: 5
├─ Achievements: 4
├─ App Config: 1
├─ Legal Content: 2
└─ Referrals: 1

Medium Seeds (10-50 records)
├─ Foods: 40+
├─ Products: 12
├─ Challenges: 25
├─ Notifications: ~20
├─ BMI Records: 30
├─ Food Synonyms: 10
├─ FAQs: 6
└─ Support Tickets: 3

Large Seeds (50+ records)
├─ Health Activities: 90
└─ Meal Logs: ~60

Total: ~300+ records
```

## 🚀 Performance

Typical execution times:

```
seedNutrition.js    → ~2 seconds
seedChallenges.js   → ~1 second
seedShop.js         → ~1 second
seedBadges.js       → ~1 second
seedSynonyms.js     → ~1 second
seedAll.js          → ~3 seconds

Total (seed:complete) → ~10 seconds
```

## 🔐 Safety Features

### 1. Environment Check
```javascript
if (!process.env.MONGO_URI) {
  console.error('❌ MONGO_URI not configured');
  process.exit(1);
}
```

### 2. Connection Validation
```javascript
try {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB');
} catch (error) {
  console.error('❌ Connection failed:', error);
  process.exit(1);
}
```

### 3. Error Handling
```javascript
try {
  await seedFunction();
} catch (error) {
  console.error('❌ Seed failed:', error);
  process.exit(1);
}
```

### 4. Production Warning
All documentation warns against running in production.

## 🎨 Console Output

Seeds provide rich console feedback:

```
🌱 Seeding Users...
✅ Created 3 users

📦 Seeding Gamification...
✅ Created 3 gamification profiles

📊 Summary:
   Users: 3
   Gamification: 3
   Health Activities: 90
   ...

🔑 Test Credentials:
   User: john@example.com / Password123!
```

## 🔄 Update Strategy

When models change:

1. Update the model file
2. Update the corresponding seed script
3. Update SEED_DATA_SUMMARY.md
4. Run `npm run seed:verify`
5. Test with `npm run seed:complete`

## 📝 Best Practices

1. **Always clear before seeding** - Ensures clean state
2. **Use meaningful data** - Makes testing easier
3. **Maintain relationships** - Keep referential integrity
4. **Log progress** - Help debug issues
5. **Handle errors** - Exit with proper codes
6. **Document changes** - Update guides when adding data

## 🎯 Extension Points

To add new seed data:

1. Create new seed script: `src/seedNewFeature.js`
2. Add npm script: `"seed:newfeature": "node src/seedNewFeature.js"`
3. Add to `seedComplete.js` SEEDS array
4. Update documentation
5. Run verification

---

**Architecture Version**: 1.0  
**Last Updated**: 2024  
**Status**: Production Ready ✅
