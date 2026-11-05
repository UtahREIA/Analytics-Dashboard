-- Migration: sync_survey_events() — ongoing survey + event-roster ingestion.
-- Applied to prod 2026-11-05.
--
-- GHL has NO public survey-submissions API (the /surveys/ routes are rejected by
-- GHL's IAM), so surveys can't be pulled like forms. But survey + event-roster
-- submissions land in the readiness_surveys table (actively populated: 16 new rows
-- in the last 7 days). This function writes them to lead_events via
-- record_lead_event, idempotently, so the daily cron can call it with no GHL cost.
-- event_roster* -> event_registered/event; everything else -> survey_submitted/survey.
--
-- Called from api/sync-form-submissions.js after the form pull.
-- Note: it re-scans all readiness_surveys each run (idempotent). Fine at current
-- volume; add a watermark if that table grows large.

create or replace function public.sync_survey_events()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare n integer;
begin
  select count(*) into n from (
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
  return n;
end; $$;
