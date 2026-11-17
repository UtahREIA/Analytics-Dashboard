-- First-party YouTube stats pulled daily from the YouTube Data API v3
-- (channel snapshot: subscribers / lifetime views / video count) and the
-- YouTube Analytics API (that day's movement: views, watch time, subs gained/lost,
-- likes, comments, shares). Replaces the inaccurate Metricool feed for YouTube.
-- One row per (date, channel). Upsert on that key makes the rolling re-pull idempotent.
create table if not exists public.youtube_channel_daily (
  date date not null,
  channel_id text not null,
  channel_title text,
  -- Snapshot (cumulative totals as of the pull), from the Data API:
  subscribers bigint,
  total_views bigint,
  video_count integer,
  -- Daily movement (that calendar day), from the Analytics API:
  views bigint,
  minutes_watched bigint,
  avg_view_duration_sec numeric,
  subscribers_gained integer,
  subscribers_lost integer,
  likes integer,
  comments integer,
  shares integer,
  updated_at timestamptz default now(),
  primary key (date, channel_id)
);

-- Service-role writes (the Vercel cron) and service-role reads (the dashboard
-- endpoint) bypass RLS; enable it with no policies so the security advisor is
-- satisfied and anon/public cannot read.
alter table public.youtube_channel_daily enable row level security;

create index if not exists youtube_channel_daily_date_idx
  on public.youtube_channel_daily (date);
