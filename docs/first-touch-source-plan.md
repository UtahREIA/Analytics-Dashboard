# Capturing each lead's original (first-touch) source

**For:** Chris (and the team) — in response to "GHL's source only shows how someone
entered GHL, not how they first found us. Capture that first source for every
contact and store it in Supabase."
**From:** David · 2026-11-18 · status: **working setup live + plan for the rest**

---

## Bottom line

You were right twice over. GHL's "source" is misleading **and**, for most contacts,
it's effectively empty — because they're created *inside* the CRM (imports, manual
adds, phone, portal, workflows), which never records where the person first came from.

I found that GHL actually keeps **two** attribution records per contact and we were
reading the wrong one, so I fixed the capture. But the honest ceiling is set upstream:
**~19% of contacts now resolve to a real origin; ~77% have no origin captured at all.**
Closing that gap is a data-entry problem at each entry point, not a dashboard problem.

---

## What was actually going on

Every GHL contact carries two attribution objects:

- `attributionSource` — **first touch** (how they first found us) ← what you asked for
- `lastAttributionSource` — **last touch** (most recent visit)

Our nightly sync stored only last-touch, and GHL often returns last-touch as an
empty `{}` that was hiding a populated first-touch. Reading the right object lifted
"has a first source" from ~24% to ~92% of contacts — **but** 80% of that is the label
`CRM UI`, which just means "created in the CRM," not a marketing source. Stripping that
out, the real split is:

| Where contacts come from | Share | Captured? |
|---|---|---|
| Created inside the CRM (import, manual, phone, portal, workflow) | ~77% | **No origin** — nothing to recover |
| Funnel / entry label (e.g. `facebook_group`, Guest Pass funnel, membership) | ~10% | Yes — readable |
| Real web bucket (Direct, Social media, Organic, Referral, Paid) | ~8% | Yes — coarse |
| Named platform via referrer (Google, LinkedIn, Facebook, Meetup, ChatGPT) | ~1.5% | Yes — precise |
| Tagged campaign (UTM) | ~0.6% | Yes — precise |
| Nothing at all | ~3.5% | No |

The key point for planning: **you cannot extract first-touch after the fact for the
77%.** It was never stamped. The only fix is to stamp a source at the moment each
contact is created, going forward.

---

## What I already shipped (live now, no one else needed)

1. **First-touch is now captured.** Added a `first_*` column set to
   `ghl_contact_attribution` (first session source, medium, UTMs, referrer, landing
   URL, ad IDs) plus `created_source` (GHL's own entry label, which is filled even
   when attribution is empty). The nightly sync (`sync-ghl-attribution`) now writes
   both first- and last-touch. Backfilled all 4,614 contacts. Additive only.

2. **The real platform is un-bucketed.** GHL lumps LinkedIn, Facebook, Instagram,
   Meetup, etc. under "Social media." The stored `first_referrer` host recovers the
   actual platform.

3. **One resolver view: `v_contact_first_source`.** One row per contact with a single
   best `first_source` and a `first_confidence` flag (`utm` > `referrer` >
   `session_bucket` > `entry_label` > `internal` > `unknown`), so reporting can show
   real marketing attribution separately from internal/untracked. `v_first_source_summary`
   rolls it up. These are what the dashboard should read for "where leads came from."

This is the "ideally a working setup" half: first-touch is captured and queryable today.

---

## The plan for the rest (the 77%) — needs a few decisions + access

The only way to raise the 19% is to capture a source at each entry point as contacts
are created. In priority order:

1. **UTM capture on every entry point** *(biggest lever).* When a link carries
   `utm_source`/`utm_campaign`, GHL records it as a precise first-touch automatically —
   today almost nothing does. Fix: add the UTM-persisting snippet to the GHL funnel
   pages (calculators, listing page, Guest Pass/meeting funnels, Lani widget page) and
   use tagged links in posts/emails/ads.
   *Needs:* GHL funnel-page access (me) + the live campaign/link list (Kingsley/Harmonie).

2. **Stamp an origin on non-web entries.** Lani (voice), the member portal, and bulk
   imports all land as `CRM UI`/`Other`. Each should set a contact source at creation:
   Lani → "Voice (Lani)"; portal → "Member portal"; each import → a named source.
   *Needs:* a decision on the source label per path; Lani change is logged + Chris-approved
   per house rules.

3. **Capture attribution at creation via the existing webhook** *(optional, richer).*
   The `ghl-webhook` fires when a contact is created; if the GHL workflow includes the
   attribution fields in its payload, we stamp first-touch instantly instead of waiting
   for the nightly pull.
   *Needs:* adding attribution custom-data to the webhook workflow in GHL.

---

## Decisions for Chris (flagging, not assuming)

1. **Canonical source taxonomy.** What buckets do you want to report in — e.g.
   Facebook, Instagram, YouTube, LinkedIn, Google (organic), Google (paid), Referral,
   Event, Direct, Voice/Lani, Internal/Import? I'll map everything to that list.
2. **Which entry points matter most** to tag first (calculators, listing page, events,
   Guest Pass funnel), so UTM work targets the highest-volume paths.
3. **Historical contacts.** The 77% internal have no origin and can't be recovered;
   OK to report them as "Internal / untracked" rather than chase them?

---

## Where it lives

- Table: `ghl_contact_attribution` (new `first_*` + `created_source` columns)
- Sync: `supabase/functions/sync-ghl-attribution` (writes first + last touch; daily)
- Views: `sql/views/first_touch_source.sql` → `v_contact_first_source`,
  `v_first_source_summary`
- Migration: `supabase/migrations/20261118000000_add_first_touch_attribution.sql`
