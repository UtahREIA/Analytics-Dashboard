-- First dashboard views (CLAUDE.md "First dashboard views" 1-6).
-- Built against live schema 2026-11-04. All views are security_invoker so they
-- respect the querying role's RLS, and all exclude TESTING fixtures (house rule).
--
-- Data readiness:
--   Populated NOW (read existing tables):   funnel, days-to-member*, Lani, calculators.
--   Ready-but-empty until feeds write lead_events: leads/week by channel, top campaigns.
--   (*days-to-member reads leads.first_touch_at, so it fills as attribution flows.)
--
-- Open definitions (Chris): "engaged" and "trial" are undefined and not present in
-- the data (membership statuses are Active / Inactive / Renewal Pending /
-- Cancel Membership / null). Those tiers are surfaced as NULL placeholders.

-- 1) Leads per week by acquisition channel (first-touch event's channel).
create or replace view public.v_leads_per_week_by_channel with (security_invoker = true) as
with first_ev as (
  select distinct on (lead_id)
    lead_id, occurred_at, coalesce(channel, 'unknown') as channel
  from public.lead_events
  order by lead_id, occurred_at asc
)
select date_trunc('week', occurred_at)::date as week,
       channel,
       count(*) as new_leads
from first_ev
group by 1, 2
order by 1 desc, 3 desc;

-- 2) Funnel (lead -> engaged -> member). David's defs (Nov 10 2026):
--    lead = any contact; member = ghl_membership_status 'Active';
--    engaged = did something active (attended an event, used a calculator/tool,
--    talked to Lani, booked an appointment, replied to a message, or sits in a GHL
--    pipeline). Tool use = a real calculator access date, not just a tool_access row.
--    Legacy *_todo_chris columns kept as NULL (non-destructive; engaged/lead_to_engaged_pct
--    appended at the end). engaged runs ~73% because calculators are the main entry point.
create or replace view public.v_funnel with (security_invoker = true) as
with tool_users as (
  select contact_id from public.tool_access
  where fix_flip_calculator_access is not null or brrrr_calculator_access is not null
     or wholesale_calculator_access is not null or rentals_calculator_access is not null
     or short_term_calculator_access is not null or rehab_estimator_access is not null
     or nullif(btrim(coalesce(rehab_subscription_status,'')),'') is not null
),
engaged_ids as (
  select c.ghl_contact_id as contact_id from public.event_attendance e join public.contacts c on c.id = e.contact_id where c.ghl_contact_id is not null
  union select c.ghl_contact_id from tool_users t join public.contacts c on c.id = t.contact_id where c.ghl_contact_id is not null
  union select contact_id from public.ghl_appointments  where contact_id is not null
  union select contact_id from public.ghl_opportunities where contact_id is not null
  union select contact_id from public.ghl_message_logs  where direction = 'inbound' and contact_id is not null
  union select resolved_ghl_contact_id from public.v_voice_agent_calls where not is_test and resolved_ghl_contact_id is not null
)
select
  count(*)                                                                as leads,
  null::bigint                                                            as engaged_todo_chris,
  null::bigint                                                            as trial_todo_chris,
  count(*) filter (where c.ghl_membership_status = 'Active')              as members,
  count(*) filter (where c.ghl_membership_status = 'Renewal Pending')     as renewal_pending,
  count(*) filter (where c.ghl_membership_status in ('Inactive','Cancel Membership')) as former_members,
  round(100.0 * count(*) filter (where c.ghl_membership_status = 'Active')
        / nullif(count(*), 0), 1)                                         as lead_to_member_pct,
  count(*) filter (where c.ghl_contact_id in (select contact_id from engaged_ids)) as engaged,
  round(100.0 * count(*) filter (where c.ghl_contact_id in (select contact_id from engaged_ids))
        / nullif(count(*), 0), 1)                                         as lead_to_engaged_pct
from public.contacts c
where lower(coalesce(c.full_name, '')) <> 'testing';

