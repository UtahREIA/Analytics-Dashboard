-- One-time backfill: readiness_surveys -> lead_events (run against prod 2026-11-05).
--
-- readiness_surveys already holds every survey AND event-roster submission in
-- Supabase (contact_id, ghl_contact_id, submission_id, submitted_at), so no GHL
-- pull is needed for history. survey_type 'event_roster*' rows are EVENT
-- registrations, not readiness surveys, so they map to event_registered/event;
-- the rest map to survey_submitted/survey. Idempotent via record_lead_event's
-- conflict key, so re-running is safe.
--
-- NOTE on ongoing capture: per sync-contacts.js, the GHL workflow that populates
-- readiness_surveys is slated to retire, so this table stops gaining new rows.
-- Ongoing survey/event ingestion should come from a GHL /surveys/submissions pull
-- (surveys.readonly scope is already granted) mirroring sync-form-submissions.js.

select count(*) as events_written from (
  select record_lead_event(
    p_event_type => case when rs.survey_type like 'event_roster%' then 'event_registered' else 'survey_submitted' end,
    p_source_system => 'ghl',
    p_source_record_id => coalesce(rs.submission_id, rs.id::text),
    p_occurred_at => coalesce(rs.submitted_at, rs.created_at, now()),
    p_phone => c.phone,
    p_ghl_contact_id => coalesce(rs.ghl_contact_id, c.ghl_contact_id),
    p_email => c.email,
    p_channel => case when rs.survey_type like 'event_roster%' then 'event' else 'survey' end,
    p_entry_point => case when rs.survey_type like 'event_roster%' then 'event' else 'survey' end,
    p_metadata => jsonb_build_object('survey_id', rs.survey_id, 'survey_name', rs.survey_name, 'survey_type', rs.survey_type)
  ) as ev
  from readiness_surveys rs
  left join contacts c on c.id = rs.contact_id
  where lower(coalesce(rs.full_name, '')) <> 'testing'
) t;
