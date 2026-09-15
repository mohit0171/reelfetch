/* IP -> country geolocation (server-side only).
   The country is resolved from the client IP using a public geo-IP service.
   Browser language / manual input is NEVER used.
   Returns a 2-letter ISO country code (e.g. "JP") or null when unknown
   (private/local IPs, provider outage, ...) — null never triggers a reset. */

const TTL_POSITIVE = 12 * 60 * 60 * 1000; // good lookups cached 12h
const TTL_NEGATIVE = 10 * 60 * 1000;      // failed lookups retried after 10min
const GEO_TIMEOUT_MS = 3000;
const CACHE_MAX = 5000;

const cache = new Map(); // ip -> { country: string|null, at: number }

const isPrivateIp = (ip) => {
  if (!ip) return true;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
  if (ip === '::1' || ip === 'localhost') return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|22[4-9]\.|2[3-5]\d\.)/.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^(fc|fd|fe80)/i.test(ip)) return true; // IPv6 private / link-local
  return false;
};

/* Normalize a raw header/proxy value to a plain public IP address.
   Handles "1.2.3.4, 5.6.7.8" (XFF chains), "::ffff:1.2.3.4", "1.2.3.4:56789". */
const normalizeIp = (raw) => {
  if (!raw) return null;
  let ip = String(raw).trim();
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.split(':')[0];
  ip = ip.replace(/^\[|\]$/g, '');
  return ip || null;
};

/* The client IP as seen by the server (same extraction the request
   logging already uses — x-forwarded-for first hop wins behind proxies). */
function getClientIp(req) {
  const raw = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString();
  return normalizeIp(raw);
}

async function fetchJson(url, timeoutMs = GEO_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'ReelFetch/1.0' } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* Provider 1: ipwho.is (HTTPS, no API key) — { success, country_code } */
async function lookupIpWhoIs(ip) {
  const j = await fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}`);
  if (j && j.success !== false && typeof j.country_code === 'string') return j.country_code;
  return null;
}

/* Provider 2: ip-api.com (no API key) — { status, countryCode } */
async function lookupIpApi(ip) {
  const j = await fetchJson(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode`);
  if (j && j.status === 'success' && typeof j.countryCode === 'string') return j.countryCode;
  return null;
}

const isValidCountryCode = (c) => typeof c === 'string' && /^[A-Za-z]{2}$/.test(c);

/* Resolve the 2-letter country code for an IP (cached). Never throws. */
async function lookupCountry(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip || isPrivateIp(ip)) return null;

  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < (hit.country ? TTL_POSITIVE : TTL_NEGATIVE)) {
    return hit.country;
  }

  let country = await lookupIpWhoIs(ip);
  if (!country) country = await lookupIpApi(ip);
  if (!isValidCountryCode(country)) country = null;

  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(ip, { country, at: Date.now() });
  return country;
}

module.exports = { getClientIp, lookupCountry, isPrivateIp, normalizeIp };