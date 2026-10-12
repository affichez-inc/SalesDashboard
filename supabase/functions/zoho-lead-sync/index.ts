// supabase/functions/zoho-lead-sync/index.ts
// Syncs Zoho CRM Leads + Contacts → the Supabase zoho_leads table.
//
// Three ways in:
//   1. Webhook   — Zoho workflow rule POSTs {id} to ?module=Leads|Contacts.
//                  Requires the x-webhook-secret header. Syncs that one record.
//   2. Full sync — header `x-full-sync: true`. Walks both modules and removes
//                  orphans. Used for the initial load and the nightly reconcile.
//   3. Incremental — default. If-Modified-Since since the last cursor. This is
//                  the safety net for events the webhook misses (imports, mass
//                  updates, Zoho outages), not the primary path.
//
// Deletes arrive through the same webhook: a Zoho Delete-trigger workflow rule
// fires with the record id, the fetch below comes back empty, and the row is
// removed locally. Zoho permits webhooks on Delete triggers (only functions and
// email notifications are restricted there).
//
// A Zoho webhook can carry at most 10 CRM fields, and we need more than that, so
// the webhook sends only the record id and we fetch the record from the API. That
// also means adding a column later needs no change on the Zoho side.
//
// Hits Zoho *CRM* (zohoapis.com/crm/v8) — a different product from the Zoho
// *Books* syncs (zoho-sync / zoho-invoice-sync). Needs a refresh token scoped to
// ZohoCRM.modules.leads.READ + ZohoCRM.modules.contacts.READ + ZohoCRM.users.READ.
// Verify with the x-check-scope header before relying on it.

const CRM_ORG_ID = Deno.env.get('ZOHO_CRM_ORG_ID') ?? '48245615';
const WEBHOOK_SECRET = Deno.env.get('ZOHO_WEBHOOK_SECRET') ?? '';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// The multiselect holding "Distribution Publicitaire" etc. Zoho mangles the
// accents in "Intérêt pour quel service initialement" into underscores.
const SERVICE_FIELD = 'Int_r_t_pour_quel_service_initialement';

// Reach fields, on both modules: what the Comptes export and the Meta audience
// upload are built from. The job title is `Designation` on Leads and `Title` on
// Contacts; Zoho labels both "Title". For the email opt-out see emailOptOut().
const REACH_FIELDS = ['Mobile', 'Secondary_Email', 'Langue', 'Email_Opt_Out', 'Unsubscribed_Mode'];

// The org's own marketing refusal checkbox and the mass-email bounce flag exist
// on Contacts only.
const NO_MARKETING_FIELD = 'Ne_veut_pas_recevoir_nos_courriels_marketing';
const BOUNCED_FIELD = 'Email_de_masse_non_remis';

const LEAD_FIELDS = [
  'id', 'Full_Name', 'First_Name', 'Last_Name', 'Company', 'Phone', 'Email',
  'Owner', 'Created_Time', 'Modified_Time',
  'Lead_Source', SERVICE_FIELD, 'Lead_Status',
  'Converted__s', 'Converted_Contact', 'Converted_Account', 'Converted_Deal',
  'Converted_Date_Time',
  ...REACH_FIELDS, 'Designation',
].join(',');

// Contacts has neither Lead_Source nor the service multiselect — the DB trigger
// inherits both from the originating lead via Converted_Contact.
const CONTACT_FIELDS = [
  'id', 'Full_Name', 'First_Name', 'Last_Name', 'Account_Name', 'Phone', 'Email',
  'Owner', 'Created_Time', 'Modified_Time',
  ...REACH_FIELDS, 'Title', NO_MARKETING_FIELD, BOUNCED_FIELD,
].join(',');

type Module = 'Leads' | 'Contacts';

// A full pass over the org's ~29k records takes longer than one invocation is
// allowed, so it runs in slices. Requests are killed at 150s; stopping at 110s
// leaves room to persist the cursor and answer.
const FULL_SYNC_BUDGET_MS = 110_000;
const FULL_RUN_KEY = 'crm_fullsync_run';
/** Stored in sync_state.cursor_token once a module's full walk has finished. */
const DONE_MARKER = 'DONE';

