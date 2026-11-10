import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

// sync-ghl-workflows
// Pulls the GHL workflow inventory (GET /workflows/) into public.ghl_workflows.
// Metadata only — the GHL v2 API exposes NO execution/enrollment counts, so this
// records WHAT automations exist and their published/draft status, not how many
// contacts ran them. Full re-pull each run, idempotent upsert on ghl_workflow_id,
// so renames and status flips correct in place. READ-ONLY against GHL (reuses
// GHL_API_KEY_CALL_LOGS; the token now carries the workflows read scope).
//
// ?probe=1  -> fetch + return a sample, no writes.

const GHL_KEY = Deno.env.get('GHL_API_KEY_CALL_LOGS') ?? '';
const LOCATION_ID = 'DNirEjy0ejVwbHsaBYrn';
const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

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

function mapRow(w: any) {
  const status = (w.status ?? null);
  return {
    ghl_workflow_id: w.id,
    name: w.name ?? null,
    status: status,
    version: w.version != null ? String(w.version) : null,
    created_at_ghl: toIso(w.createdAt ?? w.dateAdded ?? w.created_at),
    updated_at_ghl: toIso(w.updatedAt ?? w.dateUpdated ?? w.updated_at),
    is_active: status != null ? String(status).toLowerCase() === 'published' : null,
    last_synced_at: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  const started = Date.now();
  const url = new URL(req.url);
  const probe = url.searchParams.get('probe') === '1';
  if (!GHL_KEY) return Response.json({ error: 'GHL_API_KEY_CALL_LOGS not set' }, { status: 500 });

  const result: Record<string, unknown> = { fetched: 0, upserted: 0 };
  try {
    const d = await ghl(`/workflows/?locationId=${LOCATION_ID}`);
    const workflows: any[] = d.workflows ?? d.data ?? [];
    result.fetched = workflows.length;

    if (probe) {
      const first = workflows[0] ?? null;
      return Response.json({
        probe: true,
        count: workflows.length,
        workflow_keys: first ? Object.keys(first) : [],
        sample_raw: first,
        sample_mapped: first ? mapRow(first) : null,
      });
    }

    const byId = new Map<string, any>();
    for (const w of workflows) if (w.id) byId.set(w.id, mapRow(w));
    const rows = [...byId.values()];

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await sb.from('ghl_workflows').upsert(chunk, { onConflict: 'ghl_workflow_id' });
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
