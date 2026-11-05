-- Texts (SMS) + social DMs pulled from the GHL Conversations API by the
-- sync-ghl-messages edge function. Mirrors ghl_call_logs. No message bodies are
-- stored (privacy + size) — just channel, direction, status, contact and time,
-- which is all the dashboard counts need.
create table if not exists public.ghl_message_logs (
  ghl_message_id  text primary key,
  conversation_id text,
  contact_id      text,
  contact_name    text,
  channel         text,   -- sms | facebook | instagram | whatsapp | gmb | live_chat | webchat | custom
  message_type    text,   -- raw GHL messageType (TYPE_SMS, TYPE_FACEBOOK, ...)
  direction       text,   -- inbound | outbound
  status          text,   -- delivered | failed | ... (as GHL reports)
  message_at      timestamptz,
  user_id         text,
  user_name       text,
  from_addr       text,
  to_addr         text,
  last_synced_at  timestamptz default now()
);
create index if not exists ghl_message_logs_at_idx on public.ghl_message_logs (message_at);
create index if not exists ghl_message_logs_channel_at_idx on public.ghl_message_logs (channel, message_at);
create index if not exists ghl_message_logs_contact_idx on public.ghl_message_logs (contact_id);
alter table public.ghl_message_logs enable row level security;

-- Sweep/watermark cursor, mirror of ghl_call_sync_state.
create table if not exists public.ghl_message_sync_state (
  id               text primary key,
  watermark_ms     bigint,
  sweep_started_ms bigint,
  sweep_floor_ms   bigint,
  cursor_ms        bigint,
  locked_until     timestamptz,
  last_run_at      timestamptz,
  last_run_result  jsonb
);
alter table public.ghl_message_sync_state enable row level security;
insert into public.ghl_message_sync_state (id) values ('main') on conflict (id) do nothing;
