# UTM capture — fixing lead-source attribution

## The finding (why UTMs are nearly empty today)

Measured against live Supabase data (`ghl_contact_attribution`, 4,584 non-test contacts, 2026-11-09):

| Segment | Count | Share | Snippet can help? |
|---|---|---|---|
| No web attribution at all (no source, no medium) | 3,483 | 76% | **No** — imports, Lani voice, manual adds, pre-tracking. Never had a web session. |
| Channel captured, but **no UTM** on the link | 1,078 | 24% | Partly — needs the links tagged first |
| Any UTM present | 23 | <1% | — |

**Two conclusions:**

1. The 76% "unknown" bucket is **structural**, not a tracking bug. Those contacts never arrived through a trackable web page, so no front-end change can tag them. They will stay "unknown" by origin.
2. For the 24% that *do* arrive via web, GHL already records the **channel** (Direct / Organic / Social / Paid / Email) but **not the campaign**, because the links they clicked weren't UTM-tagged.

**So the #1 lever is link-tagging discipline, not code.** The snippet below is the supporting layer — it keeps UTMs from being lost once a tagged link lands. It cannot invent UTMs that were never on the link.

---

## Fix 1 (highest leverage): tag every campaign link — needs marketing sign-off

Every link Utah REIA puts in an email, social post, ad, or QR code should carry UTMs. This is a **marketing process change** (owners: Kingsley for ads/campaigns, Harmonie for live links) and the taxonomy needs Chris's/their approval — **flagged, not assumed.**

Proposed standard (for approval):

| Param | Value rule | Examples |
|---|---|---|
| `utm_source` | the platform, lowercase | `facebook`, `instagram`, `linkedin`, `youtube`, `email`, `eventbrite`, `meetup` |
| `utm_medium` | the type of link | `social`, `paid_social`, `cpc`, `email`, `bio`, `qr` |
| `utm_campaign` | the campaign, kebab-case | `brrrr-webinar-nov`, `membership-drive-q4`, `rehab-calculator-launch` |
| `utm_content` | optional A/B / placement | `story`, `feed`, `button-a` |

Example tagged link:
`https://utahreia.org/brrrr-lead?utm_source=facebook&utm_medium=paid_social&utm_campaign=brrrr-webinar-nov`

Keep source/medium/campaign lowercase and consistent — `Facebook` and `facebook` count as two campaigns in the dashboard. A shared link-builder (a pinned sheet or a bookmarked [Google UTM builder](https://ga-dev-tools.google/campaign-url-builder/)) prevents drift.

Paid ads (when Kingsley starts them) also auto-populate `ad_id` / `gclid` with no extra work — GHL captures those natively; the attribution sync already stores them.

## Fix 2 (supporting layer): the footer snippet

`docs/utm-capture.js` captures UTMs on landing, stores first- and last-touch in `localStorage`, and forwards the **first-touch** UTMs into forms, embedded GHL form/survey iframes, and internal links to the calculators / listing / booking / join pages — so the tool or form that finally submits carries the campaign across multi-step funnels.

First-touch is used deliberately: the `leads` model sets first-touch source once and never changes it.

### Deploy
1. GHL → **Settings → Custom Code → Footer** (site-wide), and/or per funnel: **Funnel → Settings → Tracking Code → Footer**.
2. Paste the full contents of `docs/utm-capture.js` wrapped in a `<script>` tag.
3. Save and publish each funnel that has the calculators, listing page, or lead forms.
4. Confirm it runs on: the Lani widget page, each calculator / Rehab Estimator page, and the property/notes listing page (the known capture holes).

### Verify (do this after deploying)
1. Open a page with a test UTM: `?utm_source=test&utm_medium=verify&utm_campaign=snippet-check`.
2. In DevTools console: `localStorage.getItem('ureia_utm_first')` → should show the values.
3. Navigate to a calculator / submit a form as a test contact.
4. In GHL, open that contact → **Attribution** → confirm `utm_source=test` etc. appear.
5. Re-capture a sample webhook payload if forms feed the Vercel webhook, so the new fields flow through. See [[live-pages-ghl-pasted]].
6. Exclude the test contact from counts (name it `TESTING`).

Nightly, `sync-ghl-attribution` mirrors these into `ghl_contact_attribution`; `v_utm_summary` and `v_conversion_by_source` then show real campaign splits.

---

## What this will and won't move

- **Will:** campaign-level attribution for new web leads that click tagged links; paid-ad tracking once ads run.
- **Won't:** the 76% historical "unknown" bucket (not web-origin), and any future lead from an untagged link (GHL still records only the channel).

The dashboard number to watch after rollout: `v_utm_summary` rows with a real `utm_campaign` (not `(none)`) should climb week over week. If they don't, the gap is untagged links (Fix 1), not the snippet.
