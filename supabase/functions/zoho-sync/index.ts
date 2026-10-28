// supabase/functions/zoho-sync/index.ts
// Syncs Zoho Books estimates → Supabase sales table
// Incremental: pg_cron every 5 min, uses last_modified_time filter (fast, 0-10 records)
// Full sync:   manual button in Settings with x-full-sync: true header

const ORGS = [
  { id: Deno.env.get('ZOHO_ORG_ID_QC') ?? '48244978', office: 'QC' },
  { id: Deno.env.get('ZOHO_ORG_ID_MTL') ?? '815683274', office: 'MTL' },
];

const DEPT_MAP: Record<string, string> = {
  'MÉDIA MULTI-ANNONCEURS': 'MULTI-ANNONCEURS',
  'MULTI-ANNONCEURS': 'MULTI-ANNONCEURS',
  'PROMOTIONNEL': 'PROMOTIONNEL',
  'DIST. PUBLICITAIRE SOLO': 'DIST. PUBLICITAIRE SOLO',
  'AGENCE PUB': 'NUMERIQUE',
  'NUMÉRIQUE': 'NUMERIQUE',
  'NUMERIQUE': 'NUMERIQUE',
  'AGENCE WEB': 'APPLICATION',
  'APPLICATION': 'APPLICATION',
  'SERVICES IA': 'SERVICES IA',
  // Added 2026-09-07, mirroring zoho-invoice-sync. Found only because the
  // syncs stopped discarding records whose department they did not know:
  // Zoho Books has been billing under EVENEMENT since May 2025.
  'ÉVÈNEMENT': 'EVENEMENT',
  'ÉVÉNEMENT': 'EVENEMENT',
  'EVENEMENT': 'EVENEMENT',
  'ÉVENEMENT': 'EVENEMENT',
};

// ─── Storing every quote, not only the won ones ───────────────────────────────
//
// Off until QUOTES_STORE_ALL_STATUSES is set in the project's secrets, so this
// can be deployed, dry-run and reviewed before it writes anything. A single run
// can also opt in with `x-store-all: true` without switching it on for the cron.
const STORE_ALL_ENV = (Deno.env.get('QUOTES_STORE_ALL_STATUSES') ?? '').toLowerCase() === 'true';

// Every quote is stored whatever its age or status: the quote list (get_quote_list)
// shows Zoho's whole history, and every revenue read filters on status.

// A full walk covers every status over the whole history — roughly 20k estimates
// across both orgs — which does not fit in one invocation. Requests are killed at
// 150s; stopping at 110s leaves room to persist the cursor and answer. Same
// budget zoho-lead-sync uses for the same reason.
const FULL_SYNC_BUDGET_MS = 110_000;

/**
 * Zoho's status → our enum, or null when we do not recognise it.
 *
 * Null is deliberate. The observed vocabulary is draft/sent/accepted/invoiced/
 * declined/expired, but it cannot be proven closed — `partially_invoiced` exists
 * in the API's filter list and returns nothing today — and an unrecognised value
 * hitting an enum column fails the INSERT, which takes the sync down. So the raw
 * string always lands in zoho_status, the mapped value lands in status, and
 * get_unmapped_status_summary() surfaces anything this function did not know.
 * Same shape as DEPT_MAP above, for the same reason.
 */
function mapStatus(raw: string): string | null {
  if (raw === 'accepted') return 'accepted';
  if (raw.includes('invoiced') || raw.includes('paid')) return 'invoiced';
  if (raw === 'declined' || raw === 'void' || raw === 'rejected') return 'declined';
  if (raw === 'sent') return 'sent';
  if (raw === 'draft') return 'draft';
  if (raw === 'expired') return 'expired';
  return null;
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

/** Format a Date as Zoho's expected last_modified_time string: "2026-04-13T10:30:45+0000" */
function toZohoTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '+0000');
}

// ─── Zoho Auth ────────────────────────────────────────────────────────────────

