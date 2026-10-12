// supabase/functions/zoho-account-sync/index.ts
// Syncs Zoho CRM Accounts → the Supabase zoho_accounts table.
//
// This started as a two-field lookup — "Origine du client" and the service
// multiselect, the two things a Contact does not carry itself. It now backs the
// Comptes module, where the account IS the record, so it carries the full
// profile: owner, creation date, reach, segment and Zoho's Royer-only revenue
// rollups. See ACCOUNT_FIELDS for what is deliberately left behind.
//
// Three ways in, matching zoho-lead-sync:
//   1. Webhook   — Zoho workflow rule POSTs {id} to this function.
//                  Requires the x-webhook-secret header. Syncs that one account.
//   2. Full sync — header `x-full-sync: true`. Walks the whole module in slices.
//   3. Incremental — default. If-Modified-Since since the last cursor.
//
// SEPARATE from zoho-lead-sync on purpose. That function is 740 lines of
// two-module walk, conversion handling and orphan reconciliation, and it carries
// a scar from deleting 39 live contacts; Accounts write to a different table with
// a different shape, so folding them in would mean threading a target table
// through mapRecord, upsertBatch, deleteBatch and reconcileStaleRows for no
// shared behaviour. Same shape, separate blast radius.
//
// SCOPE: reading Accounts needs ZohoCRM.modules.accounts.READ on top of the
// leads + contacts + users scopes the shared CRM refresh token was issued with.
// It was missing at first; verified present on 2026-09-07 (`x-check-scope: true`
// → 200, readable). Re-check with that header before blaming anything else — a
// token without the scope returns 401 OAUTH_SCOPE_MISMATCH on every page and the
// walk silently upserts nothing while still reporting success.
//
// Unlike zoho-lead-sync this never deletes. An account removed in Zoho leaves a
// row nothing points at any more: zoho_leads_unique reaches it by
// account_id, so a dangling row contributes to no contact and costs one dead
// entry. That is a far better failure than the reverse, which is what cost those
// 39 contacts.

const CRM_ORG_ID = Deno.env.get('ZOHO_CRM_ORG_ID') ?? '48245615';
const WEBHOOK_SECRET = Deno.env.get('ZOHO_WEBHOOK_SECRET') ?? '';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// Zoho mangles the accents in "Intérêt pour quel service initialement" into
// underscores. Identical api_name on Leads and on Accounts, and — verified
// value-by-value on 2026-09-03 — an identical set of eight picklist values, so
// the two can share a column without translation.
const SERVICE_FIELD = 'Int_r_t_pour_quel_service_initialement';

// 43 fields of the 70 Accounts exposes. Zoho caps `fields` at 50 per request, so
// there are 7 left — anything added here should be something the Comptes module
// actually reads.
//
// Shipping_* is read too: contacts carry no postal address of their own, so the
// account's shipping address (billing when it has none) is where a contact is
// reached by mail, and what the Meta audience upload matches on.
//
// Left out on purpose: the five zthrive* loyalty fields, Currency/Exchange_Rate (one
// currency), Enrich_Status/Record_Status/Locked (Zoho housekeeping), and
// NUM/WEB/PROM/DIST/AUTRE — the per-department currency fields are abandoned in
// Zoho (LUMEN: $1.5M of Ventes_totales against NUM = 47.78, the rest null), and
// department revenue comes from invoices.department, which is maintained.
const ACCOUNT_FIELDS = [
  'id', 'Account_Name', 'Phone', 'Website', 'Description',
  'Billing_Street', 'Billing_City', 'Billing_State', 'Billing_Code', 'Billing_Country',
  'Shipping_Street', 'Shipping_City', 'Shipping_State', 'Shipping_Code', 'Shipping_Country',
  'Owner', 'Created_Time', 'Modified_Time', 'Last_Activity_Time',
  'Origine_du_client', SERVICE_FIELD, 'Domaine_d_activit',
  'R_gion_administrative_du_client', 'R_gion_cible', 'Type_de_march',
  'P_riode_publicitaire', 'Nombre_d_employ_s', 'Budget_publicitaire_annuel',
  'Potentiel_Multi_Annonceurs', 'Potentiel_Services_IA', 'Revendeur_de_nos_services',
  'Rating', 'Tag', 'Parent_Account',
  'Nombre_de_t_ches', 'Derni_re_T_che_Ferm_e', 'Charg_e_de_projets',
  // Royer & Fils / VotreLogo.ca revenue. Verified 2026-09-07:
  // SUM(Ventes_totales_2022_2026) is $5,530,878.34 over all 20,645 accounts and
  // $5,530,878.34 over the 2,028 Royer-origin ones — every account carrying a
  // value belongs to that cohort. Its invoices are billed outside the QC and MTL
  // Books orgs, so these fields are the only way that revenue reaches the app.
  'Ventes_2022', 'Ventes_2023', 'Ventes_2024', 'Ventes_2025', 'Ventes_2026',
  'Ventes_totales_2022_2026',
].join(',');

