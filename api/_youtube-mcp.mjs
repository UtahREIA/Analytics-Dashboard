// api/_youtube-mcp.mjs  (shared handler; underscore prefix => not a route)
//
// A minimal, STATELESS Model Context Protocol (MCP) server over Streamable HTTP,
// exposing read-only YouTube stats so Claude (custom connector) can query the
// Utah REIA channel directly. Served by two routes:
//   - api/mcp-youtube.mjs        -> /api/mcp-youtube        (Authorization: Bearer header)
//   - api/mcp-youtube/[key].mjs  -> /api/mcp-youtube/<token> (secret in the URL path)
//
// AUTH: shared secret = MCP_YT_TOKEN (Vercel env + LastPass; never in the repo).
// Accepted as `Authorization: Bearer <token>` OR as the trailing URL path segment.
// Timing-safe compare; fails closed (401) if the token is unset or wrong.
//
// YouTube auth reuses the existing OAuth refresh token (YT_REFRESH_TOKEN with the
// youtube.readonly + yt-analytics.readonly scopes) on the GA4 OAuth client
// (GA4_CLIENT_ID/SECRET) -- same pattern as api/sync-youtube.js. Channel pinned by
// YT_CHANNEL_ID (Brand Account). READ-ONLY: Data API + YouTube Analytics reports.

import { timingSafeEqual } from 'node:crypto';

const YT_CLIENT_ID = process.env.GA4_CLIENT_ID;
const YT_CLIENT_SECRET = process.env.GA4_CLIENT_SECRET;
const YT_REFRESH_TOKEN = process.env.YT_REFRESH_TOKEN;
const YT_CHANNEL_ID = process.env.YT_CHANNEL_ID;
const MCP_YT_TOKEN = process.env.MCP_YT_TOKEN;

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'utah-reia-youtube', version: '1.0.0' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayISO = () => new Date().toISOString().slice(0, 10);
function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Number(n || 0));
  return d.toISOString().slice(0, 10);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

async function fetchRetry(url, options, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, options);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt >= attempts) return res;
    await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250));
  }
}

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

// Data API: channel snapshot. Pins by YT_CHANNEL_ID (Brand Account); else mine=true.
async function getChannel(accessToken) {
  const selector = YT_CHANNEL_ID ? `id=${encodeURIComponent(YT_CHANNEL_ID)}` : 'mine=true';
  const res = await fetchRetry(
    `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&${selector}&maxResults=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`channels.list ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = await res.json();
  const it = (json.items || [])[0];
  if (!it) throw new Error('no channel for this token');
  return {
    channel_id: it.id,
    channel_title: it.snippet?.title || null,
    subscribers: it.statistics?.hiddenSubscriberCount ? null : Number(it.statistics?.subscriberCount ?? 0),
    total_views: Number(it.statistics?.viewCount ?? 0),
    video_count: Number(it.statistics?.videoCount ?? 0),
  };
}

async function channelId(accessToken) {
  return YT_CHANNEL_ID || (await getChannel(accessToken)).channel_id;
}

// YouTube Analytics API report -> tidy rows keyed by columnHeader name (metrics as numbers).
async function analytics(accessToken, { startDate, endDate, metrics, dimensions, sort, maxResults }) {
  const id = await channelId(accessToken);
  const params = new URLSearchParams({ ids: `channel==${id}`, startDate, endDate, metrics });
  if (dimensions) params.set('dimensions', dimensions);
  if (sort) params.set('sort', sort);
  if (maxResults) params.set('maxResults', String(maxResults));
  const res = await fetchRetry(
    `https://youtubeanalytics.googleapis.com/v2/reports?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`analytics ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  const headers = (json.columnHeaders || []).map((h) => ({ name: h.name, metric: h.columnType === 'METRIC' }));
  const rows = (json.rows || []).map((r) => {
    const out = {};
    r.forEach((v, i) => { out[headers[i].name] = headers[i].metric ? Number(v) : v; });
    return out;
  });
  return rows;
}

// Resolve video titles for a set of video IDs (Data API videos.list).
async function videoTitles(accessToken, ids) {
  if (!ids.length) return {};
  const res = await fetchRetry(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.join(',')}&maxResults=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return {};
  const json = await res.json();
  const map = {};
  (json.items || []).forEach((it) => { map[it.id] = it.snippet?.title || it.id; });
  return map;
}

function range(args) {
  const endDate = args.endDate || todayISO();
  const startDate = args.startDate || isoDaysAgo(args.days || 30);
  return { startDate, endDate };
}

// ---- Tools -----------------------------------------------------------------

const TOOLS = [
  {
    name: 'youtube_channel_stats',
    description: 'Current snapshot of the Utah REIA YouTube channel: subscribers, lifetime views, and total video count.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'youtube_period_summary',
    description: 'Totals over a date range: views, watch time (minutes), average view duration (sec), subscribers gained/lost, likes, comments, shares. Dates YYYY-MM-DD; or pass days (default 30).',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD. Default: today minus `days`.' },
        endDate: { type: 'string', description: 'YYYY-MM-DD. Default today.' },
        days: { type: 'number', description: 'Trailing window if startDate omitted (default 30).' },
      },
    },
  },
  {
    name: 'youtube_daily',
    description: 'Per-day time series over a date range: views, watch time, subscribers gained/lost, likes, comments, shares. Dates YYYY-MM-DD; or pass days (default 30).',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD.' },
        endDate: { type: 'string', description: 'YYYY-MM-DD. Default today.' },
        days: { type: 'number', description: 'Trailing window if startDate omitted (default 30).' },
      },
    },
  },
  {
    name: 'youtube_top_videos',
    description: 'Top videos by views over a date range, with titles, watch time, likes and comments. Dates YYYY-MM-DD; or pass days (default 30).',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD.' },
        endDate: { type: 'string', description: 'YYYY-MM-DD. Default today.' },
        days: { type: 'number', description: 'Trailing window if startDate omitted (default 30).' },
        limit: { type: 'number', description: 'Max videos (default 10, max 50).' },
      },
    },
  },
  {
    name: 'youtube_traffic_sources',
    description: 'Where views came from over a date range (YouTube search, suggested videos, external, channel page, etc.), with views and watch time.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD.' },
        endDate: { type: 'string', description: 'YYYY-MM-DD. Default today.' },
        days: { type: 'number', description: 'Trailing window if startDate omitted (default 30).' },
      },
    },
  },
];

