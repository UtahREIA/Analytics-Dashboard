import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

// sync-ghl-attribution
// Pulls each GHL contact's lastAttributionSource (lead source) into
// public.ghl_contact_attribution, via POST /contacts/search (full objects, no
// per-contact GET). Full re-pull each run, idempotent upsert on ghl_contact_id,
// so sources correct in place. READ-ONLY against GHL (reuses GHL_API_KEY_CALL_LOGS;
// needs contacts.readonly on that token).
//
// ?probe=1 -> fetch first page only, return a sample + sessionSource tally (no writes).

const GHL_KEY = Deno.env.get('GHL_API_KEY_CALL_LOGS') ?? '';
const LOCATION_ID = 'DNirEjy0ejVwbHsaBYrn';
const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';
const PAGE = 100;
const MAX_PAGES = 200;
const TIME_BUDGET_MS = 110_000;

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GHL page-based search caps near 2,700; deep pagination uses the per-contact
// `searchAfter` cursor instead. Pass the last contact's searchAfter to continue.
async function searchPage(after: any[] | null): Promise<any[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const body: Record<string, unknown> = { locationId: LOCATION_ID, pageLimit: PAGE, sort: [{ field: 'dateAdded', direction: 'desc' }] };
    if (after) body.searchAfter = after;
    const r = await fetch(`${BASE}/contacts/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GHL_KEY}`, Version: VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    const text = await r.text();
    if (!r.ok) throw new Error(`GHL ${r.status} on /contacts/search: ${text.slice(0, 300)}`);
    return JSON.parse(text).contacts ?? [];
  }
  throw new Error('GHL retries exhausted on /contacts/search');
}

function hostOf(v: any): string | null {
  if (!v) return null;
  try { return new URL(String(v)).hostname.replace(/^www\./, ''); } catch { return null; }
}

function mapRow(c: any) {
  const a = c.lastAttributionSource ?? c.attributionSource ?? {};
  const name = c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.fullNameLowerCase || null;
  return {
    ghl_contact_id: c.id,
    contact_name: name,
    date_added: c.dateAdded ?? null,
    session_source: a.sessionSource ?? null,
    medium: a.medium ?? null,
    utm_source: a.utmSource ?? null,
    utm_medium: a.utmMedium ?? null,
    referrer: hostOf(a.referrer) ?? hostOf(a.url),
    last_synced_at: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  const started = Date.now();
  const probe = new URL(req.url).searchParams.get('probe') === '1';
  if (!GHL_KEY) return Response.json({ error: 'GHL_API_KEY_CALL_LOGS not set' }, { status: 500 });

  const result: Record<string, unknown> = { fetched: 0, upserted: 0, pages: 0 };

  try {
    if (probe) {
      const batch = await searchPage(null);
      const tally: Record<string, number> = {};
      for (const c of batch) { const s = (c.lastAttributionSource ?? c.attributionSource ?? {}).sessionSource ?? '(none)'; tally[s] = (tally[s] || 0) + 1; }
      return Response.json({
        probe: true,
        page_size: batch.length,
        sessionSource_tally: tally,
        sample_keys: batch[0] ? Object.keys(batch[0]) : [],
        sample_attr: batch[0] ? (batch[0].lastAttributionSource ?? batch[0].attributionSource ?? null) : null,
        sample_mapped: batch[0] ? mapRow(batch[0]) : null,
      });
    }

    // Upsert per page so a client disconnect / timeout can't lose the whole run;
    // re-running simply tops it up (idempotent on ghl_contact_id).
    let fetched = 0;
    let after: any[] | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const batch = await searchPage(after);
      if (batch.length === 0) break;
      result.pages = (result.pages as number) + 1;
      fetched += batch.length;
      const seen = new Set<string>();
      const rows: any[] = [];
      for (const c of batch) if (c.id && !seen.has(c.id)) { seen.add(c.id); rows.push(mapRow(c)); }
      if (rows.length) {
        const { error } = await sb.from('ghl_contact_attribution').upsert(rows, { onConflict: 'ghl_contact_id' });
        if (error) throw new Error('upsert: ' + error.message);
        result.upserted = (result.upserted as number) + rows.length;
      }
      const last = batch[batch.length - 1];
      after = Array.isArray(last?.searchAfter) ? last.searchAfter : null;
      if (batch.length < PAGE || !after) break;
    }
    result.fetched = fetched;

    result.seconds = Math.round((Date.now() - started) / 1000);
    return Response.json(result);
  } catch (e) {
    result.error = String(e);
    return Response.json(result, { status: 500 });
  }
});