// ~20.6k accounts at 200 a page is ~104 requests, comfortably inside one
// invocation. The slicing below is kept anyway: it costs nothing when the walk
// finishes first time and is the difference between a resumable sync and one
// that restarts forever if the org grows.
const FULL_SYNC_BUDGET_MS = 110_000;
const FULL_CURSOR_KEY = 'crm_accounts_full';
const INCREMENTAL_KEY = 'crm_accounts_incremental';
/** Stored in sync_state.cursor_token once the full walk has finished. */
const DONE_MARKER = 'DONE';

/** Zoho CRM expects ISO 8601 with an explicit offset, e.g. 2026-07-10T00:00:00+00:00 */
function toZohoCrmTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

// ─── Zoho Auth ────────────────────────────────────────────────────────────────
// Shares the zoho_oauth_token cache (key 'crm') with zoho-lead-sync and
// zoho-task-sync: Zoho throttles the refresh endpoint per refresh token, and
// access tokens last an hour.

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

// ─── Supabase writes ──────────────────────────────────────────────────────────

async function upsertBatch(batch: object[]): Promise<void> {
  if (batch.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/zoho_accounts?on_conflict=zoho_account_id`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error('Supabase upsert failed: ' + await res.text());
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

// ─── Sync state ───────────────────────────────────────────────────────────────

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

async function writeSyncState(key: string, ts: Date): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/sync_state?on_conflict=key`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, last_modified_time: ts.toISOString(), updated_at: new Date().toISOString() }),
  });
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

// ─── Field mapping ────────────────────────────────────────────────────────────

interface ZohoLookup { name?: string; id?: string; email?: string }

/** email (lowercased) → app rep_name, so a Comptes figure and a Factures figure
 *  for the same person carry the same name. Same source as zoho-lead-sync. */
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

/** Zoho returns multiselects as string[], but a single value can arrive as a string. */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v];
  return [];
}

/**
 * '-None-' is what Zoho stores in a picklist that was never set. Left as NULL so
 * a caller can COALESCE past it rather than having to know the sentinel — the
 * filter-options RPC already strips it defensively on the leads side.
 */
function pickOrNull(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s === '-None-') return null;
  return s;
}

/**
 * Zoho returns Tag as [{name, id}], not as the plain string[] every other
 * multiselect uses. Handles both so a shape change does not silently empty the
 * column.
 */
function toTagArray(v: unknown): string[] {
  if (!Array.isArray(v)) return toStringArray(v);
  return v
    .map((t) => (typeof t === 'string' ? t : (t as ZohoLookup)?.name ?? ''))
    .filter(Boolean);
}

