# Contacts sync: GHL → Supabase field map

> UPDATE 2026-11-02: the cron does NOT map fields itself. It replays each changed GHL contact
> through the existing Supabase edge function `ghl-webhook`, which fans one payload into SIX
> tables (contacts, investor_profiles, vendor_profiles, tool_access, event_attendance, and
> readiness_surveys when a survey). `ghl-webhook/index.ts` is the authoritative field spec;
> the table below is background on the `contacts` slice only. The cron's job is to translate
> GHL custom-field `id → key` and POST the same payload the workflow's contact branch sent.
> Note: the edge function writes `ghl_membership_status` (from a top-level `ghl_status`), NOT
> `membership_status` — that column is owned by a different process and is out of scope here.


Reconstructed from the live GHL custom-field catalog (location `oMOSHj4e9WNfMfx8MkBo`)
and the live `contacts` table (4,607 rows) on 2026-11-02. This is what the daily cron
must reproduce when it replaces the GHL workflow.

GHL v2 `GET /contacts/{id}` returns standard fields at the top level and custom fields as
`customFields: [{ id, value }]`. The cron maps **by field id** for custom fields.

## Only these columns are actually synced today

Verified by counting non-null values across all 4,607 contacts. Everything else is dead
(see "Not synced" below), so the cron can leave it alone.

### Standard GHL fields (top level)
| contacts column | GHL source | notes |
|---|---|---|
| full_name | `firstName` + `lastName` (standard) | there is also a custom "Full Name *" (`full_name_`, id `OkJgjRh2kvDIWwbaDJmh`) — **confirm which the workflow uses** |
| email | `email` | last-resort match key |
| phone | `phone` | compute `phone_last10` from this on write |
| company_name | `companyName` | |

### Custom fields (map by id) — high confidence
| contacts column | GHL field name | key | id | type | populated |
|---|---|---|---|---|---|
| membership_type | Membership Type | `membership_type` | `T6NZIu326VN3mn5sG8YH` | SINGLE_OPTIONS | yes |
| membership_date | Membership Date | `membership_date` | `ToVELcdiYu5Yg88zUEUk` | DATE | yes |
| membership_expiration_date | Expiration Date | `expiration_date` | `Vak42PRO9dfbEHb2w727` | DATE | sparse |
| membership_fee | Membership Fee | `membership_fee` | `A5heKY8JkVFIQrliqNbv` | NUMERICAL | yes |
| true_jv_member | TRUE JV Member | `true_jv_member` | `JTg8Tk40RObLc9d60NB4` | SINGLE_OPTIONS | 72 |
| profile_type | Profile Type | `profile_type` | `8cDnmVymbWZc9IzNEsvG` | TEXT | 19 (low) |
| how_did_you_hear_about_us | How did you hear about us? | `how_did_you_hear_about_us` | `tsGtu8zCkZBpOS1nbbeO` | SINGLE_OPTIONS | yes |
| who_referred_you | Who Referred You? (optional) | `who_referred_you` | `FHNFZq7RIGmSrVGTzbKx` | TEXT | sparse |
| first_meeting_date | First Meeting | `first_meeting` | `p8yoM0ab8zGEd9wAuWcX` | DATE | 997 |

## Needs confirmation before coding (do NOT guess)

1. **`membership_status` vs `ghl_membership_status`.** Both are populated (1,401 / 1,399 rows)
   but they **disagree on 321 contacts** — so they are two different sources, not a copy.
   Best guess: `ghl_membership_status` ← GHL custom "Status" (`status`, id `pVjzZbTLHlgbSX5IVbhc`,
   SINGLE_OPTIONS), and `membership_status` is **derived** by the workflow (likely from
   membership_type / expiration / tags). The derivation rule must come from the workflow or
   from Chris — the dashboard funnel depends on which one is "truth."

2. **`is_board_member` / `member_role`** (18 rows each, and they line up). No matching custom
   field in the catalog — almost certainly tag-driven or set manually. Confirm the source;
   if it's manual/tag-based, the cron should **not** overwrite it.

## Not synced by the current workflow (all 0 non-null across 4,607 rows — skip)

`social_facebook`, `social_instagram`, `social_linkedin`, `social_youtube`, `logo_url`,
`headshot_url`, `company_email`, `company_phone`, `company_tagline`, `company_description`,
`preferred_contact_method`, `legal_name`, `last_reia_event`, `free_guest_pass`.

These look like member/vendor-directory fields populated by a different process (forms /
Airtable), not the contacts sync. The cron must **not** null them out on upsert — only write
the mapped columns above. (GHL FILE_UPLOAD and MULTIPLE_OPTIONS custom fields can return arrays;
if any of these get added to the sync later, handle the array shape then.)

## Incremental pull key

GHL contact `dateUpdated` drives the incremental filter; `dateAdded` is first-touch.
Upsert conflict target: `contacts.ghl_contact_id` (NOT NULL + UNIQUE).