/** Zoho CRM expects ISO 8601 with an explicit offset, e.g. 2026-07-10T00:00:00+00:00 */
function toZohoCrmTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// ─── Zoho Auth ────────────────────────────────────────────────────────────────
// Shares the zoho_oauth_token cache (key 'crm') with zoho-task-sync: Zoho throttles
// the refresh endpoint per refresh token, and access tokens last an hour.

const TOKEN_CACHE_KEY = 'crm';
const TOKEN_SKEW_MS = 5 * 60 * 1000;

let memoToken: { token: string; expiresAt: number } | null = null;

function tokenIsFresh(expiresAt: number): boolean {
  return Date.now() < expiresAt - TOKEN_SKEW_MS;
}

async function readCachedToken(): Promise<string | null> {
  if (memoToken && tokenIsFresh(memoToken.expiresAt)) return memoToken.token;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/zoho_oauth_token?key=eq.${TOKEN_CACHE_KEY}` +
      `&select=access_token,expires_at`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) return null; // a cache miss must never break the sync
  const rows = await res.json() as Array<{ access_token: string; expires_at: string }>;
  if (rows.length === 0) return null;
  const expiresAt = new Date(rows[0].expires_at).getTime();
  if (!tokenIsFresh(expiresAt)) return null;
  memoToken = { token: rows[0].access_token, expiresAt };
  return rows[0].access_token;
}

async function writeCachedToken(token: string, expiresInSec: number): Promise<void> {
  const expiresAt = new Date(Date.now() + expiresInSec * 1000);
  memoToken = { token, expiresAt: expiresAt.getTime() };
  await fetch(`${SUPABASE_URL}/rest/v1/zoho_oauth_token?on_conflict=key`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      key: TOKEN_CACHE_KEY,
      access_token: token,
      expires_at: expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
}

async function getAccessToken(): Promise<string> {
  const cached = await readCachedToken();
  if (cached) return cached;

  const clientId = Deno.env.get('ZOHO_CRM_CLIENT_ID') ?? Deno.env.get('ZOHO_CLIENT_ID')!;
  const clientSecret = Deno.env.get('ZOHO_CRM_CLIENT_SECRET') ?? Deno.env.get('ZOHO_CLIENT_SECRET')!;
  const refreshToken = Deno.env.get('ZOHO_CRM_REFRESH_TOKEN') ?? Deno.env.get('ZOHO_REFRESH_TOKEN')!;
  const url = `https://accounts.zoho.com/oauth/v2/token` +
    `?refresh_token=${refreshToken}&client_id=${clientId}` +
    `&client_secret=${clientSecret}&grant_type=refresh_token`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) throw new Error('Zoho CRM token refresh failed: ' + JSON.stringify(data));
  await writeCachedToken(data.access_token, Number(data.expires_in) || 3600);
  return data.access_token;
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function upsertBatch(batch: object[]): Promise<void> {
  if (batch.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/zoho_leads?on_conflict=zoho_record_id`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error('Supabase upsert failed: ' + await res.text());
}

async function deleteBatch(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/zoho_leads?zoho_record_id=in.(${ids.join(',')})`,
    { method: 'DELETE', headers: SB_HEADERS },
  );
  if (!res.ok) throw new Error('Supabase delete failed: ' + await res.text());
}

async function logSync(action: string, statusCode: number, zohoId?: string, message?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/webhook_log`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({
      action,
      status_code: statusCode,
      zoho_id: zohoId ?? null,
      error_message: message ?? null,
    }),
  });
}

/** email (lowercased) → app rep_name, so leads line up with the rest of the app. */
async function loadRepMap(): Promise<Record<string, string>> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/allowed_users?select=email,rep_name&rep_name=not.is.null`,
    { headers: SB_HEADERS },
  );
  const map: Record<string, string> = {};
  if (res.ok) {
    const rows = await res.json() as Array<{ email: string; rep_name: string }>;
    for (const r of rows) {
      if (r.email && r.rep_name) map[r.email.toLowerCase()] = r.rep_name;
    }
  }
  return map;
}

// ─── Sync cursors ─────────────────────────────────────────────────────────────

