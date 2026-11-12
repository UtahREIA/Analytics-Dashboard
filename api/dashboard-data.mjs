// api/dashboard-data.mjs
// NOTE: .mjs (not .js) so Vercel always loads this as an ES module. Without an explicit
// package.json "type":"module", Vercel's runtime can misclassify a .js file that uses
// `export default` as CommonJS and crash with "Unexpected token 'export'". The .mjs
// extension removes that ambiguity. Route is unchanged: still served at /api/dashboard-data.
// Server-side data endpoint for the LIVE dashboard (public/dashboard.html).
// Reads Supabase views with the SERVICE-ROLE key (server-only; never shipped to the
// browser) and returns the numbers as one JSON payload. This is what makes the dashboard
// auto-update: the page fetches this on load / on a timer and always gets live data — no
// snapshots, no manual refresh.
//
// Privacy: this returns some member/attendee names (membership, event roster). Keep the
// deployment behind Vercel Deployment Protection (Project -> Settings -> Deployment
// Protection) so only authorized people can load it. The service-role key stays in the
// Vercel env (SUPABASE_SERVICE_ROLE_KEY) and is never exposed.

import crypto from 'node:crypto';

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET;

// Auth gate: this endpoint returns member names, so it must not be public. Access requires a
// valid session cookie set by api/login.mjs (HMAC-signed with DASHBOARD_SESSION_SECRET).
function parseCookies(req) {
  const out = {};
  const h = req.headers && req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function validSession(req) {
  if (!SESSION_SECRET) return false;
  const token = parseCookies(req).dash_session;
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const bodyB64 = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(bodyB64).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let payload;
  try { payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString()); } catch { return false; }
  return payload && typeof payload.exp === 'number' && Date.now() <= payload.exp;
}

