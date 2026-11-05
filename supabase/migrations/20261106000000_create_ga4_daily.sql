-- ga4_daily: one row per day per default channel group.
--
-- Summary table (totals, not people), so it does NOT go in lead_events. Fed by
-- api/sync-ga4.js, which calls the GA4 Data API runReport over
-- (date x sessionDefaultChannelGroup) and upserts here. The pull re-scans a
-- rolling window every run; the primary key makes each re-pull idempotent and
-- lets GA4's late-finalizing figures (data is ~1-2 days behind) correct in place.
--
-- RLS enabled with no policy, matching the schema convention: the service role
-- (used by the cron and by security-definer functions) bypasses RLS; nothing
-- else can read it directly. Dashboard reads go through a view / snapshot.

create table if not exists public.ga4_daily (
  date             date not null,
  channel          text not null,   -- GA4 sessionDefaultChannelGroup
  sessions         integer not null default 0,
  engaged_sessions integer not null default 0,
  total_users      integer not null default 0,
  new_users        integer not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (date, channel)
);

create index if not exists ga4_daily_date_idx on public.ga4_daily (date);

alter table public.ga4_daily enable row level security;
