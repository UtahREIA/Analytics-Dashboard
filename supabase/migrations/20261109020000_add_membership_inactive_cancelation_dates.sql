-- Membership lifecycle dates: add inactive + cancelation dates to contacts.
--
-- Context (David/Chris, Nov 9 2026): the membership picture needs the date a member
-- went INACTIVE, not just join/expiration. GHL already holds these as contact custom
-- fields, but the contacts sync (ghl-webhook) never mapped them, so they were nowhere
-- in Supabase. "Pending renewal date" and "council membership date" were asked about
-- too but DO NOT EXIST as GHL fields, so they are intentionally not added.
--
-- GHL source fields (location DNirEjy0ejVwbHsaBYrn):
--   Inactive Date   -> id Gq8W59yzjdN11VdVwKfm, key inactive_date   (DATE)
--   Cancelation Date-> id WuOCzjFan5ldNCH0IxVd, key cancelation_date (DATE)
--
-- Both are SPARSE in GHL (verified: 0 of 4 sampled active members had an expiration
-- date; inactive/cancel dates appear only on lapsed/canceled members). The columns are
-- additive and nullable; the webhook writes them via stripNulls, so an empty value never
-- blanks an existing one. Expiration date already has a column (membership_expiration_date).

alter table public.contacts
  add column if not exists membership_inactive_date    date,
  add column if not exists membership_cancelation_date date;

comment on column public.contacts.membership_inactive_date is
  'GHL "Inactive Date" (id Gq8W59yzjdN11VdVwKfm, key inactive_date). Date the membership went inactive. Sparse in GHL. Added 2026-11-09.';
comment on column public.contacts.membership_cancelation_date is
  'GHL "Cancelation Date" (id WuOCzjFan5ldNCH0IxVd, key cancelation_date). Date the membership was canceled. Sparse in GHL. Added 2026-11-09.';