async function readSyncState(key: string): Promise<Date> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sync_state?key=eq.${key}&select=last_modified_time`,
    { headers: SB_HEADERS },
  );
  if (res.ok) {
    const rows = await res.json() as Array<{ last_modified_time: string }>;
    if (rows.length > 0) return new Date(rows[0].last_modified_time);
  }
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

/** Like readSyncState but distinguishes "never set" from a real value. */
async function readSyncStateOrNull(key: string): Promise<Date | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sync_state?key=eq.${key}&select=last_modified_time`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) return null;
  const rows = await res.json() as Array<{ last_modified_time: string }>;
  return rows.length > 0 ? new Date(rows[0].last_modified_time) : null;
}

/** Position of an in-progress paginated walk, so a sliced full sync can resume it. */
async function readCursorToken(key: string): Promise<string | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sync_state?key=eq.${key}&select=cursor_token`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) return null;
  const rows = await res.json() as Array<{ cursor_token: string | null }>;
  return rows.length > 0 ? rows[0].cursor_token : null;
}

async function writeCursorToken(key: string, token: string | null): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/sync_state?on_conflict=key`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      key,
      cursor_token: token,
      last_modified_time: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
}

async function clearSyncState(keys: string[]): Promise<void> {
  await fetch(
    `${SUPABASE_URL}/rest/v1/sync_state?key=in.(${keys.join(',')})`,
    { method: 'DELETE', headers: SB_HEADERS },
  );
}

/**
 * Reconciles rows a full pass did not touch: asks Zoho about each one and deletes
 * it only if Zoho genuinely no longer has it, repairing it otherwise.
 *
 * Deleting purely on "not seen this pass" is what cost 39 live contacts — any gap
 * in the walk read as a deletion. One extra API call per candidate is cheap
 * insurance, and there should be very few candidates.
 */
async function reconcileStaleRows(
  before: Date,
  token: string,
  repMap: Record<string, string>,
  deadline: number,
): Promise<{ deleted: number; repaired: number; pending: number }> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/zoho_leads?synced_at=lt.${before.toISOString()}` +
      `&select=zoho_record_id,stage&limit=500`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) return { deleted: 0, repaired: 0, pending: 0 };
  const candidates = await res.json() as Array<{ zoho_record_id: string; stage: string }>;

  const toDelete: string[] = [];
  let repaired = 0;
  let checked = 0;

  for (const c of candidates) {
    if (Date.now() > deadline) break; // the rest wait for the next run
    checked++;
    const module: Module = c.stage === 'contact' ? 'Contacts' : 'Leads';
    try {
      const rec = await fetchOne(module, c.zoho_record_id, token);
      if (rec) {
        await upsertBatch([mapRecord(rec, module, repMap)]);
        repaired++;
      } else {
        toDelete.push(c.zoho_record_id);
      }
    } catch {
      // A transient error must not be read as "deleted in Zoho" — leave it be.
    }
  }

  for (let i = 0; i < toDelete.length; i += 100) {
    await deleteBatch(toDelete.slice(i, i + 100));
  }
  return { deleted: toDelete.length, repaired, pending: candidates.length - checked };
}

async function writeSyncState(key: string, ts: Date): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/sync_state?on_conflict=key`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, last_modified_time: ts.toISOString(), updated_at: new Date().toISOString() }),
  });
}

// ─── Field mapping ────────────────────────────────────────────────────────────

interface ZohoLookup { name?: string; id?: string; email?: string }

/** Zoho returns multiselects as string[], but a single value can arrive as a string. */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v];
  return [];
}

/** Text or null; Zoho writes "-None-" into a picklist that was never set. */
function textOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s !== '-None-' ? s : null;
}

/**
 * A checkbox Zoho returned, as a boolean. A field the record did not carry
 * stays null rather than false: "not read" must not pass for "did not refuse".
 */
function boolOrNull(rec: Record<string, unknown>, field: string): boolean | null {
  if (!(field in rec)) return null;
  return rec[field] === true;
}

/**
 * Unsubscribed from our emails. Zoho shows it two ways: the Email_Opt_Out
 * checkbox, and Unsubscribed_Mode, which says how (unsubscribe link, Zoho
 * Campaigns) and is set exactly when the person unsubscribed. The sync's login
 * gets both on Leads, where they always agree, but Email_Opt_Out never comes
 * back on Contacts (verified 2026-10-07: absent on 200 of 200), so reading the
 * checkbox alone would leave every contact "unknown". Either one saying yes is
 * a yes; either one present makes the answer known.
 */
