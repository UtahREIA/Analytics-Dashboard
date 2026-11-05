# Supabase edge functions

Phase-2 activity-layer feeds. Both pull **read-only** from GHL (reusing the
`GHL_API_KEY_CALL_LOGS` private-integration token) on the operational location
`DNirEjy0ejVwbHsaBYrn`, and write to Supabase with the service role. No message
bodies are stored.

| Function | Reads | Writes | pg_cron |
|---|---|---|---|
| `sync-ghl-messages` | Conversations API (SMS + social DMs) | `ghl_message_logs` (+ `ghl_message_sync_state` watermark) | `sync-ghl-messages-every-30-min` → `7,37 * * * *` |
| `sync-ghl-appointments` | Calendars API (events per calendar) | `ghl_appointments` | `sync-ghl-appointments-daily` → `20 10 * * *` |

Tables are created by the migrations in `../migrations/`
(`*_create_ghl_message_logs.sql`, `*_create_ghl_appointments.sql`).

## Required edge-function secrets (names only — set in Supabase, never commit values)

- `GHL_API_KEY_CALL_LOGS` — GHL private-integration token. Scopes needed:
  `conversations.readonly`, `conversations/message.readonly`, `users.readonly`,
  and (for appointments) `calendars.readonly` + `calendars/events.readonly`.
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
```

## Notes

- **DMs:** none exist in GHL currently; the message sync picks them up if any appear.
- **Emails:** this GHL token has no email-reporting API access, so emails are not
  synced here and are left off the dashboard until a working source is found.
- **Appointment show/no-show:** GHL is not marking `showed` / `noshow` in this
  data — statuses seen are `confirmed` / `cancelled` / `invalid`.
