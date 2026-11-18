-- First-touch attribution on ghl_contact_attribution.
--
-- WHY: the existing columns (session_source, medium, utm_*, referrer) map GHL's
-- lastAttributionSource -- LAST touch. Chris's ask is FIRST touch ("how they first
-- found us"), which GHL keeps in a SEPARATE object, attributionSource. POST
-- /contacts/search returns both, so this is a pure capture gap, not a data gap.
--
-- This adds a symmetric first_* set for attributionSource, plus created_source
-- (GHL's own contact.source, e.g. "Vendor Assessment Survey" / "lc-phone-api" /
-- "CLIENTPORTAL") which is populated even when attribution is empty and so gives
-- an origin label for the phone/portal/import contacts GHL has no web source for.
--
-- Additive and nullable; sync-ghl-attribution is updated to populate these. The
-- existing columns are retained as the LAST-touch set (see column comments).

alter table public.ghl_contact_attribution
  add column if not exists first_session_source text,  -- attributionSource.sessionSource
  add column if not exists first_medium          text,  -- attributionSource.medium
  add column if not exists first_utm_source       text,  -- attributionSource.utmSource
  add column if not exists first_utm_medium        text,  -- attributionSource.utmMedium
  add column if not exists first_utm_campaign      text,  -- attributionSource.campaign
  add column if not exists first_utm_content       text,  -- attributionSource.utmContent
  add column if not exists first_utm_term          text,  -- attributionSource.utmTerm
  add column if not exists first_referrer          text,  -- attributionSource.referrer host
  add column if not exists first_url               text,  -- attributionSource.url (landing)
  add column if not exists first_ad_id             text,  -- attributionSource.adId
  add column if not exists first_ad_name           text,  -- attributionSource.adName
  add column if not exists first_gclid             text,  -- attributionSource.gclid
  add column if not exists created_source          text;  -- contact.source (GHL's own entry label)

create index if not exists ghl_contact_attribution_first_source_idx
  on public.ghl_contact_attribution (first_session_source);
create index if not exists ghl_contact_attribution_created_source_idx
  on public.ghl_contact_attribution (created_source);

comment on column public.ghl_contact_attribution.session_source is
  'LAST-touch sessionSource (lastAttributionSource). First touch is first_session_source.';
comment on column public.ghl_contact_attribution.first_session_source is
  'FIRST-touch sessionSource (attributionSource) — how they first found us. Added 2026-11-18.';
comment on column public.ghl_contact_attribution.first_referrer is
  'FIRST-touch referring host — names the real platform GHL buckets as "Social media" (e.g. linkedin.com). Added 2026-11-18.';
comment on column public.ghl_contact_attribution.created_source is
  'GHL contact.source (entry label) — populated even when attribution is empty, so phone/portal/import contacts still get an origin. Added 2026-11-18.';
