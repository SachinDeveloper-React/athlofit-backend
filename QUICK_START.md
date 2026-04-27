# 🚀 Quick Start Guide

Get your AthloFit backend up and running in 3 minutes!

## Prerequisites

- Node.js (v14 or higher)
- MongoDB (local or cloud)
- npm or yarn

## Step 1: Install Dependencies

```bash
cd athlofit-backend
npm install
```

## Step 2: Configure Environment

Create a `.env` file in the `athlofit-backend` directory:

```env
# Server
PORT=5000
NODE_ENV=development

# Database
MONGO_URI=mongodb://localhost:27017/athlofit
# Or use MongoDB Atlas:
# MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/athlofit

# JWT
JWT_SECRET=your-super-secret-jwt-key-change-this
JWT_EXPIRES_IN=15m
JWT_REFRESH_SECRET=your-super-secret-refresh-key-change-this
JWT_REFRESH_EXPIRES_IN=30d

# Email (Optional - for OTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
EMAIL_FROM=AthloFit <noreply@athlofit.com>

# Frontend
CLIENT_URL=http://localhost:3000

# Cloudinary (Optional - for image uploads)
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
```

## Step 3: Seed the Database

```bash
npm run seed:complete
```

This will populate your database with:
- 3 test users (including 1 admin)
- 40+ food items
- 25 challenges
- 12 shop products
- Health data, notifications, and more!

**Test Credentials:**
```
User:  john@example.com / Password123!
User:  jane@example.com / Password123!
Admin: admin@athlofit.com / Admin123!
```

## Step 4: Start the Server

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start
```

Your API will be running at: `http://localhost:5000`

## Step 5: Test the API

### Health Check
```bash
curl http://localhost:5000/
```

### Login
```bash
curl -X POST http://localhost:5000/auth/user/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "Password123!"
  }'
```

### Get User Profile (with token)
```bash
curl http://localhost:5000/user/profile \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

## 📚 Next Steps

1. **Explore the API**: Check out the [README.md](./README.md) for all available endpoints
2. **Understand the Data**: See [SEED_DATA_SUMMARY.md](./SEED_DATA_SUMMARY.md) for what's in your database
3. **Customize Seeds**: Edit seed files in `src/seed*.js` to match your needs
4. **Connect Frontend**: Update your React Native app to point to `http://localhost:5000`

## 🔧 Common Commands

```bash
# Seed everything
npm run seed:complete

# Seed individual components
npm run seed:nutrition    # Food catalog
npm run seed:challenges   # Challenges
npm run seed:shop         # Products
npm run seed:all          # Core data

# Development
npm run dev               # Start with auto-reload
npm start                 # Start production server

# Linting
npm run lint              # Check code style
```

## 🐛 Troubleshooting

### MongoDB Connection Error
```
Error: connect ECONNREFUSED 127.0.0.1:27017
```
**Solution**: Make sure MongoDB is running
```bash
# macOS (with Homebrew)
brew services start mongodb-community

# Linux
sudo systemctl start mongod

# Or use MongoDB Atlas (cloud)
```

### Port Already in Use
```
Error: listen EADDRINUSE: address already in use :::5000
```
**Solution**: Change the PORT in your `.env` file or kill the process using port 5000
```bash
# Find process
lsof -i :5000

# Kill process
kill -9 <PID>
```

### Seed Script Fails
```
ValidationError: User validation failed
```
**Solution**: Make sure your MongoDB is running and accessible. Check your `MONGO_URI` in `.env`

## 📖 Documentation

- [README.md](./README.md) - Full API documentation
- [SEEDING_GUIDE.md](./SEEDING_GUIDE.md) - Detailed seeding guide
- [SEED_DATA_SUMMARY.md](./SEED_DATA_SUMMARY.md) - What data gets seeded

## 🎉 You're Ready!

Your AthloFit backend is now running with a fully populated database. Start building your frontend or test the API endpoints!

---

**Need Help?** Check the documentation files or open an issue on GitHub.
