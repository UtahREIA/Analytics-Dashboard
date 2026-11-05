-- Opportunities (pipeline deals) pulled from the GHL Opportunities API by the
-- sync-ghl-opportunities edge function. Pipeline + stage names are resolved from
-- the pipelines endpoint and denormalized onto each row (stages change rarely).
-- Each run re-pulls the full set and upserts on ghl_opportunity_id, so status
-- moves (open -> won/lost/abandoned) and stage changes correct in place.
--
-- RLS enabled with no policy, matching the schema convention: the service role
-- (cron + security-definer functions) bypasses RLS; dashboard reads go through a
-- view / snapshot.
create table if not exists public.ghl_opportunities (
  ghl_opportunity_id    text primary key,
  pipeline_id           text,
  pipeline_name         text,
  stage_id              text,
  stage_name            text,
  name                  text,
  status                text,   -- open | won | lost | abandoned
  monetary_value        numeric,
  contact_id            text,
  contact_name          text,
  assigned_to           text,
  source                text,
  created_at_ghl        timestamptz,   -- opportunity createdAt / dateAdded
  updated_at_ghl        timestamptz,   -- opportunity updatedAt / dateUpdated
  last_status_change_at timestamptz,
  last_stage_change_at  timestamptz,
  last_synced_at        timestamptz default now()
);
create index if not exists ghl_opportunities_status_idx on public.ghl_opportunities (status);
create index if not exists ghl_opportunities_pipeline_stage_idx on public.ghl_opportunities (pipeline_id, stage_id);
create index if not exists ghl_opportunities_created_idx on public.ghl_opportunities (created_at_ghl);
create index if not exists ghl_opportunities_contact_idx on public.ghl_opportunities (contact_id);
alter table public.ghl_opportunities enable row level security;
