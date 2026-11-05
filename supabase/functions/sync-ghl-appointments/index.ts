import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

// sync-ghl-appointments
// Pulls appointments from the GHL Calendars API (events per calendar) into
// public.ghl_appointments. Re-pulls a rolling window each run so status changes
// (showed / no-show / cancelled) correct in place. Idempotent on ghl_event_id.
// READ-ONLY against GHL (reuses GHL_API_KEY_CALL_LOGS).

const GHL_KEY = Deno.env.get('GHL_API_KEY_CALL_LOGS') ?? '';
const LOCATION_ID = 'DNirEjy0ejVwbHsaBYrn';
const BASE = 'https://services.leadconnectorhq.com';
const PAST_DAYS = 180;
const FUTURE_DAYS = 120;

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ghl(path: string, version = '2021-04-15'): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(BASE + path, {
      headers: { Authorization: `Bearer ${GHL_KEY}`, Version: version, Accept: 'application/json' },
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
  const n = Number(v);
  if (!Number.isNaN(n) && String(v).length >= 10 && /^\d+$/.test(String(v))) return new Date(n).toISOString();
  const d = Date.parse(String(v));
  return Number.isNaN(d) ? null : new Date(d).toISOString();
}

Deno.serve(async (_req) => {
  const started = Date.now();
  if (!GHL_KEY) return Response.json({ error: 'GHL_API_KEY_CALL_LOGS not set' }, { status: 500 });

  const startMs = Date.now() - PAST_DAYS * 86_400_000;
  const endMs = Date.now() + FUTURE_DAYS * 86_400_000;
  const result: Record<string, unknown> = { calendars: 0, events_found: 0, upserted: 0, errors: [] as string[] };

  try {
    const calData = await ghl(`/calendars/?locationId=${LOCATION_ID}`, '2021-04-15');
    const calendars: any[] = calData.calendars ?? [];
    result.calendars = calendars.length;
    const calName = new Map<string, string>();
    for (const c of calendars) calName.set(c.id, c.name || null);

    const rows: any[] = [];
    for (const cal of calendars) {
      try {
        const d = await ghl(`/calendars/events?locationId=${LOCATION_ID}&calendarId=${cal.id}&startTime=${startMs}&endTime=${endMs}`, '2021-04-15');
        const events: any[] = d.events ?? [];
        result.events_found = (result.events_found as number) + events.length;
        for (const e of events) {
          rows.push({
            ghl_event_id: e.id,
            calendar_id: e.calendarId ?? cal.id,
            calendar_name: calName.get(e.calendarId ?? cal.id) ?? cal.name ?? null,
            contact_id: e.contactId ?? null,
            contact_name: e.contactName ?? (e.contact && (e.contact.name)) ?? null,
            title: e.title ?? null,
            status: e.appointmentStatus ?? e.status ?? null,
            start_at: toIso(e.startTime),
            end_at: toIso(e.endTime),
            date_added: toIso(e.dateAdded),
            assigned_user_id: e.assignedUserId ?? null,
            last_synced_at: new Date().toISOString(),
          });
        }
      } catch (err) {
        (result.errors as string[]).push(`cal ${cal.id}: ${String(err).slice(0, 160)}`);
      }
    }

    // de-dup by ghl_event_id (an event can surface under its calendar once)
    const byId = new Map<string, any>();
    for (const r of rows) if (r.ghl_event_id) byId.set(r.ghl_event_id, r);
    const dedup = [...byId.values()];

    for (let i = 0; i < dedup.length; i += 500) {
      const chunk = dedup.slice(i, i + 500);
      const { error } = await sb.from('ghl_appointments').upsert(chunk, { onConflict: 'ghl_event_id' });
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
