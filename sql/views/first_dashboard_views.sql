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

-- 2) Funnel (lead -> member). lead = any contact (Chris); member = Active.
--    engaged / trial undefined -> NULL placeholders pending Chris.
create or replace view public.v_funnel with (security_invoker = true) as
select
  count(*)                                                                as leads,
  null::bigint                                                            as engaged_todo_chris,
  null::bigint                                                            as trial_todo_chris,
  count(*) filter (where ghl_membership_status = 'Active')                as members,
  count(*) filter (where ghl_membership_status = 'Renewal Pending')       as renewal_pending,
  count(*) filter (where ghl_membership_status in ('Inactive','Cancel Membership')) as former_members,
  round(100.0 * count(*) filter (where ghl_membership_status = 'Active')
        / nullif(count(*), 0), 1)                                         as lead_to_member_pct
from public.contacts
where lower(coalesce(full_name, '')) <> 'testing';

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
