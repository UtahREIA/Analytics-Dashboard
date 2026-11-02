// api/sync-contacts.js
//
// Daily Vercel cron that REPLACES only the "Contact Changed / Contact Created" branch of the
// GHL workflow "GHL <-> Claude AI via Supabase (Lani)". It does NOT reimplement ingestion.
// It pulls GHL contacts changed since a cutoff and REPLAYS each one through the existing
// Supabase edge function `ghl-webhook`, which owns the six-table fan-out (contacts,
// investor_profiles, vendor_profiles, tool_access, event_attendance, readiness_surveys).
//
// Survey/event branches stay on a slimmed GHL workflow pointed at the same edge function.
//
// Idempotent by design: the edge function upserts with merge-semantics (stripNulls), so a
// lookback window that overlaps the previous run never double-counts or blanks data. That
// means we don't need to persist last-run state — a fixed overlapping window is enough.
//
// Secrets come from Vercel env vars (names in .env.example). Public repo: never hardcode them.
//
// STATUS: scaffold. Do not deploy until (1) Chris approves the Lani-pipeline change,
// (2) the GHL /contacts/search filter shape + contact location(s) are verified on first run,
// (3) it has run in parallel with the workflow and reconciled against the ~4,607 live contacts.

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

// GHL "Status" custom field -> becomes top-level `ghl_status` so the edge function writes
// contacts.ghl_membership_status. Verified id on 2026-11-02.
const STATUS_FIELD_ID = 'pVjzZbTLHlgbSX5IVbhc';

// How far back each daily run looks. >24h so a late/missed run self-heals on the next pass.
const LOOKBACK_HOURS = Number(process.env.SYNC_LOOKBACK_HOURS || 26);

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_PRIVATE_TOKEN}`,
    Version: GHL_API_VERSION,
    'Content-Type': 'application/json',
  };
}

// id -> bare custom-field key (e.g. "membership_type"). The edge function strips a leading
// "contact." itself, so a bare key is fine.
async function fetchFieldIdToKey(locationId) {
  const res = await fetch(`${GHL_BASE}/locations/${locationId}/customFields`, { headers: ghlHeaders() });
  if (!res.ok) throw new Error(`customFields fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const map = {};
  for (const f of body.customFields || []) {
    if (f.id && f.fieldKey) map[f.id] = String(f.fieldKey).replace(/^contact\./, '');
  }
  return map;
}

// Contacts whose dateUpdated is within the lookback window.
// NOTE: verify this filter shape against the live GHL v2 /contacts/search on first run; the
// endpoint is versioned and the date-range operator has changed historically.
async function fetchChangedContactIds(locationId, sinceISO) {
  const ids = [];
  let page = 1;
  const pageLimit = 100;
  for (;;) {
    const res = await fetch(`${GHL_BASE}/contacts/search`, {
      method: 'POST',
      headers: ghlHeaders(),
      body: JSON.stringify({
        locationId,
        page,
        pageLimit,
        filters: [{ field: 'dateUpdated', operator: 'range', value: { gte: sinceISO } }],
        sort: [{ field: 'dateUpdated', direction: 'desc' }],
      }),
    });
    if (!res.ok) throw new Error(`contacts/search failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    const batch = body.contacts || [];
    for (const c of batch) if (c.id) ids.push(c.id);
    if (batch.length < pageLimit) break;
    page += 1;
    if (page > 200) break; // safety cap
  }
  return ids;
}

async function fetchContact(contactId) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: ghlHeaders() });
  if (!res.ok) throw new Error(`contacts/${contactId} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).contact;
}

// Build the exact payload the GHL workflow's contact branch sends, so the edge function
// behaves identically. customFields are translated from {id,value} to {key,value}; the
// Status field is lifted to top-level ghl_status.
function toWebhookPayload(contact, idToKey) {
  const customFields = [];
  let ghlStatus = null;
  for (const cf of contact.customFields || []) {
    if (cf.id === STATUS_FIELD_ID) ghlStatus = cf.value;
    const key = idToKey[cf.id];
    if (key) customFields.push({ key, value: cf.value });
  }
  return {
    ghl_status: ghlStatus,
    contact: {
      id: contact.id,
      firstName: contact.firstName ?? null,
      lastName: contact.lastName ?? null,
      fullName: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || null,
      email: contact.email ?? null,
      phone: contact.phone ?? null,
      companyName: contact.companyName ?? null,
      customFields,
    },
  };
}

async function replay(payload) {
  const res = await fetch(process.env.GHL_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': process.env.GHL_WEBHOOK_SECRET },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`replay failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export default async function handler(req, res) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET> when the env var is set.
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const locationId = process.env.GHL_LOCATION_ID;
  const full = req.query?.full === '1'; // weekly full resync: ignore the lookback window
  const sinceISO = full
    ? new Date(0).toISOString()
    : new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();

  const result = { since: sinceISO, full, found: 0, replayed: 0, failed: 0, errors: [] };
  try {
    const idToKey = await fetchFieldIdToKey(locationId);
    const ids = await fetchChangedContactIds(locationId, sinceISO);
    result.found = ids.length;

    for (const id of ids) {
      try {
        const contact = await fetchContact(id);
        await replay(toWebhookPayload(contact, idToKey));
        result.replayed += 1;
      } catch (err) {
        result.failed += 1;
        if (result.errors.length < 20) result.errors.push({ id, error: String(err) });
      }
    }
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err), ...result });
  }
}
