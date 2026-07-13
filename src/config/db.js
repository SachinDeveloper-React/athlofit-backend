// src/config/db.js
const mongoose = require('mongoose');

let isConnected = false;

const connectDB = async () => {
  if (isConnected) return;

  // Enable MongoDB query logging in development
  if (process.env.NODE_ENV === 'development' || process.env.MONGO_DEBUG === 'true') {
    mongoose.set('debug', (collectionName, method, query, doc) => {
      console.log(`[MongoDB] ${collectionName}.${method}`, JSON.stringify(query).slice(0, 200));
    });
  }

  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = true;
    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  }
};

module.exports = { connectDB };
