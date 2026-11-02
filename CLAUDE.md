# Utah REIA Analytics Dashboard

Owner: David Igberi (web developer and technical lead, Utah REIA)
Rock window: Nov 2 to Dec 30, 2026
Repo: UtahREIA/Analytics-Dashboard (public)
Tracking: Asana project "Analytics Dashboard (David's Rock)"

## What we are building

One dashboard that shows every key number for Utah REIA in one place.

It must answer:
- How many leads come in, and from where?
- Which leads become members, and how long does it take?
- Which channels and campaigns work best?
- Where do we lose people?

## The core decision

Supabase is the one place all numbers land. The dashboard reads only from Supabase.

Today GHL, Airtable, Vapi, Supabase, and GA4 each use different IDs. The fix is one shared match key:
1. `phone_last10` (last 10 digits of the phone number), primary match
2. `ghl_contact_id`, kept on every lead and used as fallback
3. `email`, last fallback for leads with no phone (DMs, email-only contacts)

## House rules

- The repo is public. Never put keys, tokens, or secrets in code, commits, logs, or output.
- Keys live in Vercel env vars and LastPass only. `.env.example` lists names with empty values.
- Give shell commands in PowerShell.
- Lead with the recommendation. Keep answers tight.
- Anything that needs a business decision goes to Chris. Flag it, do not assume it.
- Additive changes only on existing tables. Deactivate, do not delete.
- Verify against live Supabase and GHL data before assuming a column or value exists.
- Before changing anything in the Lani voice agent (for example `ghl-sync.js`), log a "planned" row in `voice_agent_tracker_log`. Tool changes need Chris's approval.

## Known gotchas

- GHL custom objects return 403 to outside servers (Vercel, Supabase edge functions). Read them from the nightly Supabase mirror.
- GHL SINGLE_OPTIONS dropdown fields cannot be written through the v2 Update Contact API. Use an inbound webhook workflow for those.
- GHL phone formats vary. Match on last 10 digits in Supabase, then use `ghl_contact_id`.
- Supabase upsert needs both the `Prefer: resolution=merge-duplicates` header and the `?on_conflict=<column>` URL parameter.
- GHL boolean fields on custom objects come back as arrays (`["true"]`).
- Records named TESTING or Testing are intentional test fixtures. Do not flag them. Exclude them from dashboard counts.
- Vercel Hobby cron runs at most once a day. GitHub Actions schedules can run late and are disabled on public repos after 60 days of no activity. Use them only as backstops.

## Architecture

```
Sources                         Landing                 Output
-------                         -------                 ------
Vapi (Lani) end-of-call  --->   Supabase                SQL views
GHL webhooks (forms,     --->     leads           --->  Dashboard
  surveys, events, etc.)          lead_events
Calculator / Rehab fns   --->     summary tables
Listing fns              --->     (GA4, social)
Airtable backfill + pull --->
GA4 + social daily pull  --->
                                   |
                                   v
                          Supabase -> GHL sync
                          (selected call fields)
```

### Supabase to GHL (call data)

1. Vapi end-of-call writes to Supabase first. Supabase is the source of truth.
2. A Supabase Database Webhook on insert into `voice_agent_calls` calls a Vercel function.
3. The function pushes selected fields to GHL:
   - Private integration token: plain contact fields, notes, tags.
   - Inbound webhook workflow: dropdown fields, custom objects, or anything that should trigger GHL automation.
4. A daily backstop cron retries rows where `ghl_synced_at` is null.

Open: Chris decides which call fields go to GHL.

## Data model

Two core tables. One for people, one for things that happen.

### leads (one row per person)

```sql
create table leads (
  id uuid primary key default gen_random_uuid(),
  phone_last10 text unique,
  ghl_contact_id text,
  email text,
  full_name text,
  caller_type text,         -- investor | vendor
  stage text,
  strategy text,
  first_touch_at timestamptz,
  first_source text,
  first_medium text,
  first_campaign text,
  entry_point text,         -- form | survey | voice | tool | listing | event
  member_status text default 'lead',  -- lead | trial | member | lapsed
  member_since timestamptz,
  created_at timestamptz default now()
);
```

First touch fields are set once and never change. `member_status` and `member_since` update as people move through the funnel.

### lead_events (one row per thing that happens, never edited)

```sql
create table lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id),
  occurred_at timestamptz not null,
  event_type text not null,
  source_system text not null,     -- ghl | vapi | airtable | ga4 | social | gmail
  source_record_id text not null,  -- the ID in the original system
  channel text,                    -- facebook | linkedin | form | survey | voice | calculator | listing | event | direct
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  landing_url text,
  tool_name text,                  -- which calculator, if any
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  unique (source_system, source_record_id, event_type)
);

create index on lead_events (occurred_at);
create index on lead_events (event_type, occurred_at);
create index on lead_events (channel, occurred_at);
create index on lead_events (lead_id, occurred_at);
```

The unique key lets a sync run twice without double counting.

### Review before applying the migration

These are open design points, not decided yet:

1. **Repeat events.** The unique key drops the second occurrence of events that can repeat on the same record: `opportunity_stage_changed`, `workflow_entered`, `email_clicked`, `sms_replied`. For those, build `source_record_id` from the record ID plus the stage or timestamp.
2. **Leads with no phone.** `phone_last10` can be null. Define the fallback match (ghl_contact_id, then email) so these do not become duplicates.
3. **Existing `contacts` table.** Supabase already has a contacts table queried by last 10 digits. Decide whether `leads` extends it or replaces it. Avoid two sources of truth.
4. **Last touch.** The checklist wants last touch (what pushed them over the line), but `leads` has no last touch columns. Either add them or derive last touch from `lead_events` in a view.
5. **Indexes.** Consider indexes on `leads (ghl_contact_id)` and `leads (lower(email))` for the fallback matches.

