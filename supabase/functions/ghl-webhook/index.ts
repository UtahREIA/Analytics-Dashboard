// supabase/functions/ghl-webhook/index.ts
// VERSION: v22
// v22 (2026-11-10): EVENT ATTENDANCE — array-valued checkboxes. GHL CHECKBOX custom
//   fields return as arrays (e.g. ["Attended"]), but the event filter only matched a
//   scalar string 'attended', so every event after ~May 2026 was silently dropped
//   (event_attendance froze 2026-06-12 while people kept attending). New isAttendedValue()
//   handles arrays + scalars. Backfill missed events with a full resync (?full=1).
// v21 (2026-11-09): MEMBERSHIP LIFECYCLE DATES. Map two GHL contact custom fields that
//   were never synced: Inactive Date (key inactive_date) -> membership_inactive_date and
//   Cancelation Date (key cancelation_date) -> membership_cancelation_date. Additive and
//   guarded by stripNulls, so an absent value never blanks an existing one. Expiration
//   date was already mapped (membership_expiration_date). "Pending renewal" / "council
//   membership" dates were requested but have no GHL field, so they are not added.
// v17 (2026-10-13): MERGE SEMANTICS. Every branch runs processContact, which upserts
//   investor_profiles / vendor_profiles / tool_access. Lean branches (Event Register New,
//   Event Register Free Events, Vendor Readiness) omit the investor interest block, so the
//   old code wrote NULLs over previously-synced stage/interests/goals every time a contact
//   registered for an event -- draining investor_profiles. Fix: stripNulls() drops absent
//   fields before each upsert so a branch only updates what it actually carries, and
//   wants_off_market_opportunities is now null (not false) when its source key is absent.
//   Matches the project's additive principle: empty values are ignored, not written.
// v15: Added Vendor Readiness Survey: XWJdSkA6qxctH9imv6U4

import { createClient } from 'jsr:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const GHL_WEBHOOK_SECRET = Deno.env.get('GHL_WEBHOOK_SECRET') ?? '';
const NULL_STRINGS = new Set(['null', 'undefined', 'none', 'n/a', '']);

function isNullish(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string' && NULL_STRINGS.has(val.trim().toLowerCase())) return true;
  return false;
}
function str(val: unknown): string | null {
  if (isNullish(val)) return null;
  return String(val).trim() || null;
}
function numOrNull(val: unknown): number | null {
  if (isNullish(val)) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}
function boolOrNull(val: unknown): boolean | null {
  if (isNullish(val)) return null;
  if (typeof val === 'boolean') return val;
  const s = String(val).toLowerCase().trim();
  if (s === 'yes' || s === 'true' || s === '1') return true;
  if (s === 'no' || s === 'false' || s === '0') return false;
  return null;
}
function dateOrNull(val: unknown): string | null {
  if (isNullish(val)) return null;
  try { const d = new Date(String(val)); return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0]; }
  catch { return null; }
}
function arrayOrNull(val: unknown): string[] | null {
  if (isNullish(val)) return null;
  if (Array.isArray(val)) {
    const f = val.map(String).filter(v => !NULL_STRINGS.has(v.trim().toLowerCase()));
    return f.length ? f : null;
  }
  const s = String(val).trim();
  if (NULL_STRINGS.has(s.toLowerCase())) return null;
  const parts = s.split(',').map((v: string) => v.trim()).filter((v: string) => !NULL_STRINGS.has(v.toLowerCase()));
  return parts.length ? parts : null;
}
// MERGE SEMANTICS: drop keys whose value is null so an upsert only writes fields the
// current webhook body actually carries. Without this, a lean branch (e.g. event
// registration) overwrites previously-synced data with nulls. contact_id / updated_at
// are always kept so the row still keys and timestamps correctly.
function stripNulls<T extends Record<string, unknown>>(row: T, keep: string[] = ['contact_id', 'updated_at']): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k, v]) => v !== null || keep.includes(k)));
}
function parseCustomFields(fields: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!Array.isArray(fields)) return result;
  for (const field of fields) {
    if (field && typeof field === 'object') {
      const f = field as Record<string, unknown>;
      const key = String(f.key ?? f.fieldKey ?? '').replace('contact.', '');
      const val = f.value ?? f.fieldValue;
      if (key && !isNullish(val)) result[key] = val;
    }
  }
  return result;
}

