// api/sync-form-submissions.js
//
// Daily Vercel cron that PULLS GHL form submissions from the GHL API and writes
// each as a lead_events row via the record_lead_event() Supabase function. This
// REPLACES per-workflow "Webhook" actions (a GHL premium feature billed per run):
// reading the submissions API costs nothing extra, and the submission already
// carries full attribution (contact, phone/email, submissionId, UTMs, timestamp).
//
// Why a rolling window instead of a precise cursor: record_lead_event() is
// idempotent on (source_system, source_record_id, event_type, occurred_at), so
// re-reading the same submission is a no-op. Each run re-scans the last
// LOOKBACK_DAYS, which also self-heals a missed daily run. Pass ?full=1 to
// backfill all history (paginates every form to the end).
//
// Secrets come from Vercel env vars (names in .env.example). Public repo: never hardcode.

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

// Forms live in the operational location (same as contacts). Reuses GHL_LOCATION_ID.
const LOCATION_ID = process.env.GHL_LOCATION_ID;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Rolling re-scan window (days). >1 run of slack so a skipped day self-heals.
const LOOKBACK_DAYS = Number(process.env.FORMS_LOOKBACK_DAYS || 14);
// Submissions written concurrently to overlap network waits.
const CONCURRENCY = Number(process.env.FORMS_CONCURRENCY || 4);
// Safety cap on pages per form in incremental mode (100 subs/page).
const MAX_PAGES_INCREMENTAL = Number(process.env.FORMS_MAX_PAGES || 10);
// Stop starting new work a few seconds before Vercel's function limit.
const MAX_RUN_MS = Number(process.env.FORMS_MAX_RUN_MS || 55000);

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_PRIVATE_TOKEN}`,
    Version: GHL_API_VERSION,
    'Content-Type': 'application/json',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry GHL 429 / transient 5xx with backoff, honoring Retry-After.
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

async function fetchForms(locationId) {
  const res = await fetchRetry(`${GHL_BASE}/forms/?locationId=${locationId}&limit=100`, { headers: ghlHeaders() });
  if (!res.ok) throw new Error(`forms list failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return (body.forms || []).filter((f) => f && f.id).map((f) => ({ id: f.id, name: f.name || null }));
}

async function fetchSubmissionsPage(locationId, formId, page, limit) {
  const url = `${GHL_BASE}/forms/submissions?locationId=${locationId}&formId=${formId}&page=${page}&limit=${limit}`;
  const res = await fetchRetry(url, { headers: ghlHeaders() });
  if (!res.ok) throw new Error(`submissions ${formId} p${page} failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const submissions = body.submissions || [];
  return { submissions, hasMore: submissions.length >= limit };
}

// Intentional test fixtures: skip names that begin "test " or are exactly test/testing.
function isTestSubmission(s) {
  const name = String(s.name || s.others?.full_name || '').trim().toLowerCase();
  return name === 'test' || name === 'testing' || name.startsWith('test ');
}

// Map a GHL submission to record_lead_event() params. UTMs come from the
// submission's own eventData.url_params (natively captured by GHL).
function toEventParams(s, formName) {
  const others = s.others || {};
  const ev = others.eventData || {};
  const up = ev.url_params || {};
  const submissionId = others.submissionId || s.id;
  return {
    p_event_type: 'form_submitted',
    p_source_system: 'ghl',
    p_source_record_id: String(submissionId),
    p_occurred_at: s.createdAt || (ev.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString()),
    p_phone: others.phone || null,
    p_ghl_contact_id: s.contactId || null,
    p_email: s.email || others.email || null,
    p_channel: 'form',
    p_entry_point: 'form',
    p_utm_source: up.utm_source || null,
    p_utm_medium: up.utm_medium || null,
    p_utm_campaign: up.utm_campaign || null,
    p_utm_content: up.utm_content || null,
    p_utm_term: up.utm_term || null,
    p_landing_url: ev.page?.url || null,
    p_tool_name: null,
    p_metadata: {
      form_id: s.formId || null,
      form_name: formName || ev.parentName || null,
      submission_id: submissionId,
      ghl_source: ev.source || null,
      ad_source: ev.adSource || null,
    },
  };
}

async function recordEvent(params) {
  const res = await fetchRetry(`${SUPABASE_URL}/rest/v1/rpc/record_lead_event`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`record_lead_event failed: ${res.status} ${await res.text()}`);
}

// at most `concurrency` workers in flight
async function runPool(items, worker, concurrency) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { await worker(items[i++]); }
  });
  await Promise.all(runners);
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!LOCATION_ID || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'server not configured' });
  }

  const full = req.query?.full === '1';
  const windowStart = full ? 0 : Date.now() - LOOKBACK_DAYS * 86400 * 1000;
  const deadline = Date.now() + MAX_RUN_MS;
  const result = { full, forms: 0, found: 0, written: 0, skippedTest: 0, failed: 0, deferred: 0, errors: [] };

  try {
    const forms = await fetchForms(LOCATION_ID);
    result.forms = forms.length;

    for (const form of forms) {
      if (Date.now() > deadline) { result.deferred += 1; continue; }
      const maxPages = full ? 100000 : MAX_PAGES_INCREMENTAL;
      const inWindow = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const { submissions, hasMore } = await fetchSubmissionsPage(LOCATION_ID, form.id, page, 100);
        let allOlder = submissions.length > 0;
        for (const s of submissions) {
          const ts = Date.parse(s.createdAt || '') || 0;
          if (ts >= windowStart) { inWindow.push(s); allOlder = false; }
        }
        // Submissions come newest-first; once a whole page is older than the
        // window there is nothing newer deeper in, so stop paging this form.
        if (!hasMore || (!full && allOlder)) break;
      }

      result.found += inWindow.length;
      await runPool(inWindow, async (s) => {
        if (Date.now() > deadline) { result.deferred += 1; return; }
        if (isTestSubmission(s)) { result.skippedTest += 1; return; }
        try {
          await recordEvent(toEventParams(s, form.name));
          result.written += 1;
        } catch (err) {
          result.failed += 1;
          if (result.errors.length < 20) result.errors.push({ submission: s.id, error: String(err) });
        }
      }, CONCURRENCY);
    }

    // Internal feeds whose data already lives in Supabase (surveys, event rosters,
    // event attendance, calculators, Lani calls). GHL has no API for most of these,
    // so one idempotent, cost-free server-side call fans them all into lead_events.
    try {
      const sr = await fetchRetry(`${SUPABASE_URL}/rest/v1/rpc/sync_internal_feeds`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      result.internalFeeds = sr.ok ? await sr.json() : null;
      if (!sr.ok) result.internalFeedsError = sr.status;
    } catch (err) {
      result.internalFeedsError = String(err);
    }

    console.log(`[sync-form-submissions] ${JSON.stringify({ full, forms: result.forms, found: result.found, written: result.written, skippedTest: result.skippedTest, failed: result.failed, deferred: result.deferred, internalFeeds: result.internalFeeds })}`);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error(`[sync-form-submissions] error ${String(err)}`);
    return res.status(500).json({ ok: false, error: String(err), ...result });
  }
}
