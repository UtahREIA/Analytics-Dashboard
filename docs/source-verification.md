# Source verification — what each source really returns

Phase 1 task "Verify what each source really returns" (Asana 1220128695355661, due Nov 11).
Checked against Part 1 of the planning doc. Status per source: ✅ verified · ⏳ pending · ⚠️ gap found.

Verified live on 2026-11-03.

---

## Lani voice agent — `voice_agent_calls` (Supabase) ✅ ⚠️

**Doc wants (§4):** calls/day, avg length, finished vs dropped, match rate + how often it finds
nothing, confidence spread (high/med/low), follow-up SMS sent/clicked, V1 vs V2.

**Columns that exist (27):** id, contact_id, ghl_contact_id, caller_name, caller_phone,
investor_stage, profile_type, path, tier, strategies[], blocker, goals, already_tried, summary,
vendor_matches, tool_matches, educator_match, booking_url, booking_required, stack_summary,
recommended_next, handoff_channel, vendor_contacted, vapi_call_id, call_duration_secs,
created_at, updated_at.

**Covered:** calls/day (`created_at`), avg length (`call_duration_secs`), match rate / "finds
nothing" (derive from `vendor_matches`/`tool_matches`/`educator_match` being empty), caller type
(`profile_type`/`investor_stage`), strategy (`strategies`, `path`, `tier`).

**⚠️ Gaps (and resolutions, verified against Vapi `get_call`):**
- **Finished vs dropped** — not in `voice_agent_calls`, but Vapi **does** return `status` +
  `endedReason` (sample: `ended` / `assistant-said-end-call-phrase`). The signal exists upstream;
  fix = add an `ended_reason`/`status` column and map it on the end-of-call write (Lani-pipeline
  change → `voice_agent_tracker_log` planned row + Chris approval, phase 2).
- **V1 vs V2** — Vapi returns `assistantId`; split old/new agent by that (no version column needed).
- **Confidence** — ✅ captured: it's the existing **`tier`** column (confirmed by David). Not a
  native Vapi field; it comes from Lani's own output. High/med/low spread can be built from `tier`.
- **Follow-up SMS sent/clicked** lives in GHL (SMS), not here — expected, cross-source.

---

## Website forms — GHL ✅ (list) ⏳ (UTM capture)

**Doc wants (§1):** form name, submit time, contact ID, UTMs.

**Returned by `ghl_get_forms` (appears capped at 10):** Paying guest - Meeting Funnel; Paying
guest - Meeting 5 Funnel; Utah REIA Potential Speaker Vetting Form; Free Guest Pass; Free Guest
Pass - Meeting Funnel; Member - Meeting Funnel; Investor Property Spotlight; Rent Perfect; sponsor
inquiry; Monthly Platinum.

**⚠️ Note:** exactly 10 returned — the tool looks capped, so this is likely **not the full list**.
Angela's task (forms in use today) should give the authoritative set; reconcile against it.

**⏳ Pending:** whether each form actually **captures UTMs** on submit — that's the UTM-capture audit
(separate Asana task). Submit time + contact ID are standard on GHL form submissions.

---

## Surveys — GHL ✅ (list) + Airtable Deal Access Requests ⏳

**Doc wants (§1):** survey name, calculator type, priority score.

**Returned by `ghl_get_surveys` (appears capped at 10):** Vendor Onboarding; Event Register New
(`ktDhoCZJC1erRWjzcJGB`); Vendor Assesment; Event Roster - 3/1/8 Virtual; Wholesaler Readiness
(`vnMfd0K5soW0Ob2yIO64`); Fix & Flip Readiness (`j60aT4pN9PyQON8Pnn9r`); Short Term Readiness
(`YGYxMg8ULW64gjhQDhP1`); Event Roster Old (`XgxEn2nsCdQAZtrV8PAp`).

**⚠️ Reconcile with the `ghl-webhook` edge function's `SURVEY_ID_TO_TYPE` map**, which also
references brrrr (`8CzJrtK4SZ8KuOFkpc9q`), buildscope (`59rKPVr4G72h4gLEiHfB`), rental
(`CmCuA7NQQSvbIHdpirxt`), path_to_success (`9RTgEIeNcHvWBZkqUZKl`) — none of these appear in the
top-10 returned here. Either the list is capped at 10 or those surveys are archived/renamed.
Get the full list (Angela) and confirm which readiness surveys are live.

**⏳ Pending:** Airtable "Deal Access Requests" side (priority score) — not yet checked.

---

## Membership signal (for the funnel) ✅ ⚠️

Chris's definitions (2026-11-03): **lead = any contact**, **member = paid + active member tag**.

**Verified against live data:**
- **Lead = any contact** → 4,590 contacts.
- **"Active member tag" is really the Status field, not a tag.** The literal GHL tag `active member`
  (`zmXyMLBmS5KSztW2byCI`) exists but has **0 contacts**. Membership is tracked by the GHL **Status
  custom field = "Active"** → **328** contacts, which is synced to Supabase as
  `contacts.ghl_membership_status`.
- So the funnel **member rule = `ghl_membership_status = 'Active'`** (328 ≈ 7.1% conversion).
  `membership_status = 'Active'` also = 328 and matches today.
- **Paid nuance:** only 289 of the 328 have `membership_fee > 0`; the other ~39 are Active without a
  fee (comped / board / JV). Decide whether "member" must also be paid. 419 contacts have a
  `membership_type`; 317 are both Active and typed.

**⚠️ Gap:** contact **tags are not synced to Supabase** (no tags column on `contacts`). Not needed
for the member rule (Status field covers it), but any future tag-based metric needs a tag sync.

