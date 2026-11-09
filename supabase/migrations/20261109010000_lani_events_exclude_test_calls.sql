-- Exclude test calls from the Lani voice feed.
--
-- Context (David/Chris, Nov 9 2026): every call currently in voice_agent_calls is
-- an internal test. Chris tests Lani directly from the VAPI dashboard, which does
-- NOT ask for a phone number, so those calls have no caller_phone. Real calls come
-- from the web page, which REQUIRES the phone before dialing — so a real lead call
-- always has a valid phone. A few test calls were placed from the web page too
-- (named "John Test" / "Dub Testing"), and some calls have a blank name.
--
-- Rule (decided): a call counts as a REAL Lani call only if it has a valid phone,
-- a non-blank caller_name, and no "test" in the name. Everything else (no phone =
-- VAPI dashboard test, blank name, or name containing "test") is excluded. This
-- deliberately does NOT hardcode team names (Chris/David) so a genuine future
-- caller with that name is not dropped — their calls have a phone and no "test".
-- Today this excludes all 51 calls (0 real). Revisit with an explicit VAPI test
-- flag when Lani goes live (tracked).
--
-- Only the WHERE filter changes; the event shape is unchanged.

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
    where v.caller_phone is not null
      and length(regexp_replace(coalesce(v.caller_phone, ''), '[^0-9]', '', 'g')) >= 10
      and nullif(trim(coalesce(v.caller_name, '')), '') is not null
      and lower(coalesce(v.caller_name, '')) !~ 'test'
  ) t;
  return n;
end; $$;