// Zoho throttles the OAuth refresh endpoint per refresh token, and every sync
// function shares one. Access tokens are valid an hour, so they are cached in
// zoho_oauth_token and reused across functions and invocations — only a miss
// costs a refresh. Renewed early so a token can never expire mid-run.
const TOKEN_CACHE_KEY = 'books';
const TOKEN_SKEW_MS = 5 * 60 * 1000;

/** Per-isolate copy, so a warm isolate skips even the PostgREST round trip. */
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
  // A cache miss must never break the sync — fall through to a live refresh.
  if (!res.ok) return null;
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

  const clientId = Deno.env.get('ZOHO_CLIENT_ID')!;
  const clientSecret = Deno.env.get('ZOHO_CLIENT_SECRET')!;
  const refreshToken = Deno.env.get('ZOHO_REFRESH_TOKEN')!;
  const url = `https://accounts.zoho.com/oauth/v2/token` +
    `?refresh_token=${refreshToken}&client_id=${clientId}` +
    `&client_secret=${clientSecret}&grant_type=refresh_token`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) throw new Error('Zoho token refresh failed: ' + JSON.stringify(data));
  // Zoho reports expires_in in seconds; default to the documented one hour.
  await writeCachedToken(data.access_token, Number(data.expires_in) || 3600);
  return data.access_token;
}

// ─── Supabase Helpers ─────────────────────────────────────────────────────────

async function upsertBatch(batch: object[]): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sales?on_conflict=zoho_id`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error('Supabase upsert failed: ' + await res.text());
}

async function declineBatch(zohoIds: string[]): Promise<void> {
  if (zohoIds.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sales?zoho_id=in.(${zohoIds.join(',')})`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({ status: 'declined' }),
  });
  if (!res.ok) throw new Error('Supabase decline patch failed: ' + await res.text());
}

async function deleteBatch(zohoIds: string[]): Promise<void> {
  for (let i = 0; i < zohoIds.length; i += 50) {
    const chunk = zohoIds.slice(i, i + 50).map(encodeURIComponent).join(',');
    const res = await fetch(`${SUPABASE_URL}/rest/v1/sales?zoho_id=in.(${chunk})`, {
      method: 'DELETE',
      headers: SB_HEADERS,
    });
    if (!res.ok) throw new Error('Supabase delete failed: ' + await res.text());
  }
}

/**
 * Ids of every sale a full sync is expected to see again, paged (a bare select is
 * capped at PostgREST's max_rows). Restricted to accepted/invoiced because a full sync
 * filters Zoho by those two statuses — declined rows are never returned and would
 * otherwise read as orphans and be deleted on every full sync.
 */
async function fetchOrphanCandidateIds(storeAll: boolean): Promise<string[]> {
  // The candidate set must match what the walk actually saw, or every row it
  // could not have seen reads as an orphan.
  //
  //   old behaviour  the walk asked Zoho for Accepted and Invoiced only, so only
  //                  those two statuses can be judged. A declined row is absent
  //                  from the walk while still existing, and deleting it loses it
  //                  for good — no later full sync fetches it back either.
  //   storing all    the walk asks for every status over the whole history, so
  //                  every row is fair game and the filter would wrongly protect
  //                  rows that really are gone.
  const statusFilter = storeAll ? '' : '&status=in.(accepted,invoiced)';
  const ids: string[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/sales?select=zoho_id${statusFilter}` +
        `&order=zoho_id.asc&limit=${pageSize}&offset=${offset}`,
      { headers: SB_HEADERS },
    );
    if (!res.ok) throw new Error('Sale id lookup failed: ' + await res.text());
    const rows = await res.json() as Array<{ zoho_id: string }>;
    ids.push(...rows.map((r) => r.zoho_id));
    if (rows.length < pageSize) return ids;
  }
}

// ─── Full-walk cursor ─────────────────────────────────────────────────────────
//
// A full walk does not fit in one 150s invocation, so it runs in slices and
// remembers where it got to. Stored as JSON in sync_state.cursor_token — the same
// column and the same idea zoho-lead-sync uses.
//
// The walk is ordered by created_time ASCENDING on purpose. Zoho's default is
// descending, which puts new estimates on page 1 and pushes everything else down,
// so a resumed numeric page would skip whatever shifted across the boundary.
// Ascending appends new records at the end, leaving earlier pages stable.

type WalkCursor = { org: number; page: number };

async function readWalkCursor(): Promise<WalkCursor | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sync_state?key=eq.devis&select=cursor_token`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) return null;
  const rows = await res.json() as Array<{ cursor_token: string | null }>;
  const raw = rows.length > 0 ? rows[0].cursor_token : null;
  if (!raw) return null;
  try { return JSON.parse(raw) as WalkCursor; } catch { return null; }
}

