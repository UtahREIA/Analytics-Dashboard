-- Migration: create sync_state
-- Watermark store for the contacts-sync cron (api/sync-contacts.js). One row per sync stream;
-- `cursor` is the dateUpdated up to which contacts have been confirmed synced. The incremental
-- run reads it, processes GHL contacts changed at/after it (oldest first), and advances it to
-- the earliest change NOT yet confirmed. A missed/failed run leaves the cursor where it was, so
-- the next run resumes from the gap -- no fixed window to overflow, no oldest-change loss.
--
-- Additive, standalone table. Service role only (RLS on, no policies) since just the backend
-- cron touches it; the public anon key must not be able to move the cursor.

create table if not exists public.sync_state (
  key        text primary key,
  cursor     timestamptz,
  updated_at timestamptz default now()
);

alter table public.sync_state enable row level security;
