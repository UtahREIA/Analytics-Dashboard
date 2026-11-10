// api/health.js
// Data-pipeline health check. Reads v_data_health (per-feed heartbeat: did the SYNC run,
// not when data last changed — so low-volume feeds don't false-alarm) and returns HTTP 200
// when every feed is fresh, 503 when any feed is STALE. A scheduled GitHub Action calls this
// and fails (which emails the repo owner) on non-200 — the alert, with no extra infrastructure.
// Also powers the "Data health" panel on the dashboard. Public on purpose (no secrets in the
// response); if Deployment Protection is enabled, allowlist /api/health or use a bypass token.

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ ok: false, error: 'supabase not configured' });
  try {
    const r = await fetch(`${SB}/rest/v1/v_data_health`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    if (!r.ok) throw new Error(`v_data_health -> ${r.status} ${await r.text()}`);
    const feeds = await r.json();
    const stale = feeds.filter((f) => f.status === 'STALE');
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
