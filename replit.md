# SA OutreachBot Pro

## Overview
Automated B2B lead generation, website audit, and cold email outreach system. Searches 11 global cities via Serper API, audits business websites for technical flaws, and sends personalized "Realistic Audit" style emails using Gemini AI.

## Architecture
- **Backend**: Node.js + Express (`server.js`) — single-file server handling all logic
- **Frontend**: Vanilla HTML/CSS/JS (`index.html` = dashboard, `settings.html` = admin panel)
- **Data**: JSON files in `data/` directory (leads, queue, campaigns, domains, failed leads)
- **Port**: 24771 (mapped to external port 3000 via .replit)
- **Routes**: All under `/outreachbot/` prefix

## Key Features
1. **Lead Search**: Serper Maps API across 11 cities with GPS coordinates (ll param) and up to 10 pages per sector
2. **Website Audit**: SSL, speed, mobile, under-construction detection
3. **AI Emails**: Gemini 2.0 Flash — "Realistic Audit" style mentioning ONE specific technical flaw
4. **SMTP Rotation**: Up to 10 Gmail accounts (SMTP_USER_1…SMTP_USER_10) with auto-rotation
5. **Settings UI**: Live hot-reload of all env vars including SERPER_API_KEY
6. **Cron Scheduler**: Auto-send drain on configurable schedule

## Branding
- Brand name: **SA** (formerly ITECH PRO)
- Theme: Dark Mode Glassmorphism
- Default admin password: `sa2024` (set ADMIN_PASSWORD env var to change)

## Environment Variables
| Variable | Description |
|---|---|
| SERPER_API_KEY | Serper.dev API key for lead search |
| GEMINI_API_KEY | Google Gemini AI key for email generation |
| SMTP_USER_1…10 | Gmail addresses for sending |
| SMTP_PASS_1…10 | Gmail App Passwords |
| SENDER_NAME | Display name in emails (default: SA) |
| ADMIN_PASSWORD | Settings page password (default: sa2024) |
| DAILY_EMAIL_CAP | Max emails/day total (default: 200) |
| PER_ACCOUNT_DAILY_CAP | Max emails/day per account (default: 100) |

## Search Matrix
11 cities with GPS coordinates and sector-specific keywords:
- 🇺🇸 New York (40.7128,-74.0060), Los Angeles (34.0522,-118.2437)
- 🇬🇧 London (51.5074,-0.1278)
- 🇫🇷 Paris (48.8566,2.3522)
- 🇦🇪 Dubai (25.2048,55.2708), Abu Dhabi (24.4539,54.3773)
- 🇸🇬 Singapore (1.3521,103.8198)
- 🇭🇰 Hong Kong (22.3193,114.1694)
- 🇧🇷 São Paulo (-23.5505,-46.6333)
- 🇦🇺 Sydney (-33.8688,151.2093), Melbourne (-37.8136,144.9631)

## Running
```
npm start   # node server.js
```
Workflow: "Start Server" → `npm install && npm start`
