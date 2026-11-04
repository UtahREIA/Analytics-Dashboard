-- Migration: resolve_lead() + record_lead_event()
-- Phase 2. APPLIED to prod 2026-11-04 (smoke-tested). Depends on 20261102000000.
-- search_path is pinned on both functions in 20261104010000.
--
-- Purpose: give every data feed (Vapi, GHL webhooks, Airtable pulls, calculators,
-- listings) ONE idempotent entry point so they all dedupe identically, per the
-- CLAUDE.md match priority: phone_last10 -> ghl_contact_id -> email.
--
--   resolve_lead(...)        -> finds or creates the lead, links it to contacts,
--                               backfills missing match keys, keeps EARLIEST-wins
--                               first-touch. Returns leads.id.
--   record_lead_event(...)   -> resolves the lead, then upserts one lead_events
--                               row idempotently on the dedupe key. Returns the
--                               lead_events.id.
--
-- Match keys phone_last10 and ghl_contact_id are unique-partial on leads, so the
-- functions guard against cross-lead collisions and NEVER blind-insert a dup.
-- Known limitation (F-merge): if the same person exists as two leads (e.g. an
-- email-only lead created first, then a later phone-only event), these functions
-- do NOT merge the two rows — they attach to whichever matched first and leave the
-- other. A dedicated merge routine is a later task; flagged in the tracker.

begin;

-- =====================================================================
-- resolve_lead: find-or-create the lead, return its id
-- =====================================================================
create or replace function public.resolve_lead(
  p_phone           text        default null,
  p_ghl_contact_id  text        default null,
  p_email           text        default null,
  p_entry_point     text        default null,
  p_first_touch_at  timestamptz default null,
  p_first_source    text        default null,
  p_first_medium    text        default null,
  p_first_campaign  text        default null
) returns uuid
language plpgsql
as $$
declare
  v_last10   text;
  v_email    text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_ghl      text := nullif(trim(coalesce(p_ghl_contact_id, '')), '');
  v_touch    timestamptz := coalesce(p_first_touch_at, now());
  v_lead     uuid;
  v_contact  uuid;
  v_earlier  boolean;
begin
  -- normalize phone to last 10 digits; null unless exactly 10 remain
  v_last10 := right(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 10);
  if length(coalesce(v_last10, '')) <> 10 then
    v_last10 := null;
  end if;

  -- 1) match an existing lead by priority: phone_last10 -> ghl_contact_id -> email
  if v_last10 is not null then
    select id into v_lead from public.leads where phone_last10 = v_last10 limit 1;
  end if;
  if v_lead is null and v_ghl is not null then
    select id into v_lead from public.leads where ghl_contact_id = v_ghl limit 1;
  end if;
  if v_lead is null and v_email is not null then
    select id into v_lead from public.leads where lower(email) = v_email limit 1;
  end if;

  -- 2) resolve the contacts row (identity source of truth), same priority
  if v_ghl is not null then
    select id into v_contact from public.contacts where ghl_contact_id = v_ghl limit 1;
  end if;
  if v_contact is null and v_last10 is not null then
    select id into v_contact from public.contacts
      where right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = v_last10 limit 1;
  end if;
  if v_contact is null and v_email is not null then
    select id into v_contact from public.contacts where lower(email) = v_email limit 1;
  end if;

  -- 3) create if no lead matched. Catch a concurrent insert on the unique keys
  --    and fall through to the enrich path.
  if v_lead is null then
    begin
      insert into public.leads (
        contact_id, phone_last10, ghl_contact_id, email,
        entry_point, first_touch_at, first_source, first_medium, first_campaign
      ) values (
        v_contact, v_last10, v_ghl, v_email,
        p_entry_point, v_touch, p_first_source, p_first_medium, p_first_campaign
      )
      returning id into v_lead;
      return v_lead;
    exception when unique_violation then
      -- another writer created it first; re-match and enrich below
      if v_last10 is not null then
        select id into v_lead from public.leads where phone_last10 = v_last10 limit 1;
      end if;
      if v_lead is null and v_ghl is not null then
        select id into v_lead from public.leads where ghl_contact_id = v_ghl limit 1;
      end if;
      if v_lead is null and v_email is not null then
        select id into v_lead from public.leads where lower(email) = v_email limit 1;
      end if;
    end;
  end if;

  -- 4) enrich the existing lead:
  --    - backfill missing match keys (guard the unique ones against collision)
  --    - link contact_id if not set
  --    - EARLIEST-wins first touch (so out-of-order backfills correct it)
  select (l.first_touch_at is null or v_touch < l.first_touch_at)
    into v_earlier
  from public.leads l where l.id = v_lead;

  update public.leads l set
    phone_last10 = case
      when l.phone_last10 is not null then l.phone_last10
      when v_last10 is not null
           and not exists (select 1 from public.leads x where x.phone_last10 = v_last10 and x.id <> l.id)
        then v_last10
      else l.phone_last10 end,
    ghl_contact_id = case
      when l.ghl_contact_id is not null then l.ghl_contact_id
      when v_ghl is not null
           and not exists (select 1 from public.leads x where x.ghl_contact_id = v_ghl and x.id <> l.id)
        then v_ghl
      else l.ghl_contact_id end,
    email      = coalesce(l.email, v_email),
    contact_id = coalesce(l.contact_id, v_contact),
    -- first-touch block moves together, only when this event is earlier
    first_touch_at = case when v_earlier then v_touch          else l.first_touch_at end,
    first_source   = case when v_earlier then p_first_source   else l.first_source   end,
    first_medium   = case when v_earlier then p_first_medium   else l.first_medium   end,
    first_campaign = case when v_earlier then p_first_campaign else l.first_campaign end,
    entry_point    = coalesce(l.entry_point, p_entry_point)
  where l.id = v_lead;

  return v_lead;
