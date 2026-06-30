// Load environment variables first — must be before any other require
// so that process.env.* is populated when app.js, firebase.admin.js, etc. load.
require('dotenv').config();

const { connectDB } = require('./config/db');
const app = require('./app');
const { startScheduler } = require('./services/scheduler');
const { startCronJobs } = require('./cron');

const PORT = process.env.PORT || 5001;

connectDB().then(() => {
  app.listen(PORT,'0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);

    // Start background cron jobs (uninstall detection, inactivity cleanup)
    startScheduler();
    // Start streak evaluation + weekly lives cron
    startCronJobs();
  });
});
