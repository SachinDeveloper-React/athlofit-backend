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
  // ─── Supplements ────────────────────────────────────────────────────────────
  {
    name: 'Whey Protein Isolate',
    description: 'Ultra-pure whey isolate with 27g protein per serving. Zero added sugar, fast-absorbing for muscle recovery. Available in chocolate, vanilla, and strawberry flavors.',
    price: 2999,
    discountedPrice: 2499,
    images: [
      'https://images.unsplash.com/photo-1593095948071-474c5cc2989d?w=600',
      'https://images.unsplash.com/photo-1579722820903-cbb09c0cd5e6?w=600',
      'https://images.unsplash.com/photo-1594498653385-d5172c532c00?w=600',
    ],
    category: catMap['supplements'],
    stock: 120,
    tags: ['protein', 'whey', 'muscle'],
    isFeatured: true,
    rating: 4.8,
    reviewCount: 234,
    coinReward: 30,
  },
  {
    name: 'Creatine Monohydrate',
    description: 'Pure pharmaceutical-grade creatine for increased strength and power output during high-intensity workouts. 5g per serving, unflavored.',
    price: 999,
    discountedPrice: null,
    images: [
      'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=600',
      'https://images.unsplash.com/photo-1556228578-0d85b1a4d571?w=600',
    ],
    category: catMap['supplements'],
    stock: 200,
    tags: ['creatine', 'strength', 'power'],
    isFeatured: false,
    rating: 4.6,
    reviewCount: 189,
    coinReward: 15,
  },
  {
    name: 'BCAA Energy Drink',
    description: 'Branch chain amino acids with caffeine for intra-workout energy and muscle preservation. Tropical mango flavor.',
    price: 1499,
    discountedPrice: 1199,
    images: [
      'https://images.unsplash.com/photo-1622543925917-763c34d1a86e?w=600',
      'https://images.unsplash.com/photo-1625772299848-391b6a87d7b3?w=600',
      'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600',
    ],
    category: catMap['supplements'],
    stock: 85,
    tags: ['bcaa', 'energy', 'amino'],
    isFeatured: true,
    rating: 4.4,
    reviewCount: 96,
    coinReward: 20,
  },
  {
    name: 'Pre-Workout Formula',
    description: 'High-stimulant pre-workout with beta-alanine, citrulline, and 300mg caffeine. Electric blue raspberry flavor for explosive workouts.',
    price: 1899,
    discountedPrice: 1599,
    images: [
      'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=600',
      'https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=600',
    ],
    category: catMap['supplements'],
    stock: 65,
    tags: ['pre-workout', 'energy', 'caffeine'],
    isFeatured: false,
    rating: 4.5,
    reviewCount: 143,
    coinReward: 18,
  },

  // ─── Equipment ──────────────────────────────────────────────────────────────
  {
    name: 'Adjustable Dumbbell Set',
    description: 'Space-saving adjustable dumbbells from 5–52.5 lbs. Replace 15 sets of weights with one compact set. Quick-lock mechanism.',
    price: 18999,
    discountedPrice: 15999,
    images: [
      'https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?w=600',
      'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=600',
      'https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?w=600',
      'https://images.unsplash.com/photo-1558611848-73f7eb4001a1?w=600',
    ],
    category: catMap['equipment'],
    stock: 30,
    tags: ['dumbbell', 'weights', 'home gym'],
    isFeatured: true,
    rating: 4.9,
    reviewCount: 412,
    coinReward: 150,
  },
  {
    name: 'Resistance Bands Set',
    description: 'Set of 5 resistance levels for strength training, yoga, and rehabilitation. Includes door anchor, handles, and carry bag.',
    price: 1299,
    discountedPrice: 999,
    images: [
      'https://images.unsplash.com/photo-1598971639058-fab3c3109a00?w=600',
      'https://images.unsplash.com/photo-1517344884509-a0c97ec11bcc?w=600',
      'https://images.unsplash.com/photo-1616803689943-5601631c7fec?w=600',
    ],
    category: catMap['equipment'],
    stock: 150,
    tags: ['resistance', 'bands', 'flexibility'],
    isFeatured: false,
    rating: 4.5,
    reviewCount: 301,
    coinReward: 15,
  },
  {
    name: 'Premium Yoga Mat',
    description: '6mm thick non-slip yoga mat with alignment markings. Eco-friendly TPE material, sweat-resistant surface. Includes carry strap.',
    price: 2499,
    discountedPrice: 1999,
    images: [
      'https://images.unsplash.com/photo-1601925228627-e0b1f8c5f4c9?w=600',
      'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=600',
      'https://images.unsplash.com/photo-1506126613408-eca07ce68773?w=600',
    ],
    category: catMap['equipment'],
    stock: 75,
    tags: ['yoga', 'mat', 'exercise'],
    isFeatured: false,
    rating: 4.7,
    reviewCount: 145,
    coinReward: 25,
  },
  {
    name: 'Olympic Barbell',
    description: '20kg Olympic barbell with knurled grip and rotating sleeves. Chrome finish, rated for 700 lbs. Perfect for deadlifts, squats, and bench press.',
    price: 12999,
    discountedPrice: 10999,
    images: [
      'https://images.unsplash.com/photo-1534368959876-26bf04f2c947?w=600',
      'https://images.unsplash.com/photo-1521804906057-1df8fdb718b7?w=600',
      'https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?w=600',
    ],
    category: catMap['equipment'],
    stock: 20,
    tags: ['barbell', 'olympic', 'weights'],
    isFeatured: true,
    rating: 4.8,
    reviewCount: 267,
    coinReward: 120,
  },

  // ─── Apparel ────────────────────────────────────────────────────────────────
  {
    name: 'Pro Compression Tights',
    description: 'Graduated compression tights for enhanced blood flow and muscle support during training and recovery. Available in black, navy, and grey.',
    price: 3499,
    discountedPrice: 2799,
    images: [
      'https://images.unsplash.com/photo-1506629082955-511b1aa562c8?w=600',
      'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=600',
      'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=600',
    ],
    category: catMap['apparel'],
    stock: 60,
    tags: ['compression', 'tights', 'recovery'],
    isFeatured: true,
    rating: 4.6,
    reviewCount: 88,
    coinReward: 35,
  },
  {
    name: 'Dri-Fit Performance Tee',
    description: 'Moisture-wicking performance t-shirt with 4-way stretch fabric. Odor-resistant, lightweight, perfect for any workout.',
    price: 1799,
    discountedPrice: null,
    images: [
      'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=600',
      'https://images.unsplash.com/photo-1503341504253-dff4f94032fc?w=600',
      'https://images.unsplash.com/photo-1562157873-818bc0726f68?w=600',
    ],
    category: catMap['apparel'],
    stock: 120,
    tags: ['tee', 'dri-fit', 'performance'],
    isFeatured: false,
    rating: 4.3,
    reviewCount: 67,
    coinReward: 20,
  },
  {
    name: 'Training Hoodie',
    description: 'Heavyweight cotton-blend training hoodie with thumbholes and side zip pockets. Warm-up and cool-down essential.',
    price: 2999,
    discountedPrice: 2499,
    images: [
      'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=600',
      'https://images.unsplash.com/photo-1578587018452-892bacefd3f2?w=600',
    ],
    category: catMap['apparel'],
    stock: 45,
    tags: ['hoodie', 'training', 'warm-up'],
    isFeatured: false,
    rating: 4.5,
    reviewCount: 54,
    coinReward: 28,
  },

  // ─── Accessories ────────────────────────────────────────────────────────────
  {
    name: 'Smart Fitness Tracker',
    description: 'Track steps, heart rate, sleep, and 20+ workout modes. 7-day battery, water-resistant to 50m, vibrant AMOLED display.',
    price: 7999,
    discountedPrice: 6499,
    images: [
      'https://images.unsplash.com/photo-1575311373937-040b8e1fd5b6?w=600',
      'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600',
      'https://images.unsplash.com/photo-1508685096489-7aacd43bd3b1?w=600',
      'https://images.unsplash.com/photo-1434493789847-2f02dc6ca35d?w=600',
    ],
    category: catMap['accessories'],
    stock: 45,
    tags: ['tracker', 'smartwatch', 'fitness'],
    isFeatured: true,
    rating: 4.7,
    reviewCount: 523,
    coinReward: 80,
  },
  {
    name: 'Lifting Gloves',
    description: 'Full-finger gym gloves with wrist support and anti-slip grip. Breathable mesh back, machine washable. S/M/L/XL sizes.',
    price: 899,
    discountedPrice: 699,
    images: [
      'https://images.unsplash.com/photo-1541534741688-6078c6bfb5c5?w=600',
      'https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=600',
    ],
    category: catMap['accessories'],
    stock: 200,
    tags: ['gloves', 'lifting', 'grip'],
    isFeatured: false,
    rating: 4.2,
    reviewCount: 193,
    coinReward: 10,
  },
  {
    name: 'Gym Shaker Bottle',
    description: '750ml BPA-free shaker with wire whisk ball and powder storage compartment. Leak-proof lid, dishwasher safe.',
    price: 699,
    discountedPrice: null,
    images: [
      'https://images.unsplash.com/photo-1565688534245-05d6b5be184a?w=600',
      'https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=600',
    ],
    category: catMap['accessories'],
    stock: 300,
    tags: ['shaker', 'bottle', 'gym'],
    isFeatured: false,
    rating: 4.5,
    reviewCount: 278,
    coinReward: 8,
  },
  {
    name: 'Wireless Sport Earbuds',
    description: 'IPX7 waterproof bluetooth earbuds with secure ear hooks. 8-hour battery, deep bass, built-in mic for calls during workouts.',
    price: 4999,
    discountedPrice: 3999,
    images: [
      'https://images.unsplash.com/photo-1590658268037-6bf12f8a788a?w=600',
      'https://images.unsplash.com/photo-1606220588913-b3aacb4d2f46?w=600',
      'https://images.unsplash.com/photo-1583394838336-acd977736f90?w=600',
    ],
    category: catMap['accessories'],
    stock: 80,
    tags: ['earbuds', 'bluetooth', 'wireless'],
    isFeatured: true,
    rating: 4.4,
    reviewCount: 312,
    coinReward: 45,
  },

  // ─── Nutrition ──────────────────────────────────────────────────────────────
  {
    name: 'Keto Meal Replacement',
    description: 'Low-carb, high-fat meal shake with MCT oil and collagen. 400 kcal, 30g protein per serving. Rich chocolate flavor.',
    price: 2199,
    discountedPrice: 1799,
    images: [
      'https://images.unsplash.com/photo-1543362906-acfc16c67564?w=600',
      'https://images.unsplash.com/photo-1511690656952-34342bb7c2f2?w=600',
      'https://images.unsplash.com/photo-1502741224143-90386d7f8c82?w=600',
    ],
    category: catMap['nutrition'],
    stock: 90,
    tags: ['keto', 'meal', 'replacement'],
    isFeatured: true,
    rating: 4.5,
    reviewCount: 112,
    coinReward: 25,
  },
  {
    name: 'Electrolyte Hydration Mix',
    description: 'Sugar-free electrolyte powder with sodium, potassium, and magnesium. Zero calorie, lemon-lime flavor. 30 servings.',
    price: 1099,
    discountedPrice: null,
    images: [
      'https://images.unsplash.com/photo-1570831739435-6601aa3fa4fb?w=600',
      'https://images.unsplash.com/photo-1523362628745-0c100150b504?w=600',
    ],
    category: catMap['nutrition'],
    stock: 180,
    tags: ['electrolyte', 'hydration', 'recovery'],
    isFeatured: false,
    rating: 4.6,
    reviewCount: 154,
    coinReward: 12,
  },
  {
    name: 'Organic Protein Bars (12 Pack)',
    description: 'Plant-based protein bars with 20g protein each. No artificial sweeteners, gluten-free. Mixed flavors: peanut butter, almond, coconut.',
    price: 1599,
    discountedPrice: 1299,
    images: [
      'https://images.unsplash.com/photo-1622484212850-eb596d769edc?w=600',
      'https://images.unsplash.com/photo-1558642452-9d2a7deb7f62?w=600',
      'https://images.unsplash.com/photo-1604497181015-76590d828b75?w=600',
    ],
    category: catMap['nutrition'],
    stock: 140,
    tags: ['protein bar', 'organic', 'snack'],
    isFeatured: false,
    rating: 4.3,
    reviewCount: 89,
    coinReward: 15,
  },
];

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  // Clear existing
  await Category.deleteMany({});
  await Product.deleteMany({});
  console.log('🗑  Cleared categories & products');

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
  console.log(`🛍  Seeded ${insertedProds.length} products`);

  // Print summary
  const imgCounts = insertedProds.map(p => p.images.length);
  console.log(`📸 Images per product: min=${Math.min(...imgCounts)}, max=${Math.max(...imgCounts)}, avg=${(imgCounts.reduce((a, b) => a + b, 0) / imgCounts.length).toFixed(1)}`);

  await mongoose.disconnect();
  console.log('✅ Done — disconnected');
}

seed().catch(err => { console.error(err); process.exit(1); });
