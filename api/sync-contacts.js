// api/sync-contacts.js
//
// Daily Vercel cron that REPLACES the GHL workflow "GHL <-> Claude AI via Supabase (Lani)"
// as the contact-sync path. It does NOT reimplement ingestion: it pulls GHL contacts changed
// since a cutoff and REPLAYS each one through the existing Supabase edge function `ghl-webhook`,
// which owns the six-table fan-out (contacts, investor_profiles, vendor_profiles, tool_access,
// event_attendance, readiness_surveys).
//
// Every survey answer and event Registered/Attended status is stored as a custom field on the
// contact, so a contact pull reproduces all six tables EXCEPT readiness_surveys -- that table is
// a per-submission log (survey_id + submission_id + submitted_at) which a contact's current
// field values can't reconstruct. Decision (David, 2026-11-02): the dashboard needs current
// answers only, not submission timing, so the whole workflow is retired and readiness_surveys
// simply stops gaining new rows. Existing rows are kept.
//
// Two modes:
//   - incremental (default): contacts changed since a stored watermark (sync_state.cursor),
//     oldest first. Advances the cursor only over changes it confirmed synced, so a budget cut
//     or a missed/failed run resumes from the gap next time -- nothing ages out unsynced. Runs
//     daily. First ever run bootstraps the window to LOOKBACK_HOURS.
//   - full (`?full=1&page=N`): sweep ALL contacts, one page per call, driven externally until
//     morePages is false. Weekly reconcile / backstop, since nothing pushes contacts any more.
//
// Idempotent by design: the edge function upserts with merge-semantics (stripNulls), so the
// cursor's small re-scan overlap never double-counts or blanks data.
//
// Secrets come from Vercel env vars (names in .env.example). Public repo: never hardcode them.

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

// GHL "Status" custom field -> becomes top-level `ghl_status` so the edge function writes
// contacts.ghl_membership_status. Verified id on 2026-11-02.
const STATUS_FIELD_ID = 'pVjzZbTLHlgbSX5IVbhc';

// How far back each daily run looks. >48h so one entirely missed daily run still self-heals
// on the next pass. With the GHL workflow retired, this cron is the ONLY contact path -- there
// is no real-time net -- so the window must absorb a skipped run.
const LOOKBACK_HOURS = Number(process.env.SYNC_LOOKBACK_HOURS || 50);

// Replays run concurrently so the daily window finishes well under the function time limit.
// Each contact is a GET + a POST; serial execution (~116 round-trips for ~58 contacts) times out.
const CONCURRENCY = Number(process.env.SYNC_CONCURRENCY || 4);

// Full-resync slice size: contacts replayed per `?full=1&page=N` call. Kept small so a single
// page finishes under the function limit; a driver walks pages until morePages is false. The
// weekly full sweep is the real backstop now that nothing pushes contacts in real time.
const FULL_PAGE_SIZE = Math.min(Number(process.env.SYNC_FULL_PAGE_SIZE || 50), 100);

// Wall-clock budget. Stop starting new replays a few seconds before Vercel's maxDuration (60s)
// so the response always returns with a resume hint instead of the function being killed mid-run.
const MAX_RUN_MS = Number(process.env.SYNC_MAX_RUN_MS || 55000);

// Supabase REST access for the incremental watermark (sync_state table). Service-role key: this
// is a backend-only cron and the table is RLS-locked, so the public anon key can't move the
// cursor. Used only by the incremental path.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CURSOR_KEY = 'contacts_incremental';

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_PRIVATE_TOKEN}`,
    Version: GHL_API_VERSION,
    'Content-Type': 'application/json',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GHL throttles bursts with HTTP 429. Retry those (and transient 5xx) with backoff,
// honoring a Retry-After header when GHL sends one. Everything else returns as-is for
// the caller to handle. Keeps the concurrent pool from dropping contacts under load.
async function fetchRetry(url, options, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(url, options);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt >= attempts) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250);
    await sleep(waitMs);
  }
}

// id -> bare custom-field key (e.g. "membership_type"). The edge function strips a leading
// "contact." itself, so a bare key is fine.
async function fetchFieldIdToKey(locationId) {
  const res = await fetchRetry(`${GHL_BASE}/locations/${locationId}/customFields`, { headers: ghlHeaders() });
  if (!res.ok) throw new Error(`customFields fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const map = {};
  for (const f of body.customFields || []) {
    if (f.id && f.fieldKey) map[f.id] = String(f.fieldKey).replace(/^contact\./, '');
  }
  return map;
}

