# ReelFetch backend setup (Windows, MySQL + Node.js)

## 1) Prerequisites
- Node.js 18+ (`node --version`)
- MySQL 8 / XAMPP running locally
- Python 3 + yt-dlp for real resolving/downloading:
  `pip install yt-dlp`  (must be on PATH as `yt-dlp` / `yt-dlp.exe`)
  — or download the binary and set `YTDLP_PATH=` in `.env`

## 2) Install
```
cd server
npm install
copy .env.example .env
```
Edit `.env` → set `DB_PASSWORD` (and `CORS_ORIGIN` if you serve the page
from a different port).

## 3) Create database + tables
```
npm run setup-db
```
Runs `schema.sql` → database `reelfetch` with tables `fetches`, `downloads`,
plus the live-stats tables `stats_periods`, `stats_period_countries`,
`stats_state`. (The server also creates any missing stats tables on startup.)

## 4) Run
```
npm start        # or: npm run dev
```
Server listens on `http://localhost:3001`
Health check: `GET /api/health`

> NOTE: the API works even if MySQL is down (history logging is skipped);
> yt-dlp is only needed for actual resolving/downloading.

## 5) Use the site
Serve the frontend folder (VS Code "Live Server" or any static server),
paste a reel link → the loader now calls the real API.

## API
| Method | Route | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok, db }` |
| POST | `/api/resolve` | `{ "url" }` | metadata: title, thumbnail, duration, width/height, filesize, streamUrl, qualities, fetchId |
| GET | `/api/download?url=…&quality=hd\|sd\|audio&fetchId=…` | query | file stream (attachment) |
| GET | `/api/recent?limit=20` | query | last successful fetches from MySQL |
| GET | `/api/stats` | — | live stats for the current tracking period: `{ fetches, downloads, users, countries, periodStartedAt }` |

## Live stats — country-based tracking periods

The website shows **Downloads / Fetches / Users** counted for the *current
tracking period*:

- The visitor's country is resolved **server-side** from the request IP
  (`src/geo.js`: ipwho.is → ip-api.com fallback, both keyless, with caching).
  Browser language / manual input is never used.
- When a request (fetch or download) comes from a country **not yet seen in
  the current period**, a **new period starts**: all counters reset to 0,
  the new country is marked as seen, and the triggering request counts as
  the first one of the new period.
- Requests from already-seen countries never reset anything.
- The period, its start time and its seen-countries are stored in MySQL
  (`stats_periods`, `stats_period_countries`, `stats_state`), so the reset
  state survives page refreshes and server restarts.
- Race conditions: all arrivals are serialized with `SELECT ... FOR UPDATE`
  on the singleton `stats_state` row inside a transaction, so two
  simultaneous first-time countries can only produce a single reset.
- The hero section's **"avg. fetch time" stat is completely independent** of
  this feature: it is untouched, has its own source, and is never reset.

