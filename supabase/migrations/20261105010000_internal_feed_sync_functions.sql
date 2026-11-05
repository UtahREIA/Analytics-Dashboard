-- Internal feed sync functions. Applied to prod 2026-11-05.
--
-- Feeds whose data already lives in Supabase (no GHL API cost, no cross-repo code):
--   calculators     -> tool_access         -> calculator_unlocked
--   Lani calls      -> voice_agent_calls   -> call_completed
--   event attendance-> event_attendance    -> event_attended
--   (surveys/rosters-> readiness_surveys   -> survey_submitted / event_registered, see sync_survey_events)
-- Each writes via record_lead_event (idempotent). sync_internal_feeds() runs them
-- all and is what api/sync-form-submissions.js calls once per daily run.
--
-- GHL has no public survey-submissions API, and calculators/Lani/attendance are
-- only reachable via their Supabase mirrors, so these internal syncs (not GHL
-- pulls) are the correct, cost-free pattern. Listings (Airtable Properties) are
-- the one feed NOT yet mirrored in Supabase — still to wire via an Airtable pull.
--
-- Each function re-scans its whole source table per run (idempotent). Fine at
-- current volume; add watermarks if any source grows large.

create or replace function public.sync_calculator_events()
returns integer language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  select count(*) into n from (
    select record_lead_event(
      p_event_type => 'calculator_unlocked',
      p_source_system => 'airtable',
      p_source_record_id => ta.contact_id::text || ':' || x.tool_key,
      p_occurred_at => x.access_date::timestamptz,
      p_phone => c.phone, p_ghl_contact_id => c.ghl_contact_id, p_email => c.email,
      p_channel => 'calculator', p_entry_point => 'tool', p_tool_name => x.tool_name,
      p_metadata => jsonb_build_object('tool', x.tool_name)
    ) as ev
    from tool_access ta
    join contacts c on c.id = ta.contact_id
    cross join lateral (values
      ('fix_flip','Fix & Flip', ta.fix_flip_calculator_access),
      ('brrrr','BRRRR', ta.brrrr_calculator_access),
      ('wholesale','Wholesale', ta.wholesale_calculator_access),
      ('rentals','Rentals', ta.rentals_calculator_access),
      ('short_term','Short Term', ta.short_term_calculator_access),
      ('rehab','Rehab Estimator', ta.rehab_estimator_access)
    ) x(tool_key, tool_name, access_date)
    where x.access_date is not null
      and lower(coalesce(ta.full_name, '')) <> 'testing'
  ) t;
  return n;
end; $$;

create or replace function public.sync_lani_events()
returns integer language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  select count(*) into n from (
    select record_lead_event(
      p_event_type => 'call_completed',
      p_source_system => 'vapi',
      p_source_record_id => coalesce(v.vapi_call_id, v.id::text),
      p_occurred_at => coalesce(v.created_at, now()),
      p_phone => v.caller_phone, p_ghl_contact_id => v.ghl_contact_id,
      p_channel => 'voice', p_entry_point => 'voice',
      p_metadata => jsonb_build_object('investor_stage', v.investor_stage, 'tier', v.tier,
        'blocker', v.blocker, 'strategies', v.strategies, 'call_duration_secs', v.call_duration_secs)
    ) as ev
    from voice_agent_calls v
    where lower(coalesce(v.caller_name, '')) <> 'testing'
  ) t;
  return n;
end; $$;

create or replace function public.sync_event_attendance_events()
returns integer language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  select count(*) into n from (
    select record_lead_event(
      p_event_type => 'event_attended',
      p_source_system => 'ghl',
      p_source_record_id => ea.contact_id::text || ':' || coalesce(ea.event_name,'event') || ':' || coalesce(ea.event_date::text,''),
      p_occurred_at => coalesce(ea.event_date::timestamptz, ea.created_at, now()),
      p_phone => c.phone, p_ghl_contact_id => c.ghl_contact_id, p_email => c.email,
      p_channel => 'event', p_entry_point => 'event',
      p_metadata => jsonb_build_object('event_name', ea.event_name)
    ) as ev
    from event_attendance ea
    join contacts c on c.id = ea.contact_id
    where ea.attended is true
      and lower(coalesce(ea.full_name, '')) <> 'testing'
  ) t;
  return n;
end; $$;

create or replace function public.sync_internal_feeds()
returns jsonb language plpgsql security invoker set search_path = public as $$
begin
  return jsonb_build_object(
    'survey', public.sync_survey_events(),
    'calculator', public.sync_calculator_events(),
    'lani', public.sync_lani_events(),
    'event_attendance', public.sync_event_attendance_events()
  );
end; $$;
