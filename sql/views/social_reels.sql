-- REFERENCE ONLY — these views live in the "Social Media Analytics" Supabase project
-- (oeraqcuithvmeyljuzbd), NOT the main Contact-Matching project. Kept here so the
-- analytics work is traceable in one repo. Applied 2026-11-09.
--
-- post_snapshots appends one row per post per Metricool pull, so view totals grow over
-- time; v_reels takes the LATEST snapshot per post (distinct on) to avoid double-counting.
-- Short-form = content_type 'reel' (Facebook/Instagram) plus TikTok (all TikTok content
-- is short-form vertical video, currently mislabeled content_type='feed' by the pull).
--
-- KNOWN COLLECTION GAPS (fix in the Social Media Analytics / Metricool pull repo, not here):
--   * TikTok rows come in as content_type='feed' — should be 'reel'/short-form.
--   * YouTube video_views are 0/null (YouTube Shorts views not captured).
--   * Facebook + TikTok reel snapshots are stale (latest ~Sept 2026); Instagram is fresh.

create or replace view public.v_reels as
select distinct on (network, coalesce(post_url, id::text))
  network,
  case when content_type = 'reel' then 'reel' else 'short_form' end as reel_kind,
  post_url, post_date, content_preview,
  video_views, reach, likes, comments, shares, saves, engagement_pct, snapshot_date
from public.post_snapshots
where content_type = 'reel' or network = 'tiktok'
order by network, coalesce(post_url, id::text), snapshot_date desc;

create or replace view public.v_reels_summary as
select
  network,
  count(*)                                     as reels,
  sum(coalesce(video_views,0))                 as total_views,
  round(avg(nullif(video_views,0)))            as avg_views,
  sum(coalesce(likes,0)+coalesce(comments,0)+coalesce(shares,0)+coalesce(saves,0)) as total_engagement,
  max(post_date)                               as latest_post
from public.v_reels
group by network
order by total_views desc;
