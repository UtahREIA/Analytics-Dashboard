-- Applied to the SYSTEM DATA project (byultsmaxrrsaypeoapc), NOT the main
-- Contact Matching System project. Kept in a separate folder so it is never run
-- against main by the migration runner. Already applied via MCP on 2026-11-24.
--
-- Part of the GA4 relocation (declutter): GA4 feeds move out of the Contact
-- Matching System project into System Data. sync-ga4.js writes here; the dashboard
-- reads here via systemDataView(). Data is re-backfilled from GA4 (sync-ga4 ?full=1),
-- so no cross-project row copy is needed.

create table if not exists public.ga4_daily (
  date date not null,
  channel text not null,
  sessions integer not null default 0,
  engaged_sessions integer not null default 0,
  total_users integer not null default 0,
  new_users integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (date, channel)
);
create index if not exists ga4_daily_date_idx on public.ga4_daily (date);
alter table public.ga4_daily enable row level security;

create table if not exists public.ga4_page_daily (
  date date not null,
  page_path text not null,
  views integer not null default 0,
  sessions integer not null default 0,
  total_users integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (date, page_path)
);
create index if not exists ga4_page_daily_date_idx on public.ga4_page_daily (date);
create index if not exists ga4_page_daily_views_idx on public.ga4_page_daily (views desc);
alter table public.ga4_page_daily enable row level security;

create or replace view public.v_ga4_top_pages_30d as
  select page_path, sum(views) as views, sum(sessions) as sessions, sum(total_users) as total_users
  from public.ga4_page_daily
  where date >= (current_date - 30)
  group by page_path
  order by sum(views) desc;