### Summary tables (totals, not people)

Social and GA4 numbers are totals, so they do not go in `lead_events`. To be designed:
- `social_post_metrics`: one row per post per day (platform, post type, impressions, reach, likes, comments, shares, saves, link clicks, video views).
- `social_account_daily`: followers and profile visits per account per day.
- `ga4_daily`: sessions by channel and landing page per day.

## Event types

Starting set:

`lead_created`, `form_submitted`, `survey_submitted`, `call_completed`, `matches_returned`, `no_match`, `sms_sent`, `sms_clicked`, `calculator_unlocked`, `analysis_finished`, `trial_started`, `trial_expired`, `member_activated`, `member_cancelled`, `listing_posted`, `listing_inquiry`, `event_registered`, `event_attended`, `vendor_enrolled`, `partner_referral_sent`

Messages and GHL (phase 2):

`call_inbound`, `call_outbound`, `call_missed`, `sms_delivered`, `sms_failed`, `sms_replied`, `sms_opted_out`, `email_sent`, `email_delivered`, `email_clicked`, `email_bounced`, `email_unsubscribed`, `email_replied`, `dm_received`, `appointment_booked`, `opportunity_created`, `opportunity_stage_changed`, `opportunity_won`, `opportunity_lost`, `workflow_entered`, `workflow_completed`, `social_post_engaged`

Exclude verification code emails from email counts.

## Data sources and how each gets in

| Source | Where it lives | How it gets in |
|---|---|---|
| Lani voice agent | Vapi, `voice_agent_calls` | End-of-call write to `lead_events` |
| Website forms | GHL | GHL workflow webhook to Vercel function |
| Surveys | GHL, Airtable Deal Access Requests | GHL webhook; Airtable backfill then scheduled pull |
| Events | GHL | GHL workflow webhook |
| Calculators (5) | Airtable Verifications | Existing phone-check functions also write an event |
| Rehab Estimator | Airtable subscribers | Same as calculators |
| Property and notes marketplace | Airtable (3 bases) | Add, contact, and expiration functions also write an event |
| Phone calls, texts, emails, DMs | GHL conversations, Gmail | Pull from conversation history (phase 2) |
| Opportunities | GHL pipelines | Webhook or pull (phase 2) |
| Workflows | GHL | Likely each workflow sends an event on enter and finish, since GHL probably does not expose counts. Verify. |
| Custom objects | GHL, nightly mirror in Supabase | Read from the mirror |
| Appointments | GHL calendars | Webhook (phase 2) |
| Social | Social Media Analytics in Supabase, GHL social planner | Daily pull into summary tables |
| Direct, organic, referral | GA4 | Daily pull into summary table |

## Known gaps to fix first

- **UTM capture.** Check every entry point saves UTMs. Likely holes: Lani widget, calculators, listing page.
- **No shared ID.** Solved by `phone_last10` plus fallbacks above.
- **GHL custom objects 403.** Use the nightly mirror.
- **Old data with no source.** Shows as "unknown" until tracking starts.

## First dashboard views

Plain SQL views on top of the tables:
1. Leads per week by channel
2. Funnel: lead, engaged, trial, member
3. Days from first touch to member
4. Top campaigns by members, not just leads
5. Lani calls, match rate, and no-match needs
6. Calculator uses and trial to member rate

Build the top 10 numbers first. Messages, workflows, opportunities, and social come after.

## Plan and Asana tasks

### Phase 1: Setup and checklist (Weeks 1 to 2, due Nov 13)
- [x] Create GitHub repo
- [ ] Get Chris's definitions: lead, member, engaged, and weekly numbers
- [ ] Get live campaigns and links from Harmonie
- [ ] Get forms and surveys in use from Angela
- [ ] Verify what each source really returns
- [ ] Audit UTM capture: Lani widget
- [ ] Audit UTM capture: calculators and Rehab Estimator
- [ ] Audit UTM capture: property and notes listing page
- [ ] Fix UTM capture gaps

### Phase 2: Tables and data feeds (Weeks 3 to 5, due Dec 4)
- [ ] Draft Supabase migration for `leads` and `lead_events`
- [ ] Create summary tables for GA4 and social
- [ ] Lani: Vapi end-of-call to Supabase, then sync to GHL
- [ ] GHL webhook endpoint on Vercel (forms, surveys, events)
- [ ] Event writes in calculator and Rehab Estimator functions
- [ ] Event writes in property listing functions
- [ ] Airtable backfill, then scheduled pull
- [ ] Daily GA4 and social pull
- [ ] Backstop retry cron for failed GHL syncs

### Phase 3: Dashboard (Weeks 6 to 8, due Dec 23)
- [ ] SQL views for first numbers
- [ ] Dashboard with top 10 numbers
- [ ] Review with Chris
- [ ] Add calls, texts, emails, DMs, appointments
- [ ] Add GHL opportunities, workflows, custom objects

## Waiting on others

- **Chris:** what counts as a lead, a member, and engaged; the numbers he checks weekly; which call fields go to GHL; OK on the repo being public.
- **Harmonie:** live campaigns and links, to check UTMs.
- **Angela:** forms and surveys in use today.

## Repo layout

```
supabase/migrations/   table SQL
api/                   Vercel functions (webhooks, syncs)
sql/views/             dashboard views
docs/                  checklist and table plan
```

## Key identifiers

- Supabase project: `kttzxjddtkgsitzehiid`
- GHL main location: `oMOSHj4e9WNfMfx8MkBo`
- GHL vendor object location: `DNirEjy0ejVwbHsaBYrn`
- Vercel team: `team_M9Gkv9YgPQAwYY7sJdS5uNj9`
- Lani repo: `UtahREIA/Voice-Agent-AI`
