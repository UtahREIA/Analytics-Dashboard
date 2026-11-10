-- GHL workflow inventory (metadata only — the GHL v2 API exposes no execution /
-- enrollment counts). One row per workflow, pulled from /workflows/ by the
-- sync-ghl-workflows edge function. Full re-pull each run, idempotent upsert on
-- ghl_workflow_id so renames and status flips correct in place.
-- Cron: pg_cron job 'sync-ghl-workflows-daily' at 11:05 UTC.

create table if not exists public.ghl_workflows (
  ghl_workflow_id text primary key,
  name text,
  status text,                 -- published | draft
  version text,
  created_at_ghl timestamptz,
  updated_at_ghl timestamptz,
  is_active boolean,           -- status = 'published'
  last_synced_at timestamptz default now()
);

comment on table public.ghl_workflows is 'GHL workflow inventory (metadata only — GHL v2 API exposes no execution/enrollment counts). One row per workflow, pulled from /workflows/ by the sync-ghl-workflows edge function. Full re-pull each run, idempotent upsert on ghl_workflow_id so renames/status flips correct in place.';

alter table public.ghl_workflows enable row level security;
