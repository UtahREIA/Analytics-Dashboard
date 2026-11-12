-- Community membership flags mirrored from GHL contact checkbox custom fields (Nov 12 2026).
-- Additive, nullable booleans; true = contact is in that community, null = not set (ghl-webhook
-- stripNulls keeps them from blanking). Populated by ghl-webhook v23 (checkedOrNull). Backfill
-- existing contacts with a full resync (api/sync-contacts?full=1).
alter table public.contacts add column if not exists reia_community boolean;
alter table public.contacts add column if not exists reia_latino_community boolean;
alter table public.contacts add column if not exists reia_military_community boolean;
alter table public.contacts add column if not exists veteran_investors_alliance boolean;  -- "VIA Community"
alter table public.contacts add column if not exists make_it_happen_community boolean;

comment on column public.contacts.reia_community is 'GHL custom field reia_community (checkbox). true = member of the general REIA community.';
comment on column public.contacts.veteran_investors_alliance is 'GHL custom field veteran_investors_alliance = "VIA Community" (checkbox).';