function emailOptOut(rec: Record<string, unknown>): boolean | null {
  if (!('Email_Opt_Out' in rec) && !('Unsubscribed_Mode' in rec)) return null;
  return rec.Email_Opt_Out === true || textOrNull(rec.Unsubscribed_Mode) !== null;
}

function mapRecord(
  rec: Record<string, unknown>,
  module: Module,
  repMap: Record<string, string>,
): object {
  const owner = (rec.Owner ?? {}) as ZohoLookup;
  const ownerEmail = (owner.email ?? '').toLowerCase();
  const id = String(rec.id);
  const isLead = module === 'Leads';

  // Leads carry Company as free text; Contacts point at an Account.
  const account = (rec.Account_Name ?? {}) as ZohoLookup;
  const company = isLead ? ((rec.Company as string) ?? null) : (account.name ?? null);

  const convContact = (rec.Converted_Contact ?? null) as ZohoLookup | null;
  const convAccount = (rec.Converted_Account ?? null) as ZohoLookup | null;
  const convDeal = (rec.Converted_Deal ?? null) as ZohoLookup | null;

  return {
    zoho_record_id: id,
    stage: isLead ? 'lead' : 'contact',

    full_name: (rec.Full_Name as string) ?? null,
    first_name: (rec.First_Name as string) ?? null,
    last_name: (rec.Last_Name as string) ?? null,
    company,
    phone: (rec.Phone as string) ?? null,
    email: (rec.Email as string) ?? null,
    mobile: textOrNull(rec.Mobile),
    secondary_email: textOrNull(rec.Secondary_Email),
    title: textOrNull(isLead ? rec.Designation : rec.Title),
    language: textOrNull(rec.Langue),
    email_opt_out: emailOptOut(rec),
    no_marketing: isLead ? null : boolOrNull(rec, NO_MARKETING_FIELD),
    email_bounced: isLead ? null : boolOrNull(rec, BOUNCED_FIELD),

    owner_name: owner.name ?? null,
    owner_email: owner.email ?? null,
    rep_name: (ownerEmail && repMap[ownerEmail]) ? repMap[ownerEmail] : (owner.name ?? null),

    created_time: (rec.Created_Time as string) || null,
    modified_time: (rec.Modified_Time as string) || null,

    // Contacts has neither field — left null so the DB trigger can inherit them.
    lead_source: isLead ? ((rec.Lead_Source as string) ?? null) : null,
    service_interest: isLead ? toStringArray(rec[SERVICE_FIELD]) : [],
    lead_status: isLead ? ((rec.Lead_Status as string) ?? null) : null,

    // The account this record belongs to, which is what invoices hang off:
    // Zoho Books stores a CRM account id on each customer, never a contact id.
    // A contact points at its account directly; a lead only has one once it has
    // been converted.
    account_id: isLead ? (convAccount?.id ?? null) : (account.id ?? null),

    is_converted: isLead ? Boolean(rec.Converted__s) : false,
    converted_contact_id: convContact?.id ?? null,
    converted_account_id: convAccount?.id ?? null,
    converted_deal_id: convDeal?.id ?? null,
    converted_time: (rec.Converted_Date_Time as string) || null,

    zoho_crm_url: `https://crm.zoho.com/crm/org${CRM_ORG_ID}/tab/${module}/${id}`,
    synced_at: new Date().toISOString(),
  };
}

// ─── Zoho fetching ────────────────────────────────────────────────────────────

function fieldsFor(module: Module): string {
  return module === 'Leads' ? LEAD_FIELDS : CONTACT_FIELDS;
}

