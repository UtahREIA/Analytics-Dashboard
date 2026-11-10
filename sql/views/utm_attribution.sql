-- UTM + paid-ad reporting over ghl_contact_attribution.
--
-- Answers "track the UTMs" and "a column for campaign ads": v_utm_attribution is
-- one row per contact with a derived is_paid_ad flag; v_utm_summary breaks leads
-- down by source / medium / campaign; v_paid_ads_summary is the campaign-ad
-- rollup (empty until ads run, then fills automatically from session_source +
-- ad_id + gclid).
--
-- Test fixtures (contact_name containing "test") are excluded per house rule.
-- NOTE on coverage: UTM capture is sparse upstream — most contacts arrive with no
-- UTMs because entry points don't append them. The fix is UTM capture at each
-- entry point (GHL funnel footer snippet), tracked separately; these views report
-- whatever attribution GHL actually captured.

create or replace view public.v_utm_attribution as
select
  ghl_contact_id,
  contact_name,
  date_added,
  session_source,
  medium,
  utm_source,
  utm_medium,
  utm_campaign,
  utm_content,
  utm_term,
  ad_id,
  ad_name,
  gclid,
  referrer,
  (
    session_source ilike 'Paid%'
    or (gclid is not null and gclid <> '')
    or (ad_id is not null and ad_id <> '')
    or lower(coalesce(utm_medium, '')) in ('cpc','ppc','paid','paidsocial','paid_social','paid-social')
  ) as is_paid_ad
from public.ghl_contact_attribution
where lower(coalesce(contact_name, '')) not like '%test%';

-- Lead counts by the UTM tuple actually captured. Rows with no UTMs collapse into
-- the "(none)" buckets so the gap is visible rather than hidden.
create or replace view public.v_utm_summary as
select
  coalesce(nullif(utm_source, ''), '(none)')   as utm_source,
  coalesce(nullif(utm_medium, ''), '(none)')   as utm_medium,
  coalesce(nullif(utm_campaign, ''), '(none)') as utm_campaign,
  coalesce(nullif(session_source, ''), '(none)') as session_source,
  count(*)                                     as leads,
  min(date_added)                              as first_seen,
  max(date_added)                              as last_seen
from public.v_utm_attribution
group by 1, 2, 3, 4
order by leads desc;

-- Campaign-ad rollup: only paid rows, grouped by campaign + ad. Empty until
-- campaign ads start; then each ad's lead volume lands here with no code change.
create or replace view public.v_paid_ads_summary as
select
  coalesce(nullif(session_source, ''), '(unknown)') as ad_channel,
  coalesce(nullif(utm_campaign, ''), '(no campaign)') as utm_campaign,
  coalesce(nullif(ad_name, ''), nullif(ad_id, ''), '(no ad id)') as ad,
  count(*)        as leads,
  min(date_added) as first_seen,
  max(date_added) as last_seen
from public.v_utm_attribution
where is_paid_ad
group by 1, 2, 3
order by leads desc;
