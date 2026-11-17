// api/sync-meta.js
//
// Daily Vercel cron that PULLS first-party Facebook Page + Instagram stats from the
// Meta Graph API and upserts one row per (date, platform, account) into
// `meta_account_daily` in the SOCIAL-analytics Supabase project (with YouTube and the
// Metricool feeds). Replaces the inaccurate Metricool feed for FB + IG.
//
// Two kinds of data:
//   1. SNAPSHOT (stable node fields) — FB: followers_count, fan_count; IG:
//      followers_count, media_count. Written onto today's row, always.
//   2. DAILY INSIGHTS (volatile) — reach, impressions, views, profile_views,
//      engagement, via /{id}/insights?period=day. Meta deprecates/renames these
//      often, so each metric is fetched independently and is NON-FATAL: one that a
//      Graph API version has dropped is skipped and reported in `insightErrors`,
//      never failing the run. Anything not promoted to a column lands in `extra`.
//
// Auth: a Meta access token (ideally a non-expiring Business "System User" token with
// the page + IG assigned and pages_read_engagement / read_insights / instagram_basic /
// instagram_manage_insights). Stored in META_ACCESS_TOKEN (Vercel env). Public repo:
// never hardcode it.
//
// Snapshot and daily are upserted in SEPARATE requests with DISJOINT column sets, so
// each merge only updates its own columns and never nulls the other's.

const TOKEN = process.env.META_ACCESS_TOKEN;
const PAGE_ID = process.env.META_PAGE_ID || '186123311580369';   // Utah REIA FB Page
const IG_ID = process.env.META_IG_ID || '17841444000419929';     // utah.reia IG business
const VERSION = process.env.META_API_VERSION || 'v21.0';
const BASE = `https://graph.facebook.com/${VERSION}`;

// Social-analytics project (same as sync-youtube). Writes need the SERVICE-ROLE key.
const SOCIAL_URL = process.env.SOCIAL_SUPABASE_URL || 'https://oeraqcuithvmeyljuzbd.supabase.co';
const SOCIAL_KEY = process.env.SOCIAL_SUPABASE_SERVICE_ROLE_KEY
  || process.env.SUPABASE_SOCIAL_SERVICE_ROLE_KEY
  || process.env.SOCIAL_SERVICE_ROLE_KEY
  || process.env.SOCIAL_SUPABASE_KEY
  || '';

const LOOKBACK_DAYS = Number(process.env.META_LOOKBACK_DAYS || 30);
const FULL_DAYS = Number(process.env.META_FULL_DAYS || 400);
const CHUNK_DAYS = 90; // Meta insight windows are capped; page the range in chunks.

// Metric -> column maps. Left = Graph API metric name, right = our column (or 'extra:<k>').
const FB_METRICS = [
  ['page_impressions_unique', 'reach'],
  ['page_impressions', 'impressions'],
  ['page_post_engagements', 'engagement'],
  ['page_views_total', 'profile_views'],
];
const IG_METRICS = [
  ['reach', 'reach'],
  ['views', 'views'],
  ['profile_views', 'profile_views'],
  ['accounts_engaged', 'engagement'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayISO = () => new Date().toISOString().slice(0, 10);
function isoDaysAgo(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
function addDaysISO(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function fetchRetry(url, options, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, options);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt >= attempts) return res;
    await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250));
  }
}