async function fetchOne(
  module: Module, id: string, token: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `https://www.zohoapis.com/crm/v8/${module}/${id}` +
      `?fields=${encodeURIComponent(fieldsFor(module))}`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
  );
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`Zoho ${module}/${id} → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data?.[0] ?? null;
}

/**
 * Walks one module from `since` forward, upserting as it goes, and stops when the
 * module is exhausted or `deadline` passes — whichever comes first.
 *
 * The walk is ordered by Modified_Time ascending and the cursor is persisted after
 * every page, so a run cut short by the platform's 150s request limit resumes from
 * where it stopped instead of starting over. The org has ~29k records, which is
 * several times more than one invocation can move.
 *
 * `converted=both` is essential: by default Zoho hides converted leads, so a plain
 * query over January 2026 returns 1 record instead of 200+.
 */
async function syncModule(
  module: Module,
  token: string,
  repMap: Record<string, string>,
  since: Date | null,
  errors: string[],
  opts: { deadline?: number; cursorKey?: string } = {},
): Promise<{ upserted: number; complete: boolean; cursor: Date | null }> {
  const { deadline, cursorKey } = opts;
  let upserted = 0;
  let hasMore = true;
  let complete = false;
  let page = 1;
  const MAX_PAGES = 400;

  // A sliced full sync resumes the *same* query from its stored page_token. Tokens
  // are unambiguous where timestamps are not: a page whose records all share one
  // Modified_Time gives a cursor no way to advance without skipping records, and
  // skipped records look deleted to the orphan pass.
  let pageToken: string | null = cursorKey ? await readCursorToken(cursorKey) : null;

  // Held constant for the whole walk — changing it would invalidate the token.
  const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${token}` };
  if (since) headers['If-Modified-Since'] = toZohoCrmTimestamp(since);

  const convertedParam = module === 'Leads' ? '&converted=both' : '';

  while (hasMore && page <= MAX_PAGES) {
    if (deadline && Date.now() > deadline) break; // resume on the next invocation

    const pageParam = pageToken
      ? `&page_token=${encodeURIComponent(pageToken)}`
      : `&page=${page}`;
    const url = `https://www.zohoapis.com/crm/v8/${module}` +
      `?fields=${encodeURIComponent(fieldsFor(module))}` +
      `&per_page=200&sort_by=Modified_Time&sort_order=asc${convertedParam}${pageParam}`;

    const res = await fetch(url, { headers });
    if (res.status === 304 || res.status === 204) { complete = true; break; }
    if (!res.ok) {
      const body = await res.text();
      // A stored token can be rejected if the query behind it changed. Restarting
      // the walk costs time but never loses records — the upserts are idempotent.
      if (pageToken && body.includes('TOKEN_BOUND_DATA_MISMATCH')) {
        pageToken = null;
        page = 1;
        if (cursorKey) await writeCursorToken(cursorKey, null);
        continue;
      }
      errors.push(`${module} p.${page}: ${body.slice(0, 300)}`);
      break;
    }

    const data = await res.json();
    const records: Record<string, unknown>[] = data.data ?? [];
    if (records.length === 0) { complete = true; break; }

    await upsertBatch(records.map(rec => mapRecord(rec, module, repMap)));
    upserted += records.length;

    const info = (data.info ?? {}) as Record<string, unknown>;
    hasMore = Boolean(info.more_records);
    pageToken = (info.next_page_token as string) ?? null;
    if (!pageToken) page++;

    if (cursorKey) await writeCursorToken(cursorKey, pageToken);

    if (!hasMore) { complete = true; break; }
    // Guard: more_records true but no token and a short page → stop rather than loop.
    if (hasMore && !pageToken && records.length < 200) break;
  }

  return { upserted, complete, cursor: since };
}

// ─── Webhook payload parsing ──────────────────────────────────────────────────

/**
 * Pulls the record id out of whatever Zoho sends. The workflow webhook can be
 * configured as form-data, raw JSON, or query params, and the parameter name is
 * whatever the person clicking through the UI typed — so accept the usual
 * spellings rather than depending on one exact configuration.
 */
async function extractRecordId(req: Request, url: URL): Promise<string | null> {
  const KEYS = [
    'id', 'record_id', 'recordId', 'Record_Id', 'entity_id', 'entityId',
    'leadId', 'lead_id', 'contactId', 'contact_id',
  ];

  // Headers first. Zoho's webhook builder nests "Module Parameters" under a
  // "Header" section, so a parameter named `id` arrives as an HTTP header rather
  // than a query param — but that layout differs between Zoho UI versions, so all
  // three locations are checked.
  for (const k of KEYS) {
    const v = req.headers.get(k);
    if (v && /^\d+$/.test(v)) return v;
  }

  for (const k of KEYS) {
    const v = url.searchParams.get(k);
    if (v && /^\d+$/.test(v)) return v;
  }

  const ct = req.headers.get('content-type') ?? '';
  let body: Record<string, unknown> = {};
  try {
    if (ct.includes('application/json')) {
      body = await req.json();
    } else if (ct.includes('form')) {
      const fd = await req.formData();
      for (const [k, v] of fd.entries()) body[k] = String(v);
    } else {
      const text = (await req.text()).trim();
      if (text.startsWith('{')) body = JSON.parse(text);
      else if (text) for (const [k, v] of new URLSearchParams(text)) body[k] = v;
    }
  } catch { /* fall through to the null return */ }

  for (const k of KEYS) {
    const v = body[k];
    if (v != null && /^\d+$/.test(String(v))) return String(v);
  }
  return null;
}

