import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

// sync-ghl-messages
// Pulls texts (SMS) and social DMs from the GHL Conversations API into
// public.ghl_message_logs. Mirrors sync-ghl-calls: a watermark 'sweep' walks
// conversations newest-first until sweep_floor, split across runs via cursor_ms.
// READ-ONLY against GHL (reuses GHL_API_KEY_CALL_LOGS). No message bodies stored.

const GHL_KEY = Deno.env.get('GHL_API_KEY_CALL_LOGS') ?? '';
const LOCATION_ID = 'DNirEjy0ejVwbHsaBYrn';
const BASE = 'https://services.leadconnectorhq.com';
const BACKFILL_DAYS = 90;
const OVERLAP_MS = 2 * 60 * 60 * 1000;
const TIME_BUDGET_MS = 100_000;
const SMS_CODE = 2; // TYPE_SMS in conversation.messageTypes
const SOCIAL_CONV_TYPES = new Set(['TYPE_FB_MESSENGER', 'TYPE_INSTAGRAM', 'TYPE_GMB', 'TYPE_LIVE_CHAT', 'TYPE_WHATSAPP', 'TYPE_CUSTOM', 'TYPE_SOCIAL']);
const DM_MSG_TYPES = new Set(['TYPE_FACEBOOK', 'TYPE_INSTAGRAM', 'TYPE_WHATSAPP', 'TYPE_GMB', 'TYPE_LIVE_CHAT', 'TYPE_WEBCHAT', 'TYPE_CUSTOM']);

function channelFor(mt: string): string {
  if (mt === 'TYPE_SMS') return 'sms';
  if (DM_MSG_TYPES.has(mt)) return mt.replace('TYPE_', '').toLowerCase();
  return 'other';
}

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

async function loadUsers(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const d = await ghl(`/users/?locationId=${LOCATION_ID}`, '2021-07-28');
    for (const u of d.users ?? []) {
      map.set(u.id, u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id);
    }
  } catch (e) { console.error('users lookup failed', String(e)); }
  return map;
}

async function messagesForConversation(convId: string, type?: string): Promise<any[]> {
  const out: any[] = [];
  let lastId: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q = `/conversations/${convId}/messages?limit=100` + (type ? `&type=${type}` : '') + (lastId ? `&lastMessageId=${lastId}` : '');
    const d = await ghl(q);
    const box = d.messages ?? {};
    const list: any[] = Array.isArray(box) ? box : (box.messages ?? []);
    out.push(...list);
    if (!box.nextPage || !box.lastMessageId || list.length === 0) break;
    lastId = box.lastMessageId;
  }
  return out;
}