/** Zoho sends currency fields as a number, but an empty one arrives as null or ''. */
function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A Zoho date field is 'YYYY-MM-DD'; an unset one is null or ''. */
function toDateOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function mapAccount(rec: Record<string, unknown>, repMap: Record<string, string>): object {
  // Account_Name is plain text on Accounts, unlike on Contacts where it is the
  // lookup pointing here.
  const name = rec.Account_Name;
  const owner = (rec.Owner ?? {}) as ZohoLookup;
  const parent = (rec.Parent_Account ?? null) as ZohoLookup | null;
  const ownerEmail = owner.email?.toLowerCase() ?? null;
  const id = String(rec.id);

  return {
    zoho_account_id: id,
    account_name: typeof name === 'string'
      ? name
      : ((name as ZohoLookup | null)?.name ?? null),

    // Reach
    phone: pickOrNull(rec.Phone),
    website: pickOrNull(rec.Website),
    description: pickOrNull(rec.Description),
    billing_street: pickOrNull(rec.Billing_Street),
    billing_city: pickOrNull(rec.Billing_City),
    billing_state: pickOrNull(rec.Billing_State),
    billing_code: pickOrNull(rec.Billing_Code),
    billing_country: pickOrNull(rec.Billing_Country),
    shipping_street: pickOrNull(rec.Shipping_Street),
    shipping_city: pickOrNull(rec.Shipping_City),
    shipping_state: pickOrNull(rec.Shipping_State),
    shipping_code: pickOrNull(rec.Shipping_Code),
    shipping_country: pickOrNull(rec.Shipping_Country),

    // Ownership. rep_name falls back to Zoho's own owner name when the address is
    // not in allowed_users — an ex-rep's accounts should keep showing a name
    // rather than collapsing into a null bucket.
    owner_id: owner.id ?? null,
    owner_name: owner.name ?? null,
    owner_email: ownerEmail,
    rep_name: (ownerEmail && repMap[ownerEmail]) ? repMap[ownerEmail] : (owner.name ?? null),
    charge_de_projets: pickOrNull(rec.Charg_e_de_projets),

    // Dates. Zoho stamps these with the org's own offset (-04:00/-05:00), so they
    // are already Montreal wall-clock; Postgres stores the instant and the
    // scoped view reads them back AT TIME ZONE 'America/Toronto'.
    created_time: (rec.Created_Time as string) || null,
    modified_time: (rec.Modified_Time as string) || null,
    last_activity_time: (rec.Last_Activity_Time as string) || null,

    // Attribution and segmentation
    origine_du_client: pickOrNull(rec.Origine_du_client),
    service_interest: toStringArray(rec[SERVICE_FIELD]),
    domaine_activite: pickOrNull(rec.Domaine_d_activit),
    region_administrative: pickOrNull(rec.R_gion_administrative_du_client),
    region_cible: toStringArray(rec.R_gion_cible),
    type_marche: toStringArray(rec.Type_de_march),
    periode_publicitaire: toStringArray(rec.P_riode_publicitaire),
    nombre_employes: pickOrNull(rec.Nombre_d_employ_s),
    budget_publicitaire_annuel: toNumberOrNull(rec.Budget_publicitaire_annuel),
    potentiel_multi_annonceurs: pickOrNull(rec.Potentiel_Multi_Annonceurs),
    potentiel_services_ia: (rec.Potentiel_Services_IA as boolean) ?? null,
    revendeur: (rec.Revendeur_de_nos_services as boolean) ?? null,
    rating: pickOrNull(rec.Rating),
    tags: toTagArray(rec.Tag),

    // Hierarchy — recorded, not rolled up. A child keeps its own invoices.
    parent_account_id: parent?.id ?? null,
    parent_account_name: parent?.name ?? null,

    // Activity
    nombre_taches: rec.Nombre_de_t_ches === null || rec.Nombre_de_t_ches === undefined
      ? null
      : Number(rec.Nombre_de_t_ches),
    derniere_tache_fermee: toDateOrNull(rec.Derni_re_T_che_Ferm_e),

    // Royer & Fils / VotreLogo.ca only — see ACCOUNT_FIELDS. Never summed into
    // revenue_attributed or revenue_lifetime.
    ventes_2022: toNumberOrNull(rec.Ventes_2022),
    ventes_2023: toNumberOrNull(rec.Ventes_2023),
    ventes_2024: toNumberOrNull(rec.Ventes_2024),
    ventes_2025: toNumberOrNull(rec.Ventes_2025),
    ventes_2026: toNumberOrNull(rec.Ventes_2026),
    ventes_totales: toNumberOrNull(rec.Ventes_totales_2022_2026),

    zoho_crm_url: `https://crm.zoho.com/crm/org${CRM_ORG_ID}/tab/Accounts/${id}`,
    synced_at: new Date().toISOString(),
  };
}

// ─── Zoho fetching ────────────────────────────────────────────────────────────

