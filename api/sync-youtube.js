// api/sync-youtube.js
//
// Daily Vercel cron that PULLS first-party YouTube stats and upserts one row per
// (date x channel) into Supabase `youtube_channel_daily`. This replaces the
// inaccurate Metricool feed for YouTube.
//
// Two Google APIs, one OAuth client (reuses the GA4 credentials — same project):
//   1. YouTube Data API v3  -> channel SNAPSHOT: subscribers, lifetime views,
//      video count (cumulative totals as of the pull).
//   2. YouTube Analytics API -> per-day MOVEMENT: views, watch time, subs
//      gained/lost, likes, comments, shares for each calendar day.
//
// Auth: an OAuth refresh token minted for the channel-owning Google account with
// the youtube.readonly + yt-analytics.readonly scopes. Each run swaps the refresh
// token for a short-lived access token (same pattern as sync-ga4.js). The org's
// Google policy blocks service-account keys, hence the user-OAuth approach.
//
// Why a rolling window: YouTube Analytics finalizes figures a few days late, so we
// re-pull the last LOOKBACK_DAYS every run and upsert; the (date, channel) key
// makes the re-pull idempotent and corrects late data in place. Pass ?full=1 to
// backfill a long history (YT_FULL_DAYS).
//
// The snapshot (subscribers / total_views / video_count) is a single current value,
// so it is written only onto today's row. Daily-movement and snapshot columns are
// upserted in two separate requests with DISJOINT column sets, so each request's
// merge-duplicates only updates the columns it carries and never nulls the other's.
//
// Secrets come from Vercel env vars (names in .env.example). Public repo: never hardcode.

const YT_CLIENT_ID = process.env.GA4_CLIENT_ID;          // same Google OAuth client as GA4
const YT_CLIENT_SECRET = process.env.GA4_CLIENT_SECRET;  // same Google OAuth client as GA4
const YT_REFRESH_TOKEN = process.env.YT_REFRESH_TOKEN;   // minted with the youtube scopes

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Rolling re-pull window (days). Generous so a skipped run self-heals and late
// YouTube Analytics data gets corrected.
const LOOKBACK_DAYS = Number(process.env.YT_LOOKBACK_DAYS || 30);
// Window used for ?full=1 backfills.
const FULL_DAYS = Number(process.env.YT_FULL_DAYS || 400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, options, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, options);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt >= attempts) return res;
    await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250));
  }
}

// YYYY-MM-DD for a date N days before today (UTC).
function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
const todayISO = () => new Date().toISOString().slice(0, 10);

// Swap the refresh token for a short-lived access token.
async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: YT_CLIENT_ID,
    client_secret: YT_CLIENT_SECRET,
    refresh_token: YT_REFRESH_TOKEN,
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

// Data API: the channel(s) the authorized user owns, with snapshot statistics.
async function getChannels(accessToken) {
  const res = await fetchRetry(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true&maxResults=50',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`channels.list failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return (json.items || []).map((it) => ({
    channel_id: it.id,
    channel_title: it.snippet?.title || null,
    subscribers: it.statistics?.hiddenSubscriberCount ? null : Number(it.statistics?.subscriberCount ?? 0),
    total_views: Number(it.statistics?.viewCount ?? 0),
    video_count: Number(it.statistics?.videoCount ?? 0),
  }));
}

// Analytics API: per-day movement for one owned channel.
async function getDailyAnalytics(accessToken, channelId, days) {
  const params = new URLSearchParams({
    ids: `channel==${channelId}`,
    startDate: isoDaysAgo(days),
    endDate: todayISO(),
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares',
    dimensions: 'day',
    sort: 'day',
  });
  const res = await fetchRetry(
    `https://youtubeanalytics.googleapis.com/v2/reports?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`analytics report failed (${channelId}): ${res.status} ${await res.text()}`);
  const json = await res.json();
  const now = new Date().toISOString();
  // Column order matches the `metrics` list above, with `day` first (the dimension).
  return (json.rows || []).map((r) => ({
    date: r[0],
    channel_id: channelId,
    views: Number(r[1] || 0),
    minutes_watched: Number(r[2] || 0),
    avg_view_duration_sec: Number(r[3] || 0),
    subscribers_gained: Number(r[4] || 0),
    subscribers_lost: Number(r[5] || 0),
    likes: Number(r[6] || 0),
    comments: Number(r[7] || 0),
    shares: Number(r[8] || 0),
    updated_at: now,
  }));
}

// Upsert on (date, channel_id). Both the merge-duplicates header and the
// ?on_conflict parameter are required (house rule). Each call carries only the
// columns it owns, so merging never nulls columns written by the other call.
async function upsert(rows) {
  if (!rows.length) return 0;
  const res = await fetchRetry(
    `${SUPABASE_URL}/rest/v1/youtube_channel_daily?on_conflict=date,channel_id`,
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
  if (!res.ok) throw new Error(`youtube_channel_daily upsert failed: ${res.status} ${await res.text()}`);
  return rows.length;
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
    return res.status(500).json({ error: 'youtube not configured' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'supabase not configured' });
  }

  const full = req.query?.full === '1';
  const days = full ? FULL_DAYS : LOOKBACK_DAYS;

  try {
    const accessToken = await getAccessToken();

    const channels = await getChannels(accessToken);
    if (!channels.length) {
      return res.status(200).json({ ok: true, channels: 0, note: 'no owned channel for this token' });
    }

    const today = todayISO();
    let dailyWritten = 0;
    let snapWritten = 0;

    for (const ch of channels) {
      // Per-day movement (does NOT carry snapshot columns).
      const daily = await getDailyAnalytics(accessToken, ch.channel_id, days);
      // Stamp the channel title on daily rows too, so the row is complete even
      // on days the snapshot upsert does not touch.
      daily.forEach((d) => { d.channel_title = ch.channel_title; });
      dailyWritten += await upsert(daily);

      // Snapshot (cumulative totals) onto today's row only (does NOT carry daily columns).
      snapWritten += await upsert([{
        date: today,
        channel_id: ch.channel_id,
        channel_title: ch.channel_title,
        subscribers: ch.subscribers,
        total_views: ch.total_views,
        video_count: ch.video_count,
        updated_at: new Date().toISOString(),
      }]);
    }

    console.log(`[sync-youtube] ${JSON.stringify({ full, days, channels: channels.length, dailyWritten, snapWritten })}`);
    return res.status(200).json({ ok: true, full, days, channels: channels.length, dailyWritten, snapWritten });
  } catch (err) {
    console.error(`[sync-youtube] error ${String(err)}`);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
