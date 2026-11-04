# UTM capture audit

Phase 1 tasks: audit UTM capture at each entry point, then fix the gaps.
Checked against the plan doc §10 ("Lani widget, calculators, and listing page are the most likely
holes"). Status: ❌ no capture · ⚠️ partial · ✅ captured.

---

## Lani widget ❌ (no UTM capture)

**Code:** `UtahREIA/Voice-Agent-AI` → `public/index.html` (and `public/index-new.html`).

**Finding:** the widget captures **no attribution whatsoever**.
- Only URL param it reads is `debug=1` (`location.search`, line 521). No `utm_*`, `gclid`, `fbclid`,
  or `document.referrer` anywhere in the repo (grep confirmed).
- Vapi call `variableValues` carry only `liveContext`, `preCallPhone`, `caller_type`.
- `syncToGHL()` payload (line ~1036) = `{ first_name, last_name, email, phone,
  tags: ['Voice Agent Lead'] }`.

**Impact:** a lead who arrives from an ad/campaign and uses Lani is written to GHL (and
`voice_agent_calls`) with no source/medium/campaign — shows as "unknown" in the funnel's
"where did leads come from."

**Fix (for "Fix UTM capture gaps"):**
1. On page load, parse `location.search` for `utm_source/medium/campaign/content/term` (+ `gclid`,
   `fbclid`, `document.referrer`); persist to `sessionStorage`/`localStorage` so they survive the
   widget flow and any SPA navigation.
2. Add them to the `syncToGHL()` payload so the GHL webhook → contact/lead carries first-touch
   attribution.
3. Optionally inject into Vapi `variableValues` so they also reach the end-of-call write to
   `voice_agent_calls`.

**Process note:** this edits the Lani voice-agent pipeline → per CLAUDE.md it needs a "planned" row
in `voice_agent_tracker_log` + Chris's approval before the fix is applied. (This audit is
inspection only — no change made.)

---

## Calculators + Rehab Estimator ❌ (no UTM capture)

**Code:** per-tool GitHub repos — `UtahREIA/FixFlip-Calculator`, `UtahREIA/Wholesale-Calculator`,
`UtahREIA/Rehab-Estimator` (+ BRRRR/Rentals/Short-Term presumably similar; not all located as
separate repos yet).

**Finding (verified FixFlip-Calculator + Rehab-Estimator):** no attribution capture. No `utm_*`,
`location.search`, `gclid`, `fbclid`, or `document.referrer` in app code. The only `URLSearchParams`
uses are building POST bodies for reCAPTCHA verification (`api/verify-phone.js`, `api/check-keys.js`)
and image upload — not reading URL params. The phone-check writes member/trial + access date to
Airtable with no source/campaign.

**To close fully:** spot-check the remaining calculator repos (Wholesale/BRRRR/Rentals/Short-Term) —
they share the same `verify-phone` pattern, so almost certainly the same gap.

## Property & notes listing page ❌ (no UTM capture)

**Code:** `UtahREIA/Property-Listing`. **Finding:** no UTM capture — no `location.search`/`utm_*`/
`gclid` in app code (only dependency/node_modules noise and a form-body `URLSearchParams` in
`serverless/upload-image.js`).

---

## Summary

**All three flagged entry points capture zero UTM/attribution** — the plan doc's §10 suspicion is
confirmed across the board. Every Lani/calculator/listing lead currently reaches GHL/Airtable with no
source, medium, or campaign, so they land as "unknown" in the funnel's channel/campaign views.

**The fix is the same pattern everywhere** ("Fix UTM capture gaps" task):
1. On page load, read `utm_source/medium/campaign/content/term` (+ `gclid`, `fbclid`, referrer) from
   `location.search`; persist to `sessionStorage`/`localStorage`.
2. Include them in whatever each entry point already POSTs (Lani `syncToGHL`, the calculator
   phone-check, the listing add/contact/subscribe calls).
3. Make sure they flow through to the `lead_events`/`leads` first-touch columns once those exist.

Separately, `UtahREIA/UTM-Tracking` exists but is for tracking educator-purchase engagement, not
entry-point capture — not a substitute for the above.

**Note:** Lani is the one with an approval gate (CLAUDE.md: tracker row + Chris) before its fix;
the calculator/listing fixes are ordinary app changes.

---

## Fix status (2026-11-03)

### Calculators — code done

