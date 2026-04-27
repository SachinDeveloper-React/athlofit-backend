# Database Seeding Guide

This guide explains how to seed your AthloFit database with sample data for development and testing.

## 📋 Overview

The seeding system consists of multiple scripts that populate different parts of your database:

- **seedAll.js** - Seeds core user data, health activities, notifications, etc.
- **seedNutrition.js** - Seeds food catalog with 40+ items
- **seedChallenges.js** - Seeds daily and weekly challenges
- **seedShop.js** - Seeds product categories and shop items
- **seedBadges.js** - Seeds badge definitions
- **seedSynonyms.js** - Seeds multilingual food synonyms

## 🚀 Quick Start

### Option 1: Seed Everything (Recommended)

Run this single command to seed all data in the correct order:

```bash
npm run seed:complete
```

This will execute all seed scripts in sequence:
1. Nutrition catalog
2. Challenges
3. Shop data
4. Food synonyms
5. All other data (users, health activities, etc.)

### Option 2: Seed Individual Components

You can also run individual seed scripts:

```bash
# Seed core data (users, health, notifications, etc.)
npm run seed:all

# Seed nutrition catalog
npm run seed:nutrition

# Seed challenges
npm run seed:challenges

# Seed shop (categories & products)
npm run seed:shop

# Seed badge definitions
npm run seed:badges

# Seed food synonyms
npm run seed:synonyms
```

## 📊 What Gets Seeded

### Users (3 users)
- **john@example.com** / Password123! (Regular user, 21-day streak)
- **jane@example.com** / Password123! (Regular user, 12-day streak)
- **admin@athlofit.com** / Admin123! (Admin user, 45-day streak)

### Gamification Profiles
- Coin balances, streaks, and badge progress for each user

### Badge Definitions (6 badges)
- Starter (1 day) → Elite (30 days) → Champion (60 days) → Legend (90 days)

### Health Activities
- 30 days of health data per user (steps, calories, hydration, sleep, etc.)

### BMI Records
- 10 weekly BMI measurements per user

### Nutrition Data
- **40+ food items** across breakfast, lunch, dinner, and snacks
- **Nutrition preferences** for each user
- **7 days of meal logs** per user
- **10 multilingual food synonyms** (Hindi, Spanish, French, German)

### Challenges
- **25 challenges** (daily and weekly)
- Categories: fitness, hydration, nutrition
- Criteria: steps, calories, active minutes, hydration, meals logged, etc.

### Shop Data
- **5 product categories** (Supplements, Equipment, Apparel, Accessories, Nutrition)
- **12 products** with images, prices, discounts, and coin rewards

### Notifications
- 5-10 notifications per user (goals, hydration, challenges, coins, security)

### Referrals
- Sample referral relationship (User 1 referred User 2)

### Achievements (4 achievements)
- First 10K Steps, 100K Steps Total, Hydration Master, First Order

### App Configuration
- Global app settings (coin rates, step goals, feature flags, etc.)

### FAQs (6 entries)
- Common questions across General, Coins, Health, and Nutrition categories

### Legal Content
- Terms and Conditions
- Privacy Policy

### Support Tickets (3 tickets)
- Sample support requests in various states (open, in_progress, resolved)

## 🔧 Environment Setup

Make sure your `.env` file is configured with a valid MongoDB connection:

```env
MONGO_URI=mongodb://localhost:27017/athlofit
# or
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/athlofit
```

## ⚠️ Important Notes

1. **Data Deletion**: All seed scripts use `deleteMany()` to clear existing data before seeding. This ensures a clean state but will **delete all existing data** in the affected collections.

2. **Dependencies**: Some seed scripts depend on others:
   - `seedAll.js` checks for existing foods, challenges, and shop data
   - Run `seed:complete` to ensure all dependencies are met

3. **Idempotent Seeds**: Most seed scripts are safe to re-run. They will:
   - Clear existing data
   - Insert fresh seed data
   - Maintain referential integrity

4. **Production Warning**: **Never run seed scripts in production!** They will delete all your production data.

## 📈 Verification

After seeding, you can verify the data:

```bash
# Start your server
npm start

# Or in development mode
npm run dev
```

Then check the database counts in the console output, or use MongoDB Compass/CLI:

```javascript
// In MongoDB shell
use athlofit
db.users.countDocuments()
db.foods.countDocuments()
db.challenges.countDocuments()
// etc.
```

## 🎯 Use Cases

### Development
```bash
npm run seed:complete
```
Seeds everything for a full development environment.

### Testing Specific Features
```bash
# Testing nutrition features
npm run seed:nutrition
npm run seed:all

# Testing challenges
npm run seed:challenges
npm run seed:all

# Testing shop
npm run seed:shop
npm run seed:all
```

### Fresh Start
```bash
# Clear and reseed everything
npm run seed:complete
```

## 🐛 Troubleshooting

### Connection Errors
```
Error: connect ECONNREFUSED 127.0.0.1:27017
```
**Solution**: Make sure MongoDB is running locally or your connection string is correct.

### Missing Dependencies
```
Error: Cannot find module 'mongoose'
```
**Solution**: Run `npm install` to install all dependencies.

### Validation Errors
```
ValidationError: User validation failed
```
**Solution**: Check that your models match the seed data structure. Update seed scripts if models have changed.

## 📝 Customization

You can customize the seed data by editing the seed files:

- **User data**: Edit `seedAll.js` → `seedUsers()`
- **Food items**: Edit `seedNutrition.js` → `FOODS` array
- **Challenges**: Edit `seedChallenges.js` → `CHALLENGES` array
- **Products**: Edit `seedShop.js` → `getProducts()` function

## 🔄 Updating Seeds

When you add new models or fields:

1. Update the relevant seed script
2. Add sample data for the new fields
3. Test the seed script
4. Update this guide if needed

## 📚 Related Files

- `src/seedAll.js` - Main seed script
- `src/seedNutrition.js` - Food catalog seed
- `src/seedChallenges.js` - Challenges seed
- `src/seedShop.js` - Shop data seed
- `src/seedBadges.js` - Badge definitions seed
- `src/seedSynonyms.js` - Food synonyms seed
- `src/seed.js` - Legacy simple seed (kept for backward compatibility)

## 💡 Tips

1. **Use seed:complete for first-time setup** - It handles all dependencies automatically
2. **Run individual seeds during development** - Faster when working on specific features
3. **Check the console output** - Each seed script provides detailed feedback
4. **Use test credentials** - All seeded users have simple passwords for easy testing
5. **Inspect the data** - Use MongoDB Compass or Studio 3T to browse seeded data

---

**Happy Seeding! 🌱**
