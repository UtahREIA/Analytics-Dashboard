-- Lead -> member conversion. Answers "how many leads actually became members"
-- and "which channels produce members, not just leads".
--
-- Member definition (Chris): lead = any contact; member = has a membership
-- status. Two numerators are exposed because "became a member" is ambiguous:
--   ever_member  = ghl_membership_status is set (ever joined: Active, Inactive,
--                  Renewal Pending, Cancel Membership)
--   active_member = ghl_membership_status = 'Active' (paid + active today)
-- Chris picks which is the headline conversion number.
--
-- Source comes from ghl_contact_attribution (GHL session_source); contacts with
-- no attribution row fall into "(unknown)". Test fixtures excluded.
-- NOTE: membership_type is sparse (set on far fewer rows than have a status), so
-- ghl_membership_status is the reliable member signal, not membership_type.

create or replace view public.v_contact_conversion as
select
  c.ghl_contact_id,
  c.full_name,
  c.ghl_membership_status,
  c.membership_type,
  c.membership_date,
  (c.ghl_membership_status is not null)       as ever_member,
  (c.ghl_membership_status = 'Active')        as active_member,
  coalesce(nullif(a.session_source, ''), '(unknown)') as source,
  coalesce(nullif(a.utm_source, ''), '(none)')        as utm_source,
  coalesce(nullif(a.utm_campaign, ''), '(none)')      as utm_campaign
from public.contacts c
left join public.ghl_contact_attribution a
  on a.ghl_contact_id = c.ghl_contact_id
where lower(coalesce(c.full_name, '')) not like '%test%';

-- Top-line funnel: leads, ever-members, active members, and both conversion rates.
create or replace view public.v_conversion_summary as
select
  count(*)                                                                   as leads,
  count(*) filter (where ever_member)                                        as ever_members,
  count(*) filter (where active_member)                                      as active_members,
  round(100.0 * count(*) filter (where ever_member)  / nullif(count(*), 0), 1) as ever_conversion_pct,
  round(100.0 * count(*) filter (where active_member) / nullif(count(*), 0), 1) as active_conversion_pct
from public.v_contact_conversion;

-- Conversion by lead source: which channels turn leads into members.
create or replace view public.v_conversion_by_source as
select
  source,
  count(*)                              as leads,
  count(*) filter (where ever_member)   as members,
  count(*) filter (where active_member) as active_members,
  round(100.0 * count(*) filter (where ever_member) / nullif(count(*), 0), 1) as conversion_pct
from public.v_contact_conversion
group by source
order by members desc, leads desc;
