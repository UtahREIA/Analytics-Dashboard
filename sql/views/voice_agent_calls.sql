-- v_voice_agent_calls
-- Resolving view over voice_agent_calls.
--
-- Why: Lani dual-writes each call to Supabase (voice_agent_calls) and to GHL
-- (contact custom fields) via structured outputs, but it does NOT write
-- ghl_contact_id back onto the Supabase row. So calls land with
-- ghl_contact_id = null and are not joinable to contacts/members.
--
-- This view resolves the contact on the fly by matching the last 10 digits of
-- caller_phone against contacts.phone, so every call (past and future) is
-- joinable without re-running a backfill. Prefers a stored ghl_contact_id if
-- one is already present.
--
-- Flags:
--   is_test       - record is a NAMED test fixture (house rule: exclude from counts)
--   phone_unknown - no usable caller id ('<UNKNOWN>' web-widget call); unmatchable
--
-- Applied via Supabase migrations create_v_voice_agent_calls +
-- fix_v_voice_agent_calls_is_test (2026-11-09). See memory lani-already-syncs-to-ghl.

create or replace view v_voice_agent_calls as
with norm as (
  select
    v.*,
    nullif(right(regexp_replace(coalesce(v.caller_phone,''), '\D', '', 'g'), 10), '') as phone_last10
  from voice_agent_calls v
)
select
  n.*,
  coalesce(n.ghl_contact_id, c.ghl_contact_id) as resolved_ghl_contact_id,
  c.full_name                                  as contact_full_name,
  c.ghl_membership_status                      as contact_membership_status,
  (coalesce(n.caller_name,'') ~* '\mtest'
     or coalesce(c.full_name,'') ~* '\mtest')  as is_test,
  (n.caller_phone = '<UNKNOWN>'
     or n.phone_last10 is null)                as phone_unknown
from norm n
left join lateral (
  select ghl_contact_id, full_name, ghl_membership_status
  from contacts
  where n.phone_last10 is not null
    and nullif(right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 10), '') = n.phone_last10
  order by ghl_contact_id
  limit 1
) c on true;