-- 3) Days from first touch to member (fills as leads.first_touch_at is set).
create or replace view public.v_days_to_member with (security_invoker = true) as
with d as (
  select (c.membership_date - l.first_touch_at::date) as days
  from public.leads l
  join public.contacts c on c.id = l.contact_id
  where c.ghl_membership_status = 'Active'
    and l.first_touch_at is not null
    and c.membership_date is not null
    and c.membership_date >= l.first_touch_at::date
    and lower(coalesce(c.full_name, '')) <> 'testing'
)
select count(*)                                              as members_with_first_touch,
       round(avg(days), 1)                                   as avg_days,
       percentile_cont(0.5) within group (order by days)     as median_days
from d;

-- 4) Top campaigns by MEMBERS (not just leads) — first-touch campaign.
create or replace view public.v_top_campaigns_by_members with (security_invoker = true) as
select coalesce(l.first_campaign, '(none)')  as campaign,
       coalesce(l.first_source, '(unknown)') as source,
       count(*) filter (where c.ghl_membership_status = 'Active') as members,
       count(*)                                                   as leads
from public.leads l
left join public.contacts c on c.id = l.contact_id
group by 1, 2
order by members desc, leads desc;

-- 5) Lani calls, match rate (match = any vendor/tool/educator match returned).
-- Built on v_voice_agent_calls and excludes NAMED test fixtures via is_test
-- (Test User, Dub Testing, Voice Testing, ...). The old lower(caller_name)='testing'
-- exact filter matched nothing, so tests leaked into the count.
create or replace view public.v_lani_calls with (security_invoker = true) as
with c as (
  select (nullif(btrim(coalesce(vendor_matches, '')), '') is not null
          or nullif(btrim(coalesce(tool_matches, '')), '') is not null
          or nullif(btrim(coalesce(educator_match, '')), '') is not null) as matched
  from public.v_voice_agent_calls
  where not is_test
)
select count(*)                              as calls,
       count(*) filter (where matched)       as matched,
       count(*) filter (where not matched)   as no_match,
       round(100.0 * count(*) filter (where matched) / nullif(count(*), 0), 1) as match_rate_pct
from c;

-- 5b) No-match needs — what blocked the callers Lani couldn't match (resource gaps).
create or replace view public.v_lani_no_match_needs with (security_invoker = true) as
select coalesce(nullif(btrim(blocker), ''), '(unspecified)') as blocker,
       count(*) as calls
from public.v_voice_agent_calls
where not is_test
  and nullif(btrim(coalesce(vendor_matches, '')), '') is null
  and nullif(btrim(coalesce(tool_matches, '')), '') is null
  and nullif(btrim(coalesce(educator_match, '')), '') is null
group by 1
order by 2 desc;

-- 6) Calculator usage + member share among users (tool -> member proxy;
--    trial -> member needs a "trial" definition from Chris).
create or replace view public.v_calculator_usage with (security_invoker = true) as
with u as (
  select 'Fix & Flip'  as tool, ta.fix_flip_calculator_access   as used_on, c.ghl_membership_status as status from public.tool_access ta left join public.contacts c on c.id = ta.contact_id
  union all select 'BRRRR',      ta.brrrr_calculator_access,      c.ghl_membership_status from public.tool_access ta left join public.contacts c on c.id = ta.contact_id
  union all select 'Wholesale',  ta.wholesale_calculator_access,  c.ghl_membership_status from public.tool_access ta left join public.contacts c on c.id = ta.contact_id
  union all select 'Rentals',    ta.rentals_calculator_access,    c.ghl_membership_status from public.tool_access ta left join public.contacts c on c.id = ta.contact_id
  union all select 'Short Term', ta.short_term_calculator_access, c.ghl_membership_status from public.tool_access ta left join public.contacts c on c.id = ta.contact_id
  union all select 'Rehab Estimator', ta.rehab_estimator_access, c.ghl_membership_status from public.tool_access ta left join public.contacts c on c.id = ta.contact_id
)
select tool,
       count(used_on)                                                   as uses,
       count(*) filter (where used_on is not null and status = 'Active') as member_users,
       round(100.0 * count(*) filter (where used_on is not null and status = 'Active')
             / nullif(count(used_on), 0), 1)                            as member_share_pct
from u
group by tool
order by uses desc;

