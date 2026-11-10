// api/dashboard-data.js
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

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

export default async function handler(req, res) {
  if (!SB || !KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });
  }
  try {
    const [
      funnel, days, lani, laniNeeds, convSrc, convContacts, weekly, leadsWk,
      calc, campaigns, memType, emailTotals, utm, paidAds, roster,
      sms, appts, opps, ga4, emailCampaigns, ga4Pages,
      vendors, educators, courses, tools, coEvents, health,
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

    const [social, reels] = await Promise.all([
      socialView('v_social_channels'),
      socialView('v_reels_summary'),
    ]);

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
      health: health,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
