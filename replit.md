# SA OutreachBot Pro

## Overview
Automated B2B lead generation, website audit, and cold email outreach system with full CRM, 3-stage email sequences, A/B testing, reply detection, revenue tracking, and a public services landing page.

## Architecture
- **Backend**: Node.js + Express (`server.js`) — extended with modular files
- **Modules**: `db.js` (SQLite), `sequences.js` (3-stage emails), `reply-detector.js` (IMAP), `api-routes.js` (new routes)
- **Frontend**: `index.html` (dashboard), `settings.html` (admin), `crm.html` (CRM), `services.html` (public landing page)
- **Data**: SQLite (`data/outreachbot.db`) for CRM/sequences + JSON files in `data/` for legacy leads/queue/campaigns
- **Port**: 24771 (mapped to external port 3000 via .replit)
- **Routes**: All under `/outreachbot/` prefix; `/outreachbot/services` is public

## Pages
| Path | Description |
|---|---|
| `/outreachbot/` | Main dashboard (pipeline, A/B results, revenue, leads) |
| `/outreachbot/crm` | CRM — contacts table, bulk actions, revenue entry |
| `/outreachbot/services` | Public landing page for prospects |
| `/outreachbot/settings` | Admin settings panel |

## Key Features
1. **Lead Search**: Serper Maps API across 11 cities with GPS coordinates (ll param) and up to 10 pages per sector
2. **Website Audit**: SSL, speed, mobile, under-construction detection with realistic AI prompts
3. **3-Stage Email Sequences**: Auto follow-up Day 1 / Day 3 / Day 7, stops on reply
4. **A/B Testing**: 3 subject line variants (A/B/C), tracks open+reply rate, declares winner at 100 sends
5. **Reply Detection**: IMAP inbox scan every 30 min, Gemini sentiment analysis (interested/question/not_interested/other), admin email notification
6. **CRM**: Full contact management — status, notes, bulk actions, revenue entry, CSV export
7. **Revenue Tracking**: One-time + recurring revenue, projected annual, monthly breakdown
8. **Pipeline Dashboard**: Contacted → Opened → Replied → Interested → Closed funnel view
9. **Services Landing Page**: Public page at `/outreachbot/services` with audit request form
10. **AI Emails**: Gemini 2.0 Flash — "Realistic Audit" style mentioning ONE specific technical flaw
11. **SMTP Rotation**: Up to 10 Gmail accounts with auto-rotation
12. **Settings UI**: Live hot-reload including sequence timing, pricing, Calendly link, IMAP config

## SQLite Schema (`data/outreachbot.db`)
- `contacts` — CRM contacts with sequence stage, status, revenue, sentiment
- `sequence_log` — log of every email sent per contact per stage
- `ab_results` — A/B test counters per variant (A/B/C)
- `replies` — detected replies with sentiment
- `revenue` — revenue entries (one_time / recurring)
- `services_leads` — audit request form submissions

## Automated Schedulers
- **Sequence follow-ups**: every 30 min — sends Stage 2/3 to contacts past their delay threshold
- **Reply detection**: every :15 and :45 past the hour — checks IMAP inbox for replies

## Environment Variables
| Variable | Description |
|---|---|
| SERPER_API_KEY | Serper.dev API key for lead search |
| GEMINI_API_KEY | Google Gemini AI key for email generation + sentiment |
| SMTP_USER_1…10 | Gmail addresses for sending |
| SMTP_PASS_1…10 | Gmail App Passwords |
| SENDER_NAME | Display name in emails (default: SA) |
| ADMIN_PASSWORD | Settings page password (default: sa2024) |
| ADMIN_EMAIL | Your email for reply notifications |
| DAILY_EMAIL_CAP | Max emails/day total (default: 200) |
| PER_ACCOUNT_DAILY_CAP | Max emails/day per account (default: 100) |
| SEQ_DAYS_1_TO_2 | Days before Stage 2 follow-up (default: 3) |
| SEQ_DAYS_2_TO_3 | Days before Stage 3 closing email (default: 4) |
| PRICING_WEBSITE | Website price in Stage 3 email (default: $1,000) |
| PRICING_MONTHLY | AI monthly price in Stage 3 email (default: $300) |
| CALENDLY_LINK | Optional booking link appended to emails |
| IMAP_HOST | IMAP server for reply detection (default: imap.gmail.com) |
| IMAP_PORT | IMAP port (default: 993) |

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