async function fetchOne(id: string, token: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `https://www.zohoapis.com/crm/v8/Accounts/${id}` +
      `?fields=${encodeURIComponent(ACCOUNT_FIELDS)}`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
  );
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`Zoho Accounts/${id} → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data?.[0] ?? null;
}

/**
 * Walks Accounts from `since` forward, upserting as it goes, and stops when the
 * module is exhausted or `deadline` passes — whichever comes first.
 *
 * Ordered by Modified_Time ascending with the page_token persisted after every
 * page, so a run cut short by the platform's 150s limit resumes where it stopped.
 * Tokens rather than timestamps because a page whose records share one
 * Modified_Time gives a timestamp cursor no way to advance without skipping.
 */
async function syncAccounts(
  token: string,
  repMap: Record<string, string>,
  since: Date | null,
  errors: string[],
  opts: { deadline?: number; cursorKey?: string } = {},
): Promise<{ upserted: number; complete: boolean }> {
  const { deadline, cursorKey } = opts;
  let upserted = 0;
  let hasMore = true;
  let complete = false;
  let page = 1;
  const MAX_PAGES = 400;

  let pageToken: string | null = cursorKey ? await readCursorToken(cursorKey) : null;
  if (pageToken === DONE_MARKER) pageToken = null;

  // Held constant for the whole walk — changing it would invalidate the token.
  const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${token}` };
  if (since) headers['If-Modified-Since'] = toZohoCrmTimestamp(since);

  while (hasMore && page <= MAX_PAGES) {
    if (deadline && Date.now() > deadline) break; // resume on the next invocation

    const pageParam = pageToken
      ? `&page_token=${encodeURIComponent(pageToken)}`
      : `&page=${page}`;
    const url = `https://www.zohoapis.com/crm/v8/Accounts` +
      `?fields=${encodeURIComponent(ACCOUNT_FIELDS)}` +
      `&per_page=200&sort_by=Modified_Time&sort_order=asc${pageParam}`;

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
      errors.push(`Accounts p.${page}: ${body.slice(0, 300)}`);
      break;
    }

    const data = await res.json();
    const records: Record<string, unknown>[] = data.data ?? [];
    if (records.length === 0) { complete = true; break; }

    await upsertBatch(records.map((r) => mapAccount(r, repMap)));
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

  return { upserted, complete };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // `x-check-scope: true` answers the one question that decides whether any of
  // this works: does the shared CRM refresh token carry
  // ZohoCRM.modules.accounts.READ? It was issued for leads + contacts + users, so
  // the honest default assumption is no. Run this before scheduling the cron.
  if (req.headers.get('x-check-scope') === 'true') {
    try {
      const token = await getAccessToken();
      const res = await fetch(
        `https://www.zohoapis.com/crm/v8/Accounts?fields=Account_Name&per_page=1`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      );
      const body = await res.text();
      return json({
        module: 'Accounts',
        status: res.status,
        readable: res.ok || res.status === 204,
        // 401 OAUTH_SCOPE_MISMATCH here means the refresh token must be reissued
        // with ZohoCRM.modules.accounts.READ added to the existing scopes.
        detail: body.slice(0, 400),
      }, 200);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  // ── Webhook: one account by id ──
  // Zoho hits …/zoho-account-sync with the record id in the body.
  const recordId = await (async () => {
    if (req.method !== 'POST') return null;
    try {
      const body = await req.json();
      return (body?.id ?? body?.account_id ?? null) as string | null;
    } catch {
      return null;
    }
  })();

  if (recordId) {
    if (WEBHOOK_SECRET && req.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
      await logSync('webhook_accounts', 401, recordId, 'bad secret');
      return json({ error: 'Unauthorized' }, 401);
    }
    try {
      const token = await getAccessToken();
      const rec = await fetchOne(recordId, token);
      if (!rec) {
        // Deliberately not a delete — see the header note. A vanished account is
        // left in place because nothing reads a row no contact points at.
        await logSync('webhook_accounts', 200, recordId, 'not found in Zoho; left as is');
        return json({ id: recordId, action: 'absent' });
      }
      await upsertBatch([mapAccount(rec, await loadRepMap())]);
      await logSync('webhook_accounts', 200, recordId);
      return json({ id: recordId, action: 'upserted' });
    } catch (e) {
      await logSync('webhook_accounts', 500, recordId, String(e));
      return json({ error: String(e) }, 500);
    }
  }

  // ── Full sync, in slices ──
  const isFull = req.headers.get('x-full-sync') === 'true'
    || url.searchParams.get('full') === 'true';
  const errors: string[] = [];
  const deadline = Date.now() + FULL_SYNC_BUDGET_MS;

  try {
    const token = await getAccessToken();
    // One read for the whole walk: allowed_users holds 16 rows and does not
    // change mid-sync, so fetching it per page would be ~104 pointless requests.
    const repMap = await loadRepMap();

    if (isFull) {
      const done = await readCursorToken(FULL_CURSOR_KEY);
      if (done === DONE_MARKER && url.searchParams.get('restart') !== 'true') {
        return json({ mode: 'full', done: true, note: 'already complete; ?restart=true to walk again' });
      }
      if (url.searchParams.get('restart') === 'true') {
        await writeCursorToken(FULL_CURSOR_KEY, null);
      }

      // No If-Modified-Since: a full pass walks the entire module.
      const r = await syncAccounts(token, repMap, null, errors, { deadline, cursorKey: FULL_CURSOR_KEY });
      if (r.complete) {
        await writeCursorToken(FULL_CURSOR_KEY, DONE_MARKER);
        await writeSyncState(INCREMENTAL_KEY, new Date());
      }
      await logSync('accounts_full', errors.length ? 500 : 200, undefined,
                    errors.length ? errors.join(' | ').slice(0, 500) : undefined);
      return json({ mode: 'full', upserted: r.upserted, done: r.complete, errors });
    }

    // ── Incremental ──
    const since = await readSyncState(INCREMENTAL_KEY);
    const startedAt = new Date();
    const r = await syncAccounts(token, repMap, since, errors, { deadline });
    // Only advance the cursor on a clean pass; otherwise the next run re-covers
    // the same window rather than stepping over whatever failed.
    if (errors.length === 0) await writeSyncState(INCREMENTAL_KEY, startedAt);
    await logSync('accounts_incremental', errors.length ? 500 : 200, undefined,
                  errors.length ? errors.join(' | ').slice(0, 500) : undefined);
    return json({
      mode: 'incremental',
      since: since.toISOString(),
      upserted: r.upserted,
      org: CRM_ORG_ID,
      errors,
    });
  } catch (e) {
    await logSync('accounts_sync', 500, undefined, String(e));
    return json({ error: String(e) }, 500);
  }
});
