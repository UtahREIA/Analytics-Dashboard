-- Nov 17 2026: YouTube stats were moved to the SOCIAL-analytics Supabase project
-- (alongside the Metricool feeds), where they belong. The copy that
-- 20261117000000_create_youtube_channel_daily.sql created in THIS (main) project
-- is now unused: api/sync-youtube.js writes to the social project and
-- api/dashboard-data.mjs reads it from there via socialView(). Drop the orphan so
-- there is a single home for the data. (The social-project table is managed from
-- the social repo; see memory youtube-stats-pipeline.)
drop table if exists public.youtube_channel_daily;
