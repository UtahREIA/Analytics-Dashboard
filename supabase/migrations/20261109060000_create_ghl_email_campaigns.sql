-- GHL email campaign stats (sent / delivered / failed per campaign).
--
-- Pulled by sync-ghl-emails from GHL /emails/schedule. Each campaign object
-- carries send counts (totalCount, successCount, failed, queued). GHL's v2 API
-- does NOT expose open/click stats (no statistics endpoint; those live only in
-- the GHL UI reporting), so this table covers sent/delivered/failed only.
-- Opens/clicks would need a GHL UI export or a per-contact conversation pull.
--
-- Summary table (totals, not people), like ga4_daily / social — so it does not
-- go in lead_events. Idempotent upsert on the GHL schedule id.

create table if not exists public.ghl_email_campaigns (
  id               text primary key,   -- GHL schedule id
  name             text,
  subject          text,
  status           text,               -- complete | draft | cancelled | pause
  campaign_type    text,               -- send_now | drip_schedule | schedule_later | ...
  has_tracking     boolean,
  has_utm_tracking boolean,
  total_count      integer,            -- recipients targeted
  delivered_count  integer,            -- successCount (successfully sent/accepted)
  processed_count  integer,
  failed_count     integer,
  queued_count     integer,
  date_scheduled   timestamptz,
  ghl_created_at   timestamptz,
  ghl_updated_at   timestamptz,
  last_synced_at   timestamptz default now()
);

create index if not exists ghl_email_campaigns_status_idx    on public.ghl_email_campaigns (status);
create index if not exists ghl_email_campaigns_scheduled_idx on public.ghl_email_campaigns (date_scheduled);

alter table public.ghl_email_campaigns enable row level security;

comment on table public.ghl_email_campaigns is
  'GHL email campaigns from /emails/schedule: sent/delivered/failed per campaign. No open/click (not in GHL v2 API). Added 2026-11-09.';

-- GHL reports send counts inconsistently: some campaigns populate successCount /
-- processed, others only queuedCount (= total). Derive robustly:
--   sent      = processed, else queued, else total (the attempted send volume)
--   delivered = successCount, else sent - failed (best effort)
-- so the delivered % reflects reality instead of null handling.
create or replace view public.v_email_campaign_stats as
with base as (
  select
    id, name, subject, campaign_type, date_scheduled, has_tracking, has_utm_tracking,
    total_count,
    coalesce(failed_count, 0)                              as failed,
    coalesce(processed_count, queued_count, total_count)  as sent,
    coalesce(
      delivered_count,
      coalesce(processed_count, queued_count, total_count) - coalesce(failed_count, 0)
    )                                                      as delivered
  from public.ghl_email_campaigns
  where status = 'complete'
    and lower(coalesce(name, '')) not like '%verification%'
    and lower(coalesce(name, '')) not like '%verify%'
)
select
  id, name, subject, campaign_type, date_scheduled,
  total_count as targeted,
  delivered,
  failed,
  round(100.0 * delivered / nullif(sent, 0), 1) as delivered_pct,
  has_tracking, has_utm_tracking,
  sent
from base
order by date_scheduled desc nulls last;

-- Overall email totals across completed campaigns (same robust derivation).
create or replace view public.v_email_totals as
select
  count(*)            as campaigns,
  sum(sent)           as total_sent,
  sum(delivered)      as total_delivered,
  sum(failed)         as total_failed,
  round(100.0 * sum(delivered) / nullif(sum(sent), 0), 1) as delivered_pct
from public.v_email_campaign_stats;
