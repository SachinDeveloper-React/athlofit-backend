# Cron Jobs — EC2 System Cron Setup

All scheduled jobs run via the **system crontab** on EC2, calling the backend's HTTP endpoints.
This is more reliable than in-process node-cron because it survives app crashes and PM2 restarts.

## Prerequisites

1. Set `CRON_SECRET` in your `.env`:
   ```
   CRON_SECRET=your-long-random-secret-here
   ```

2. Ensure the backend is running (PM2 auto-restart handles this).

## Install the crontab

SSH into your EC2 and run:
```bash
crontab -e
```

Paste these lines (all times are IST via TZ variable):

```cron
# Athlofit Scheduled Jobs
# ─────────────────────────────────────────────────────────────────────
TZ=Asia/Kolkata
CRON_SECRET=your-long-random-secret-here
API=http://localhost:5001

# Apply pending step goal changes — daily at 00:05 IST
5 0 * * * curl -s -H "Authorization: Bearer $CRON_SECRET" "$API/cron/apply-pending-goals" >> /var/log/athlofit-cron.log 2>&1

# Evaluate streaks (break/protect) — daily at 00:30 IST
30 0 * * * curl -s -H "Authorization: Bearer $CRON_SECRET" "$API/cron/evaluate-streaks" >> /var/log/athlofit-cron.log 2>&1

# Grant weekly streak lives — Monday at 00:45 IST
45 0 * * 1 curl -s -H "Authorization: Bearer $CRON_SECRET" "$API/cron/grant-weekly-lives" >> /var/log/athlofit-cron.log 2>&1

# Passive coin distribution — every 3 hours
0 0,3,6,9,12,15,18,21 * * * curl -s -H "Authorization: Bearer $CRON_SECRET" "$API/cron/distribute-passive-coins" >> /var/log/athlofit-cron.log 2>&1

# Passive coin EOD sweep — daily at 23:59
59 23 * * * curl -s -H "Authorization: Bearer $CRON_SECRET" "$API/cron/distribute-passive-coins" >> /var/log/athlofit-cron.log 2>&1
```

## Verify

```bash
# Check crontab is installed
crontab -l

# Watch the log
tail -f /var/log/athlofit-cron.log

# Test manually
curl -s -H "Authorization: Bearer YOUR_SECRET" http://localhost:5001/cron/evaluate-streaks
```

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/cron/evaluate-streaks` | Break/protect streaks for users who missed a day |
| `/cron/grant-weekly-lives` | Award 1 streak life per user per week |
| `/cron/apply-pending-goals` | Apply scheduled step-goal changes |
| `/cron/distribute-passive-coins` | Award passive step coins |

All require `Authorization: Bearer <CRON_SECRET>` header or `?key=<CRON_SECRET>` query param.

## Why system cron over node-cron

- System cron runs independently of the Node process
- Survives app crashes, PM2 restarts, and deployments
- Logs to a file for debugging
- Won't duplicate if you scale (only one EC2 runs the crontab)
