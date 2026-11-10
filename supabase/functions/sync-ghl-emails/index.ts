import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

// sync-ghl-emails
// Pulls GHL email campaigns from /emails/schedule into public.ghl_email_campaigns
// (sent / delivered / failed per campaign). Full re-pull each run, idempotent
// upsert on the schedule id, so counts correct in place. READ-ONLY against GHL
// (reuses GHL_API_KEY_CALL_LOGS; needs the emails read scope on that token).
//
// NOTE: GHL's v2 API exposes send counts on the schedule object (totalCount,
// successCount, failed, queued) but NOT open/click stats — there is no working
// statistics endpoint (all /emails/statistics paths 404). Opens/clicks would
// need a GHL UI export or a per-contact conversation pull.
//
// ?probe=1 -> fetch first page only, return counts (no writes).

const GHL_KEY = Deno.env.get('GHL_API_KEY_CALL_LOGS') ?? '';
const LOCATION_ID = 'DNirEjy0ejVwbHsaBYrn';
const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';
const PAGE = 100;
const MAX_PAGES = 20;

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(offset: number): Promise<any[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(`${BASE}/emails/schedule?locationId=${LOCATION_ID}&limit=${PAGE}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${GHL_KEY}`, Version: VERSION, Accept: 'application/json' },
    });
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    const text = await r.text();
    if (!r.ok) throw new Error(`GHL ${r.status} on /emails/schedule: ${text.slice(0, 300)}`);
    return JSON.parse(text).schedules ?? [];
  }
  throw new Error('GHL retries exhausted on /emails/schedule');
}

function msToIso(ms: any): string | null {
  const n = Number(ms);
  if (!n || Number.isNaN(n)) return null;
  try { return new Date(n).toISOString(); } catch { return null; }
}

function mapRow(s: any) {
  return {
    id: s.id,
    name: s.name ?? null,
    subject: s.subject ?? null,
    status: s.status ?? null,
    campaign_type: s.campaignType ?? null,
    has_tracking: typeof s.hasTracking === 'boolean' ? s.hasTracking : null,
    has_utm_tracking: typeof s.hasUtmTracking === 'boolean' ? s.hasUtmTracking : null,
    total_count: Number.isFinite(s.totalCount) ? s.totalCount : null,
    delivered_count: Number.isFinite(s.successCount) ? s.successCount : null,
    processed_count: Number.isFinite(s.processed) ? s.processed : null,
    failed_count: Number.isFinite(s.failed) ? s.failed : null,
    queued_count: Number.isFinite(s.queuedCount) ? s.queuedCount : null,
    date_scheduled: msToIso(s.dateScheduled),
    ghl_created_at: s.createdAt ?? null,
    ghl_updated_at: s.updatedAt ?? s.dateUpdated ?? null,
    last_synced_at: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  const started = Date.now();
  const probe = new URL(req.url).searchParams.get('probe') === '1';
  if (!GHL_KEY) return Response.json({ error: 'GHL_API_KEY_CALL_LOGS not set' }, { status: 500 });

  const result: Record<string, unknown> = { fetched: 0, upserted: 0, pages: 0 };
  try {
    let fetched = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await fetchPage(page * PAGE);
      if (batch.length === 0) break;
      result.pages = (result.pages as number) + 1;
      fetched += batch.length;

      if (probe) {
        return Response.json({ probe: true, page_size: batch.length, sample: mapRow(batch[0]) });
      }

      const seen = new Set<string>();
      const rows: any[] = [];
      for (const s of batch) if (s.id && !seen.has(s.id)) { seen.add(s.id); rows.push(mapRow(s)); }
      if (rows.length) {
        const { error } = await sb.from('ghl_email_campaigns').upsert(rows, { onConflict: 'id' });
        if (error) throw new Error('upsert: ' + error.message);
        result.upserted = (result.upserted as number) + rows.length;
      }
      if (batch.length < PAGE) break;
    }
    result.fetched = fetched;
    result.seconds = Math.round((Date.now() - started) / 1000);
    return Response.json(result);
  } catch (e) {
    result.error = String(e);
    return Response.json(result, { status: 500 });
  }
});
