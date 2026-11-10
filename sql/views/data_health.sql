-- v_data_health: per-feed heartbeat for the dashboard "Data health" panel and /api/health.
-- Heartbeat = did the SYNC run recently (pg_cron run history for pg_cron feeds; each
-- feed's own last-write timestamp for Vercel / custom feeds), NOT when data last changed —
-- so a low-volume feed with no new rows never false-alarms.
-- status: ok (ran within max_age_min) | STALE (overdue -> /api/health returns 503 -> the
-- GitHub Action emails us) | unknown (never run yet; does not trip the alert).
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
    (select last_ok from cron_last where jobname='sync-ghl-calls-every-30-min') as last_run, 120 as max_age_min
  union all select 'GHL messages / SMS (30 min)'::text,
    (select last_ok from cron_last where jobname='sync-ghl-messages-every-30-min'), 120
  union all select 'GHL appointments (daily)'::text,
    (select last_ok from cron_last where jobname='sync-ghl-appointments-daily'), 1800
  union all select 'GHL opportunities (daily)'::text,
    (select last_ok from cron_last where jobname='sync-ghl-opportunities-daily'), 1800
  union all select 'GHL attribution / UTM (daily)'::text,
    (select last_ok from cron_last where jobname='sync-ghl-attribution-daily'), 1800
  union all select 'GHL emails (daily)'::text,
    (select last_ok from cron_last where jobname='sync-ghl-emails-daily'), 1800
  union all select 'GHL workflows (daily)'::text,
    (select last_ok from cron_last where jobname='sync-ghl-workflows-daily'), 1800
  union all select 'Contacts + fan-out (Vercel)'::text,
    (select max(updated_at) from sync_state), 1800
  union all select 'GA4 traffic + top pages'::text,
    (select max(updated_at) from ga4_daily), 1800
  union all select 'GHL custom objects'::text,
    (select max(synced_at) from ghl_vendor_resources), 1800
)
select feed, last_run,
  case when last_run is null then null::integer
       else round(extract(epoch from now()-last_run)/60::numeric)::integer end as age_min,
  max_age_min,
  case when last_run is null then 'unknown'
       when (now()-last_run) > ((max_age_min||' minutes')::interval) then 'STALE'
       else 'ok' end as status
from feeds
order by (case when last_run is null then 0
               when (now()-last_run) > ((max_age_min||' minutes')::interval) then 1
               else 2 end), feed;