// One page of contacts ({id, dateUpdated}) whose dateUpdated is >= sinceISO, newest first.
// Filter shape verified against live GHL v2 /contacts/search on 2026-11-02 (returned 348).
async function searchContactPage(locationId, sinceISO, page, pageLimit) {
  const res = await fetchRetry(`${GHL_BASE}/contacts/search`, {
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
  const batch = (await res.json()).contacts || [];
  const contacts = [];
  for (const c of batch) if (c.id) contacts.push({ id: c.id, dateUpdated: c.dateUpdated });
  return { contacts, hasMore: batch.length >= pageLimit };
}

// Incremental mode: walk every page since the cursor, then return oldest-first. A budget cut
// then defers the NEWEST changes, letting the watermark advance over the confirmed-synced oldest
// ones while the newest are retried next run.
async function fetchChangedContacts(locationId, sinceISO) {
  const all = [];
  for (let page = 1; page <= 500; page += 1) {
    const { contacts, hasMore } = await searchContactPage(locationId, sinceISO, page, 100);
    all.push(...contacts);
    if (!hasMore) break;
  }
  all.sort((a, b) => String(a.dateUpdated).localeCompare(String(b.dateUpdated)));
  return all;
}

async function fetchContact(contactId) {
  const res = await fetchRetry(`${GHL_BASE}/contacts/${contactId}`, { headers: ghlHeaders() });
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
  const res = await fetchRetry(process.env.GHL_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': process.env.GHL_WEBHOOK_SECRET },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`replay failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Read/advance the incremental watermark. The cursor is the dateUpdated the next run resumes
// from. Normalized to ISO-Z on read so the value handed to GHL's filter matches the format it
// expects (Supabase returns the timestamp with a +00:00 offset).
async function readCursor() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sync_state?key=eq.${CURSOR_KEY}&select=cursor`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`sync_state read failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows[0]?.cursor ? new Date(rows[0].cursor).toISOString() : null;
}

async function writeCursor(cursorISO) {
  // Supabase upsert needs BOTH the merge-duplicates header and ?on_conflict=<col> (CLAUDE.md).
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sync_state?on_conflict=key`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ key: CURSOR_KEY, cursor: cursorISO, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`sync_state write failed: ${res.status} ${await res.text()}`);
}

// Run `worker` over `items` with at most `concurrency` in flight. JS is single-threaded, so the
// shared counter increments are safe; this just overlaps the network waits.
async function runPool(items, worker, concurrency) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { await worker(items[i++]); }
  });
  await Promise.all(runners);
}

// One compact line per run so every invocation -- scheduled or manual -- is visible in Vercel's
// runtime logs (which only capture application output). Full error objects stay in the HTTP
// response; the log keeps just a count so a run is greppable without dumping contact data.
function logSummary(tag, result, extra = {}) {
  const { errors, ...counts } = result;
  console.log(`[sync-contacts] ${tag} ${JSON.stringify({ ...counts, errorCount: errors.length, ...extra })}`);
}

export default async function handler(req, res) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET> when the env var is set.
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const locationId = process.env.GHL_LOCATION_ID;
  const full = req.query?.full === '1'; // full resync: ignore the cursor, sweep all contacts

  // Stop starting new replays once we're this close to the function limit, so the response
  // always returns (with a resume hint) rather than the function being killed mid-run.
  const deadline = Date.now() + MAX_RUN_MS;

  const result = { since: null, full, found: 0, replayed: 0, failed: 0, deferred: 0, errors: [] };

  // Incremental watermark bookkeeping. Deferred items are the newest (ASC order, unstarted
  // suffix), so advancing the cursor to the newest SYNCED change still re-includes them next
  // run. Only a failure older than that point could be skipped, so we track failure timestamps
  // and never advance the cursor past the earliest failure. Unused by full mode.
  const failedTimes = [];
  let maxSynced = null;

  let idToKey;
  const replayOne = async (c) => {
    if (Date.now() > deadline) { result.deferred += 1; return; } // newest suffix; retried next run
    try {
      const contact = await fetchContact(c.id);
      await replay(toWebhookPayload(contact, idToKey));
      result.replayed += 1;
      const du = contact.dateUpdated ?? c.dateUpdated; // GET value is authoritative
      if (du && (!maxSynced || du > maxSynced)) maxSynced = du;
    } catch (err) {
      result.failed += 1;
      failedTimes.push(c.dateUpdated);
      if (result.errors.length < 20) result.errors.push({ id: c.id, error: String(err) });
    }
  };

  try {
    idToKey = await fetchFieldIdToKey(locationId);

    if (full) {
      // One search page per call; a driver (PowerShell loop / GitHub Actions) walks pages until
      // morePages is false. If the time budget cut the page short, re-run the SAME page.
      const sinceISO = new Date(0).toISOString();
      result.since = sinceISO;
      const page = Math.max(1, Number(req.query?.page) || 1);
      const { contacts, hasMore } = await searchContactPage(locationId, sinceISO, page, FULL_PAGE_SIZE);
      result.found = contacts.length;
      await runPool(contacts, replayOne, CONCURRENCY);
      const nextPage = result.deferred > 0 ? page : (hasMore ? page + 1 : null);
      logSummary('full', result, { page, nextPage });
      return res.status(200).json({ ok: true, ...result, page, morePages: nextPage !== null, nextPage });
    }

    // Incremental: resume from the stored watermark; bootstrap to LOOKBACK_HOURS on the first run.
    const cursor = await readCursor();
    const sinceISO = cursor ?? new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
    result.since = sinceISO;

    const contacts = await fetchChangedContacts(locationId, sinceISO); // oldest first
    result.found = contacts.length;
    await runPool(contacts, replayOne, CONCURRENCY);

    // Hold at/below the earliest failure so it retries; otherwise advance to the newest synced
    // change (deferred ones are newer, so they re-enter the window next run). If a failure's
    // timestamp is unknown, don't advance -- better to re-scan than to skip.
    let newCursor;
    if (failedTimes.some((t) => !t)) {
      newCursor = cursor;
    } else if (failedTimes.length) {
      newCursor = failedTimes.reduce((m, t) => (t < m ? t : m));
    } else {
      newCursor = maxSynced ?? cursor;
    }
    if (newCursor && newCursor !== cursor) await writeCursor(newCursor);

    logSummary('incremental', result, { cursor, newCursor });
    return res.status(200).json({ ok: true, ...result, cursor, newCursor });
  } catch (err) {
    console.error(`[sync-contacts] error ${String(err)} ${JSON.stringify({ full, found: result.found, replayed: result.replayed, failed: result.failed })}`);
    return res.status(500).json({ ok: false, error: String(err), ...result });
  }
}
