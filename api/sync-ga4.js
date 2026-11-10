// api/sync-ga4.js
//
// Daily Vercel cron that PULLS Google Analytics 4 traffic from the GA4 Data API
// and upserts one row per (date x default channel group) into Supabase
// `ga4_daily`. This is the "Direct / organic / referral" + overall traffic feed.
//
// Auth: an OAuth refresh token (not a service-account key). The org's Google
// policy blocks downloadable service-account keys, so we authorize once as a
// user with GA4 access and store the long-lived refresh token. Each run swaps
// it for a short-lived access token.
//
// Why a rolling window: GA4 finalizes figures ~1-2 days late, so we re-pull the
// last LOOKBACK_DAYS every run and upsert; the (date, channel) primary key makes
// the re-pull idempotent and corrects late data in place. Pass ?full=1 to
// backfill a long history (GA4_FULL_DAYS).
//
// Secrets come from Vercel env vars (names in .env.example). Public repo: never hardcode.

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const GA4_CLIENT_ID = process.env.GA4_CLIENT_ID;
const GA4_CLIENT_SECRET = process.env.GA4_CLIENT_SECRET;
const GA4_REFRESH_TOKEN = process.env.GA4_REFRESH_TOKEN;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Rolling re-pull window (days). Generous so a skipped run self-heals and late
// GA4 data gets corrected.
const LOOKBACK_DAYS = Number(process.env.GA4_LOOKBACK_DAYS || 30);
// Window used for ?full=1 backfills.
const FULL_DAYS = Number(process.env.GA4_FULL_DAYS || 400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, options, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, options);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt >= attempts) return res;
    await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250));
  }
}

// Swap the refresh token for a short-lived access token.
async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: GA4_CLIENT_ID,
    client_secret: GA4_CLIENT_SECRET,
    refresh_token: GA4_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetchRetry('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`oauth token failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('oauth token: no access_token in response');
  return json.access_token;
}

// runReport over date x channel. GA4 returns the `date` dimension as YYYYMMDD.
async function runReport(accessToken, days) {
  const res = await fetchRetry(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
        metrics: [
          { name: 'sessions' },
          { name: 'engagedSessions' },
          { name: 'totalUsers' },
          { name: 'newUsers' },
        ],
        limit: 100000,
      }),
    },
  );
  if (!res.ok) throw new Error(`runReport failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function toRows(report) {
  const rows = report.rows || [];
  return rows.map((r) => {
    const d = r.dimensionValues || [];
    const m = r.metricValues || [];
    const ymd = String(d[0]?.value || '');
    const date = ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null;
    return {
      date,
      channel: d[1]?.value || '(not set)',
      sessions: Number(m[0]?.value || 0),
      engaged_sessions: Number(m[1]?.value || 0),
      total_users: Number(m[2]?.value || 0),
      new_users: Number(m[3]?.value || 0),
      updated_at: new Date().toISOString(),
    };
  }).filter((r) => r.date);
}

// runReport over date x pagePath for the "top page views" feed. screenPageViews is
// GA4's page-view metric. Same YYYYMMDD date handling as the channel report.
async function runPageReport(accessToken, days) {
  const res = await fetchRetry(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'date' }, { name: 'pagePath' }],
        metrics: [
          { name: 'screenPageViews' },
          { name: 'sessions' },
          { name: 'totalUsers' },
        ],
        limit: 100000,
      }),
    },
  );
  if (!res.ok) throw new Error(`runPageReport failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function toPageRows(report) {
  const rows = report.rows || [];
  return rows.map((r) => {
    const d = r.dimensionValues || [];
    const m = r.metricValues || [];
    const ymd = String(d[0]?.value || '');
    const date = ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null;
    return {
      date,
      page_path: d[1]?.value || '(not set)',
      views: Number(m[0]?.value || 0),
      sessions: Number(m[1]?.value || 0),
      total_users: Number(m[2]?.value || 0),
      updated_at: new Date().toISOString(),
    };
  }).filter((r) => r.date && r.page_path);
}

// Upsert on (date, channel): both the merge-duplicates header and the
// ?on_conflict parameter are required (house rule).
async function upsertRows(rows) {
  if (!rows.length) return 0;
  const res = await fetchRetry(
    `${SUPABASE_URL}/rest/v1/ga4_daily?on_conflict=date,channel`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) throw new Error(`ga4_daily upsert failed: ${res.status} ${await res.text()}`);
  return rows.length;
}

// Upsert page rows on (date, page_path). Same merge-duplicates + on_conflict rule.
async function upsertPageRows(rows) {
  if (!rows.length) return 0;
  const res = await fetchRetry(
    `${SUPABASE_URL}/rest/v1/ga4_page_daily?on_conflict=date,page_path`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) throw new Error(`ga4_page_daily upsert failed: ${res.status} ${await res.text()}`);
  return rows.length;
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!GA4_PROPERTY_ID || !GA4_CLIENT_ID || !GA4_CLIENT_SECRET || !GA4_REFRESH_TOKEN) {
    return res.status(500).json({ error: 'ga4 not configured' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'supabase not configured' });
  }

  const full = req.query?.full === '1';
  const days = full ? FULL_DAYS : LOOKBACK_DAYS;

  try {
    const accessToken = await getAccessToken();

    const report = await runReport(accessToken, days);
    const rows = toRows(report);
    const written = await upsertRows(rows);

    // Page-level "top page views" feed into ga4_page_daily.
    const pageReport = await runPageReport(accessToken, days);
    const pageRows = toPageRows(pageReport);
    const pageWritten = await upsertPageRows(pageRows);

    console.log(`[sync-ga4] ${JSON.stringify({ full, days, rows: rows.length, written, pageRows: pageRows.length, pageWritten })}`);
    return res.status(200).json({ ok: true, full, days, rows: rows.length, written, pageRows: pageRows.length, pageWritten });
  } catch (err) {
    console.error(`[sync-ga4] error ${String(err)}`);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
