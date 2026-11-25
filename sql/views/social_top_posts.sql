-- REFERENCE ONLY — this view lives in the "Social Media Analytics" Supabase project
-- (oeraqcuithvmeyljuzbd), NOT the main Contact-Matching project. Kept here so the
-- analytics work is traceable in one repo. Applied 2026-11-25.
--
-- Top-performing social posts across ALL content types (feed, carousel, reel, video),
-- for the dashboard "Top posts" panel. post_snapshots appends one row per post per
-- Metricool pull, so we take the LATEST snapshot per post (distinct on) to avoid
-- double-counting, same pattern as v_reels.
--
-- RANKING: by absolute engagement actions (likes+comments+shares+saves). This is
-- comparable across networks. We deliberately do NOT rank by engagement_pct — it is
-- reach-relative and massively favors tiny-reach posts (reach 5, 1 like = 20%).
--
-- NOTE: the Metricool pull is currently stale (latest snapshot ~2026-11-02), so this
-- reflects posts through early Nov until the social pull is reconnected (social repo).

create or replace view public.v_top_posts as
with latest as (
  select distinct on (network, coalesce(post_url, id::text)) *
  from public.post_snapshots
  order by network, coalesce(post_url, id::text), snapshot_date desc
)
select
  network,
  content_type,
  format_type,
  post_url,
  post_date,
  content_preview,
  impressions,
  reach,
  coalesce(reach, impressions)                          as reach_or_impressions,
  engagement_pct,
  coalesce(likes,0)                                     as likes,
  coalesce(comments,0)                                  as comments,
  coalesce(shares,0)                                    as shares,
  coalesce(saves,0)                                     as saves,
  coalesce(video_views,0)                               as video_views,
  (coalesce(likes,0)+coalesce(comments,0)+coalesce(shares,0)+coalesce(saves,0)) as engagement_actions,
  snapshot_date
from latest
order by engagement_actions desc, video_views desc nulls last, reach_or_impressions desc nulls last;
