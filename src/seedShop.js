// src/seedShop.js — run with: node src/seedShop.js
require('dotenv').config();
const mongoose = require('mongoose');
const Category = require('./models/Category.model');
const Product = require('./models/Product.model');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/athlofit';

const categories = [
  { name: 'All',          slug: 'all',          icon: 'LayoutGrid',   color: '#0099FF' },
  { name: 'Supplements',  slug: 'supplements',  icon: 'Pill',         color: '#7C3AED' },
  { name: 'Equipment',    slug: 'equipment',    icon: 'Dumbbell',     color: '#0099FF' },
  { name: 'Apparel',      slug: 'apparel',      icon: 'Shirt',        color: '#059669' },
  { name: 'Accessories',  slug: 'accessories',  icon: 'Watch',        color: '#D97706' },
  { name: 'Nutrition',    slug: 'nutrition',    icon: 'Apple',        color: '#DC2626' },
];

const getProducts = (catMap) => [
  // Supplements
  { name: 'Whey Protein Isolate', description: 'Ultra-pure whey isolate with 27g protein per serving. Zero added sugar, fast-absorbing for muscle recovery.', price: 2999, discountedPrice: 2499, images: ['https://images.unsplash.com/photo-1593095948071-474c5cc2989d?w=400'], category: catMap['supplements'], stock: 120, tags: ['protein', 'whey', 'muscle'], isFeatured: true, rating: 4.8, reviewCount: 234, coinReward: 30 },
  { name: 'Creatine Monohydrate', description: 'Pure pharmaceutical-grade creatine for increased strength and power output during high-intensity workouts.', price: 999, discountedPrice: null, images: ['https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=400'], category: catMap['supplements'], stock: 200, tags: ['creatine', 'strength', 'power'], isFeatured: false, rating: 4.6, reviewCount: 189, coinReward: 15 },
  { name: 'BCAA Energy Drink', description: 'Branch chain amino acids with caffeine for intra-workout energy and muscle preservation.', price: 1499, discountedPrice: 1199, images: ['https://images.unsplash.com/photo-1622543925917-763c34d1a86e?w=400'], category: catMap['supplements'], stock: 85, tags: ['bcaa', 'energy', 'amino'], isFeatured: true, rating: 4.4, reviewCount: 96, coinReward: 20 },

  // Equipment
  { name: 'Adjustable Dumbbell Set', description: 'Space-saving adjustable dumbbells from 5–52.5 lbs. Replace 15 sets of weights with one compact set.', price: 18999, discountedPrice: 15999, images: ['https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?w=400'], category: catMap['equipment'], stock: 30, tags: ['dumbbell', 'weights', 'home gym'], isFeatured: true, rating: 4.9, reviewCount: 412, coinReward: 150 },
  { name: 'Resistance Bands Set', description: 'Set of 5 resistance levels for strength training, yoga, and rehabilitation. Includes door anchor and handles.', price: 1299, discountedPrice: 999, images: ['https://images.unsplash.com/photo-1598971639058-fab3c3109a00?w=400'], category: catMap['equipment'], stock: 150, tags: ['resistance', 'bands', 'flexibility'], isFeatured: false, rating: 4.5, reviewCount: 301, coinReward: 15 },
  { name: 'Premium Yoga Mat', description: '6mm thick non-slip yoga mat with alignment markings. Eco-friendly TPE material, sweat-resistant surface.', price: 2499, discountedPrice: 1999, images: ['https://images.unsplash.com/photo-1601925228627-e0b1f8c5f4c9?w=400'], category: catMap['equipment'], stock: 75, tags: ['yoga', 'mat', 'exercise'], isFeatured: false, rating: 4.7, reviewCount: 145, coinReward: 25 },

  // Apparel
  { name: 'Pro Compression Tights', description: 'Graduated compression tights for enhanced blood flow and muscle support during training and recovery.', price: 3499, discountedPrice: 2799, images: ['https://images.unsplash.com/photo-1506629082955-511b1aa562c8?w=400'], category: catMap['apparel'], stock: 60, tags: ['compression', 'tights', 'recovery'], isFeatured: true, rating: 4.6, reviewCount: 88, coinReward: 35 },
  { name: 'Dri-Fit Performance Tee', description: 'Moisture-wicking performance t-shirt with 4-way stretch fabric. Odor-resistant, perfect for any workout.', price: 1799, discountedPrice: null, images: ['https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400'], category: catMap['apparel'], stock: 120, tags: ['tee', 'dri-fit', 'performance'], isFeatured: false, rating: 4.3, reviewCount: 67, coinReward: 20 },

  // Accessories
  { name: 'Smart Fitness Tracker', description: 'Track steps, heart rate, sleep, and 20+ workout modes. 7-day battery, water-resistant, AMOLED display.', price: 7999, discountedPrice: 6499, images: ['https://images.unsplash.com/photo-1575311373937-040b8e1fd5b6?w=400'], category: catMap['accessories'], stock: 45, tags: ['tracker', 'smartwatch', 'fitness'], isFeatured: true, rating: 4.7, reviewCount: 523, coinReward: 80 },
  { name: 'Lifting Gloves', description: 'Full-finger gym gloves with wrist support and anti-slip grip. Breathable mesh back, machine washable.', price: 899, discountedPrice: 699, images: ['https://images.unsplash.com/photo-1541534741688-6078c6bfb5c5?w=400'], category: catMap['accessories'], stock: 200, tags: ['gloves', 'lifting', 'grip'], isFeatured: false, rating: 4.2, reviewCount: 193, coinReward: 10 },
  { name: 'Gym Shaker Bottle', description: '750ml BPA-free shaker with wire whisk ball and powder storage. Leak-proof lid, dishwasher safe.', price: 699, discountedPrice: null, images: ['https://images.unsplash.com/photo-1565688534245-05d6b5be184a?w=400'], category: catMap['accessories'], stock: 300, tags: ['shaker', 'bottle', 'gym'], isFeatured: false, rating: 4.5, reviewCount: 278, coinReward: 8 },

  // Nutrition
  { name: 'Keto Meal Replacement', description: 'Low-carb, high-fat meal shake with MCT oil and collagen. 400 kcal, 30g protein. Chocolate flavor.', price: 2199, discountedPrice: 1799, images: ['https://images.unsplash.com/photo-1543362906-acfc16c67564?w=400'], category: catMap['nutrition'], stock: 90, tags: ['keto', 'meal', 'replacement'], isFeatured: true, rating: 4.5, reviewCount: 112, coinReward: 25 },
  { name: 'Electrolyte Hydration Mix', description: 'Sugar-free electrolyte powder with sodium, potassium, and magnesium. Zero calorie, lemon-lime flavor.', price: 1099, discountedPrice: null, images: ['https://images.unsplash.com/photo-1570831739435-6601aa3fa4fb?w=400'], category: catMap['nutrition'], stock: 180, tags: ['electrolyte', 'hydration', 'recovery'], isFeatured: false, rating: 4.6, reviewCount: 154, coinReward: 12 },
];

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  // Clear existing
  await Category.deleteMany({});
  await Product.deleteMany({});
  console.log('🗑 Cleared categories & products');

  // Seed categories (skip "All" — it's a UI-only filter)
  const realCategories = categories.filter(c => c.slug !== 'all');
  const insertedCats = await Category.insertMany(realCategories);
  console.log(`📦 Seeded ${insertedCats.length} categories`);

  // Build slug→id map
  const catMap = {};
  insertedCats.forEach(c => { catMap[c.slug] = c._id; });

  // Seed products
  const products = getProducts(catMap);
  const insertedProds = await Product.insertMany(products);
  console.log(`🛍 Seeded ${insertedProds.length} products`);

  await mongoose.disconnect();
  console.log('✅ Done — disconnected');
}

seed().catch(err => { console.error(err); process.exit(1); });