async function writeWalkCursor(cursor: WalkCursor | null): Promise<void> {
  // PATCH, not upsert: sync_state.last_modified_time is NOT NULL with no default,
  // so an upsert that omits it only survives because the row happens to exist.
  // The 'devis' row is created by readSyncState's own upsert; this only ever
  // updates it.
  await fetch(`${SUPABASE_URL}/rest/v1/sync_state?key=eq.devis`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({
      cursor_token: cursor ? JSON.stringify(cursor) : null,
      updated_at: new Date().toISOString(),
    }),
  });
}

/**
 * Ask Zoho whether one estimate still exists, and with what status.
 * exists === null means the answer was inconclusive (401/429/500) — never act on it.
 */
async function checkEstimateExists(
  zohoId: string,
  accessToken: string,
): Promise<{ exists: boolean | null; status: string | null }> {
  for (const org of ORGS) {
    const res = await fetch(
      `https://www.zohoapis.com/books/v3/estimates/${zohoId}?organization_id=${org.id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.ok) {
      const data = await res.json();
      return { exists: true, status: String((data.estimate ?? {}).status ?? '') };
    }
    let code: number | null = null;
    try { code = Number((await res.json())?.code ?? NaN); } catch { /* non-JSON body */ }
    // 1002 = resource not found. Try the other org before concluding it is gone.
    if (res.status !== 404 && code !== 1002) return { exists: null, status: null };
  }
  return { exists: false, status: null };
}

async function logSync(action: string, statusCode: number, message?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/webhook_log`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({ action, status_code: statusCode, zoho_id: null, error_message: message ?? null }),
  });
}

// ─── Sync State ───────────────────────────────────────────────────────────────

async function readSyncState(key: string): Promise<Date> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sync_state?key=eq.${key}&select=last_modified_time`,
    { headers: SB_HEADERS },
  );
  if (res.ok) {
    const rows = await res.json() as Array<{ last_modified_time: string }>;
    if (rows.length > 0) return new Date(rows[0].last_modified_time);
  }
  // Fallback if table row missing for some reason
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

async function writeSyncState(key: string, ts: Date): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/sync_state?on_conflict=key`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, last_modified_time: ts.toISOString(), updated_at: new Date().toISOString() }),
  });
}

// ─── Row ──────────────────────────────────────────────────────────────────────

/**
 * The stored row for one estimate, from a list page or a detail read. The list
 * carries custom fields at the top level (cf_d_partement); the detail only in
 * custom_field_hash, which is also the only place it has the acceptance date.
 * Null when the estimate has no date at all: sale_date is NOT NULL.
 */