-- 7) Historical lead-VOLUME trend from contacts.created_at. Volume proxy only:
--    no channel attribution, and pre-sync contacts pile into the initial load
--    (~Apr 2026). Use v_leads_per_week_by_channel for attributed, forward-looking
--    detail; use this for long-run volume depth.
create or replace view public.v_leads_volume_per_week with (security_invoker = true) as
select date_trunc('week', created_at)::date as week,
       count(*) as new_contacts
from public.contacts
where lower(coalesce(full_name, '')) <> 'testing'
group by 1
order by 1 desc;

-- 8) Weekly scorecard (David's weekly numbers, Nov 10 2026): new leads, new members,
--    engaged, event attendances, Lani calls + match rate — one row per week, last 26.
--    New-leads-by-source lives in v_leads_per_week_by_channel. new_leads uses
--    contacts.created_at (accurate for recent weeks; older weeks lump on the backfill).
create or replace view public.v_weekly_scorecard with (security_invoker = true) as
with weeks as (
  select generate_series(date_trunc('week', now()) - interval '25 weeks',
                         date_trunc('week', now()), interval '1 week')::date as week
),
new_leads as (
  select date_trunc('week', created_at)::date w, count(*) n
  from public.contacts where lower(coalesce(full_name,'')) <> 'testing' group by 1
),
new_members as (
  select date_trunc('week', membership_date)::date w, count(*) n
  from public.contacts
  where ghl_membership_status = 'Active' and membership_date is not null
    and lower(coalesce(full_name,'')) <> 'testing' group by 1
),
lani as (
  select date_trunc('week', created_at)::date w, count(*) n,
         count(*) filter (where nullif(btrim(coalesce(vendor_matches,'')),'') is not null
            or nullif(btrim(coalesce(tool_matches,'')),'') is not null
            or nullif(btrim(coalesce(educator_match,'')),'') is not null) matched
  from public.v_voice_agent_calls where not is_test group by 1
),
events as (
  select date_trunc('week', event_date)::date w, count(*) n
  from public.event_attendance where event_date is not null group by 1
),
engaged as (
  select w, count(distinct gid) n from (
    select date_trunc('week', e.event_date)::date w, c.ghl_contact_id gid from public.event_attendance e join public.contacts c on c.id = e.contact_id where e.event_date is not null and c.ghl_contact_id is not null
    union all select date_trunc('week', t.created_at)::date, c.ghl_contact_id from public.tool_access t join public.contacts c on c.id = t.contact_id
       where (t.fix_flip_calculator_access is not null or t.brrrr_calculator_access is not null
          or t.wholesale_calculator_access is not null or t.rentals_calculator_access is not null
          or t.short_term_calculator_access is not null or t.rehab_estimator_access is not null
          or nullif(btrim(coalesce(t.rehab_subscription_status,'')),'') is not null)
         and c.ghl_contact_id is not null
    union all select date_trunc('week', start_at)::date, contact_id from public.ghl_appointments where contact_id is not null
    union all select date_trunc('week', created_at_ghl)::date, contact_id from public.ghl_opportunities where contact_id is not null
    union all select date_trunc('week', message_at)::date, contact_id from public.ghl_message_logs where direction = 'inbound' and contact_id is not null
    union all select date_trunc('week', created_at)::date, resolved_ghl_contact_id from public.v_voice_agent_calls where not is_test and resolved_ghl_contact_id is not null
  ) s group by w
)
select
  wk.week,
  coalesce(nl.n,0)       as new_leads,
  coalesce(nm.n,0)       as new_members,
  coalesce(en.n,0)       as engaged,
  coalesce(ev.n,0)       as event_attendances,
  coalesce(la.n,0)       as lani_calls,
  coalesce(la.matched,0) as lani_matched,
  round(100.0 * coalesce(la.matched,0) / nullif(la.n,0), 1) as lani_match_pct
from weeks wk
left join new_leads  nl on nl.w = wk.week
left join new_members nm on nm.w = wk.week
left join engaged    en on en.w = wk.week
left join events     ev on ev.w = wk.week
left join lani       la on la.w = wk.week
order by wk.week desc;
