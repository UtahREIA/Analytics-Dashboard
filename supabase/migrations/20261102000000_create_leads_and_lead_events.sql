-- Migration: create leads and lead_events
-- Phase 2, task 1. APPLIED to prod 2026-11-04 (smoke-tested in a rolled-back txn
-- first; all 9 checks passed). RLS/security hardening is in 20261104010000.
--
-- Context re-verified against live Supabase (project kttzxjddtkgsitzehiid) on 2026-11-04:
--   - contacts exists: 4594 rows. ghl_contact_id NOT NULL + UNIQUE (the identity key).
--     Raw `phone` (not last10); 3686 have a phone, 4069 an email, 87 have NEITHER.
--     contacts already owns membership (membership_status, ghl_membership_status,
--     membership_date, membership_expiration_date, membership_fee).
--   - The contact_id -> contacts(id) link is the ESTABLISHED pattern: voice_agent_calls,
--     readiness_surveys, and tool_access all reference contacts(id) that way (each also
--     keeps ghl_contact_id for matching). leads/lead_events follow the same convention.
--   - leads and lead_events do NOT exist yet.
--   - phone_last10 is NEAR-unique, not unique: exactly 2 last-10 groups in contacts map to
--     >1 contact today (likely duplicate GHL contacts). See [R2] for how the unique index
--     treats them. 87 contacts have no phone and no email — unmatchable until one is added.
--
-- DESIGN DECISION (design point #3): leads EXTENDS contacts, it does not replace it, and we
--   did NOT fold attribution into contacts. Reasons, both confirmed against live data:
--     (a) contacts.ghl_contact_id is NOT NULL, so a lead that arrives before the nightly GHL
--         sync (calculator / Vapi / listing webhook) could not be stored in contacts at all;
--         leads.contact_id is nullable and a backstop links it later via the match keys.
--     (b) contacts is overwritten by the GHL sync; first-touch columns there would be at risk
--         of being nulled each run. Keeping attribution in leads avoids that.
--   Identity + membership are read from contacts; days-to-member = contacts.membership_date
--   minus leads.first_touch_at (member rule = ghl_membership_status = 'Active').
--
-- The 5 "Review before applying" points are addressed inline; see notes marked [R1]..[R5].
-- STATUS: APPLIED to prod 2026-11-04. Flag resolutions are at the bottom.

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
--      The UNIQUE here enforces the writer's contract: match-by-last10 to an
--      existing lead and attach, NEVER blind-insert a duplicate. The 2 last-10
--      groups that map to >1 contact today therefore collapse to ONE lead each
--      (correct if they are duplicate GHL contacts; see bottom flag if they are
--      genuinely different people sharing a line).
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

-- =====================================================================
-- FLAG RESOLUTIONS (status as of 2026-11-04)
-- =====================================================================
-- F1. DONE. resolve_lead() + record_lead_event() shipped in 20261104000000 and
--     smoke-tested; every writer calls record_lead_event() and dedupes identically.
-- F2. ACCEPTED (David). The 2 shared-last-10 pairs merge into one lead; treated as
--     duplicate GHL contacts. Revisit only if a pair turns out to be two people.
-- F3. ACCEPTED (David). The 87 phone-less + email-less contacts' events land with
--     null contact_id until an identifier appears; acceptable for now.
-- F4. OPEN (feed work). Existing contact_id-bearing tables (voice_agent_calls, readiness_surveys,
--     tool_access) are NOT rewritten. Their event writers will emit into
--     lead_events; strategy/caller_type can be sourced from voice_agent_calls
--     (profile_type, strategies[]) and survey_type, rather than re-entered.
-- F5. entry_point vocabulary (form|survey|voice|tool|listing|event) maps to the
--     live sources: readiness_surveys -> survey, tool_access -> tool,
--     voice_agent_calls -> voice, add-property -> listing, GHL forms -> form,
--     event surveys/rosters -> event. Confirm no 7th category is needed.