function estimateRow(est: Record<string, unknown>, office: string): Record<string, unknown> | null {
  const cf = (est.custom_field_hash ?? {}) as Record<string, unknown>;
  const rawStatus = ((est.status as string) ?? '').toLowerCase();
  const quoteDate = (est.date as string) || null;
  const acceptedDate =
    (est.cf_date_acceptation_unformatted as string) ||
    (cf.cf_date_acceptation_unformatted as string) ||
    (est.accepted_date as string) || null;
  if (!quoteDate && !acceptedDate) return null;

  const deptLabel = (est.cf_d_partement ?? est.department ?? cf.cf_d_partement_unformatted) as string;
  return {
    zoho_id: String(est.estimate_id),
    // Unchanged formula, and it still means "when the money happened"
    // for a won quote. For one that was never accepted it falls back
    // to the issue date — which is why quote_date exists rather than
    // this column being reused as a cohort date.
    sale_date: acceptedDate || quoteDate,
    quote_date: quoteDate,
    accepted_date: acceptedDate,
    client_name: est.customer_name,
    // The Books customer, which the sales_fill_crm_account trigger
    // resolves to a CRM account through zoho_books_customers.
    books_customer_id: est.customer_id ? String(est.customer_id) : null,
    // Zoho's total, taxes included. The sales_pretax_amount trigger
    // derives amount as total minus Zoho's tax once zoho-pretax-sync has
    // read it from the estimate's detail (the list carries no tax), and
    // falls back to total / 1.14975 until then. amount is left out of
    // the payload so a re-sync never overwrites an exact figure.
    total_incl_tax: Number(est.total),
    quote_number: est.estimate_number,
    rep_name: (est.salesperson_name as string)?.trim() || null,
    zoho_department_label: deptLabel ? String(deptLabel) : null,
    department: DEPT_MAP[deptLabel] ?? null,
    office,
    zoho_status: rawStatus || null,
    status: mapStatus(rawStatus),
  };
}

// ─── Open quotes ──────────────────────────────────────────────────────────────
//
// Two changes to an open quote never reach the incremental sync, which reads
// only what Books reports as modified: a draft or sent quote deleted in Books,
// and one passing its expiry date, which turns expired without a new
// last_modified_time (Books does the same to overdue invoices). Either way the
// row stayed draft or sent here for good. At most once an hour this reads Books'
// Draft and Sent lists, writes the quotes whose status differs here, and reads
// back one by one every quote held as draft or sent that neither list carries:
// a 404 removes the row, anything else rewrites it from the detail payload.

const OPEN_CHECK_KEY = 'devis_open';
const OPEN_CHECK_EVERY_MS = 60 * 60 * 1000;
/** Detail reads per org and pass; the rest wait for the next pass. */
const OPEN_RECHECK_MAX = 25;

