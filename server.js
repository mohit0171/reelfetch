/* ReelFetch API server — Express + MySQL + yt-dlp */
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { initDb, logFetch, logDownload, recentFetches, isReady } = require('./db');
const { resolveUrl, streamDownload } = require('./downloader');
const { getClientIp, lookupCountry } = require('./geo');
const { ensureStatsSchema, recordActivity, getLiveStats } = require('./stats');

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '64kb' }));
app.use(morgan('dev'));

const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true }));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

const isUrl = (v) => typeof v === 'string' && /^https?:\/\/[\w.-]+\.[a-z]{2,}.*$/i.test(v.trim());

/* Country-based tracking period:
   resolve the visitor's country from the request IP (server-side geo-IP
   lookup — never browser language), then update the tracking period.
   If the country is NEW to the current period, a new period starts (all
   live counters reset to 0) and the country is marked as seen. */
async function updateTrackingPeriod(req) {
  try {
    const ip = getClientIp(req);
    const country = await lookupCountry(ip);
    return await recordActivity(country);
  } catch (e) {
    console.warn('[stats] tracking period update skipped:', e.message);
    return null;
  }
}

/* health */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'reelfetch-server', db: isReady() ? 'connected' : 'offline', time: new Date().toISOString() });
});

/* POST /api/resolve { url } -> metadata + qualities (also logs to MySQL) */
app.post('/api/resolve', async (req, res) => {
  const url = (req.body?.url || '').trim();
  if (!isUrl(url)) return res.status(400).json({ ok: false, error: 'Provide a valid http(s) reel URL.' });
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().slice(0, 64);
  await updateTrackingPeriod(req); // country-based reset check happens BEFORE logging, so this request counts as the first of a new period

  try {
    const info = await resolveUrl(url);
    if (!info.ok) {
      await logFetch({ platform: info.platform, source_url: url, status: 'error', error_message: info.error, client_ip: clientIp });
      return res.status(422).json({ ok: false, error: info.error });
    }
    const fetchId = await logFetch({
      platform: info.platform, source_url: url, title: info.title, thumbnail: info.thumbnail,
      duration_sec: info.duration, width: info.width, height: info.height,
      filesize_bytes: info.filesize, status: 'ok', client_ip: clientIp,
    });
    res.json({ ok: true, fetchId, ...info });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Resolve failed: ' + e.message });
  }
});

/* GET /api/download?url=...&quality=hd|sd|audio -> streams the file */
app.get('/api/download', async (req, res) => {
  const url = (req.query.url || '').trim();
  const quality = ['hd', 'sd', 'audio'].includes(req.query.quality) ? req.query.quality : 'hd';
  const fetchId = Number(req.query.fetchId) || null;
  if (!isUrl(url)) return res.status(400).json({ ok: false, error: 'Missing ?url=' });
  await updateTrackingPeriod(req); // country-based reset check happens BEFORE logging the download
  await logDownload(fetchId, quality, 'started');
  streamDownload(url, quality, res, 'reelfetch_reel');
});

/* GET /api/recent -> last successful fetches (history from MySQL) */
app.get('/api/recent', async (req, res) => {
  res.json({ ok: true, db: isReady(), items: await recentFetches(req.query.limit || 20) });
});

/* GET /api/stats -> live stats for the current tracking period
   (fetches / downloads / users since the period started; resets to 0 when a
   first-time country joins). The site's static "avg. fetch time" is NOT
   included here — it is independent and never reset. */
app.get('/api/stats', async (req, res) => {
  res.json({ ok: true, db: isReady(), stats: await getLiveStats() });
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

(async () => {
  await initDb(); // non-fatal if MySQL is down
  await ensureStatsSchema(); // creates the tracking-period tables if missing (non-fatal)
  app.listen(PORT, () => {
    console.log(`⚡ ReelFetch server on http://localhost:${PORT}`);
    console.log(`   health:  GET  /api/health`);
    console.log(`   resolve: POST /api/resolve  { "url": "<reel link>" }`);
    console.log(`   stream:  GET  /api/download?url=<link>&quality=hd|sd|audio`);
  });
})();
