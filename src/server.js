// Load environment variables first — must be before any other require
// so that process.env.* is populated when app.js, firebase.admin.js, etc. load.
require('dotenv').config();

const { connectDB } = require('./config/db');
const app = require('./app');

const PORT = process.env.PORT || 5001;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});