async function view(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

// Social analytics live in a SEPARATE Supabase project (Metricool-fed). The project URL is
// public; the key comes from a Vercel env var. Non-fatal: if the key isn't set (or the name
// doesn't match), social/reels just come back empty instead of breaking the whole dashboard.
const SOCIAL_URL = process.env.SOCIAL_SUPABASE_URL || 'https://oeraqcuithvmeyljuzbd.supabase.co';
const SOCIAL_KEY = process.env.SOCIAL_SUPABASE_SERVICE_ROLE_KEY || process.env.SOCIAL_SUPABASE_KEY
  || process.env.SUPABASE_SOCIAL_SERVICE_ROLE_KEY || process.env.SOCIAL_SERVICE_ROLE_KEY
  || process.env.SOCIAL_SUPABASE_ANON_KEY || process.env.SOCIAL_SUPABASE_PUBLISHABLE_KEY || '';
async function socialView(path) {
  if (!SOCIAL_KEY) return [];
  try {
    const r = await fetch(`${SOCIAL_URL}/rest/v1/${path}`, { headers: { apikey: SOCIAL_KEY, Authorization: `Bearer ${SOCIAL_KEY}` } });
    if (!r.ok) return [];
    return r.json();
  } catch { return []; }
}

// Social data-freshness row for the health panel. Social is a separate project, so v_data_health
// can't include it; we compute it here (oldest per-network newest-date; stale if > 3 days) and
// append it to the health list. Shape matches v_data_health rows; no "sync ran" heartbeat exists
// (the pull runs from a separate repo), so status is 'n/a' and only data_status is evaluated.
const SOCIAL_WINDOW_MIN = 3 * 24 * 60;
async function socialHealthRow() {
  const base = {
    feed: 'Social (Metricool)', last_run: null, age_min: null, max_age_min: null, status: 'n/a',
    last_data_at: null, data_age_min: null, data_max_age_min: SOCIAL_WINDOW_MIN, data_status: 'unknown', note: null,
  };
  if (!SOCIAL_KEY) return base;
  try {
    const r = await fetch(`${SOCIAL_URL}/rest/v1/evolution_daily?select=network,date&order=date.desc.nullslast&limit=2000`,
      { headers: { apikey: SOCIAL_KEY, Authorization: `Bearer ${SOCIAL_KEY}` } });
    if (!r.ok) return base;
    const rows = await r.json();
    const maxByNet = {};
    for (const x of rows) { if (x && x.date && (!maxByNet[x.network] || x.date > maxByNet[x.network])) maxByNet[x.network] = x.date; }
    const nets = Object.keys(maxByNet);
    if (!nets.length) return base;
    let lag = nets[0];
    for (const n of nets) if (maxByNet[n] < maxByNet[lag]) lag = n;
    const lagDate = maxByNet[lag];
    const ageMin = Math.round((Date.now() - new Date(lagDate + 'T00:00:00Z').getTime()) / 60000);
    return {
      ...base, last_data_at: lagDate, data_age_min: ageMin,
      data_status: ageMin > SOCIAL_WINDOW_MIN ? 'STALE' : 'fresh',
      note: `oldest network: ${lag} (${lagDate})`,
    };
  } catch { return base; }
}

export default async function handler(req, res) {
  if (!SB || !KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });
  }
  // Require a valid login session before returning any data (names are included).
  if (!validSession(req)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const [
      funnel, days, lani, laniNeeds, convSrc, convContacts, weekly, leadsWk,
      calc, campaigns, memType, emailTotals, utm, paidAds, roster,
      sms, appts, opps, ga4, emailCampaigns, ga4Pages,
      vendors, educators, courses, tools, coEvents, health, workflows, memberRoster,
    ] = await Promise.all([
      view('v_funnel'),
      view('v_days_to_member'),
      view('v_lani_calls'),
      view('v_lani_no_match_needs'),
      view('v_conversion_by_source?order=members.desc'),
      view('v_conversion_contacts?select=lead_date,source,ever_member,active_member&order=ghl_contact_id.asc'),
      view('v_weekly_scorecard?order=week.desc'),
      view('v_leads_per_week_by_channel?order=week.desc&limit=600'),
      view('v_calculator_usage'),
      view('v_top_campaigns_by_members?limit=15'),
      view('v_membership_by_type'),
      view('v_email_totals'),
      view('v_utm_summary?limit=100'),
      view('v_paid_ads_summary'),
      view('v_event_roster?select=event_name,event_date,full_name,attended&order=event_date.desc.nullslast&limit=2000'),
      view('v_sms_daily?order=date.desc'),
      view('v_appointments_list?order=date.desc.nullslast&limit=500'),
      view('v_opportunities_list?order=date.desc.nullslast&limit=1000'),
      view('ga4_daily?select=date,channel,sessions,engaged_sessions,new_users&order=date.desc&limit=3000'),
      view('v_email_campaign_stats?order=date_scheduled.desc.nullslast&limit=100'),
      view('ga4_page_daily?select=date,page_path,views,sessions&order=date.desc,page_path.asc&limit=1000'),
      view('ghl_vendor_resources?select=company_name,deals_opportunities,contractor_speciality,is_active,approval_status&order=company_name'),
      view('ghl_educators_mentors?select=educators_name,educational_topics,educational_level,is_active&order=educators_name'),
      view('ghl_educational_courses?select=course_name,educational_topics,membership_required,paid_education,is_active&order=course_name'),
      view('ghl_tools_resources?select=resource_title,educational_topics,resource_url,membership_required,paid_resource,is_active&order=resource_title'),
      view('ghl_upcoming_events?select=event_title,event_date,event_time,event_location,speaker_name,event_type,is_active&order=event_date.desc.nullslast'),
      view('v_data_health'),
      view('ghl_workflows?select=name,status,updated_at_ghl&order=name.asc'),
      view('v_member_roster?select=full_name,status,membership_type,active_since,expires_on,inactive_since&order=ghl_contact_id.asc&limit=1000'),
    ]);

    // ga4_page_daily grows daily; page past the 1000-row cap (stable order on date+page_path).
    let ga4PagesAll = ga4Pages;
    for (let off = 1000; ga4PagesAll.length === off && off < 20000; off += 1000) {
      const more = await view(`ga4_page_daily?select=date,page_path,views,sessions&order=date.desc,page_path.asc&limit=1000&offset=${off}`);
      ga4PagesAll = ga4PagesAll.concat(more);
      if (more.length < 1000) break;
    }

    // conversion_contacts can exceed the PostgREST 1000-row cap; page the rest.
    let cc = convContacts;
    for (let off = 1000; cc.length === off; off += 1000) {
      const more = await view(`v_conversion_contacts?select=lead_date,source,ever_member,active_member&order=ghl_contact_id.asc&limit=1000&offset=${off}`);
      cc = cc.concat(more);
      if (more.length < 1000) break;
    }

    // member_roster (~1.4k rows) also exceeds the 1000-row cap; page the rest (stable order on ghl_contact_id).
    let memberRows = memberRoster;
    for (let off = 1000; memberRows.length === off; off += 1000) {
      const more = await view(`v_member_roster?select=full_name,status,membership_type,active_since,expires_on,inactive_since&order=ghl_contact_id.asc&limit=1000&offset=${off}`);
      memberRows = memberRows.concat(more);
      if (more.length < 1000) break;
    }

    const [social, reels, socialHealth] = await Promise.all([
      socialView('v_social_channels'),
      socialView('v_reels_summary'),
      socialHealthRow(),
    ]);
    const healthRows = Array.isArray(health) ? health.concat([socialHealth]) : health;

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    res.status(200).json({
      generated_at: new Date().toISOString(),
      social: social,
      reels: reels,
      funnel: funnel[0] || {},
      days: days[0] || {},
      lani: lani[0] || {},
      lani_needs: laniNeeds,
      conversions_by_source: convSrc,
      conversion_contacts: cc.map((r) => ({ date: r.lead_date, source: r.source, ever: r.ever_member ? 1 : 0, active: r.active_member ? 1 : 0 })),
      weekly: weekly,
      leads_by_week: leadsWk,
      calculators: calc,
      campaigns: campaigns,
      membership_by_type: memType,
      email_totals: emailTotals[0] || {},
      utm: utm,
      paid_ads: paidAds,
      event_roster: roster,
      sms: sms,
      appointments: appts,
      opportunities: opps,
      ga4: ga4,
      email_campaigns: emailCampaigns,
      ga4_pages: ga4PagesAll,
      vendors: vendors,
      educators: educators,
      courses: courses,
      tools: tools,
      upcoming_events: coEvents,
      health: healthRows,
      workflows: workflows,
      member_roster: memberRows,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
