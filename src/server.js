// src/server.js
require('dotenv').config();
const app = require('./app');
const { connectDB } = require('./config/db');

const PORT = process.env.PORT || 5001;

const start = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`\n🚀 Athlofit API running → http://localhost:${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
  });
};

start();
