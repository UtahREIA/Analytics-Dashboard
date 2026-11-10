-- GA4 page-level daily metrics: "top page views" for the website-traffic section.
--
-- ga4_daily holds traffic by channel; it has no page breakdown, so top pages were
-- unanswerable. This adds one row per (date, page_path) with views/sessions/users,
-- pulled by api/sync-ga4.js (same OAuth + rolling-window pattern). screenPageViews
-- maps to `views`. Additive; does not touch ga4_daily.

create table if not exists public.ga4_page_daily (
  date         date    not null,
  page_path    text    not null,
  views        integer not null default 0,   -- GA4 screenPageViews
  sessions     integer not null default 0,
  total_users  integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (date, page_path)
);

create index if not exists ga4_page_daily_date_idx  on public.ga4_page_daily (date);
create index if not exists ga4_page_daily_views_idx on public.ga4_page_daily (views desc);

comment on table public.ga4_page_daily is
  'GA4 page-level daily metrics (top page views). One row per (date, page_path). GA4 screenPageViews -> views. Populated by api/sync-ga4.js. Added 2026-11-09.';

-- Top pages over the trailing 30 days, aggregated across dates. Drives the
-- "top page views" tile.
create or replace view public.v_ga4_top_pages_30d as
select
  page_path,
  sum(views)       as views,
  sum(sessions)    as sessions,
  sum(total_users) as total_users
from public.ga4_page_daily
where date >= current_date - 30
group by page_path
order by views desc;