end;
$$;

-- =====================================================================
-- record_lead_event: resolve the lead, then idempotently upsert the event
-- =====================================================================
create or replace function public.record_lead_event(
  p_event_type       text,
  p_source_system    text,
  p_source_record_id text,
  p_occurred_at      timestamptz default now(),
  -- identity
  p_phone            text default null,
  p_ghl_contact_id   text default null,
  p_email            text default null,
  -- attribution / context
  p_channel          text  default null,
  p_utm_source       text  default null,
  p_utm_medium       text  default null,
  p_utm_campaign     text  default null,
  p_utm_content      text  default null,
  p_utm_term         text  default null,
  p_landing_url      text  default null,
  p_tool_name        text  default null,
  p_entry_point      text  default null,
  p_metadata         jsonb default '{}'::jsonb
) returns uuid
language plpgsql
as $$
declare
  v_lead  uuid;
  v_event uuid;
begin
  v_lead := public.resolve_lead(
    p_phone, p_ghl_contact_id, p_email,
    p_entry_point, p_occurred_at, p_utm_source, p_utm_medium, p_utm_campaign
  );

  insert into public.lead_events (
    lead_id, occurred_at, event_type, source_system, source_record_id,
    channel, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    landing_url, tool_name, metadata
  ) values (
    v_lead, coalesce(p_occurred_at, now()), p_event_type, p_source_system, p_source_record_id,
    p_channel, p_utm_source, p_utm_medium, p_utm_campaign, p_utm_content, p_utm_term,
    p_landing_url, p_tool_name, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (source_system, source_record_id, event_type, occurred_at)
  do update set lead_id = coalesce(public.lead_events.lead_id, excluded.lead_id)
  returning id into v_event;

  return v_event;
end;
$$;

commit;

-- =====================================================================
-- USAGE (writers call one function; it handles identity + dedupe)
-- =====================================================================
-- Lani end-of-call (vapi):
--   select public.record_lead_event(
--     'call_completed', 'vapi', :vapi_call_id, :ended_at,
--     p_phone => :caller_phone, p_ghl_contact_id => :ghl_contact_id,
--     p_channel => 'voice', p_entry_point => 'voice',
--     p_metadata => jsonb_build_object('strategies', :strategies, 'blocker', :blocker));
--
-- Calculator finish (airtable/ghl webhook), UTMs from the footer snippet:
--   select public.record_lead_event(
--     'analysis_finished', 'ghl', :submission_id, now(),
--     p_phone => :phone, p_channel => 'calculator', p_entry_point => 'tool',
--     p_tool_name => :calculator,
--     p_utm_source => :utm_source, p_utm_medium => :utm_medium, p_utm_campaign => :utm_campaign);
--
-- Repeatable events (F-repeat): pass a source_record_id that already varies per
-- occurrence (e.g. opportunity id + stage), and occurred_at makes the dedupe key
-- unique per transition.