async function graph(path, params) {
  const qs = new URLSearchParams({ access_token: TOKEN, ...params });
  const res = await fetchRetry(`${BASE}/${path}?${qs.toString()}`, { method: 'GET' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json && json.error ? `${json.error.code}/${json.error.error_subcode || 0} ${json.error.message}` : `${res.status}`;
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return json;
}

// Stable node-field snapshot. Returns {account_name, followers, fan_count?, media_count?}.
async function snapshot(platform) {
  if (platform === 'facebook') {
    const j = await graph(PAGE_ID, { fields: 'name,followers_count,fan_count' });
    return { account_name: j.name || null, followers: num(j.followers_count), fan_count: num(j.fan_count), media_count: null };
  }
  const j = await graph(IG_ID, { fields: 'username,followers_count,media_count' });
  return { account_name: j.username || null, followers: num(j.followers_count), fan_count: null, media_count: num(j.media_count) };
}
function num(v) { return v == null ? null : Number(v); }

// One insight metric as a {date: value} map over [sinceISO, untilISO], chunked. Throws on API error.
async function insightSeries(objId, metric, sinceISO, untilISO) {
  const out = {};
  for (let from = sinceISO; from < untilISO; from = addDaysISO(from, CHUNK_DAYS)) {
    const to = addDaysISO(from, CHUNK_DAYS) < untilISO ? addDaysISO(from, CHUNK_DAYS) : untilISO;
    const j = await graph(`${objId}/insights`, { metric, period: 'day', since: from, until: to });
    const series = (j.data && j.data[0] && j.data[0].values) || [];
    for (const v of series) {
      if (v == null || v.value == null || !v.end_time) continue;
      // period=day: end_time marks the end of the day's window; the value covers the
      // prior calendar day. Use end_time's date minus one day.
      const d = addDaysISO(String(v.end_time).slice(0, 10), -1);
      out[d] = typeof v.value === 'object' ? sumObj(v.value) : Number(v.value) || 0;
    }
  }
  return out;
}
function sumObj(o) { let s = 0; for (const k in o) s += Number(o[k]) || 0; return s; }

async function upsert(rows) {
  if (!rows.length) return 0;
  const res = await fetchRetry(
    `${SOCIAL_URL}/rest/v1/meta_account_daily?on_conflict=date,platform,account_id`,
    {
      method: 'POST',
      headers: {
        apikey: SOCIAL_KEY, Authorization: `Bearer ${SOCIAL_KEY}`,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) throw new Error(`meta_account_daily upsert failed: ${res.status} ${await res.text()}`);
  return rows.length;
}

// Pull one platform: snapshot (today) + daily insight metrics (best-effort). Returns counts + errors.
async function processPlatform(platform, objId, metricMap, sinceISO, untilISO) {
  const errors = [];
  const snap = await snapshot(platform); // node fields are stable; let a failure here fail the run (token/perms)

  // Daily: gather each metric into a per-date accumulator with a consistent column set.
  const cols = Array.from(new Set(metricMap.map((m) => m[1])));
  const byDate = {};
  for (const [metric, col] of metricMap) {
    try {
      const series = await insightSeries(objId, metric, sinceISO, untilISO);
      for (const d in series) {
        const row = byDate[d] || (byDate[d] = {});
        row[col] = series[d];
      }
    } catch (e) { errors.push(`${platform}.${metric}: ${String(e.message || e)}`); }
  }
  const now = new Date().toISOString();
  const dailyRows = Object.keys(byDate).map((d) => {
    const r = { date: d, platform, account_id: objId, account_name: snap.account_name, updated_at: now };
    for (const c of cols) r[c] = byDate[d][c] != null ? byDate[d][c] : null;
    return r;
  });
  const dailyWritten = await upsert(dailyRows);

  // Snapshot totals onto today's row (disjoint columns from the daily upsert).
  const snapWritten = await upsert([{
    date: todayISO(), platform, account_id: objId, account_name: snap.account_name,
    followers: snap.followers, fan_count: snap.fan_count, media_count: snap.media_count, updated_at: now,
  }]);

  return { snapWritten, dailyWritten, errors };
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!TOKEN) return res.status(500).json({ error: 'meta not configured (set META_ACCESS_TOKEN)' });
  if (!SOCIAL_URL || !SOCIAL_KEY) {
    return res.status(500).json({ error: 'social supabase not configured (set SOCIAL_SUPABASE_SERVICE_ROLE_KEY)' });
  }

  const full = req.query?.full === '1';
  const days = full ? FULL_DAYS : LOOKBACK_DAYS;
  const sinceISO = isoDaysAgo(days);
  const untilISO = todayISO();

  const out = { ok: true, full, days, facebook: null, instagram: null, insightErrors: [] };
  try {
    for (const [platform, objId, map] of [['facebook', PAGE_ID, FB_METRICS], ['instagram', IG_ID, IG_METRICS]]) {
      try {
        const r = await processPlatform(platform, objId, map, sinceISO, untilISO);
        out[platform] = { snapWritten: r.snapWritten, dailyWritten: r.dailyWritten };
        out.insightErrors.push(...r.errors);
      } catch (e) {
        out[platform] = { error: String(e.message || e) };
      }
    }
    if (!out.insightErrors.length) delete out.insightErrors;
    console.log(`[sync-meta] ${JSON.stringify(out)}`);
    return res.status(200).json(out);
  } catch (err) {
    console.error(`[sync-meta] error ${String(err)}`);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
