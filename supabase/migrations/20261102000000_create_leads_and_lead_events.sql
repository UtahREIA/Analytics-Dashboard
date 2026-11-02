-- Migration: create leads and lead_events
-- Phase 2, task 1. Draft for review — not yet applied.
--
-- Context verified against live Supabase (project kttzxjddtkgsitzehiid) on 2026-11-02:
--   - contacts exists: 4607 rows, ghl_contact_id NOT NULL + UNIQUE, raw `phone` (not last10),
--     and it already owns membership_status / membership_date / membership_expiration_date.
--   - voice_agent_calls exists: 43 rows, FK-style contact_id -> contacts(id), vapi_call_id UNIQUE.
--   - leads and lead_events do NOT exist yet.
--
-- The 5 "Review before applying" points are addressed inline; see notes marked [R1]..[R5].

begin;

-- =====================================================================
-- leads (attribution + funnel layer; EXTENDS contacts, does not replace)
-- =====================================================================
-- [R3] contacts stays the system of record for identity and membership.
--      leads links to it via contact_id and carries only what contacts lacks:
--      the shared match keys, first-touch attribution, and funnel stage.
--      Identity (full_name) and membership (member_status/member_since in the
--      CLAUDE.md sketch) are intentionally NOT duplicated here — read them from
--      contacts. This keeps one source of truth.
--      contact_id is nullable so a lead can land before its contacts row exists
--      (e.g. a form webhook that fires before the nightly GHL sync); a backstop
--      then links it using the match keys below.
create table public.leads (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid references public.contacts(id),

  -- shared match keys (CLAUDE.md: phone_last10 -> ghl_contact_id -> email)
  phone_last10    text,   -- [R2] nullable: DMs / email-only leads have no phone
  ghl_contact_id  text,
  email           text,   -- [R2] last-resort match for phone-less leads

  -- first-touch attribution (set once, never updated)
  caller_type     text,   -- investor | vendor
  stage           text,
  strategy        text,
  first_touch_at  timestamptz,
  first_source    text,
  first_medium    text,
  first_campaign  text,
  entry_point     text,   -- form | survey | voice | tool | listing | event

  created_at      timestamptz default now()
);

-- [R2] Match-key uniqueness that tolerates nulls, so phone-less / ghl-less
--      leads never collide on NULL. Partial unique indexes are the fix.
create unique index leads_phone_last10_uidx
  on public.leads (phone_last10) where phone_last10 is not null;

create unique index leads_ghl_contact_id_uidx
  on public.leads (ghl_contact_id) where ghl_contact_id is not null;

-- [R5] Fallback-match lookups. ghl_contact_id is already covered by the unique
--      partial index above; email is non-unique (shared household emails exist),
--      so a plain functional index is enough for the email fallback.
create index leads_email_lower_idx on public.leads (lower(email));
create index leads_contact_id_idx  on public.leads (contact_id);

-- =====================================================================
-- lead_events (one immutable row per thing that happens)
-- =====================================================================
create table public.lead_events (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid references public.leads(id),
  occurred_at     timestamptz not null,
  event_type      text not null,
  source_system   text not null,     -- ghl | vapi | airtable | ga4 | social | gmail
  source_record_id text not null,    -- the ID in the original system
  channel         text,              -- facebook | linkedin | form | survey | voice | calculator | listing | event | direct
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  utm_content     text,
  utm_term        text,
  landing_url     text,
  tool_name       text,              -- which calculator, if any
  metadata        jsonb default '{}'::jsonb,
  created_at      timestamptz default now(),

  -- [R1] Repeatable events (opportunity_stage_changed, workflow_entered,
  --      email_clicked, sms_replied, ...) share one source_record_id but differ
  --      by occurred_at. Adding occurred_at to the dedupe key lets legitimate
  --      repeats through while a re-run of the same sync (same occurred_at)
  --      still upserts idempotently — no double counting.
  --      Alternative considered: fold stage/timestamp into source_record_id in
  --      the writer. Chose the composite key so the writer stays simple.
  unique (source_system, source_record_id, event_type, occurred_at)
);

create index lead_events_occurred_at_idx       on public.lead_events (occurred_at);
create index lead_events_type_occurred_idx      on public.lead_events (event_type, occurred_at);
create index lead_events_channel_occurred_idx   on public.lead_events (channel, occurred_at);
create index lead_events_lead_occurred_idx      on public.lead_events (lead_id, occurred_at);

-- =====================================================================
-- [R4] Last touch — derived, not stored.
-- =====================================================================
-- The checklist wants "what pushed them over the line" without adding columns
-- that would drift out of sync. This view returns each lead's most recent event
-- and its attribution. first touch stays on leads; last touch is always current.
create view public.lead_last_touch as
select distinct on (e.lead_id)
  e.lead_id,
  e.occurred_at  as last_touch_at,
  e.event_type   as last_touch_event,
  e.channel      as last_touch_channel,
  e.utm_source   as last_touch_source,
  e.utm_medium   as last_touch_medium,
  e.utm_campaign as last_touch_campaign
from public.lead_events e
order by e.lead_id, e.occurred_at desc;

commit;