---

## GHL — opportunities, calendars, workflows ✅ ⚠️

- **Opportunities** (`ghl_get_opportunities`): return name, stage, monetaryValue, status, contact,
  assignedTo, createdAt. ⚠️ On sampled rows the **`stage` is blank** (all $149 "membership" opps,
  status open, auto-created on signup). Pipeline/stage tracking looks thin — confirm whether stages
  are actually used before relying on "where leads get stuck."
- **Calendars** (`ghl_get_calendars`): 24 — team personal calendars, "1–9 Monthly Meetings",
  Vendor Partner, General Utah REIA, etc. Appointments source confirmed (phase 2).
- **Workflows** (`ghl_get_workflows`): ~180, returns only **id / name / status — NO enter/finish
  counts.** ✅ This answers the doc's open question: **GHL does not expose workflow counts**, so each
  workflow must emit an event on enter/finish (as the doc anticipated). Relevant workflows seen:
  "GHL <-> Claude AI via Supabase (Lani)", "Utah REIA Voice Agent Lead", "Vendor Review Outcome"
  (draft), "Set First Seen Date on New Contact" (first-touch), "Contact Source Facebook"/"TikTok"
  (source tagging).

## Already synced to Supabase (don't re-pull live) ✅

Found in the project DB — several sources the doc lists as phase-2 pulls are **already landing**:
- **`ghl_call_logs`** (17 cols) + `ghl_call_sync_state` → **phone calls already synced.**
- **`email_workflow_stats`** (14) + `email_stats_monthly_delta` → **email stats already summarized.**
- **`vendor_referrals`** (17) → partner referrals (doc §9).
- **`survey_definitions`** (5) → authoritative survey list — use this instead of the capped GHL API.
- `event_attendance` (9), `readiness_surveys`, `investor_profiles`, `vendor_profiles`, `tool_access`
  → the `ghl-webhook` fan-out.
- ⚠️ **No `social_*` or `ga4_*` tables** in this project — see Social/GA4 below.

## Airtable (15 bases) ✅ ⚠️

- **Calculators:** "Calculator Verfications" (`apps7R9r2huHG3pvG`) + 5 per-calculator "Verification
  Base" bases (Fix & Flip, BRRRR, Rentals, Short Term, Wholesale).
- **Rehab Estimator:** "Rehab Estimator Subscribers" (`appDzyTMc5MKGCPwu`) + "Subscriber Management".
- **Marketplace:** "Property Management", "property_listing", "Property Listings", "Note
  Marketplace" → ⚠️ the doc says **"3 bases" but there are 4** property/note bases. Confirm which
  are live vs legacy.
- **Deal Access:** "Deal Access System" (`appDv5cagOFElWPQD`) = the Deal Access Requests survey
  source.
- ("Utah REIA Content System/Logs" = content ops, not dashboard data.)

## Social & GA4 ✅ (separate systems)

- **Social analytics = a SEPARATE Supabase project** `oeraqcuithvmeyljuzbd`
  (https://oeraqcuithvmeyljuzbd.supabase.co), not the main `kttzxjddtkgsitzehiid`. Tables:
  `post_snapshots` (per-post), `evolution_daily` + `follower_growth` (per-account/day),
  `follower_demographics`, `hashtag_performance`, `reaction_breakdown`, `best_time_to_post`,
  `opusclip_projects_log`. Maps to the doc's planned `social_post_metrics` / `social_account_daily`.
  The dashboard pulls social from HERE (cross-project).
- **GA4:** account "Utah Real Estate Invest…" (`339006476`), property **utahreia.org =
  `528122699`** (the active/starred property). Second account "Utah REIA" (`387381298`) also exists.
  No GA4 tool in this environment, so the daily pull needs GA4 API credentials for property
  `528122699`.

## Surveys — resolved via `survey_definitions` ✅

`survey_definitions` holds **11 active surveys** (id → type), and fully matches the edge function's
`SURVEY_ID_TO_TYPE`: buildscope, brrrr, path_to_success, rental, event_roster_free, fix_flip,
event_roster, event_roster_virtual, wholesale, vendor, short_term. The capped GHL API list (10) was
just incomplete — nothing missing. **Use `survey_definitions` as the source of truth for surveys.**

## Confirmed by David 2026-11-03 ✅

- **Live Airtable bases** (the authoritative set the dashboard pulls):
  - Calculators (5 per-calc **Verification Base** bases): Fix & Flip `appgtWTvDczCtb1HF`,
    BRRRR `apprR3cZHurOc0Kvy`, Short Term `appZaQDCT0k0OuIUl`, Rentals `appDf8aWiO1PNa6se`,
    Wholesale `appBIKgoBA1p90H1V`. (So calculators write to these, NOT the combined "Calculator
    Verfications" base.)
  - Rehab Estimator Subscribers `appDzyTMc5MKGCPwu`.
  - Marketplace = **2 bases**: Property Listings `appvnc6bZuI2D2DSR` + Note Marketplace
    `appyrBjzJd9YNntBI`. (Not the "Property Management"/"property_listing" bases — those are legacy.)
- **GHL opportunity stages ARE used** — the blank-stage rows I sampled were just freshly
  auto-created opps not yet moved into a stage. Stage-based funnel tracking is viable.
- **Lani confidence IS captured** — yes, it's in `voice_agent_calls` (the `tier` column). The
  high/med/low spread can be built.
- **Social project** `oeraqcuithvmeyljuzbd` and **GA4 property** `528122699` — see section above.
