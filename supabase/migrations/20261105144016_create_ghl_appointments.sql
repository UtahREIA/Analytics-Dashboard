-- Appointments pulled from the GHL Calendars API (events per calendar) by the
-- sync-ghl-appointments function. Idempotent upsert on ghl_event_id; each run
-- re-pulls a window so status changes (showed/no-show/cancelled) correct in place.
create table if not exists public.ghl_appointments (
  ghl_event_id   text primary key,
  calendar_id    text,
  calendar_name  text,
  contact_id     text,
  contact_name   text,
  title          text,
  status         text,  -- appointmentStatus: new | confirmed | showed | noshow | cancelled | invalid
  start_at       timestamptz,
  end_at         timestamptz,
  date_added     timestamptz,
  assigned_user_id text,
  last_synced_at timestamptz default now()
);
create index if not exists ghl_appointments_start_idx on public.ghl_appointments (start_at);
create index if not exists ghl_appointments_cal_idx on public.ghl_appointments (calendar_id, start_at);
create index if not exists ghl_appointments_contact_idx on public.ghl_appointments (contact_id);
alter table public.ghl_appointments enable row level security;
