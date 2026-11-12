-- v_data_health: per-feed health for the dashboard "Data health" panel and /api/health.
-- TWO signals per feed:
--   1. "sync ran"   (status): did the job execute recently? From pg_cron run history for
--      pg_cron feeds; each feed's own last-write timestamp for Vercel / custom feeds.
--   2. "data fresh" (data_status): is the NEWEST data row recent? Catches a feed that runs
--      but silently stops producing data (the social-pull failure mode).
-- A quiet low-volume feed with no new rows is NOT broken, so only high-volume feeds get a data
-- window; the rest report data_status 'n/a' (informational last_data_at only).
--   GHL messages: 1 day (1440) · GA4: 2 days (2880).
-- Social lives in a SEPARATE Supabase project, so its 3-day freshness is computed in the API
-- layer (api/health.js, api/dashboard-data.mjs) and injected as an extra feed row — the main
-- v_data_health view cannot cross-query it.
-- security_invoker=false so the anon/service REST read can see cron.* + the source tables.

create or replace view public.v_data_health
with (security_invoker=false) as
with cron_last as (
  select j.jobname,
         max(r.end_time) filter (where r.status = 'succeeded') as last_ok
  from cron.job j
  left join cron.job_run_details r on r.jobid = j.jobid
  group by j.jobname
), feeds as (
  select 'GHL calls (30 min)'::text as feed,
    (select last_ok from cron_last where jobname='sync-ghl-calls-every-30-min') as last_run, 120 as max_age_min,
    (select max(call_at) from ghl_call_logs) as last_data_at, null::int as data_max_age_min
  union all select 'GHL messages / SMS (30 min)',
    (select last_ok from cron_last where jobname='sync-ghl-messages-every-30-min'), 120,
    (select max(message_at) from ghl_message_logs), 1440
  union all select 'GHL appointments (daily)',
    (select last_ok from cron_last where jobname='sync-ghl-appointments-daily'), 1800,
    (select max(date_added) from ghl_appointments), null
  union all select 'GHL opportunities (daily)',
    (select last_ok from cron_last where jobname='sync-ghl-opportunities-daily'), 1800,
    (select max(updated_at_ghl) from ghl_opportunities), null
  union all select 'GHL attribution / UTM (daily)',
    (select last_ok from cron_last where jobname='sync-ghl-attribution-daily'), 1800,
    (select max(date_added) from ghl_contact_attribution), null
  union all select 'GHL emails (daily)',
    (select last_ok from cron_last where jobname='sync-ghl-emails-daily'), 1800,
    (select max(date_scheduled) from ghl_email_campaigns), null
  union all select 'GHL workflows (daily)',
    (select last_ok from cron_last where jobname='sync-ghl-workflows-daily'), 1800,
    (select max(updated_at_ghl) from ghl_workflows), null
  union all select 'Contacts + fan-out (Vercel)',
    (select max(updated_at) from sync_state), 1800,
    (select max(created_at) from contacts), null
  union all select 'GA4 traffic + top pages',
    (select max(updated_at) from ga4_daily), 1800,
    (select max(date)::timestamptz from ga4_daily), 2880
  union all select 'GHL custom objects',
    (select max(synced_at) from ghl_vendor_resources), 1800,
    (select max(ghl_updated_at) from ghl_vendor_resources), null
)
select feed,
  last_run,
  case when last_run is null then null::int
       else round(extract(epoch from now()-last_run)/60::numeric)::int end as age_min,
  max_age_min,
  case when last_run is null then 'unknown'
       when (now()-last_run) > ((max_age_min||' minutes')::interval) then 'STALE'
       else 'ok' end as status,
  last_data_at,
  case when last_data_at is null then null::int
       else round(extract(epoch from now()-last_data_at)/60::numeric)::int end as data_age_min,
  data_max_age_min,
  case when data_max_age_min is null then 'n/a'
       when last_data_at is null then 'unknown'
       when (now()-last_data_at) > ((data_max_age_min||' minutes')::interval) then 'STALE'
       else 'fresh' end as data_status
from feeds
order by (case
    when last_run is not null and (now()-last_run) > ((max_age_min||' minutes')::interval) then 0
    when data_max_age_min is not null and last_data_at is not null
         and (now()-last_data_at) > ((data_max_age_min||' minutes')::interval) then 0
    when last_run is null then 1
    else 2 end), feed;
