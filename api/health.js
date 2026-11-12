// api/health.js
// Data-pipeline health check. Reads v_data_health and returns HTTP 200 when every feed is
// healthy, 503 when any feed is STALE. A feed is STALE if EITHER signal fails:
//   - status      ("sync ran")   : the sync job stopped running, or
//   - data_status ("data fresh") : the newest data row is older than the feed's window.
// Social analytics live in a separate Supabase project, so its 3-day freshness is computed
// here and injected as an extra feed (the SQL view can't cross-query it).
// A scheduled GitHub Action calls this and fails (emailing the repo owner) on non-200.
// Public on purpose (no secrets in the response).

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Social project (Metricool-fed). Same env fallback chain as api/dashboard-data.mjs.
const SOCIAL_URL = process.env.SOCIAL_SUPABASE_URL || 'https://oeraqcuithvmeyljuzbd.supabase.co';
const SOCIAL_KEY = process.env.SOCIAL_SUPABASE_SERVICE_ROLE_KEY || process.env.SOCIAL_SUPABASE_KEY
  || process.env.SUPABASE_SOCIAL_SERVICE_ROLE_KEY || process.env.SOCIAL_SERVICE_ROLE_KEY
  || process.env.SOCIAL_SUPABASE_ANON_KEY || process.env.SOCIAL_SUPABASE_PUBLISHABLE_KEY || '';
const SOCIAL_WINDOW_MIN = 3 * 24 * 60; // 3 days

// Social freshness = the OLDEST per-network newest-date (so one dead network flags STALE even
// if others still update). Shape matches v_data_health rows; it has no "sync ran" heartbeat
// (the pull runs from a separate repo), so status is 'n/a' and only data_status is evaluated.
async function socialHealthRow() {
  const base = {
    feed: 'Social (Metricool)', last_run: null, age_min: null, max_age_min: null, status: 'n/a',
    last_data_at: null, data_age_min: null, data_max_age_min: SOCIAL_WINDOW_MIN, data_status: 'unknown', note: null,
  };
  if (!SOCIAL_KEY) return base;
  try {
    const r = await fetch(`${SOCIAL_URL}/rest/v1/evolution_daily?select=network,date&order=date.desc.nullslast&limit=2000`,
      { headers: { apikey: SOCIAL_KEY, Authorization: `Bearer ${SOCIAL_KEY}` } });
    if (!r.ok) return base;
    const rows = await r.json();
    const maxByNet = {};
    for (const x of rows) { if (x && x.date && (!maxByNet[x.network] || x.date > maxByNet[x.network])) maxByNet[x.network] = x.date; }
    const nets = Object.keys(maxByNet);
    if (!nets.length) return base;
    let lag = nets[0];
    for (const n of nets) if (maxByNet[n] < maxByNet[lag]) lag = n;
    const lagDate = maxByNet[lag];
    const ageMin = Math.round((Date.now() - new Date(lagDate + 'T00:00:00Z').getTime()) / 60000);
    return {
      ...base, last_data_at: lagDate, data_age_min: ageMin,
      data_status: ageMin > SOCIAL_WINDOW_MIN ? 'STALE' : 'fresh',
      note: `oldest network: ${lag} (${lagDate})`,
    };
  } catch { return base; }
}

const isStale = (f) => f.status === 'STALE' || f.data_status === 'STALE';

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ ok: false, error: 'supabase not configured' });
  try {
    const [vr, social] = await Promise.all([
      fetch(`${SB}/rest/v1/v_data_health`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }),
      socialHealthRow(),
    ]);
    if (!vr.ok) throw new Error(`v_data_health -> ${vr.status} ${await vr.text()}`);
    const feeds = (await vr.json()).concat([social]);
    const stale = feeds.filter(isStale);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(stale.length ? 503 : 200).json({
      ok: stale.length === 0,
      checked_at: new Date().toISOString(),
      stale: stale.map((f) => f.feed),
      feeds,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
