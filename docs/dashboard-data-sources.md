# Dashboard data sources

Every number on the Utah REIA analytics dashboard is backed by a Supabase table or
view — nothing is hand-entered or dashboard-only. This maps each dashboard section to
its backing object and how that object is kept current.

Two Supabase projects are involved:
- **Main** — `kttzxjddtkgsitzehiid` (contacts, events, GHL feeds, GA4)
- **Social** — `oeraqcuithvmeyljuzbd` (Metricool-fed social analytics)

> The dashboard reads **snapshots**, not live Supabase. Each panel loads a JSON file
> exported from these objects; the data lives in Supabase and is current there, but the
> dashboard shows the last export and needs a re-snapshot to pick up new rows. (The
> dashboard artifact's only live-query connector is BigQuery, which this project does not
> use, so Supabase is exported to JSON blobs instead.)

## Main project (`kttzxjddtkgsitzehiid`)

| Dashboard section | Backing object | How it's populated |
|---|---|---|
| Leads · funnel · headline KPIs | `leads`, `lead_events`, `contacts` | GHL webhook + syncs |
| Members & lapsed | `contacts` → `v_members` | `ghl-webhook` edge fn (contacts sync) |
| Membership types & status | `v_membership_by_type`, `v_membership_summary` | from `contacts` membership fields |
| Conversions (lead → member) | `v_conversion_summary`, `v_conversion_by_source` | `contacts` + `ghl_contact_attribution` |
| UTMs & paid ads | `ghl_contact_attribution` → `v_utm_summary`, `v_paid_ads_summary` | `sync-ghl-attribution` edge fn (daily) |
| Emails (sent/delivered/failed) | `ghl_email_campaigns` → `v_email_campaign_stats`, `v_email_totals` | `sync-ghl-emails` edge fn |
| Events by name / attendance | `event_attendance` | GHL (contacts sync) |
| Website traffic (GA4) | `ga4_daily` | `api/sync-ga4.js` (Vercel cron) |
| Website top pages | `ga4_page_daily` → `v_ga4_top_pages_30d` | `api/sync-ga4.js` |
| Phone calls | `ghl_call_logs` | `sync-ghl-calls` edge fn (30 min) |
| Texts (SMS) | `ghl_message_logs` | `sync-ghl-messages` edge fn (30 min) |
| Appointments | `ghl_appointments` | `sync-ghl-appointments` edge fn (daily) |
| Opportunities | `ghl_opportunities` | `sync-ghl-opportunities` edge fn (daily) |

## Social project (`oeraqcuithvmeyljuzbd`)

| Dashboard section | Backing object | How it's populated |
|---|---|---|
| Social analytics (by platform) | `evolution_daily` | Metricool pull |
| Reels / short-form video | `post_snapshots` → `v_reels`, `v_reels_summary` | Metricool pull |

## Freshness notes (affect currency, not existence)

- **Membership inactive dates** — `ghl-webhook` v21 captures `membership_inactive_date`,
  but ~1,061 existing contacts need a full resync to backfill (run `sync-contacts?full=1`).
- **Email sync cron** — `ghl_email_campaigns` is populated, but a daily `pg_cron` job for
  `sync-ghl-emails` still needs to be scheduled (see function header).
- **UTM/attribution** — `utm_campaign` + paid-ad fields backfill on the next
  `sync-ghl-attribution-daily` run (existing rows predated the mapping).

## Known data gaps (not yet in Supabase)

- **Email opens / clicks** — not in GHL's v2 API (no statistics endpoint); only
  sent/delivered/failed are available.
- **Per-event registration** (vs attendance) — `lead_events.event_registered` records the
  generic registration survey, not which specific event. Only `event_attendance` ties
  people to a named event, so the dashboard breaks down *attendance* by event.
- **YouTube per-video Shorts metrics** — the social pull writes
  `{"note":"performance metrics unavailable"}` for YouTube posts. Channel-level YouTube
  (video views, subscribers) IS in `evolution_daily`; Metricool exposes the per-video
  metrics, so this is a pull fix in the social repo.
