// api/login.mjs
// Password gate for the live dashboard. POST { password } -> on success, sets an httpOnly,
// Secure, SameSite=Strict cookie holding an HMAC-signed session token valid 7 days.
// POST { action: "logout" } clears the cookie. Failed logins are rate-limited per IP.
//
// Secrets come ONLY from Vercel env vars — never hardcoded, never logged:
//   DASHBOARD_PASSWORD        the shared dashboard password
//   DASHBOARD_SESSION_SECRET  HMAC key that signs/verifies the session cookie
// .mjs so Vercel always loads this as an ES module (see api/dashboard-data.mjs note).

import crypto from 'node:crypto';

const PASSWORD = process.env.DASHBOARD_PASSWORD;
const SECRET = process.env.DASHBOARD_SESSION_SECRET;

const COOKIE = 'dash_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Rate limit: 5 failed attempts per IP per 15 minutes. In-memory and therefore best-effort —
// serverless instances are ephemeral and not shared, so this throttles the common case
// (a single instance under a burst) but is not a hard global limit. A durable limit would
// need a shared store (KV/Redis); noted intentionally.
const RL_MAX = 5;
const RL_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map(); // ip -> { count, resetAt }

function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

// Constant-time, length-independent comparison (hash both sides to a fixed 32 bytes first).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function readBody(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string' && b.length) { try { return JSON.parse(b); } catch { return {}; } }
  return {};
}

const cookie = (value, maxAgeSec) =>
  `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!PASSWORD || !SECRET) {
    return res.status(500).json({ error: 'auth not configured' });
  }

  const body = readBody(req);

  // Logout: clear the cookie (Max-Age=0). No password needed.
  if (body.action === 'logout') {
    res.setHeader('Set-Cookie', cookie('', 0));
    return res.status(200).json({ ok: true, loggedOut: true });
  }

  // Rate limit failed attempts per IP.
  const ip = clientIp(req);
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) { rec = { count: 0, resetAt: now + RL_WINDOW_MS }; attempts.set(ip, rec); }
  if (rec.count >= RL_MAX) {
    res.setHeader('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (!password || !safeEqual(password, PASSWORD)) {
    rec.count += 1;
    return res.status(401).json({ error: 'incorrect password' });
  }

  // Success: clear the counter and issue a signed session cookie.
  attempts.delete(ip);
  const token = signToken({ exp: now + SESSION_MS }, SECRET);
  res.setHeader('Set-Cookie', cookie(token, Math.floor(SESSION_MS / 1000)));
  return res.status(200).json({ ok: true });
}
