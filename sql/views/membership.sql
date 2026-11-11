-- Membership views: a flexible, queryable layer over contacts for the dashboard and
-- ad-hoc "fetch me the members" questions. Additive and definition-agnostic — they just
-- report what GHL holds; they do NOT decide what counts as a "member" for conversion
-- (that bucketing is Chris's call). Test fixtures (name contains "testing") are excluded.
--
-- Status source: ghl_membership_status is the live GHL "Status" field (maintained by the
-- ghl-webhook sync); membership_status is a second, partly-legacy column that disagrees on
-- ~321 rows. The views prefer ghl_membership_status and expose the legacy one alongside so
-- the discrepancy stays visible until it's reconciled.

-- One row per member (anyone with a membership type or status in GHL).
create or replace view public.v_members as
select
  c.id,
  c.ghl_contact_id,
  c.full_name,
  c.email,
  c.phone,
  c.membership_type,
  coalesce(c.ghl_membership_status, c.membership_status) as membership_status,
  c.ghl_membership_status,
  c.membership_status                                    as membership_status_legacy,
  c.membership_date,
  c.membership_expiration_date,
  c.membership_inactive_date,
  c.membership_cancelation_date,
  c.membership_fee
from public.contacts c
where (c.membership_type is not null
       or c.ghl_membership_status is not null
       or c.membership_status is not null)
  and lower(coalesce(c.full_name, '')) not like '%testing%';

-- Counts by status: members, how many carry expiration / inactive dates, and how many
-- expire in the next 30 days. Drives the membership tiles.
create or replace view public.v_membership_summary as
select
  coalesce(membership_status, '(unknown)') as membership_status,
  count(*)                                                                                   as members,
  count(*) filter (where membership_expiration_date is not null)                             as with_expiration_date,
  count(*) filter (where membership_inactive_date  is not null)                              as with_inactive_date,
  count(*) filter (where membership_expiration_date >= current_date
                     and membership_expiration_date <  current_date + 30)                    as expiring_next_30d
from public.v_members
group by 1
order by 2 desc;

-- Roster for the dashboard's "Active members" / "Inactive members" panels: names + the
-- membership dates only (NO phone/email in the columns the dashboard reads). Active panel
-- uses status Active/Renewal Pending with active_since + expires_on; inactive panel uses
-- Inactive/Cancel Membership with inactive_since. security_invoker=false so anon/service
-- REST reads resolve the underlying contacts join.
create or replace view public.v_member_roster
with (security_invoker=false) as
select
  full_name,
  coalesce(ghl_membership_status, membership_status) as status,
  membership_type,
  membership_date              as active_since,
  membership_expiration_date   as expires_on,
  membership_inactive_date     as inactive_since,
  ghl_contact_id  -- stable paging key (ordered by, never selected into the payload)
from public.v_members
where full_name is not null;

-- Counts by membership type (Individual/Platinum/Couples/Vendor/Board/Sponsor/etc).
create or replace view public.v_membership_by_type as
select
  coalesce(membership_type, '(unspecified)') as membership_type,
  count(*)                                                        as members,
  count(*) filter (where membership_status = 'Active')           as active,
  count(*) filter (where membership_status = 'Inactive')         as inactive
from public.v_members
group by 1
order by 2 desc;
