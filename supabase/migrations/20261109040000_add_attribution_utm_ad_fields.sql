-- Widen ghl_contact_attribution to carry the full UTM set and paid-ad signals.
--
-- GHL's lastAttributionSource returns campaign / utmContent / utmTerm and the
-- paid-ad identifiers (adId, adName, gclid, gbraid, wbraid), but the sync only
-- stored utm_source/utm_medium. This adds the missing UTM columns plus the
-- paid-ad columns so campaign ads are tracked automatically once they start
-- running (session_source already arrives as "Paid Social" / "Paid Search").
-- Additive and nullable; sync-ghl-attribution is updated to populate them.

alter table public.ghl_contact_attribution
  add column if not exists utm_campaign text,  -- lastAttributionSource.campaign (GHL stores utm_campaign here)
  add column if not exists utm_content  text,  -- lastAttributionSource.utmContent
  add column if not exists utm_term     text,  -- lastAttributionSource.utmTerm
  add column if not exists ad_id        text,  -- lastAttributionSource.adId   (paid ads)
  add column if not exists ad_name      text,  -- lastAttributionSource.adName (paid ads)
  add column if not exists gclid        text;  -- lastAttributionSource.gclid  (Google paid click id)

create index if not exists ghl_contact_attribution_campaign_idx
  on public.ghl_contact_attribution (utm_campaign);

comment on column public.ghl_contact_attribution.utm_campaign is
  'GHL lastAttributionSource.campaign — the utm_campaign value. Added 2026-11-09.';
comment on column public.ghl_contact_attribution.ad_id is
  'GHL lastAttributionSource.adId — paid-ad identifier; null until campaign ads run. Added 2026-11-09.';