const EVENT_KEY_PATTERN = /^\d{6,8}/;
function isEventField(key: string): boolean { return EVENT_KEY_PATTERN.test(key); }
// GHL CHECKBOX custom fields come back as ARRAYS, e.g. ["Attended"] or ["true"]
// (CLAUDE.md gotcha). Count a value as attended if it — or any array element — is a
// truthy/attended marker. "Registered" and other values are NOT attendance.
function isAttendedValue(value: unknown): boolean {
  const vals = Array.isArray(value) ? value : [value];
  return vals.some((v) =>
    v === true || v === 1 ||
    (typeof v === 'string' && ['true', '1', 'attended'].includes(v.trim().toLowerCase())));
}
function keyToEventName(key: string): string {
  return key.replace(/^\d{6,8}_*/, '').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()).trim();
}
function extractDateFromKey(key: string): string | null {
  const m = key.match(/^(\d{6,8})/);
  if (!m) return null;
  const d = m[1];
  let mo: string, dy: string, yr: string;
  if (d.length === 8) { mo = d.slice(0,2); dy = d.slice(2,4); yr = d.slice(4,8); }
  else if (d.length === 7) { mo = '0'+d.slice(0,1); dy = d.slice(1,3); yr = d.slice(3,7); }
  else { mo = d.slice(0,2); dy = d.slice(2,4); yr = '20'+d.slice(4,6); }
  try { const dt = new Date(`${yr}-${mo}-${dy}`); return isNaN(dt.getTime()) ? null : dt.toISOString().split('T')[0]; }
  catch { return null; }
}

const SURVEY_ID_TO_TYPE: Record<string, string> = {
  // Current IDs (June 2026)
  '8CzJrtK4SZ8KuOFkpc9q': 'brrrr',
  '59rKPVr4G72h4gLEiHfB': 'buildscope',
  'j60aT4pN9PyQON8Pnn9r': 'fix_flip',
  'CmCuA7NQQSvbIHdpirxt': 'rental',
  'YGYxMg8ULW64gjhQDhP1': 'short_term',
  'vnMfd0K5soW0Ob2yIO64': 'wholesale',
  '9RTgEIeNcHvWBZkqUZKl': 'path_to_success',
  'ktDhoCZJC1erRWjzcJGB': 'event_roster',
  'ey3blG1MMg54GLPQLJIc': 'event_roster_free',
  'OtlsyMRStvmrwyEYxaZx': 'event_roster_virtual',
  'XWJdSkA6qxctH9imv6U4': 'vendor',
  // Legacy IDs (fallback)
  'DhnDb2SsytJF6bacAafd': 'fix_flip',
  'w5e3kPk4jK60mJFjKfWo': 'wholesale',
  '83hyIL3oCuS0Sp29QVyN': 'rental',
  'jhrib8YKGa00UDFevyaQ': 'short_term',
  '12zEvlS4FVglce7fWUTN': 'buildscope',
  'KF89kt5k4npRKkKuLYZi': 'path_to_success',
  'XgxEn2nsCdQAZtrV8PAp': 'event_roster',
};

async function recordReadinessSurvey(contactId: string, ghlContactId: string, surveyId: string,
  surveyName: string | null, customFields: Record<string, unknown>, submissionId: string | null, submittedAt: string) {
  const surveyType = SURVEY_ID_TO_TYPE[surveyId] ?? 'unknown';
  const answerKeys = [
    'where_would_you_say_you_are_in_your_real_estate_investing_journey',
    'what_type_of_investing_are_you_most_interested_in','property_type_',
    'what_are_you_trying_to_accomplish_in_the_next_6_to_12_months',
    'tell_us_what_best_describes_you_right_now','do_you_want_access_to_off_market_opportunities',
    'select_the_commercial_asset_types_that_most_interest_you','funding__financial',
    'deals__opportunities','education__tools','growth__network','team__vendors',
    'do_you_want_to_share_your_contact_with_other_investors',
    'would_you_like_us_to_connect_with_professionals_that_can_help_you_with_these_services',
    'if_we_can_connect_with_a_mentor_in_this_space_is_that_something_that_would_interest_you',
    'soft_commit_amount','initial_commitment_amount','what_is_your_area_of_expertise',
    'contractor_specility','which_types_of_investors_do_you_typically_work_with'
  ];
  const answers: Record<string, unknown> = {};
  for (const key of answerKeys) { const value = customFields[key]; if (!isNullish(value)) answers[key] = value; }
  const row = {
    contact_id: contactId, ghl_contact_id: ghlContactId, survey_id: surveyId,
    survey_name: surveyName ?? 'Unknown Survey', survey_type: surveyType,
    submission_id: submissionId || `${surveyId}_${contactId}_${Date.now()}`,
    submitted_at: submittedAt, answers, source: 'webhook'
  };
  const { error } = await supabase.from('readiness_surveys').upsert(row, { onConflict: 'survey_id,submission_id', ignoreDuplicates: false });
  if (error) console.error('readiness_surveys upsert failed:', error.message);
}

