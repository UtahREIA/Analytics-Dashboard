import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

// sync-ghl-opportunities
// Pulls pipeline opportunities from the GHL Opportunities API into
// public.ghl_opportunities. Resolves pipeline + stage names from the pipelines
// endpoint and denormalizes them onto each row. Full re-pull each run, idempotent
// upsert on ghl_opportunity_id, so status/stage changes correct in place.
// READ-ONLY against GHL (reuses GHL_API_KEY_CALL_LOGS).
//
// ?probe=1  -> fetch pipelines + first page only, return a sample (no writes).

const GHL_KEY = Deno.env.get('GHL_API_KEY_CALL_LOGS') ?? '';
const LOCATION_ID = 'DNirEjy0ejVwbHsaBYrn';
const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';
const PAGE = 100;
const MAX_PAGES = 200;
const TIME_BUDGET_MS = 100_000;

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ghl(path: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(BASE + path, {
      headers: { Authorization: `Bearer ${GHL_KEY}`, Version: VERSION, Accept: 'application/json' },
    });
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    const text = await r.text();
    if (!r.ok) throw new Error(`GHL ${r.status} on ${path.split('?')[0]}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
  throw new Error(`GHL retries exhausted on ${path.split('?')[0]}`);
}

function toIso(v: any): string | null {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v).toISOString();
  const s = String(v);
  if (/^\d+$/.test(s) && s.length >= 10) return new Date(Number(s)).toISOString();
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : new Date(d).toISOString();
}

// pipelineId -> { name, stages: Map<stageId, stageName> }
async function loadPipelines(): Promise<Map<string, { name: string; stages: Map<string, string> }>> {
  const map = new Map<string, { name: string; stages: Map<string, string> }>();
  const d = await ghl(`/opportunities/pipelines?locationId=${LOCATION_ID}`);
  for (const p of d.pipelines ?? []) {
    const stages = new Map<string, string>();
    for (const s of p.stages ?? []) stages.set(s.id, s.name);
    map.set(p.id, { name: p.name, stages });
  }
  return map;
}

function mapRow(o: any, pipelines: Map<string, { name: string; stages: Map<string, string> }>) {
  const pid = o.pipelineId ?? o.pipeline_id ?? null;
  const sid = o.pipelineStageId ?? o.stageId ?? o.pipeline_stage_id ?? null;
  const pipe = pid ? pipelines.get(pid) : undefined;
  return {
    ghl_opportunity_id: o.id,
    pipeline_id: pid,
    pipeline_name: pipe?.name ?? null,
    stage_id: sid,
    stage_name: sid && pipe ? (pipe.stages.get(sid) ?? null) : null,
    name: o.name ?? null,
    status: o.status ?? null,
    monetary_value: o.monetaryValue ?? o.monetary_value ?? null,
    contact_id: o.contactId ?? o.contact?.id ?? null,
    contact_name: o.contact?.name ?? o.contactName ?? o.name ?? null,
    assigned_to: o.assignedTo ?? o.assigned_to ?? null,
    source: o.source ?? null,
    created_at_ghl: toIso(o.createdAt ?? o.dateAdded ?? o.created_at),
    updated_at_ghl: toIso(o.updatedAt ?? o.dateUpdated ?? o.updated_at),
    last_status_change_at: toIso(o.lastStatusChangeAt ?? o.last_status_change_at),
    last_stage_change_at: toIso(o.lastStageChangeAt ?? o.last_stage_change_at),
    last_synced_at: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  const started = Date.now();
  const url = new URL(req.url);
  const probe = url.searchParams.get('probe') === '1';
  if (!GHL_KEY) return Response.json({ error: 'GHL_API_KEY_CALL_LOGS not set' }, { status: 500 });

  const result: Record<string, unknown> = { pipelines: 0, fetched: 0, upserted: 0, pages: 0 };

  try {
    const pipelines = await loadPipelines();
    result.pipelines = pipelines.size;

    if (probe) {
      const d = await ghl(`/opportunities/search?location_id=${LOCATION_ID}&limit=5`);
      const first = (d.opportunities ?? [])[0] ?? null;
      return Response.json({
        probe: true,
        pipeline_names: [...pipelines.values()].map((p) => p.name),
        meta_keys: Object.keys(d.meta ?? {}),
        meta: d.meta ?? null,
        opportunity_keys: first ? Object.keys(first) : [],
        sample_raw: first,
        sample_mapped: first ? mapRow(first, pipelines) : null,
      });
    }

    let startAfter: string | null = null;
    let startAfterId: string | null = null;
    const all: any[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const q = `/opportunities/search?location_id=${LOCATION_ID}&limit=${PAGE}` +
        (startAfter ? `&startAfter=${startAfter}` : '') +
        (startAfterId ? `&startAfterId=${startAfterId}` : '');
      const d = await ghl(q);
      const opps: any[] = d.opportunities ?? [];
      result.pages = (result.pages as number) + 1;
      all.push(...opps);
      const meta = d.meta ?? {};
      startAfter = meta.startAfter != null ? String(meta.startAfter) : null;
      startAfterId = meta.startAfterId ?? null;
      if (opps.length < PAGE || !startAfterId) break;
    }
    result.fetched = all.length;

    const byId = new Map<string, any>();
    for (const o of all) if (o.id) byId.set(o.id, mapRow(o, pipelines));
    const rows = [...byId.values()];

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await sb.from('ghl_opportunities').upsert(chunk, { onConflict: 'ghl_opportunity_id' });
      if (error) throw new Error('upsert: ' + error.message);
      result.upserted = (result.upserted as number) + chunk.length;
    }

    result.seconds = Math.round((Date.now() - started) / 1000);
    return Response.json(result);
  } catch (e) {
    result.error = String(e);
    return Response.json(result, { status: 500 });
  }
});
