import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

// sync-ghl-attribution
// Pulls each GHL contact's attribution into public.ghl_contact_attribution, via
// POST /contacts/search (returns both attributionSource + lastAttributionSource;
// no per-contact GET). Full re-pull each run, idempotent upsert on ghl_contact_id,
// so sources correct in place. READ-ONLY against GHL (reuses GHL_API_KEY_CALL_LOGS;
// needs contacts.readonly on that token).
//
// ?probe=1 -> fetch first page only, return a sample + sessionSource tally (no writes).
//
// 2026-11-09: also pulls utm_campaign (GHL `campaign`), utm_content, utm_term and
// the paid-ad signals (adId, adName, gclid) into the widened attribution table.
// 2026-11-18: FIRST TOUCH. The existing columns map lastAttributionSource (LAST
// touch). GHL keeps first touch in a separate object, attributionSource -- which
// is what "how they first found us" means. Now map both: first_* <- attributionSource,
// the generic columns <- lastAttributionSource, plus created_source <- contact.source
// (the entry label, populated even when attribution is empty: lc-phone-api, SURVEY,
// CLIENTPORTAL...). Backfills in place on the next run.

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
  // last = lastAttributionSource (most recent touch); first = attributionSource
  // (how they first found us). Either can be an empty {} when GHL captured no
  // web source (phone / portal / import) -- created_source still labels those.
  const last = c.lastAttributionSource ?? {};
  const first = c.attributionSource ?? {};
  const name = c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.fullNameLowerCase || null;
  return {
    ghl_contact_id: c.id,
    contact_name: name,
    date_added: c.dateAdded ?? null,
    // GHL's own entry label -- present even when both attribution objects are empty.
    created_source: c.source ?? null,
    // LAST touch (existing columns, unchanged meaning).
    session_source: last.sessionSource ?? null,
    medium: last.medium ?? null,
    utm_source: last.utmSource ?? null,
    utm_medium: last.utmMedium ?? null,
    // GHL stores the utm_campaign value in `campaign`; fall back to utmCampaign.
    utm_campaign: last.campaign ?? last.utmCampaign ?? null,
    utm_content: last.utmContent ?? null,
    utm_term: last.utmTerm ?? null,
    // Paid-ad signals: null until campaign ads run, then populated automatically.
    ad_id: last.adId ?? null,
    ad_name: last.adName ?? null,
    gclid: last.gclid ?? null,
    referrer: hostOf(last.referrer) ?? hostOf(last.url),
    // FIRST touch (new columns).
    first_session_source: first.sessionSource ?? null,
    first_medium: first.medium ?? null,
    first_utm_source: first.utmSource ?? null,
    first_utm_medium: first.utmMedium ?? null,
    first_utm_campaign: first.campaign ?? first.utmCampaign ?? null,
    first_utm_content: first.utmContent ?? null,
    first_utm_term: first.utmTerm ?? null,
    first_ad_id: first.adId ?? null,
    first_ad_name: first.adName ?? null,
    first_gclid: first.gclid ?? null,
    first_referrer: hostOf(first.referrer),
    first_url: first.url ?? null,
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
      const firstTally: Record<string, number> = {};
      const createdTally: Record<string, number> = {};
      for (const c of batch) {
        const fs = (c.attributionSource ?? {}).sessionSource ?? '(none)'; firstTally[fs] = (firstTally[fs] || 0) + 1;
        const cs = c.source ?? '(none)'; createdTally[cs] = (createdTally[cs] || 0) + 1;
      }
      return Response.json({
        probe: true,
        page_size: batch.length,
        first_sessionSource_tally: firstTally,
        created_source_tally: createdTally,
        sample_keys: batch[0] ? Object.keys(batch[0]) : [],
        sample_first_attr: batch[0] ? (batch[0].attributionSource ?? null) : null,
        sample_last_attr: batch[0] ? (batch[0].lastAttributionSource ?? null) : null,
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
