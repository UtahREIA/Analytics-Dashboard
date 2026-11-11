-- ga4_page_daily was the only public table with RLS disabled (anon could read/write it).
-- It is written by api/sync-ga4.js and read by api/dashboard-data.js, both with the
-- service-role key (which bypasses RLS). Enabling RLS with no policy matches every
-- sibling table: service-role access is unchanged, anonymous access is removed.
alter table public.ga4_page_daily enable row level security;
