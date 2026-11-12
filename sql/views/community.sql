-- Community membership views over the contacts mirror (test fixtures excluded).
-- Source: GHL contact checkbox custom fields, synced by ghl-webhook v23 into contacts.
-- Counts stay low until a full resync (api/sync-contacts?full=1) backfills existing contacts;
-- new/updated contacts populate live.

create or replace view public.v_community_summary
with (security_invoker=false) as
with c as (select * from public.contacts where lower(coalesce(full_name,'')) not like '%testing%')
select 'REIA Community'::text as community, count(*) filter (where reia_community) as members from c
union all select 'REIA Latino Community', count(*) filter (where reia_latino_community) from c
union all select 'REIA Military Community', count(*) filter (where reia_military_community) from c
union all select 'VIA (Veteran Investors Alliance)', count(*) filter (where veteran_investors_alliance) from c
union all select 'Make it Happen Community', count(*) filter (where make_it_happen_community) from c
order by members desc;

create or replace view public.v_community_members
with (security_invoker=false) as
with c as (select * from public.contacts where lower(coalesce(full_name,'')) not like '%testing%')
select full_name, coalesce(ghl_membership_status,'(none)') as member_status, 'REIA Community'::text as community, ghl_contact_id from c where reia_community
union all select full_name, coalesce(ghl_membership_status,'(none)'), 'REIA Latino Community', ghl_contact_id from c where reia_latino_community
union all select full_name, coalesce(ghl_membership_status,'(none)'), 'REIA Military Community', ghl_contact_id from c where reia_military_community
union all select full_name, coalesce(ghl_membership_status,'(none)'), 'VIA (Veteran Investors Alliance)', ghl_contact_id from c where veteran_investors_alliance
union all select full_name, coalesce(ghl_membership_status,'(none)'), 'Make it Happen Community', ghl_contact_id from c where make_it_happen_community;