async function processContact(payload: Record<string, unknown>): Promise<{ contactId: string; eventsWritten: number; eventsFailed: number }> {
  const contact = (payload.contact as Record<string, unknown>) ?? payload;
  const customFields = parseCustomFields(contact.customFields ?? contact.custom_fields ?? []);
  const ghlContactId = String(contact.id ?? contact.contactId ?? '');
  if (!ghlContactId) throw new Error('No contact ID in payload');
  const rawStatus = str(payload.ghl_status ?? contact.ghl_status ?? customFields['ghl_status']);

  const contactRow = {
    ghl_contact_id: ghlContactId,
    full_name: str(contact.fullName ?? contact.full_name ?? contact.name ?? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim()),
    email: str(contact.email), phone: str(contact.phone),
    legal_name: str(customFields['legal_name']),
    company_name: str(contact.companyName ?? contact.company_name ?? customFields['company']),
    company_email: str(customFields['company_email']), company_phone: str(customFields['company_phone']),
    profile_type: str(customFields['entity_type']), membership_type: str(customFields['membership_type']),
    membership_date: dateOrNull(customFields['membership_date']),
    membership_expiration_date: dateOrNull(customFields['expiration_date']),
    membership_inactive_date: dateOrNull(customFields['inactive_date']),
    membership_cancelation_date: dateOrNull(customFields['cancelation_date']),
    membership_fee: numOrNull(customFields['membership_fee']),
    true_jv_member: str(customFields['true_jv_member']),
    preferred_contact_method: str(customFields['preferred_contact_method']),
    how_did_you_hear_about_us: str(customFields['how_did_you_hear_about_us']),
    who_referred_you: str(customFields['who_referred_you']),
    last_reia_event: str(customFields['last_reia_event']),
    first_meeting_date: dateOrNull(customFields['first_meeting']),
    free_guest_pass: boolOrNull(customFields['free_guest_pass']),
    ghl_membership_status: rawStatus,
    updated_at: new Date().toISOString()
  };

  // contacts is identity data keyed on ghl_contact_id; strip nulls so a lean branch does
  // not blank name/email/membership on an existing contact.
  const { data: upsertedContact, error: contactError } = await supabase
    .from('contacts').upsert(stripNulls(contactRow, ['ghl_contact_id', 'updated_at']), { onConflict: 'ghl_contact_id' }).select('id').single();
  if (contactError) throw new Error(`contacts upsert failed: ${contactError.message}`);
  const contactId = upsertedContact.id as string;

  const offMarketRaw = customFields['do_you_want_access_to_off_market_opportunities'];
  const investorRow = {
    contact_id: contactId,
    investing_journey_stage:        str(customFields['where_would_you_say_you_are_in_your_real_estate_investing_journey']),
    investing_interests:            arrayOrNull(customFields['what_type_of_investing_are_you_most_interested_in']),
    property_types:                 arrayOrNull(customFields['property_type_']),
    accomplish_next_6_to_12_months: arrayOrNull(customFields['what_are_you_trying_to_accomplish_in_the_next_6_to_12_months']),
    what_best_describes_you:        arrayOrNull(customFields['tell_us_what_best_describes_you_right_now']),
    wants_off_market_opportunities: isNullish(offMarketRaw) ? null : String(offMarketRaw).toLowerCase().includes('yes'),
    commercial_asset_types:         arrayOrNull(customFields['select_the_commercial_asset_types_that_most_interest_you']),
    funding_financial:              arrayOrNull(customFields['funding__financial']),
    deals_opportunities:            arrayOrNull(customFields['deals__opportunities']),
    education_tools:                arrayOrNull(customFields['education__tools']),
    growth_network:                 arrayOrNull(customFields['growth__network']),
    team_vendors:                   arrayOrNull(customFields['team__vendors']),
    soft_commit_amount:             numOrNull(customFields['soft_commit_amount']),
    initial_commitment_amount:      numOrNull(customFields['initial_commitment_amount']),
    wants_professional_connections: boolOrNull(customFields['would_you_like_us_to_connect_with_professionals_that_can_help_you_with_these_services']),
    wants_investor_connections:     boolOrNull(customFields['do_you_want_to_share_your_contact_with_other_investors']),
    wants_mentor_connection:        boolOrNull(customFields['if_we_can_connect_with_a_mentor_in_this_space_is_that_something_that_would_interest_you']),
    updated_at: new Date().toISOString()
  };
  // stripNulls => only fields this body carries get written; lean branches no longer
  // null-out a contact's previously-synced stage / interests / goals.
  const { error: investorError } = await supabase.from('investor_profiles').upsert(stripNulls(investorRow), { onConflict: 'contact_id' });
  if (investorError) throw new Error(`investor_profiles upsert failed: ${investorError.message}`);

  const vendorRow = {
    contact_id: contactId,
    service_types:              arrayOrNull(customFields['what_is_your_area_of_expertise']),
    contractor_specialty:       str(customFields['contractor_specility']),
    investor_types_worked_with: arrayOrNull(customFields['which_types_of_investors_do_you_typically_work_with']),
    updated_at: new Date().toISOString()
  };
  const strippedVendor = stripNulls(vendorRow);
  // Only touch vendor_profiles when this body carried a vendor field (more than the keys
  // we always keep), so investor-only branches do not create empty vendor rows.
  if (Object.keys(strippedVendor).length > 2) {
    const { error: vendorError } = await supabase.from('vendor_profiles').upsert(strippedVendor, { onConflict: 'contact_id' });
    if (vendorError) console.error(`vendor_profiles upsert failed: ${vendorError.message}`);
  }

  const toolRow = {
    contact_id: contactId,
    fix_flip_calculator_access:   dateOrNull(customFields['fix__flip_calculator_access']),
    brrrr_calculator_access:      dateOrNull(customFields['brrrr_calculator_access']),
    wholesale_calculator_access:  dateOrNull(customFields['wholesale_calculator_access']),
    rentals_calculator_access:    dateOrNull(customFields['rentals_calculator_access']),
    short_term_calculator_access: dateOrNull(customFields['short_term_calculator_access']),
    rehab_estimator_access:       dateOrNull(customFields['rehab_estimator']),
    rehab_subscription_status:    str(customFields['rehab_subscription_status']),
    updated_at: new Date().toISOString()
  };
  const strippedTool = stripNulls(toolRow);
  if (Object.keys(strippedTool).length > 2) {
    const { error: toolError } = await supabase.from('tool_access').upsert(strippedTool, { onConflict: 'contact_id' });
    if (toolError) console.error(`tool_access upsert failed: ${toolError.message}`);
  }

  const eventEntries = Object.entries(customFields).filter(
    ([key, value]) => isEventField(key) && isAttendedValue(value)
  );
  console.log(`event_attendance: found ${eventEntries.length} event fields for ${ghlContactId}`);
  let eventsWritten = 0, eventsFailed = 0;
  for (const [key] of eventEntries) {
    const { error: evErr } = await supabase.from('event_attendance').upsert(
      { contact_id: contactId, event_name: keyToEventName(key), event_date: extractDateFromKey(key), attended: true, ghl_field_key: key },
      { onConflict: 'contact_id,ghl_field_key' }
    );
    if (evErr) { console.error(`event_attendance failed for "${key}": ${evErr.message}`); eventsFailed++; }
    else eventsWritten++;
  }
  return { contactId, eventsWritten, eventsFailed };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const token = req.headers.get('x-ghl-signature') ?? req.headers.get('x-webhook-secret') ?? req.headers.get('authorization') ?? '';
  if (GHL_WEBHOOK_SECRET && token !== GHL_WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });
  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
  try {
    const { contactId, eventsWritten, eventsFailed } = await processContact(payload);
    const surveyId = str(payload.survey_id);
    if (surveyId) {
      const contact = (payload.contact as Record<string, unknown>) ?? payload;
      const customFields = parseCustomFields(contact.customFields ?? contact.custom_fields ?? []);
      const ghlContactId = String(contact.id ?? contact.contactId ?? '');
      const submittedAtRaw = str(payload.submitted_at);
      const submittedAt = submittedAtRaw
        ? (() => { const d = new Date(submittedAtRaw); return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); })()
        : new Date().toISOString();
      await recordReadinessSurvey(contactId, ghlContactId, surveyId, str(payload.survey_name), customFields, str(payload.submission_id), submittedAt);
    }
    return new Response(JSON.stringify({ success: true, eventsWritten, eventsFailed, surveyLogged: Boolean(surveyId) }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { headers: { 'Content-Type': 'application/json' }, status: 500 });
  }
});
