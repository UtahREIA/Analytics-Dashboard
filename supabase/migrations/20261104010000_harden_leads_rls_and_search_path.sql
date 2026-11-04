-- Migration: harden leads / lead_events to match the schema's security posture.
-- Applied to prod (kttzxjddtkgsitzehiid) 2026-11-04. Depends on 20261102000000,
-- 20261104000000. Clears the two Supabase security advisor ERRORs the initial
-- objects tripped, and the function search_path WARN.
--
-- Posture matches every other table here: RLS ENABLED with no policy, so anon /
-- authenticated are denied and the service role (used by all the data feeds and
-- the nightly syncs) bypasses. When the dashboard's read path is decided, add
-- SELECT policies for whatever role it uses.

alter table public.leads       enable row level security;
alter table public.lead_events enable row level security;

-- The view must enforce the querying user's RLS, not the creator's (fixes the
-- security_definer_view advisor on lead_last_touch).
create or replace view public.lead_last_touch with (security_invoker = true) as
select distinct on (e.lead_id)
  e.lead_id,
  e.occurred_at  as last_touch_at,
  e.event_type   as last_touch_event,
  e.channel      as last_touch_channel,
  e.utm_source   as last_touch_source,
  e.utm_medium   as last_touch_medium,
  e.utm_campaign as last_touch_campaign
from public.lead_events e
order by e.lead_id, e.occurred_at desc;

-- Pin search_path on the two functions (fixes function_search_path_mutable).
alter function public.resolve_lead(text,text,text,text,timestamptz,text,text,text)
  set search_path = public;
alter function public.record_lead_event(text,text,text,timestamptz,text,text,text,text,text,text,text,text,text,text,text,text,jsonb)
  set search_path = public;
