-- Fix: resolve_lead must NOT create a lead with no match key.
--
-- Bug (found 2026-11-09): sync_lani_events() re-scans all voice_agent_calls every
-- run and calls record_lead_event -> resolve_lead. 32 voice calls have no valid
-- phone and no ghl_contact_id (and none have email). resolve_lead could not match
-- them, so it inserted a BRAND-NEW lead every run — 32 keyless orphan leads per day
-- (258 accumulated, 65% of the leads table), while lead_events stayed flat (the
-- event deduped on its stable source_record_id). This corrupts every leads-based
-- metric (lead count, conversion, days-to-member).
--
-- Fix: if no match key (phone_last10 / ghl_contact_id / email) resolved AND no
-- contact linked, return NULL instead of creating an un-dedupable lead.
-- record_lead_event then stores the event with lead_id = NULL (the column is
-- nullable): the call is still counted, but no phantom lead is created and a
-- re-scan cannot duplicate it.
--
-- Only the keyless-and-contactless path changes. Every other feed (calculators,
-- events, surveys, listings, and voice calls that DO have a phone) passes a key
-- from contacts, so their behavior is unchanged.

begin;

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
    -- KEYLESS GUARD: a lead with no phone/ghl/email and no contact link can never
    -- be matched again, so a re-scanning feed would mint a fresh duplicate every
    -- run. Do not create it; caller records the event with lead_id = null.
    if v_last10 is null and v_ghl is null and v_email is null and v_contact is null then
      return null;
    end if;
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
    first_touch_at = case when v_earlier then v_touch          else l.first_touch_at end,
    first_source   = case when v_earlier then p_first_source   else l.first_source   end,
    first_medium   = case when v_earlier then p_first_medium   else l.first_medium   end,
    first_campaign = case when v_earlier then p_first_campaign else l.first_campaign end,
    entry_point    = coalesce(l.entry_point, p_entry_point)
  where l.id = v_lead;

  return v_lead;
end;
$$;

-- re-pin search_path (CREATE OR REPLACE may reset function settings)
alter function public.resolve_lead(text,text,text,text,timestamptz,text,text,text)
  set search_path = public;

commit;