const MOVEMENT_METRICS = 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares';

async function callTool(name, args = {}) {
  const accessToken = await getAccessToken();

  if (name === 'youtube_channel_stats') {
    return await getChannel(accessToken);
  }

  if (name === 'youtube_period_summary') {
    const { startDate, endDate } = range(args);
    const rows = await analytics(accessToken, { startDate, endDate, metrics: MOVEMENT_METRICS });
    return { startDate, endDate, totals: rows[0] || {} };
  }

  if (name === 'youtube_daily') {
    const { startDate, endDate } = range(args);
    const rows = await analytics(accessToken, {
      startDate, endDate,
      metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost,likes,comments,shares',
      dimensions: 'day', sort: 'day',
    });
    return { startDate, endDate, rowCount: rows.length, rows };
  }

  if (name === 'youtube_top_videos') {
    const { startDate, endDate } = range(args);
    const limit = Math.min(Number(args.limit) || 10, 50);
    const rows = await analytics(accessToken, {
      startDate, endDate,
      metrics: 'views,estimatedMinutesWatched,likes,comments',
      dimensions: 'video', sort: '-views', maxResults: limit,
    });
    const titles = await videoTitles(accessToken, rows.map((r) => r.video).filter(Boolean));
    rows.forEach((r) => { r.title = titles[r.video] || r.video; });
    return { startDate, endDate, rowCount: rows.length, rows };
  }

  if (name === 'youtube_traffic_sources') {
    const { startDate, endDate } = range(args);
    const rows = await analytics(accessToken, {
      startDate, endDate,
      metrics: 'views,estimatedMinutesWatched',
      dimensions: 'insightTrafficSourceType', sort: '-views',
    });
    return { startDate, endDate, rowCount: rows.length, rows };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ---- JSON-RPC / MCP dispatch -----------------------------------------------

async function handleRpc(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // notification

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      },
    };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    try {
      const data = await callTool(params?.name, params?.arguments || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false } };
    } catch (err) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${String(err.message || err)}` }], isError: true } };
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function authorized(req) {
  if (!MCP_YT_TOKEN) return false;
  const fromPath = req.query?.key;
  if (fromPath && safeEqual(String(fromPath), MCP_YT_TOKEN)) return true;
  const auth = req.headers?.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && safeEqual(m[1], MCP_YT_TOKEN)) return true;
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
    return res.status(500).json({ error: 'youtube not configured' });
  }
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });

  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) { const r = await handleRpc(m); if (r) out.push(r); }
    if (!out.length) return res.status(202).end();
    return res.status(200).json(out);
  }

  const result = await handleRpc(body);
  if (!result) return res.status(202).end();
  return res.status(200).json(result);
}
