-- First-touch (original source) resolver over ghl_contact_attribution.
--
-- Chris's ask: capture how each contact FIRST found us, not how they entered GHL.
-- GHL's attributionSource (first touch) is now stored in the first_* columns by
-- sync-ghl-attribution. This view resolves the best available origin per contact
-- by priority, and names the real platform that GHL buckets as "Social media".
--
-- Priority (first non-null wins):
--   1. first_utm_source/campaign    -- an explicit campaign tag (strongest; rare today)
--   2. first_referrer -> platform   -- un-buckets Social/Organic (linkedin, google, meetup...)
--   3. first_session_source bucket  -- a real external bucket (Direct, Organic, Paid Social...)
--   4. created_source (entry label) -- funnel/entry name for CRM-created contacts (facebook_group...)
--   5. 'Internal / untracked'       -- CRM UI / Other with no better signal (import, manual, phone)
--   6. 'unknown'                    -- nothing at all
--
-- first_confidence records which rung matched, so reporting can separate real
-- marketing attribution from internal/untracked origins honestly.
-- Test fixtures (contact_name containing "test") are excluded per house rule.

create or replace view public.v_contact_first_source as
with base as (
  select
    ghl_contact_id,
    contact_name,
    date_added,
    first_session_source,
    first_referrer,
    first_utm_source,
    first_utm_campaign,
    created_source,
    -- Real platform from the referring host (GHL hides this under "Social media").
    case
      when first_referrer is null then null
      when first_referrer ilike '%linkedin%'                       then 'LinkedIn'
      when first_referrer ilike '%instagram%'                      then 'Instagram'
      when first_referrer ilike '%facebook%' or first_referrer ilike 'fb.%'
                                                                   then 'Facebook'
      when first_referrer ilike '%youtube%' or first_referrer ilike '%youtu.be%'
                                                                   then 'YouTube'
      when first_referrer ilike '%tiktok%'                         then 'TikTok'
      when first_referrer ilike '%t.co%' or first_referrer ilike '%twitter%' or first_referrer = 'x.com'
                                                                   then 'X / Twitter'
      when first_referrer ilike '%reddit%'                         then 'Reddit'
      when first_referrer ilike '%meetup%'                         then 'Meetup'
      when first_referrer ilike '%chatgpt%' or first_referrer ilike '%openai%'
                                                                   then 'ChatGPT'
      when first_referrer ilike '%google%' and first_referrer ilike '%mail%'   then 'Email (Gmail)'
      when first_referrer ilike '%android.gm%'                     then 'Email (Gmail)'
      when first_referrer ilike '%google%'                         then 'Google'
      when first_referrer ilike '%bing%'                           then 'Bing'
      when first_referrer ilike '%duckduckgo%'                     then 'DuckDuckGo'
      when first_referrer ilike '%utahreia%'                       then null  -- own site, not an external source
      else first_referrer
    end as referrer_platform
  from public.ghl_contact_attribution
  where lower(coalesce(contact_name, '')) not like '%test%'
)
select
  ghl_contact_id,
  contact_name,
  date_added,
  first_session_source,
  first_referrer,
  created_source,
  case
    when nullif(first_utm_source, '')   is not null then 'utm'
    when referrer_platform              is not null then 'referrer'
    when first_session_source in ('Direct traffic','Organic Search','Social media',
                                  'Paid Social','Paid Search','Referral','Email Marketing',
                                  'Third Party','Trigger Link')               then 'session_bucket'
    when nullif(created_source, '')     is not null then 'entry_label'
    when first_session_source in ('CRM UI','CRM Workflows','Other')           then 'internal'
    else 'unknown'
  end as first_confidence,
  coalesce(
    nullif(first_utm_source, ''),
    referrer_platform,
    case when first_session_source in ('Direct traffic','Organic Search','Social media',
                                       'Paid Social','Paid Search','Referral','Email Marketing',
                                       'Third Party','Trigger Link')
         then first_session_source end,
    nullif(created_source, ''),
    case when first_session_source in ('CRM UI','CRM Workflows','Other')
         then 'Internal / untracked' end,
    'unknown'
  ) as first_source
from base;

-- Rollup: contacts by resolved first source + how confident the attribution is.
create or replace view public.v_first_source_summary as
select
  first_source,
  first_confidence,
  count(*)        as contacts,
  min(date_added) as first_seen,
  max(date_added) as last_seen
from public.v_contact_first_source
group by 1, 2
order by contacts desc;