Deno.serve(async (req) => {
  const started = Date.now();
  const url = new URL(req.url);
  const noSkip = url.searchParams.get('noskip') === '1';
  if (!GHL_KEY) return Response.json({ error: 'GHL_API_KEY_CALL_LOGS not set' }, { status: 500 });

  const { data: lockRows } = await sb.from('ghl_message_sync_state')
    .update({ locked_until: new Date(Date.now() + 5 * 60_000).toISOString() })
    .eq('id', 'main')
    .or(`locked_until.is.null,locked_until.lt.${new Date().toISOString()}`)
    .select();
  if (!lockRows || lockRows.length === 0) return Response.json({ skipped: 'another run in progress' });
  const st = lockRows[0];

  const result: Record<string, unknown> = { conversations_scanned: 0, conversations_with_messages: 0, messages_upserted: 0 };
  let sweepStarted = st.sweep_started_ms as number | null;
  let floor = st.sweep_floor_ms as number | null;
  let cursor = st.cursor_ms as number | null;
  let watermark = st.watermark_ms as number | null;
  let sweepDone = false;

  try {
    if (cursor == null) {
      sweepStarted = Date.now();
      floor = watermark != null ? watermark - OVERLAP_MS : Date.now() - BACKFILL_DAYS * 86_400_000;
      cursor = null;
      result.new_sweep = true;
    }
    result.sweep_floor = new Date(floor!).toISOString();

    const users = await loadUsers();

    while (Date.now() - started < TIME_BUDGET_MS) {
      const q = `/conversations/search?locationId=${LOCATION_ID}&sortBy=last_message_date&sort=desc&limit=100` +
        (cursor != null ? `&startAfterDate=${cursor}` : '');
      const d = await ghl(q);
      const convs: any[] = d.conversations ?? [];
      if (convs.length === 0) { sweepDone = true; break; }

      const rows: any[] = [];
      let reachedFloor = false;
      for (const c of convs) {
        const lmd = Number(c.lastMessageDate ?? c.sort?.[0] ?? 0);
        if (lmd < floor!) { reachedFloor = true; break; }
        result.conversations_scanned = (result.conversations_scanned as number) + 1;
        const types: number[] | undefined = Array.isArray(c.messageTypes) ? c.messageTypes : undefined;
        const hasSMS = noSkip || !types || types.includes(SMS_CODE) || c.lastMessageType === 'TYPE_SMS';
        const isSocial = SOCIAL_CONV_TYPES.has(c.type) || DM_MSG_TYPES.has(c.lastMessageType);
        const msgs: any[] = [];
        if (hasSMS) {
          const s = await messagesForConversation(c.id, 'TYPE_SMS');
          for (const m of s) if (m.messageType === 'TYPE_SMS') msgs.push(m);
        }
        if (isSocial) {
          const a = await messagesForConversation(c.id);
          for (const m of a) if (DM_MSG_TYPES.has(m.messageType)) msgs.push(m);
        }
        if (msgs.length) result.conversations_with_messages = (result.conversations_with_messages as number) + 1;
        for (const m of msgs) {
          const at = Date.parse(m.dateAdded);
          if (!at || at < floor! - 86_400_000) continue;
          rows.push({
            ghl_message_id: m.id,
            conversation_id: m.conversationId ?? c.id,
            contact_id: m.contactId ?? c.contactId ?? null,
            contact_name: c.fullName || c.contactName || null,
            channel: channelFor(m.messageType),
            message_type: m.messageType ?? null,
            direction: m.direction ?? null,
            status: m.status ?? null,
            message_at: new Date(at).toISOString(),
            user_id: m.userId ?? null,
            user_name: m.userId ? (users.get(m.userId) ?? null) : null,
            from_addr: m.from ?? null,
            to_addr: m.to ?? null,
            last_synced_at: new Date().toISOString(),
          });
        }
        cursor = lmd;
        if (Date.now() - started > TIME_BUDGET_MS) break;
      }

      if (rows.length) {
        const { error } = await sb.from('ghl_message_logs').upsert(rows, { onConflict: 'ghl_message_id' });
        if (error) throw new Error('upsert: ' + error.message);
        result.messages_upserted = (result.messages_upserted as number) + rows.length;
      }
      if (reachedFloor || convs.length < 100) { sweepDone = true; break; }
    }

    const patch: Record<string, unknown> = { locked_until: null, last_run_at: new Date().toISOString() };
    if (sweepDone) {
      patch.watermark_ms = sweepStarted; patch.cursor_ms = null; patch.sweep_started_ms = null; patch.sweep_floor_ms = null;
    } else {
      patch.cursor_ms = cursor; patch.sweep_started_ms = sweepStarted; patch.sweep_floor_ms = floor;
    }
    result.sweep_done = sweepDone;
    result.cursor = cursor != null ? new Date(cursor).toISOString() : null;
    result.seconds = Math.round((Date.now() - started) / 1000);
    patch.last_run_result = result;
    await sb.from('ghl_message_sync_state').update(patch).eq('id', 'main');
    return Response.json(result);
  } catch (e) {
    result.error = String(e);
    await sb.from('ghl_message_sync_state').update({
      locked_until: null, last_run_at: new Date().toISOString(), last_run_result: result,
      cursor_ms: cursor, sweep_started_ms: sweepStarted, sweep_floor_ms: floor,
    }).eq('id', 'main');
    return Response.json(result, { status: 500 });
  }
});
