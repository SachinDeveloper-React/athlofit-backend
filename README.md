# Athlofit Backend

Node.js + Express REST API for the Athlofit health & gamification platform.

## Tech Stack
- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB (Mongoose)
- **Auth**: JWT (access + refresh token rotation)
- **Email**: Nodemailer (OTP flow)

## Project Structure

```
athlofit-backend/
├── src/
│   ├── server.js               # Entry point
│   ├── app.js                  # Express app config
│   ├── config/
│   │   └── db.js               # MongoDB connection
│   ├── models/
│   │   ├── User.model.js
│   │   ├── RefreshToken.model.js
│   │   ├── Gamification.model.js
│   │   └── HealthActivity.model.js
│   ├── controllers/
│   │   ├── auth.controller.js
│   │   ├── user.controller.js
│   │   ├── health.controller.js
│   │   └── gamification.controller.js
│   ├── routes/
│   │   ├── auth.routes.js
│   │   ├── user.routes.js
│   │   ├── health.routes.js
│   │   └── gamification.routes.js
│   ├── middleware/
│   │   ├── auth.middleware.js
│   │   ├── error.middleware.js
│   │   └── validate.middleware.js
│   ├── validators/
│   │   └── auth.validator.js
│   └── utils/
│       ├── jwt.js
│       ├── otp.js
│       ├── response.js
│       └── date.js
├── .env.example
└── package.json
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and fill in values
cp .env.example .env

# 3. Start development server
npm run dev

# 4. Start production server
npm start
```

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 5000) |
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` | Access token signing secret |
| `JWT_EXPIRES_IN` | Access token duration (e.g. `15m`) |
| `JWT_REFRESH_SECRET` | Refresh token signing secret |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token duration (e.g. `30d`) |
| `SMTP_HOST` | SMTP server host |
| `SMTP_PORT` | SMTP port |
| `SMTP_USER` | SMTP username/email |
| `SMTP_PASS` | SMTP password/app-password |
| `EMAIL_FROM` | Sender display name + email |
| `CLIENT_URL` | Frontend URL for CORS |

## API Endpoints

### Auth (`/auth`)
| Method | Path | Description |
|---|---|---|
| POST | `/auth/user/signup` | Register new user |
| POST | `/auth/user/signup-verify` | Verify email OTP |
| POST | `/auth/user/login` | Login |
| POST | `/auth/user/refresh-token` | Rotate refresh token |
| POST | `/auth/forgot-password` | Send reset OTP |
| POST | `/auth/resend-otp` | Resend OTP |
| POST | `/auth/reset-password` | Reset password with OTP |
| POST | `/auth/logout` | 🔒 Revoke tokens |

### User (`/user`) 🔒
| Method | Path | Description |
|---|---|---|
| GET | `/user/profile` | Get current user |
| PATCH | `/user/profile` | Update profile fields |
| POST | `/user/complete-profile` | Complete onboarding profile |
| PATCH | `/user/step-goal` | Update daily step goal |

### Health (`/health`) 🔒
| Method | Path | Description |
|---|---|---|
| GET | `/health/weekly-steps?from=&to=` | 7-day step history |
| GET | `/health/today` | Today's health snapshot |
| GET | `/health/history?from=&to=&limit=` | Paginated history |
| POST | `/health/sync` | Push daily health snapshot |

### Gamification (`/gamification`) 🔒
| Method | Path | Description |
|---|---|---|
| GET | `/gamification/me` | Coins + streak state |
| GET | `/gamification/streaks` | Streak days + badges |
| POST | `/gamification/sync` | Sync local state to server |
| POST | `/gamification/coins/earn` | Award coins |
| GET | `/gamification/leaderboard` | Top 20 by coins |

## Standard Response Format

All endpoints return:
```json
{
  "success": true,
  "message": "Human readable message",
  "data": { }
}
```

## Auth Flow

1. **Signup** → OTP sent to email
2. **Verify OTP** → Access + refresh token returned
3. **Login** → Access + refresh token returned  
4. **Refresh** → New token pair issued, old revoked
5. **Logout** → All refresh tokens revoked

🔒 = Requires `Authorization: Bearer <accessToken>` header
# athlofit-backend
