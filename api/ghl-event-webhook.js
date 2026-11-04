// api/ghl-event-webhook.js
//
// Receives GHL workflow webhooks for FORMS, SURVEYS, and EVENTS and records each
// as one row in Supabase `lead_events` via the record_lead_event() function, which
// resolves/dedupes the lead by phone_last10 -> ghl_contact_id -> email and keeps
// first-touch attribution. Idempotent: record_lead_event() upserts on
// (source_system, source_record_id, event_type, occurred_at), so GHL re-sends never
// double-count.
//
// GHL config (per form/survey/event workflow): add a "Webhook" (POST) action to
//   https://<this-app>/api/ghl-event-webhook?type=form     (or survey | event)
// and send the shared secret as ?secret=<GHL_EVENTS_WEBHOOK_SECRET> or header
// x-webhook-secret. Map these into the JSON body (GHL custom values on the right):
//   contact_id, email, phone, submission_id, name (form/survey/event name),
//   utm_source, utm_medium, utm_campaign, utm_content, utm_term, page_url, occurred_at
// Everything is optional; identity falls back phone -> ghl_contact_id -> email, and
// a missing submission_id is replaced by a stable composite so re-sends still dedupe.
// Pass event_type in the body to override the default (e.g. event_attended).
//
// Secrets come from Vercel env vars (names in .env.example). Public repo: never hardcode.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INGEST_SECRET = process.env.GHL_EVENTS_WEBHOOK_SECRET;

// ?type -> default event_type / channel / entry_point
const TYPE_MAP = {
  form:   { event_type: 'form_submitted',   channel: 'form',   entry_point: 'form' },
  survey: { event_type: 'survey_submitted', channel: 'survey', entry_point: 'survey' },
  event:  { event_type: 'event_registered', channel: 'event',  entry_point: 'event' },
};

// First non-empty value among candidate keys.
function pick(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

// GHL may send UTMs flat (utm_source) or nested under attributionSource /
// lastAttributionSource (utmSource, ...). Read both.
function extractUtms(body) {
  const attr = body.attributionSource || body.lastAttributionSource || {};
  return {
    utm_source:   pick(body, ['utm_source', 'utmSource'])     || attr.utmSource   || null,
    utm_medium:   pick(body, ['utm_medium', 'utmMedium'])     || attr.utmMedium   || null,
    utm_campaign: pick(body, ['utm_campaign', 'utmCampaign']) || attr.campaign || attr.utmCampaign || null,
    utm_content:  pick(body, ['utm_content', 'utmContent'])   || attr.utmContent  || null,
    utm_term:     pick(body, ['utm_term', 'utmTerm'])         || attr.utmTerm     || null,
    landing_url:  pick(body, ['page_url', 'pageUrl', 'landing_url', 'url']) || attr.url || null,
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  // Shared-secret gate (public repo + inbound endpoint). Enforced only when the env is set.
  if (INGEST_SECRET) {
    const provided = req.query?.secret || req.headers['x-webhook-secret'];
    if (provided !== INGEST_SECRET) return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[ghl-event-webhook] missing Supabase env');
    return res.status(500).json({ error: 'server not configured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const type = String(req.query?.type || body.type || 'form').toLowerCase();
  const map = TYPE_MAP[type];
  if (!map) return res.status(400).json({ error: `unknown type "${type}" (form|survey|event)` });

  // Identity (record_lead_event resolves priority phone -> ghl_contact_id -> email).
  const ghlContactId = pick(body, ['contact_id', 'contactId', 'ghl_contact_id', 'id']);
  const phone = pick(body, ['phone', 'phone_number', 'phoneNumber']);
  const email = pick(body, ['email', 'contact_email']);

  // Event identity / idempotency.
  const name = pick(body, ['form_name', 'formName', 'survey_name', 'surveyName', 'event_name', 'eventName', 'name']);
  const occurredRaw = pick(body, ['occurred_at', 'submitted_at', 'date_created', 'dateAdded', 'timestamp']);
  const occurredAt = occurredRaw ? new Date(occurredRaw).toISOString() : new Date().toISOString();
  const submissionId = pick(body, ['submission_id', 'submissionId', 'event_id', 'record_id']);
  // Stable id so re-sends dedupe; composite fallback when GHL sends no submission id.
  const recordId = submissionId
    || [ghlContactId || email || phone || 'anon', name || type, occurredAt].join('|');

  const eventType = pick(body, ['event_type', 'eventType']) || map.event_type;
  const utms = extractUtms(body);

  const rpcBody = {
    p_event_type: eventType,
    p_source_system: 'ghl',
    p_source_record_id: String(recordId),
    p_occurred_at: occurredAt,
    p_phone: phone ? String(phone) : null,
    p_ghl_contact_id: ghlContactId ? String(ghlContactId) : null,
    p_email: email ? String(email) : null,
    p_channel: map.channel,
    p_entry_point: map.entry_point,
    p_utm_source: utms.utm_source,
    p_utm_medium: utms.utm_medium,
    p_utm_campaign: utms.utm_campaign,
    p_utm_content: utms.utm_content,
    p_utm_term: utms.utm_term,
    p_landing_url: utms.landing_url,
    p_metadata: { type, name: name || null, submission_id: submissionId || null },
  };

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_lead_event`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rpcBody),
    });
    if (!r.ok) {
      const text = await r.text();
      console.error(`[ghl-event-webhook] rpc failed ${r.status} ${text}`);
      return res.status(502).json({ error: 'record failed', status: r.status });
    }
    const eventId = await r.json(); // scalar uuid
    // Compact, PII-free log line (booleans + type only).
    console.log(`[ghl-event-webhook] ${JSON.stringify({ type, eventType, identified: !!(phone || ghlContactId || email) })}`);
    return res.status(200).json({ ok: true, event_id: eventId });
  } catch (err) {
    console.error(`[ghl-event-webhook] error ${String(err)}`);
    return res.status(500).json({ error: String(err) });
  }
}