async function reconcileOpenQuotes(
  org: { id: string; office: string },
  accessToken: string,
  dryRun: boolean,
): Promise<{ complete: boolean; written: number; rewritten: number; removed: number; errors: string[] }> {
  const errors: string[] = [];
  const listed: Record<string, unknown>[] = [];
  for (const filter of ['Draft', 'Sent']) {
    for (let page = 1; ; page++) {
      const url = `https://www.zohoapis.com/books/v3/estimates` +
        `?organization_id=${org.id}&filter_by=Status.${filter}&page=${page}&per_page=200`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) {
        // A partial list would send quotes still open to a detail read for nothing.
        errors.push(`${org.office} open ${filter} p.${page}: ${await response.text()}`);
        return { complete: false, written: 0, rewritten: 0, removed: 0, errors };
      }
      const data = await response.json();
      listed.push(...(data.estimates ?? []));
      if (!(data.page_context as Record<string, boolean>)?.has_more_page) break;
    }
  }

  // Paged until an empty page: a bare select stops at PostgREST's row cap.
  const stored = new Map<string, string>();
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/sales?select=zoho_id,status&office=eq.${org.office}` +
        `&status=in.(draft,sent)&order=zoho_id.asc&limit=1000&offset=${offset}`,
      { headers: SB_HEADERS },
    );
    if (!res.ok) throw new Error('Open quote scan failed: ' + await res.text());
    const page = await res.json() as Array<{ zoho_id: string; status: string }>;
    if (page.length === 0) break;
    for (const r of page) stored.set(r.zoho_id, r.status);
  }

  // Only what differs is written, so an unchanged hour fires no Realtime event.
  const rows: object[] = [];
  for (const est of listed) {
    const row = estimateRow(est, org.office);
    if (row && stored.get(row.zoho_id as string) !== row.status) rows.push(row);
  }
  if (!dryRun) for (let i = 0; i < rows.length; i += 200) await upsertBatch(rows.slice(i, i + 200));

  const listedIds = new Set(listed.map((est) => String(est.estimate_id)));
  const stale = [...stored.keys()].filter((id) => !listedIds.has(id));
  let rewritten = 0;
  let removed = 0;
  for (const id of stale.slice(0, OPEN_RECHECK_MAX)) {
    const response = await fetch(
      `https://www.zohoapis.com/books/v3/estimates/${id}?organization_id=${org.id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (response.ok) {
      const row = estimateRow(((await response.json()).estimate ?? {}) as Record<string, unknown>, org.office);
      if (!row) { errors.push(`${org.office} open recheck ${id}: no date in Books, left as is`); continue; }
      if (!dryRun) await upsertBatch([row]);
      rewritten++;
      continue;
    }
    let code: number | null = null;
    try { code = Number((await response.json())?.code ?? NaN); } catch { /* non-JSON body */ }
    // 1002 = not found. Anything else (401/429/500) is no answer: never delete on it.
    if (response.status === 404 || code === 1002) {
      if (!dryRun) await deleteBatch([id]);
      removed++;
    } else {
      errors.push(`${org.office} open recheck ${id}: HTTP ${response.status}, left as is`);
    }
  }
  if (stale.length > OPEN_RECHECK_MAX) {
    errors.push(`${org.office} open recheck: ${stale.length - OPEN_RECHECK_MAX} left for the next pass`);
  }

  return { complete: true, written: rows.length, rewritten, removed, errors };
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'authorization, x-sync-source, x-full-sync, x-debug-id, x-dry-run, content-type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // ─ Debug single-record mode ─────────────────────────────────────────────────
  const debugId = req.headers.get('x-debug-id');
  if (debugId) {
    const debugOrg = req.headers.get('x-debug-org');
    try {
      const accessToken = await getAccessToken();
      const org = debugOrg ? (ORGS.find(o => o.office === debugOrg) ?? ORGS[0]) : ORGS[0];
      const res = await fetch(
        `https://www.zohoapis.com/books/v3/estimates/${debugId}?organization_id=${org.id}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const data = await res.json();
      return new Response(JSON.stringify(data.estimate ?? data, null, 2), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // ─ Normal sync ──────────────────────────────────────────────────────────────
  const startTime = Date.now();
  const isManual = req.headers.get('x-sync-source') !== 'cron';
  // An orphan sweep is a full walk restricted to the won statuses. That is the
  // only shape that still finishes in one invocation, and orphan detection needs
  // one invocation to have seen all of Zoho by itself — see the guard below.
  const isSweep = req.headers.get('x-orphan-sweep') === 'true';
  const isFullSync = req.headers.get('x-full-sync') === 'true' || isSweep;
  // Reports what the run WOULD write and remove, without writing or removing it.
  const isDryRun = req.headers.get('x-dry-run') === 'true';
  // Storing every status is off until the secret is set; a single run can opt in.
  // A sweep deliberately opts OUT of storing everything, even when the secret is
  // on: walking every status needs slicing, and a sliced walk can never sweep.
  const storeAll = !isSweep && (STORE_ALL_ENV || req.headers.get('x-store-all') === 'true');
  const action = isManual
    ? (isFullSync ? 'sync_manual_full' : 'sync_manual')
    : 'sync_auto';

  let totalUpserted = 0;
  let totalDeleted = 0;
  let totalDeclined = 0;
  let totalSkippedNoDate = 0;
  const byStatus: Record<string, number> = {};
  const unmapped: Record<string, number> = {};
  const errors: string[] = [];

  try {
    const accessToken = await getAccessToken();

    // Record sync start BEFORE calling Zoho so anything modified during this run
    // is picked up by the next run (no gap between runs).
    const syncStart = new Date();

    // Incremental: read last_modified_time from sync_state, pass to Zoho filter.
    // Full sync:   no time filter, Zoho returns all records, status filters applied.
    const lastModified = isFullSync ? null : await readSyncState('devis');

    const seenZohoIds = new Set<string>();

    // Zoho's estimates endpoint has NO working date filter. Verified against the
    // live API: date_start and date_after are both accepted and both ignored —
    // asking for 2026-09-01 onward, sorted ascending, returns EST-000003 dated
    // 2015-03-23, and page_context echoes no date criterion at all. So a full
    // walk cannot be narrowed by date; it is bounded by a deadline and resumed
    // from a cursor instead.
    const deadline = startTime + FULL_SYNC_BUDGET_MS;

    // Full sync, storing everything: one ordered walk per org over every status.
    // Full sync, won only (today): the old two status filters, far fewer pages.
    // Incremental: no status filter — last_modified_time catches every change.
    const statusFilters = isFullSync ? (storeAll ? [null] : ['Accepted', 'Invoiced']) : [null];

    // A sliced walk resumes where the last slice stopped. Only a full walk that
    // is storing everything is long enough to need this.
    const useCursor = isFullSync && storeAll;
    const startCursor = useCursor ? await readWalkCursor() : null;
    let walkComplete = true;

    // Set when the budget runs out. Without it the deadline `break` below only
    // leaves the page loop, control falls through to the next org, that org
    // immediately re-checks the deadline and overwrites the cursor with its own
    // position — so the org that actually ran out of time is never resumed and
    // the walk reports complete having skipped its tail.
    let outOfTime = false;

    for (let orgIdx = 0; orgIdx < ORGS.length && !outOfTime; orgIdx++) {
      const org = ORGS[orgIdx];
      // Resuming: skip the orgs the previous slice already finished.
      if (startCursor && orgIdx < startCursor.org) continue;

      for (const statusFilter of statusFilters) {
        if (outOfTime) break;
        let page = (startCursor && orgIdx === startCursor.org) ? startCursor.page : 1;
        let hasMore = true;

        while (hasMore) {
          // Out of time. Remember where we are and let the next call continue;
          // the walk is deliberately NOT marked complete, which is what keeps
          // orphan detection from running against a half-seen Zoho.
          // The budget applies to every full walk, not only the sliced ones. A
          // sweep that runs long stops itself and reports, rather than being
          // killed at the platform's 150s limit with nothing to show; and because
          // walkComplete goes false, it deletes nothing.
          if (isFullSync && Date.now() > deadline) {
            // A dry run must not persist the cursor. Leaving one behind would make
            // the first real run resume from it and never see the pages before it,
            // which is the opposite of what a rehearsal is for. So a dry run only
            // ever reports its first slice.
            if (useCursor && !isDryRun) await writeWalkCursor({ org: orgIdx, page });
            walkComplete = false;
            outOfTime = true;
            hasMore = false;
            break;
          }

          const lastModParam = lastModified
            ? `&last_modified_time=${encodeURIComponent(toZohoTimestamp(lastModified))}`
            : '';
          const statusParam = statusFilter ? `&filter_by=Status.${statusFilter}` : '';
          // Ascending on a full walk so numeric pages stay stable between slices:
          // Zoho's default descending order puts new estimates on page 1 and
          // pushes everything down, so a resumed page would skip whatever moved.
          const sortParam = useCursor ? '&sort_column=created_time&sort_order=A' : '';
          const url = `https://www.zohoapis.com/books/v3/estimates` +
            `?organization_id=${org.id}&page=${page}&per_page=200${statusParam}${lastModParam}${sortParam}`;

          const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!response.ok) {
            errors.push(`${org.office} p.${page}: ${await response.text()}`);
            walkComplete = false;
            break;
          }

          const data = await response.json();
          const estimates: Record<string, unknown>[] = data.estimates ?? [];
          if (estimates.length === 0) break;

          const toUpsert: object[] = [];
          const toDecline: string[] = [];

          for (const est of estimates) {
            const rawStatus = ((est.status as string) ?? '').toLowerCase();
            const zohoId = String(est.estimate_id);
            // Every estimate the walk saw, whether or not it is written. Orphan
            // detection asks "did Zoho show me this?", not "did I store it?".
            seenZohoIds.add(zohoId);

            const mapped = mapStatus(rawStatus);
            if (storeAll) {
              byStatus[mapped ?? `(unmapped:${rawStatus || 'empty'})`] =
                (byStatus[mapped ?? `(unmapped:${rawStatus || 'empty'})`] ?? 0) + 1;
              if (!mapped) unmapped[rawStatus || '(empty)'] = (unmapped[rawStatus || '(empty)'] ?? 0) + 1;
            }

            if (storeAll) {
              const row = estimateRow(est, org.office);
              if (!row) { totalSkippedNoDate++; continue; }
              toUpsert.push(row);
            } else if (rawStatus === 'accepted' || rawStatus.includes('invoiced') || rawStatus.includes('paid')) {
              // An unrecognised department no longer throws the quote away.
              // The old `if (department)` meant an estimate whose department
              // Zoho reports under a name DEPT_MAP does not know vanished with
              // no error and no log. It now lands with a null department,
              // keeping Zoho's raw label, and is reported by
              // get_unmapped_department_summary so the mapping can be fixed.
              const deptLabel = (est.cf_d_partement ?? est.department) as string;
              const department = DEPT_MAP[deptLabel] ?? null;
              toUpsert.push({
                zoho_id: zohoId,
                sale_date: (est.cf_date_acceptation_unformatted as string) || (est.accepted_date as string) || (est.date as string),
                client_name: est.customer_name,
                books_customer_id: est.customer_id ? String(est.customer_id) : null,
                total_incl_tax: Number(est.total), // amount: see the note above
                quote_number: est.estimate_number,
                rep_name: (est.salesperson_name as string)?.trim() || null,
                zoho_department_label: deptLabel ? String(deptLabel) : null,
                department,
                office: org.office,
                status: rawStatus === 'accepted' ? 'accepted' : 'invoiced',
                // Deliberately NOT set here. The estimates list carries no
                // creator at all - only the detail endpoint does, and only as an
                // id - so filling it costs one API call per quote. That runs in
                // zoho-quote-creator-sync at its own pace; leaving the column
                // out of this upsert is what stops a re-sync wiping a name the
                // back-fill already paid for.
              });
            } else if (rawStatus === 'declined' || rawStatus === 'void') {
              toDecline.push(zohoId);
            }
          }

          // A dry run counts what it would have written and writes nothing, so a
          // backfill this size can be inspected before it touches the table.
          if (toUpsert.length > 0) {
            if (!isDryRun) await upsertBatch(toUpsert);
            totalUpserted += toUpsert.length;
          }
          if (toDecline.length > 0 && !isDryRun) { await declineBatch(toDecline); }

          hasMore = (data.page_context as Record<string, boolean>)?.has_more_page ?? false;
          page++;
        }
      }
    }

    // The walk finished every org and page: clear the cursor so the next full
    // sync starts from the beginning rather than resuming a completed pass.
    if (useCursor && walkComplete && !isDryRun) await writeWalkCursor(null);

    // Orphan detection: only safe on a full sync that walked every Zoho page cleanly.
    // A mid-run Zoho error leaves seenZohoIds short, which reads as mass deletion —
    // bail out instead. Same guard for an implausibly large orphan set.
    if (isFullSync) {
      if (errors.length > 0) {
        errors.push('orphan detection skipped: Zoho paging was incomplete');
      } else if (!walkComplete) {
        // A run cut short by the deadline has only seen part of Zoho. Every row
        // it did not reach yet would read as an orphan, so this must wait for the
        // slice that finishes the walk. Not an error — just not finished.
        errors.push('orphan detection deferred: walk resumes on the next run');
      } else if (startCursor !== null) {
        // The slice that FINISHES a resumed walk has only the ids from its own
        // slice in seenZohoIds — the set does not survive across invocations. So
        // "complete" is not enough; orphan detection needs one invocation that saw
        // all of Zoho by itself, or it would read every earlier slice's rows as
        // orphans. The 5% ceiling below would stop the deletion, but silently, and
        // orphan detection would simply never run again.
        //
        // A won-only full sync (the default) still walks everything in one pass,
        // so this only defers while a storing-everything backfill is slicing. Run
        // one without x-store-all afterwards to sweep orphans.
        errors.push('orphan detection skipped: walk was resumed, so this run did not see all of Zoho by itself');
      } else {
        const existingIds = await fetchOrphanCandidateIds(storeAll);
        const orphanIds = existingIds.filter(id => !seenZohoIds.has(id));
        const maxOrphans = Math.max(50, Math.floor(existingIds.length * 0.05));
        if (orphanIds.length > maxOrphans) {
          errors.push(
            `orphan detection skipped: ${orphanIds.length} of ${existingIds.length} rows unseen ` +
            `(limit ${maxOrphans}) — investigate before deleting`,
          );
        } else if (orphanIds.length > 0) {
          // "Unseen" is not the same as "gone". A full sync filters Zoho by Accepted
          // and Invoiced, so a quote that has since been declined or expired is absent
          // from seenZohoIds while still existing — deleting it loses the row for good,
          // because a later full sync will not fetch it back either. Ask Zoho about each
          // candidate and only delete what Zoho genuinely no longer has.
          for (const id of orphanIds) {
            const { exists, status } = await checkEstimateExists(id, accessToken);
            if (exists === null) {
              errors.push(`orphan check inconclusive for ${id} — left untouched`);
            } else if (exists === false) {
              if (!isDryRun) await deleteBatch([id]);
              totalDeleted++;
            } else if (status === 'declined' || status === 'void') {
              if (!isDryRun) await declineBatch([id]);
              totalDeclined++;
            } else {
              errors.push(`${id} still exists in Zoho as "${status}" — kept`);
            }
          }
        }
      }
    }

    // Persist the timestamp we used at the start of this run.
    // Skip on full sync so we don't overwrite the incremental pointer.
    if (!isFullSync) {
      await writeSyncState('devis', syncStart);
    }

    // Open-quote pass, isolated: its failure must not fail the sync. The hourly
    // pointer moves only after a clean pass over both orgs.
    const open = { checked: false, written: 0, rewritten: 0, removed: 0 };
    if (!isFullSync && storeAll) {
      try {
        const due = req.headers.get('x-open-check') === 'true' ||
          Date.now() - (await readSyncState(OPEN_CHECK_KEY)).getTime() >= OPEN_CHECK_EVERY_MS;
        if (due) {
          const checkStart = new Date();
          let clean = true;
          for (const org of ORGS) {
            const r = await reconcileOpenQuotes(org, accessToken, isDryRun);
            open.written += r.written;
            open.rewritten += r.rewritten;
            open.removed += r.removed;
            if (!r.complete) clean = false;
            errors.push(...r.errors);
          }
          open.checked = true;
          if (clean && !isDryRun) await writeSyncState(OPEN_CHECK_KEY, checkStart);
        }
      } catch (err) {
        errors.push('open quotes: ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    const durationMs = Date.now() - startTime;
    const result = {
      upserted: totalUpserted,
      deleted: isDryRun ? 0 : totalDeleted,
      declined: totalDeclined,
      orphans_found: totalDeleted,
      dry_run: isDryRun,
      store_all: storeAll,
      sweep: isSweep,
      walk_complete: walkComplete,
      seen: seenZohoIds.size,
      ...(storeAll ? { by_status: byStatus, skipped_no_date: totalSkippedNoDate } : {}),
      ...(open.checked ? { open_checked: true, open_written: open.written,
                           open_rewritten: open.rewritten, open_removed: open.removed } : {}),
      ...(Object.keys(unmapped).length > 0 ? { unmapped_statuses: unmapped } : {}),
      errors,
      duration_ms: durationMs,
    };
    await logSync(action, 200, errors.length > 0 ? errors.join(' | ') : undefined);
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSync(action, 500, message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