`UtahREIA/FixFlip-Calculator` hosts Fix & Flip, BRRRR, Rental, and Short-Term. Each page now
captures `utm_*` / `gclid` / `fbclid` / `referrer` from the landing URL on load (first-touch wins,
stored in `sessionStorage`) and forwards them as `utms` in the existing `/api/track-event` POST.
`api/track-event.js` accepts `utms` and spreads it into the GHL inbound-webhook body.

- Fix & Flip: merged to `main`.
- BRRRR / Rental / Short-Term: branch `feat/utm-capture-remaining` (PR pending).
- BRRRR carries UTMs on both `calculator_access` (unlock) and `finish_analysis`; the others on
  `finish_analysis`.
- `fixflip-first.html` is a legacy variant (uses `action: 'calculator_accessed'`, not the deployed
  `event` shape) — left untouched.

**Wholesale** (`UtahREIA/Wholesale-Calculator`): same architecture as Fix & Flip (own
`api/track-event.js` + a `finish_analysis` POST). Full mirror applied — branch `feat/utm-capture`
(PR pending). Same GHL workflow-mapping step applies.

**Rehab Estimator** (`UtahREIA/Rehab-Estimator`): **no repo change — no seam exists.** The page is a
gated tool: `verify-phone.js` only checks subscription status, and the subscription (the actual
lead) is created upstream in GHL, which posts to `subscribe.js` (a GHL→Vercel receiver). There is no
lead-creation POST on the page to attach UTMs to. Attribution for Rehab belongs on the **GHL
subscribe funnel** (GHL captures UTMs natively on its own forms/funnels) — a GHL-config item, not a
code change here.

**Property & notes listing** (`UtahREIA/Property-Listing`): `add-property.html` (seller posts a
property, with name/email/phone) is the real lead seam. Frontend instrumented — branch
`feat/utm-capture` (PR pending): captures UTMs on load and forwards `utm_*` on submit under their
intended Airtable column names. **But** `add-property.js` silently drops any field outside its
whitelist (guards against Airtable 422s), so nothing persists yet. To complete:
1. Add columns `UTM Source` / `UTM Medium` / `UTM Campaign` / `UTM Content` / `UTM Term` to the
   Airtable **Properties** table.
2. Add those names to the whitelist in `add-property.js`.
3. Carry them through the Airtable → Supabase pull once `lead_events` exists.
(The buyer-side `contact-property.js` only emails the owner + marks "Contacted" — no lead store — so
there is nothing to persist there until a contact record is written somewhere.)

### GHL — fields created, workflow mapping still manual

Operational location: **`DNirEjy0ejVwbHsaBYrn`** ("Utah REIA" — where contacts/members/fields live;
CLAUDE.md's "main location" ID is not where the data is).

UTM contact fields (all TEXT, writable via inbound-webhook workflow):

| Incoming key | GHL field | Field key | ID |
|---|---|---|---|
| `utm_source`   | Last UTM Source   | `contact.last_utm_source`   | `oTUtW4V6JKyqoft8QClP` (created) |
| `utm_medium`   | Last UTM Medium   | `contact.last_utm_medium`   | `33lXNadBJ9Q29SfFLWTH` (created) |
| `utm_campaign` | Last UTM Campaign | `contact.last_utm_campaign` | `koTAWfR35FLvBT9vYyO4` (existing) |
| `utm_content`  | Last UTM Content  | `contact.last_utm_content`  | `Swu3X7BblDHT5dd9YGLk` (existing) |
| `utm_term`     | Last UTM Term     | `contact.last_utm_term`     | `GvuDaNMI9tD7o1GFaKGq` (created) |

(No GHL fields yet for `gclid` / `fbclid` / `referrer` — add later if paid-ad click IDs are wanted.)

**Manual step (David, in GHL UI)** — the inbound-webhook workflows behind
`GHL_FINISH_ANALYSIS_WEBHOOK_URL` and `GHL_CALCULATOR_ACCESS_WEBHOOK_URL`:
1. Trigger the webhook once with a real payload (run a calculator with `?utm_source=test&utm_medium=test`)
   so GHL captures the payload keys.
2. Add an **Update Contact Field** action to each workflow.
3. Map each field to its inbound property: `Last UTM Source = {{inbound_webhook.utm_source}}`, and the
   same for medium / campaign / content / term.
4. Save and publish.

Until the mapping is published, the calculators send the UTMs but nothing writes them onto the
contact. Fields are TEXT, so the v2-API SINGLE_OPTIONS write restriction does not apply.
