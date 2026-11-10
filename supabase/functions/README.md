# Supabase edge functions

Phase-2/3 activity + attribution feeds. All pull **read-only** from GHL (reusing
the `GHL_API_KEY_CALL_LOGS` private-integration token) on the operational location
`DNirEjy0ejVwbHsaBYrn`, and write to Supabase with the service role. No message
bodies are stored.

| Function | Reads | Writes | pg_cron |
|---|---|---|---|
| `sync-ghl-messages` | Conversations API (SMS + social DMs) | `ghl_message_logs` (+ `ghl_message_sync_state` watermark) | `sync-ghl-messages-every-30-min` → `7,37 * * * *` |
| `sync-ghl-appointments` | Calendars API (events per calendar) | `ghl_appointments` | `sync-ghl-appointments-daily` → `20 10 * * *` |
| `sync-ghl-opportunities` | Opportunities API (search + pipelines) | `ghl_opportunities` | `sync-ghl-opportunities-daily` → `40 10 * * *` |
| `sync-ghl-attribution` | Contacts search (`lastAttributionSource`) | `ghl_contact_attribution` | `sync-ghl-attribution-daily` → `50 10 * * *` |

Tables are created by the migrations in `../migrations/` (`*_create_ghl_message_logs.sql`,
`*_create_ghl_appointments.sql`, `*_create_ghl_opportunities.sql`,
`*_create_ghl_contact_attribution.sql`).

Each function supports `?probe=1` (opportunities/attribution) to sample the live
GHL response shape without writing. Opportunities resolves pipeline + stage names
from `/opportunities/pipelines` and denormalizes them onto each row. Contacts
search is paginated with the per-contact `searchAfter` cursor (GHL's page-based
paging caps near 2,700), and attribution is upserted per page so a disconnect
can't lose the run.

## Required edge-function secrets (names only — set in Supabase, never commit values)

- `GHL_API_KEY_CALL_LOGS` — GHL private-integration token. Scopes needed:
  `conversations.readonly`, `conversations/message.readonly`, `users.readonly`,
  `calendars.readonly`, `calendars/events.readonly`, `opportunities.readonly`,
  and `contacts.readonly`.
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## pg_cron setup

The schedules call each function over HTTP with the project's anon JWT as the
Bearer token. Create them from the SQL editor (substitute the real anon key; do
not commit it):

```sql
-- runs the SMS/DM sweep at :07 and :37 past the hour
select cron.schedule('sync-ghl-messages-every-30-min', '7,37 * * * *', $$
  select net.http_post(
    url     := 'https://kttzxjddtkgsitzehiid.supabase.co/functions/v1/sync-ghl-messages',
    headers := '{"Authorization":"Bearer <SUPABASE_ANON_KEY>","Content-Type":"application/json"}'::jsonb
  );
$$);

-- re-pulls the appointments window once a day at 10:20
select cron.schedule('sync-ghl-appointments-daily', '20 10 * * *', $$
  select net.http_post(
    url     := 'https://kttzxjddtkgsitzehiid.supabase.co/functions/v1/sync-ghl-appointments',
    headers := '{"Authorization":"Bearer <SUPABASE_ANON_KEY>","Content-Type":"application/json"}'::jsonb
  );
$$);

-- re-pulls all opportunities once a day at 10:40
select cron.schedule('sync-ghl-opportunities-daily', '40 10 * * *', $$
  select net.http_post(
    url     := 'https://kttzxjddtkgsitzehiid.supabase.co/functions/v1/sync-ghl-opportunities',
    headers := '{"Authorization":"Bearer <SUPABASE_ANON_KEY>","Content-Type":"application/json"}'::jsonb
  );
$$);

-- re-pulls all contact attribution once a day at 10:50 (give it the full timeout)
select cron.schedule('sync-ghl-attribution-daily', '50 10 * * *', $$
  select net.http_post(
    url     := 'https://kttzxjddtkgsitzehiid.supabase.co/functions/v1/sync-ghl-attribution',
    headers := '{"Authorization":"Bearer <SUPABASE_ANON_KEY>","Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
```

## Notes

- **DMs:** none exist in GHL currently; the message sync picks them up if any appear.
- **Emails:** this GHL token has no email-reporting API access, so emails are not
  synced here and are left off the dashboard until a working source is found.
- **Appointment show/no-show:** GHL is not marking `showed` / `noshow` in this
  data — statuses seen are `confirmed` / `cancelled` / `invalid`.
- **Opportunities:** 4 pipelines hold live deals; most are `open` (few `won`,
  `lost` is unused). TEST records are excluded at the dashboard layer, not here.
- **Attribution (lead source):** GHL records social leads as one `Social media`
  bucket (plus `Paid Social`) — it does **not** split Facebook/Instagram/LinkedIn/
  etc., so the dashboard shows a single "Social media" group. Most contacts are
  `CRM UI` (staff/manual) or `Direct traffic`; ~half are untracked.
