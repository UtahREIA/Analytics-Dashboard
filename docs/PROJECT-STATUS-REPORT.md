# Utah REIA Analytics Dashboard — Project Status Report

**Prepared by:** David Igberi (web developer / technical lead)
**Date:** November 12, 2026
**Rock window:** November 2 – December 30, 2026
**Repo:** `UtahREIA/Analytics-Dashboard` (public)
**Live dashboard:** https://analytics-dashboard-beta-three.vercel.app/dashboard.html

---

## 1. Executive summary

We set out to put **every key Utah REIA number in one place**, answering four questions:

- How many leads come in, and from where?
- Which leads become members, and how long does it take?
- Which channels and campaigns work best?
- Where do we lose people?

**Where we are:** the core is built and running. Supabase is the single source of truth, every major data source now feeds it automatically on a schedule, and a **live, auto-updating dashboard** reads those numbers directly — no manual refresh, no copy-paste. A data-health monitor watches every feed and emails us if anything stops.

In short: **Phase 1 and Phase 2 are essentially complete, and Phase 3 (the dashboard) is live and expanding.** The remaining work is additional breadth (more GHL detail) and closing a handful of *upstream* data-entry gaps that only Utah REIA staff can fill (e.g. UTMs on campaign links, membership expiration dates in GHL).

---

## 2. The core architectural decision

**Supabase is the one place all numbers land. The dashboard reads only from Supabase.**

Previously GHL, Airtable, Vapi, Supabase, and GA4 each used different IDs, so the same person couldn't be matched across systems. The fix is a shared match key:

1. `phone_last10` (last 10 digits of the phone number) — primary match
2. `ghl_contact_id` — kept on every lead, used as fallback
3. `email` — last fallback for phone-less contacts (DMs, email-only)

Everything downstream (funnel, conversion, attribution) relies on this.

```
Sources                         Landing (Supabase)        Output
-------                         ------------------        ------
Vapi (Lani) end-of-call  --->   contacts / leads          SQL views
GHL webhooks + API pulls  --->   lead_events         --->  Live dashboard
Airtable (calcs, listings)--->   GHL mirror tables         (Vercel page)
GA4 + social daily pull  --->    summary tables            Data-health monitor
```

---

## 3. What we built

### 3.1 Data model (Supabase, project `kttzxjddtkgsitzehiid`)

**Core tables**
- `contacts` (~4,600) — one row per person; the match-key hub, with membership status/type/dates.
- `leads` / `lead_events` — forward-looking, event-sourced lead tracking (one row per person, one row per thing that happens; a unique key prevents double-counting on re-sync).

**GHL mirror tables (synced from GHL, read by the dashboard)**
- `ghl_message_logs` (~5,100) — SMS, inbound/outbound, delivery status
- `ghl_appointments` — calendar bookings
- `ghl_opportunities` (~830) — pipeline deals with pipeline/stage names
- `ghl_contact_attribution` (~4,600) — lead source + UTM fields
- `ghl_email_campaigns` — per-campaign sent/delivered/failed
- `ghl_workflows` (210) — the full automation inventory
- Custom-object mirrors: `ghl_vendor_resources`, `ghl_educators_mentors`, `ghl_educational_courses`, `ghl_tools_resources`, `ghl_upcoming_events`

**Summary tables (totals, not people)**
- `ga4_daily` — sessions by channel per day
- `ga4_page_daily` — top page views per day
- Social metrics live in a separate Supabase project (Metricool-fed), read live by the dashboard

### 3.2 Automated data feeds

Every feed runs on its own schedule — nothing is refreshed by hand.

| Feed | Mechanism | Schedule |
|---|---|---|
| GHL calls | pg_cron → edge fn | every 30 min |
| GHL messages / SMS | pg_cron → edge fn | every 30 min |
| GHL appointments | pg_cron → edge fn | daily |
| GHL opportunities | pg_cron → edge fn | daily |
| GHL attribution / UTMs | pg_cron → edge fn | daily |
| GHL emails | pg_cron → edge fn | daily |
| GHL workflows | pg_cron → edge fn | daily |
| Contacts + 6-table fan-out | Vercel cron → `ghl-webhook` | daily (08:00) + live webhooks |
| Form submissions / surveys | Vercel cron | daily (09:00) |
| GA4 traffic + top pages | Vercel cron | daily (10:00) |
| Social (followers, reels) | Metricool pull (social project) | daily |

Plus **live GHL webhooks** (forms, surveys, events, membership changes) hit `ghl-webhook` in real time, and **Lani (the voice agent)** dual-writes call data to both Supabase and GHL at end-of-call.

A **GitHub Actions backstop** re-hits every sync endpoint daily in case a primary cron misses.

### 3.3 The live dashboard

- **Served at** https://analytics-dashboard-beta-three.vercel.app/dashboard.html
- **How it stays live:** a server endpoint (`api/dashboard-data.mjs`) reads the Supabase views with a secure server-only key and returns one JSON payload; the page fetches it on load and **auto-refreshes every 5 minutes**, showing a live "updated" timestamp.
- **Security/privacy:** the service key never reaches the browser; the deployment can be kept behind access protection. Member rosters show **names only** — no phone or email.