/** Length-checked, branch-free compare so the secret can't be probed byte by byte. */
function secretMatches(given: string | null): boolean {
  if (!WEBHOOK_SECRET || !given || given.length !== WEBHOOK_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ WEBHOOK_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'authorization, x-sync-source, x-full-sync, x-debug-id, x-check-scope, x-webhook-secret, content-type',
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);

  // ─ Scope check ──────────────────────────────────────────────────────────────
  // `x-check-scope: true` verifies the credentials can read BOTH modules without
  // touching Supabase. Run this first — the Books refresh token almost certainly
  // lacks leads/contacts scope.
  if (req.headers.get('x-check-scope')) {
    const usingCrmSecrets = Boolean(Deno.env.get('ZOHO_CRM_REFRESH_TOKEN'));
    try {
      const token = await getAccessToken();
      const out: Record<string, unknown> = {
        credentials: usingCrmSecrets ? 'ZOHO_CRM_*' : 'ZOHO_* (Books, reused)',
        webhook_secret_set: Boolean(WEBHOOK_SECRET),
      };
      for (const m of ['Leads', 'Contacts'] as Module[]) {
        const res = await fetch(
          `https://www.zohoapis.com/crm/v8/${m}?fields=Email&per_page=1`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
        );
        const body = await res.text();
        out[m] = { status: res.status, ok: res.ok || res.status === 204, body: body.slice(0, 400) };
      }
      return json(out);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  // ─ Webhook mode ─────────────────────────────────────────────────────────────
  // Zoho hits …/zoho-lead-sync/Leads or …/Contacts with the record id.
  //
  // The module is taken from the path in preference to ?module=. Zoho appends its
  // own parameters to whatever URL you configure, so handing it a URL that already
  // carries a query string invites a malformed concatenation. A path segment is
  // always safe to append to.
  const pathTail = (url.pathname.split('/').filter(Boolean).pop() ?? '').toLowerCase();
  const moduleParam = (pathTail === 'leads' || pathTail === 'contacts')
    ? pathTail
    : url.searchParams.get('module');
  if (moduleParam) {
    const module: Module | null =
      moduleParam.toLowerCase() === 'contacts' ? 'Contacts'
      : moduleParam.toLowerCase() === 'leads' ? 'Leads'
      : null;
    if (!module) return json({ error: `Unknown module "${moduleParam}"` }, 400);

    if (!WEBHOOK_SECRET) {
      return json({ error: 'ZOHO_WEBHOOK_SECRET is not set on the function' }, 503);
    }
    // Header is the intended slot. The query-string fallback exists because Zoho's
    // webhook UI offers no way to force a parameter into the header on every plan;
    // note that a secret in a URL does get written to the function logs.
    const givenSecret = req.headers.get('x-webhook-secret')
      ?? url.searchParams.get('x-webhook-secret')
      ?? url.searchParams.get('secret');
    if (!secretMatches(givenSecret)) {
      return json({ error: 'Bad or missing x-webhook-secret' }, 401);
    }

    const recordId = await extractRecordId(req, url);
    const logAction = `webhook_${module.toLowerCase()}`;
    if (!recordId) {
      await logSync(logAction, 400, undefined, 'No record id in payload');
      return json({ error: 'No numeric record id found in query or body' }, 400);
    }

    try {
      const token = await getAccessToken();
      const rec = await fetchOne(module, recordId, token);
      if (!rec) {
        // Deleted, merged, or out of scope between the event and this fetch.
        await deleteBatch([recordId]);
        await logSync(logAction, 200, recordId, 'Not found in Zoho — removed locally');
        return json({ module, id: recordId, action: 'deleted' });
      }
      const repMap = await loadRepMap();
      await upsertBatch([mapRecord(rec, module, repMap)]);
      await logSync(logAction, 200, recordId);
      return json({ module, id: recordId, action: 'upserted' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logSync(logAction, 500, recordId, message);
      return json({ error: message }, 500); // a 500 makes Zoho retry
    }
  }

  // ─ Debug single-record mode ─────────────────────────────────────────────────
  const debugId = req.headers.get('x-debug-id');
  if (debugId) {
    const m: Module = url.searchParams.get('m') === 'Contacts' ? 'Contacts' : 'Leads';
    try {
      const token = await getAccessToken();
      return json(await fetchOne(m, debugId, token) ?? { error: 'not found' });
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }

  // ─ Bulk sync (full or incremental) ──────────────────────────────────────────
  const startTime = Date.now();
  const isManual = req.headers.get('x-sync-source') !== 'cron';
  const isFullSync = req.headers.get('x-full-sync') === 'true';
  const action = isManual
    ? (isFullSync ? 'sync_leads_manual_full' : 'sync_leads_manual')
    : 'sync_leads_auto';

  const errors: string[] = [];
  const deadline = startTime + FULL_SYNC_BUDGET_MS;
  try {
    const token = await getAccessToken();
    const repMap = await loadRepMap();

    // Stamped before calling Zoho so records modified mid-run are picked up next
    // time rather than falling in the gap between runs.
    const syncStart = new Date();

    const results: Record<string, number> = {};
    let deleted = 0;
    let done = true;

    if (isFullSync) {
      // A full pass over ~29k records cannot finish inside the platform's 150s
      // request limit, so it runs in time-boxed slices. Progress is persisted per
      // module; call again until the response says done: true.
      let runStart = await readSyncStateOrNull(FULL_RUN_KEY);
      const resuming = runStart !== null;
      if (!runStart) {
        runStart = syncStart;
        await writeSyncState(FULL_RUN_KEY, runStart);
      }

      for (const module of ['Leads', 'Contacts'] as Module[]) {
        if (Date.now() > deadline) { done = false; break; }
        const key = module === 'Leads' ? 'crm_leads_full' : 'crm_contacts_full';

        // A finished module is marked so a later slice does not walk it again.
        // An absent token means "not started"; DONE_MARKER means "already walked".
        if (await readCursorToken(key) === DONE_MARKER) {
          results[`${module.toLowerCase()}_upserted`] = 0;
          continue;
        }

        // No If-Modified-Since — a full pass walks the entire module, and the
        // page_token alone carries the position.
        const r = await syncModule(module, token, repMap, null, errors, { deadline, cursorKey: key });
        results[`${module.toLowerCase()}_upserted`] = r.upserted;
        if (r.complete) await writeCursorToken(key, DONE_MARKER);
        else { done = false; break; }
      }

      if (done && errors.length === 0) {
        // Rows the pass never touched are candidates for deletion, but each is
        // confirmed against Zoho first — see reconcileStaleRows.
        const rec = await reconcileStaleRows(runStart, token, repMap, deadline);
        deleted = rec.deleted;
        results.repaired = rec.repaired;
        if (rec.pending > 0) {
          results.reconcile_pending = rec.pending;
          done = false; // finish the remaining candidates on the next call
        } else {
          await clearSyncState([FULL_RUN_KEY, 'crm_leads_full', 'crm_contacts_full']);
          // The incremental cursors can start from here — the data is now current.
          await writeSyncState('crm_leads', syncStart);
          await writeSyncState('crm_contacts', syncStart);
        }
      }
      results.resumed = resuming ? 1 : 0;

    } else {
      for (const module of ['Leads', 'Contacts'] as Module[]) {
        const key = module === 'Leads' ? 'crm_leads' : 'crm_contacts';
        const since = await readSyncState(key);
        const r = await syncModule(module, token, repMap, since, errors);
        results[`${module.toLowerCase()}_upserted`] = r.upserted;
        await writeSyncState(key, syncStart);
      }
    }

    const result = {
      ...results, deleted, done, errors,
      duration_ms: Date.now() - startTime,
      ...(done ? {} : { note: 'Time limit reached — call again to continue.' }),
    };
    await logSync(action, 200, undefined, errors.length > 0 ? errors.join(' | ') : undefined);
    return json(result);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSync(action, 500, undefined, message);
    return json({ error: message }, 500);
  }
});
