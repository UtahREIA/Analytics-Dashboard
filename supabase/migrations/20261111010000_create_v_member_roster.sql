-- Roster view for the dashboard's "Active members" / "Inactive members" panels.
-- Names + membership dates only (NO phone/email in the exposed columns). Built on v_members
-- (which already excludes test fixtures). security_invoker=false so anon/service REST reads
-- resolve the underlying contacts join, matching the other dashboard list views.
create or replace view public.v_member_roster
with (security_invoker=false) as
select
  full_name,
  coalesce(ghl_membership_status, membership_status) as status,
  membership_type,
  membership_date              as active_since,
  membership_expiration_date   as expires_on,
  membership_inactive_date     as inactive_since,
  ghl_contact_id  -- stable paging key: ordered by to page past the PostgREST 1000-row cap,
                  -- never selected into the dashboard payload (names only on the wire)
from public.v_members
where full_name is not null;
