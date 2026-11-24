// api/mcp/[key].mjs
//
// A minimal, STATELESS Model Context Protocol (MCP) server over Streamable HTTP,
// exposing read-only Google Analytics 4 tools so Claude (custom connector) can
// query GA4 directly. One Vercel function; no framework.
//
// AUTH: a shared secret in the URL path -> /api/mcp/<MCP_GA4_TOKEN>. Claude.ai's
// custom-connector UI has no field for a bearer header, so the secret rides in the
// path instead (an Authorization: Bearer <token> header is also accepted for
// Claude Code / Desktop). Wrong/absent token -> 401. Keep the URL private (LastPass).
//
// GA4 auth reuses the existing OAuth refresh token (GA4_CLIENT_ID/SECRET/
// REFRESH_TOKEN, property GA4_PROPERTY_ID) -- same pattern as api/sync-ga4.js.
// READ-ONLY: only runReport / runRealtimeReport are called. Public repo: no secrets.
//
// Protocol: handles `initialize`, `notifications/initialized`, `tools/list`,
// `tools/call` as JSON-RPC 2.0 over POST, replying application/json (stateless).

import { timingSafeEqual } from 'node:crypto';

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const GA4_CLIENT_ID = process.env.GA4_CLIENT_ID;
const GA4_CLIENT_SECRET = process.env.GA4_CLIENT_SECRET;
const GA4_REFRESH_TOKEN = process.env.GA4_REFRESH_TOKEN;
const MCP_GA4_TOKEN = process.env.MCP_GA4_TOKEN;

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'utah-reia-ga4', version: '1.0.0' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Swap the long-lived refresh token for a short-lived access token.
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

async function ga4(method, requestBody) {
  const accessToken = await getAccessToken();
  const res = await fetchRetry(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:${method}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`GA4 ${method} ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

// Flatten a GA4 report into tidy rows keyed by header name; reformat the YYYYMMDD
// `date` dimension to YYYY-MM-DD and coerce metrics to numbers.
function formatReport(report) {
  const dims = (report.dimensionHeaders || []).map((h) => h.name);
  const mets = (report.metricHeaders || []).map((h) => h.name);
  const rows = (report.rows || []).map((r) => {
    const out = {};
    (r.dimensionValues || []).forEach((v, i) => {
      let val = v.value;
      if (dims[i] === 'date' && /^\d{8}$/.test(val)) val = `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`;
      out[dims[i]] = val;
    });
    (r.metricValues || []).forEach((v, i) => { out[mets[i]] = Number(v.value); });
    return out;
  });
  return { rowCount: report.rowCount ?? rows.length, rows };
}

// ---- Tools -----------------------------------------------------------------

const TOOLS = [
  {
    name: 'ga4_run_report',
    description:
      'Run an arbitrary Google Analytics 4 report for the Utah REIA property. Supply GA4 API dimension and metric names (e.g. dimensions ["date","sessionDefaultChannelGroup","pagePath","country","deviceCategory"]; metrics ["sessions","totalUsers","newUsers","screenPageViews","engagedSessions","eventCount","conversions","averageSessionDuration","bounceRate"]). Dates are GA4 expressions like "2026-11-01", "28daysAgo", "yesterday", "today".',
    inputSchema: {
      type: 'object',
      properties: {
        dimensions: { type: 'array', items: { type: 'string' }, description: 'GA4 dimension names.' },
        metrics: { type: 'array', items: { type: 'string' }, description: 'GA4 metric names.' },
        startDate: { type: 'string', description: 'Start date (GA4 expression). Default 28daysAgo.' },
        endDate: { type: 'string', description: 'End date (GA4 expression). Default today.' },
        limit: { type: 'number', description: 'Max rows (default 100, max 10000).' },
        orderByMetric: { type: 'string', description: 'Metric name to sort by, descending.' },
      },
      required: ['metrics'],
    },
  },
  {
    name: 'ga4_top_pages',
    description: 'Top pages by views for the Utah REIA site over a date range (pagePath x screenPageViews, sessions, totalUsers).',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Default 28daysAgo.' },
        endDate: { type: 'string', description: 'Default today.' },
        limit: { type: 'number', description: 'Max pages (default 25).' },
      },
    },
  },
  {
    name: 'ga4_traffic_by_channel',
    description: 'Sessions, users and new users grouped by default channel group (Direct, Organic Search, Referral, Social, ...) over a date range.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Default 28daysAgo.' },
        endDate: { type: 'string', description: 'Default today.' },
      },
    },
  },
  {
    name: 'ga4_realtime_users',
    description: 'Active users on the Utah REIA site right now (last 30 minutes), broken down by device category and country.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args = {}) {
  const startDate = args.startDate || '28daysAgo';
  const endDate = args.endDate || 'today';

  if (name === 'ga4_run_report') {
    const metrics = Array.isArray(args.metrics) ? args.metrics : [];
    if (!metrics.length) throw new Error('ga4_run_report requires at least one metric.');
    const dimensions = Array.isArray(args.dimensions) ? args.dimensions : [];
    const body = {
      dateRanges: [{ startDate, endDate }],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      limit: Math.min(Number(args.limit) || 100, 10000),
    };
    if (args.orderByMetric) body.orderBys = [{ desc: true, metric: { metricName: args.orderByMetric } }];
    return formatReport(await ga4('runReport', body));
  }

  if (name === 'ga4_top_pages') {
    return formatReport(await ga4('runReport', {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ desc: true, metric: { metricName: 'screenPageViews' } }],
      limit: Math.min(Number(args.limit) || 25, 1000),
    }));
  }

  if (name === 'ga4_traffic_by_channel') {
    return formatReport(await ga4('runReport', {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' }, { name: 'engagedSessions' }],
      orderBys: [{ desc: true, metric: { metricName: 'sessions' } }],
      limit: 1000,
    }));
  }

  if (name === 'ga4_realtime_users') {
    return formatReport(await ga4('runRealtimeReport', {
      dimensions: [{ name: 'deviceCategory' }, { name: 'country' }],
      metrics: [{ name: 'activeUsers' }],
      limit: 1000,
    }));
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ---- JSON-RPC / MCP dispatch -----------------------------------------------

async function handleRpc(msg) {
  const { id, method, params } = msg;
  // Notifications (no id) get no response body.
  if (id === undefined || id === null) return null;

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
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const toolName = params?.name;
    try {
      const data = await callTool(toolName, params?.arguments || {});
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `Error: ${String(err.message || err)}` }], isError: true },
      };
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function authorized(req) {
  if (!MCP_GA4_TOKEN) return false; // fail closed if unconfigured
  const fromPath = req.query?.key;
  if (fromPath && safeEqual(String(fromPath), MCP_GA4_TOKEN)) return true;
  const auth = req.headers?.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && safeEqual(m[1], MCP_GA4_TOKEN)) return true;
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!GA4_PROPERTY_ID || !GA4_CLIENT_ID || !GA4_CLIENT_SECRET || !GA4_REFRESH_TOKEN) {
    return res.status(500).json({ error: 'ga4 not configured' });
  }
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  // Stateless: no server-held sessions, so GET/DELETE session ops are not served.
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });

  // A client may batch messages in an array.
  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) { const r = await handleRpc(m); if (r) out.push(r); }
    if (!out.length) return res.status(202).end();
    return res.status(200).json(out);
  }

  const result = await handleRpc(body);
  if (!result) return res.status(202).end(); // notification: accepted, no body
  return res.status(200).json(result);
}