**Panels currently live:**
- Headline KPIs (leads, members, conversion %, days-to-member, engaged, Lani calls) with click-to-explain
- **Data health** (per-feed green/red status)
- Conversions — leads → members, filterable by year / month / week / day
- Weekly scorecard
- Website traffic (GA4) by channel + **Top pages**
- New leads per week by channel
- Event attendance (per-event roster)
- Texts (SMS), Appointments, Opportunities
- Emails (per-campaign), UTMs & sources
- Social channels + Reels / short-form video
- Calculator usage, Lani calls, Membership by type, Top campaigns by members
- **Active / Expiring / Inactive member rosters** (by name, with dates, searchable)
- **GHL workflows** inventory (searchable, published/draft)
- Directories: Vendor partners, Educators & mentors, Education library, Tools & resources, Event lineup

### 3.4 Data-health monitoring

- `v_data_health` view gives a per-feed heartbeat — *did the sync run recently* (from the cron run history), not *when data last changed*, so a quiet feed with no new rows doesn't false-alarm.
- `api/health.js` returns HTTP 200 when all feeds are fresh, 503 if any is stale.
- A **GitHub Action checks it every 3 hours** and emails us if anything goes stale — the alert, with no extra infrastructure.
- Latest audit (Nov 11): **all 10 feeds healthy.**

---

## 4. What the numbers currently show

Representative figures (as of early–mid November 2026; they move as data flows):

- **~4,600 contacts** in the system.
- **Conversion:** roughly **30% ever became members**, **~7% are currently active** — a big gap worth watching.
- **Source attribution:** about **three-quarters of leads have no captured source** ("unknown"). This is the single biggest data-quality limiter and is an *upstream* capture gap (see §6).
- **Members:** ~1,400 total — **319 active, 38 expiring (renewal due), ~1,040 inactive.**
- **Automations:** **210 GHL workflows** (131 published, 79 draft).
- **Lani (voice agent):** still pre-launch; mostly internal test calls, treated as a baseline.

---

## 5. Key decisions, fixes, and lessons

- **Lani already syncs to GHL.** We confirmed the voice agent dual-writes call data to GHL itself (via structured outputs), so a separate Supabase→GHL sync and its backstop were unnecessary — closed as already-done, saving build time.
- **Keyless voice-lead dedup bug (fixed).** A lead-resolver was minting ~32 un-dedupable orphan leads per day (258 junk rows). Fixed at the source.
- **Event attendance frozen at May 2026 (fixed).** GHL checkbox fields come back as arrays (`["Attended"]`); our filter only matched scalars. Fixed in `ghl-webhook` v22 and backfilled — attendance now current.
- **Conversion/roster accuracy.** Several dashboard views had to run as "definer" so the live reads could see joined tables; and large lists must page past the database's 1,000-row cap ordered by a unique column (a subtle double-count trap we hit and fixed).
- **Security hardening.** `ga4_page_daily` was the only table left world-readable/writable; we enabled row-level security to match every other table.
- **Membership status vocabulary.** GHL stores `Active / Inactive / Renewal Pending / Cancel Membership`. Per the business vocabulary, the dashboard now shows **Active / Expiring / Inactive** ("Renewal Pending" → "Expiring"; cancellations folded into Inactive).

---

## 6. Known gaps (most require upstream action, not more code)

These limit the numbers' completeness and are **business/data-entry decisions**, not dashboard bugs:

1. **UTM capture is sparse.** Most campaign links aren't tagged, so ~76% of leads show source "unknown." Fixing this means tagging live links (GHL funnel pages) with UTMs. Capture improves attribution across the whole dashboard.
2. **Membership expiration dates barely entered in GHL.** Only **47 contacts system-wide** have an expiration date on file, so the "Expires" column is blank for ~97% of members. The data is accurate — GHL simply doesn't have it. Needs staff to enter it (or a decision that it isn't tracked).
3. **GHL API has no workflow run counts.** We can show *what* automations exist and their status, but not *how many contacts* went through each — the API doesn't expose it. Per-workflow volume would require instrumenting individual workflows to emit events.
4. **Email opens/clicks aren't in GHL's API.** We report sent / delivered / failed (deliverability ~98%); opens and clicks aren't available.
5. **Old data with no source** shows as "unknown" until tracking matures.

---

## 7. Plan status

**Phase 1 — Setup & checklist (due Nov 13): essentially complete.**
Repo created; definitions confirmed; data sources verified; UTM capture audited (gaps identified, upstream).

**Phase 2 — Tables & data feeds (due Dec 4): complete.**
`leads`/`lead_events` live; GA4 + social summary tables built; all source feeds cron'd and idempotent; GHL webhook endpoint live; Airtable backfill + scheduled pull running; Lani sync confirmed already handled.

**Phase 3 — Dashboard (due Dec 23): live and expanding.**
SQL views built; live auto-updating dashboard with the top numbers plus messages, appointments, opportunities, emails, UTMs, social, workflows, and member rosters; data-health monitoring added.
*Remaining:* review with Chris; continue adding GHL depth (opportunities drill-down, custom objects, deeper message/email detail as it becomes available).

---

## 8. Recommended next steps

1. **Review the live dashboard with Chris** and confirm the headline definitions and weekly numbers he wants front-and-center.
2. **Close the UTM gap** on live campaign links — the highest-leverage data-quality fix (shrinks "unknown" source dramatically).
3. **Decide on membership expiration tracking** — either start entering expiration dates in GHL or formally de-scope that column.
4. **Keep the dashboard behind access protection** given it surfaces member names.
5. Continue adding GHL breadth (calls/texts/emails/DMs/appointments detail, opportunities, workflows) as prioritized.

---

*Supabase project `kttzxjddtkgsitzehiid` · GHL location `DNirEjy0ejVwbHsaBYrn` · all feeds auto-updating · data-health monitored.*
