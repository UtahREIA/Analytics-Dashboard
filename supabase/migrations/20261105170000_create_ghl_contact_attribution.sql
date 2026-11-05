-- Per-contact attribution (lead source) pulled from GHL by sync-ghl-attribution.
-- GHL's mirrored contacts table has no source columns; this holds each contact's
-- lastAttributionSource so the dashboard can show where leads came from
-- (e.g. "Social media"). Full re-pull each run, idempotent on ghl_contact_id.
--
-- RLS enabled with no policy (service role bypasses; dashboard reads go through a
-- view / snapshot), matching the schema convention.
create table if not exists public.ghl_contact_attribution (
  ghl_contact_id text primary key,
  contact_name   text,
  date_added     timestamptz,
  session_source text,   -- lastAttributionSource.sessionSource (Social media, Direct traffic, Email Marketing, CRM UI, ...)
  medium         text,
  utm_source     text,
  utm_medium     text,
  referrer       text,   -- referring hostname, where known
  last_synced_at timestamptz default now()
);
create index if not exists ghl_contact_attribution_source_idx on public.ghl_contact_attribution (session_source);
create index if not exists ghl_contact_attribution_date_idx on public.ghl_contact_attribution (date_added);
alter table public.ghl_contact_attribution enable row level security;
