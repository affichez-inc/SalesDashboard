// supabase/functions/zoho-invoice-sync/index.ts
// Syncs Zoho Books invoices + credit notes → Supabase invoices table
// Incremental: pg_cron every 5 min, uses last_modified_time filter (fast, 0-10 records)
// Full sync:   manual button in Settings with x-full-sync: true header
//              Uses date_start=2025-01-01 so only 2025+ data is fetched (fits in 150s)
// Overdue:     at most once an hour (and on every full sync, or x-overdue-check: true),
//              re-reads Books' overdue list; see reconcileOverdue

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
  // Added 2026-09-07. Zoho Books has billed under this since May 2025 and the
  // app never saw a cent of it: 160 invoices, $142,918, discarded silently by
  // the `if (!dept) continue` that used to sit below. Every accent spelling is
  // listed because extractDept upper-cases but does not strip accents, and
  // Zoho's own wording is inconsistent across its two modules.
  'ÉVÈNEMENT': 'EVENEMENT',
  'ÉVÉNEMENT': 'EVENEMENT',
  'EVENEMENT': 'EVENEMENT',
  'ÉVENEMENT': 'EVENEMENT',
};

const STATUS_MAP: Record<string, string> = {
  paid:          'paid',
  partiallypaid: 'partial',
  sent:          'sent',
  overdue:       'overdue',
};

// Full sync window: 2025-01-01 — covers all app data, keeps the request well within 150s.
// Override per run with the x-date-start header. Needed once to back-fill
// books_customer_id onto the ~6,400 invoices dated before 2025, which the default
// window does not reach; pair it with x-date-end and x-org to slice a deep
// back-fill into requests that each finish inside the 150s budget.
const DEFAULT_FULL_SYNC_DATE_START = '2025-01-01';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

/**
 * Zoho Books filters a list on the `date` field with `date_start` / `date_end`.
 *
 * Not `date.start`: that form is accepted and silently ignored, so the request
 * comes back completely unfiltered. Verified against the live API on 2026-09-03 —
 * `date.start=2021-01-01&date.end=2021-12-31` returned byte-identical results to
 * sending no filter at all, while the underscore form correctly bounded them.
 * That is why the "full sync anchored at 2025-01-01" was in fact fetching the
 * entire history on every run.
 */
function dateRangeParam(start: string, end: string | null): string {
  return `&date_start=${start}` + (end ? `&date_end=${end}` : '');
}

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
  const res = await fetch(`${SUPABASE_URL}/rest/v1/invoices?on_conflict=zoho_id`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error('Supabase upsert failed: ' + await res.text());
}

async function deleteBatch(zohoIds: string[]): Promise<void> {
  for (let i = 0; i < zohoIds.length; i += 50) {
    const chunk = zohoIds.slice(i, i + 50).map(encodeURIComponent).join(',');
    const res = await fetch(`${SUPABASE_URL}/rest/v1/invoices?zoho_id=in.(${chunk})`, {
      method: 'DELETE',
      headers: SB_HEADERS,
    });
    if (!res.ok) throw new Error('Supabase delete failed: ' + await res.text());
  }
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
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

async function writeSyncState(key: string, ts: Date): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/sync_state?on_conflict=key`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, last_modified_time: ts.toISOString(), updated_at: new Date().toISOString() }),
  });
}

// ─── Field Extraction ─────────────────────────────────────────────────────────

/**
 * Zoho's own wording for the department, mapped or not. Stored alongside a null
 * `department` so get_unmapped_department_summary can name the label somebody
 * has to add to DEPT_MAP, rather than just reporting a count of mystery rows.
 */
function rawDeptLabel(record: Record<string, unknown>): string | null {
  let raw = (record.cf_d_partement ?? record.department ?? '') as string;
  if (!raw) {
    const fields = record.custom_fields as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(fields)) {
      const f = fields.find(
        (x) => x.api_name === 'cf_d_partement' || x.api_name === 'cf_departement' || x.label === 'Département',
      );
      raw = ((f?.value ?? f?.string_value ?? '') as string);
    }
  }
  return raw?.trim() || null;
}

function extractDept(record: Record<string, unknown>): { label: string; mapped: string } | null {
  // Try flat field first (invoices list returns cf_xxx inline)
  let raw = (record.cf_d_partement ?? record.department ?? '') as string;
  // Fallback: custom_fields array (credit notes use this format)
  if (!raw) {
    const fields = record.custom_fields as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(fields)) {
      const f = fields.find(
        (x) => x.api_name === 'cf_d_partement' || x.api_name === 'cf_departement' || x.label === 'Département',
      );
      raw = ((f?.value ?? f?.string_value ?? '') as string);
    }
  }
  const label = raw?.trim() ?? '';
  const mapped = DEPT_MAP[label.toUpperCase()] ?? DEPT_MAP[label] ?? null;
  if (!mapped) return null;
  return { label, mapped };
}

/**
 * Zoho credit notes store reference_number as e.g. "MTL-01892" (5-digit) while our DB
 * stores invoice_number as "MTL-001892" (6-digit zero-padded). Normalize before lookup.
 */
function normalizeInvoiceRef(ref: string): string {
  const match = ref.match(/^([A-Z]+-?)(\d+)$/);
  if (!match) return ref;
  const [, prefix, num] = match;
  return prefix + num.padStart(6, '0');
}

/**
 * Batch-lookup from a credit note's reference_number to the invoice it corrects.
 *
 * Returns the department AND the creator. Zoho gives a credit note neither: its
 * list payload carries no `created_by` at all — verified 2026-09-07, all 881
 * came back without one. So the only honest attribution is the person who
 * created the invoice being refunded, which is exactly who should carry the
 * reduction on the "Créé par" page.
 */
async function lookupDeptByInvoiceNumber(
  invoiceNumbers: string[],
  office: string,
): Promise<Map<string, { label: string; mapped: string; createdBy: string | null }>> {
  if (invoiceNumbers.length === 0) return new Map();
  const normalized = invoiceNumbers.map(normalizeInvoiceRef);
  const nums = normalized.map((n) => encodeURIComponent(n)).join(',');
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/invoices?select=invoice_number,department,zoho_department_label,created_by_name&office=eq.${office}&invoice_number=in.(${nums})`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) return new Map();
  const rows = await res.json() as Array<{
    invoice_number: string; department: string; zoho_department_label: string;
    created_by_name: string | null;
  }>;
  return new Map(rows.map((r) => [
    r.invoice_number,
    { label: r.zoho_department_label, mapped: r.department, createdBy: r.created_by_name },
  ]));
}

// ─── Sync Invoices ────────────────────────────────────────────────────────────

/** The row stored for one invoice of a Books list page; null for a status the table does not keep. */
function invoiceRow(inv: Record<string, unknown>, office: string): Record<string, unknown> | null {
  const rawStatus = ((inv.status as string) ?? '').toLowerCase().replace(/_/g, '');
  const mappedStatus = STATUS_MAP[rawStatus];
  if (!mappedStatus) return null;
  // An unrecognised department no longer throws the record away. Before
  // this, `continue` meant an invoice whose department Zoho reported under
  // a name DEPT_MAP does not know vanished with no error and no log -
  // harmless while the six live labels are all mapped, and a silent hole
  // in the revenue the day somebody adds a seventh. The row now lands with
  // a null department, keeps Zoho's raw label, and shows up in
  // get_unmapped_department_summary so the mapping can be fixed.
  const dept = extractDept(inv);
  return {
    zoho_id: String(inv.invoice_id),
    invoice_number: inv.invoice_number,
    client_name: inv.customer_name,
    // The Books customer behind this invoice. A DB trigger turns it into
    // crm_account_id once zoho-books-customer-link has resolved that
    // customer, which is what ties an invoice to a CRM contact.
    books_customer_id: String(inv.customer_id ?? '') || null,
    amount: Math.round((Number(inv.total) / 1.14975) * 100) / 100,
    rep_name: (inv.salesperson_name as string)?.trim() || null,
    // Who keyed the invoice in, which is routinely NOT the salesperson:
    // the first record sampled on 2026-09-07 was created_by "Morgane
    // Owczarzak" with salesperson "Dominic Letendre". Free - Zoho puts it
    // on the list payload, unlike estimates, which need a detail call
    // each (see zoho-quote-creator-sync).
    created_by_name: (inv.created_by as string)?.trim() || null,
    zoho_department_label: dept?.label ?? rawDeptLabel(inv),
    department: dept?.mapped ?? null,
    office,
    invoice_date: inv.date,
    status: mappedStatus,
    is_avoir: false,
  };
}

async function syncInvoices(
  org: { id: string; office: string },
  accessToken: string,
  lastModified: Date | null,
  touched: Set<string>,
  statusOverride: string | null = null,
  dateStart: string = DEFAULT_FULL_SYNC_DATE_START,
  dateEnd: string | null = null,
): Promise<{ upserted: number; errors: string[] }> {
  let upserted = 0;
  const errors: string[] = [];

  // Zoho Books ignores date_start/date_end whenever filter_by is also present —
  // verified against the live API on 2026-09-03: QC with filter_by=Status.Sent and
  // a two-day 2019 window still returned all 114 Sent invoices. The two are
  // mutually exclusive, so the full sync picks one.
  //
  // It picks the date window. Splitting by status was only ever a way to keep a
  // request under 150s without a working date filter, and it splits badly — Paid
  // holds most of the book, so that one slice times out while the other three
  // return in seconds. A date window splits evenly and needs one pass instead of
  // four. Statuses we do not store are dropped by STATUS_MAP below, exactly as
  // the incremental path already does.
  //
  // x-status remains for re-fetching a single status without a date bound; it
  // turns the date filter off because Zoho would ignore it anyway.
  const useStatusFilter = lastModified === null && statusOverride !== null;
  const statusFilters = useStatusFilter ? [statusOverride] : [null];

  for (const statusFilter of statusFilters) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const lastModParam = lastModified
        ? `&last_modified_time=${encodeURIComponent(toZohoTimestamp(lastModified))}`
        : '';
      const statusParam = statusFilter ? `&filter_by=Status.${statusFilter}` : '';
      // Full sync: anchor to dateStart so we don't pull years of old invoices, and
      // optionally cap at dateEnd so a deep back-fill can be sliced by year. Never
      // sent alongside filter_by, which would silently void it.
      const dateParam = (lastModified === null && !useStatusFilter)
        ? dateRangeParam(dateStart, dateEnd)
        : '';
      const url = `https://www.zohoapis.com/books/v3/invoices` +
        `?organization_id=${org.id}&page=${page}&per_page=200${statusParam}${lastModParam}${dateParam}`;

      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) {
        errors.push(`${org.office} invoices(${statusFilter ?? 'all'}) p.${page}: ${await response.text()}`);
        break;
      }

      const data = await response.json();
      const invoices: Record<string, unknown>[] = data.invoices ?? [];
      if (invoices.length === 0) break;

      const toUpsert: object[] = [];
      for (const inv of invoices) {
        const row = invoiceRow(inv, org.office);
        if (!row) continue;
        touched.add(String(inv.invoice_number));
        toUpsert.push(row);
      }

      if (toUpsert.length > 0) { await upsertBatch(toUpsert); upserted += toUpsert.length; }
      hasMore = (data.page_context as Record<string, boolean>)?.has_more_page ?? false;
      page++;
    }
  }

  return { upserted, errors };
}

// ─── Sync Credit Notes ────────────────────────────────────────────────────────

async function syncCreditNotes(
  org: { id: string; office: string },
  accessToken: string,
  lastModified: Date | null,
  touched: Set<string>,
  dateStart: string = DEFAULT_FULL_SYNC_DATE_START,
  dateEnd: string | null = null,
): Promise<{ upserted: number; errors: string[] }> {
  let page = 1;
  let hasMore = true;
  let upserted = 0;
  const errors: string[] = [];

  while (hasMore) {
    const lastModParam = lastModified
      ? `&last_modified_time=${encodeURIComponent(toZohoTimestamp(lastModified))}`
      : '';
    // Full sync: anchor to dateStart, optionally capped at dateEnd
    const dateParam = lastModified === null ? dateRangeParam(dateStart, dateEnd) : '';
    const url = `https://www.zohoapis.com/books/v3/creditnotes` +
      `?organization_id=${org.id}&page=${page}&per_page=200${lastModParam}${dateParam}`;

    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      errors.push(`${org.office} creditnotes p.${page}: ${await response.text()}`);
      break;
    }

    const data = await response.json();
    const notes: Record<string, unknown>[] = data.creditnotes ?? [];
    if (notes.length === 0) break;

    type Pending = {
      note: Record<string, unknown>;
      dept: { label: string; mapped: string } | null;
      createdBy: string | null;
    };
    const pending: Pending[] = [];
    for (const note of notes) {
      const rawStatus = ((note.status as string) ?? '').toLowerCase();
      if (rawStatus === 'void') continue;
      pending.push({ note, dept: extractDept(note), createdBy: null });
    }

    // Batch-lookup dept for notes that had no inline dept field
    const needsLookup = pending.filter((p) => p.dept === null);
    if (needsLookup.length > 0) {
      const refNums = [...new Set(
        needsLookup.map((p) => (p.note.reference_number as string)?.trim()).filter(Boolean),
      )];
      const deptByInv = await lookupDeptByInvoiceNumber(refNums, org.office);
      for (const p of needsLookup) {
        const ref = (p.note.reference_number as string)?.trim();
        const normalizedRef = ref ? normalizeInvoiceRef(ref) : null;
        const hit = normalizedRef ? deptByInv.get(normalizedRef) : undefined;
        if (hit) {
          p.dept = { label: hit.label, mapped: hit.mapped };
          p.createdBy = hit.createdBy;
        }
      }
    }

    const toUpsert: object[] = [];
    for (const { note, dept, createdBy } of pending) {
      // Same rule as invoices above: land it with a null department rather than
      // losing it. A credit note is money leaving; dropping one silently
      // overstates revenue.
      touched.add(String(note.creditnote_number));
      toUpsert.push({
        zoho_id: String(note.creditnote_id),
        invoice_number: note.creditnote_number,
        client_name: note.customer_name,
        books_customer_id: String(note.customer_id ?? '') || null,
        amount: Math.round((Number(note.total) / 1.14975) * 100) / 100 * -1,
        rep_name: (note.salesperson_name as string)?.trim() || null,
        // Zoho sends no creator on a credit note, so this falls back to the
        // creator of the invoice being refunded, inherited above. Without it the
        // "Créé par" page shows billing with none of the matching refunds, and
        // its totals can never agree with the account detail page.
        created_by_name: (note.created_by as string)?.trim() || createdBy,
        zoho_department_label: dept?.label ?? rawDeptLabel(note),
        department: dept?.mapped ?? null,
        office: org.office,
        invoice_date: note.date,
        status: 'avoir',
        is_avoir: true,
      });
    }

    if (toUpsert.length > 0) { await upsertBatch(toUpsert); upserted += toUpsert.length; }
    hasMore = (data.page_context as Record<string, boolean>)?.has_more_page ?? false;
    page++;
  }

  return { upserted, errors };
}

// ─── Overdue Status ───────────────────────────────────────────────────────────
// Books turns an invoice overdue once its due date passes without touching
// last_modified_time, so the incremental sync never reads it again and the row
// keeps `sent`. Measured 2026-10-13: 63 of the 201 invoices Books listed as
// overdue were still `sent` here. This pass reads Books' overdue list (a page or
// two per org) and writes those rows. A row stored as overdue that Books no
// longer lists (paid, due date moved, voided) is read back one by one.

const OVERDUE_CHECK_KEY = 'invoices_overdue';
const OVERDUE_CHECK_EVERY_MS = 60 * 60 * 1000;
/** Detail reads per org and pass; the rest wait for the next pass. */
const OVERDUE_RECHECK_MAX = 25;

async function setInvoiceStatus(zohoId: string, status: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/invoices?zoho_id=eq.${encodeURIComponent(zohoId)}`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error('Supabase status update failed: ' + await res.text());
}

async function reconcileOverdue(
  org: { id: string; office: string },
  accessToken: string,
  touched: Set<string>,
): Promise<{ complete: boolean; marked: number; cleared: number; errors: string[] }> {
  const errors: string[] = [];
  const listed: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    // filter_by alone: Zoho drops a date range sent beside it.
    const url = `https://www.zohoapis.com/books/v3/invoices` +
      `?organization_id=${org.id}&filter_by=Status.OverDue&page=${page}&per_page=200`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      // A partial list would read as "no longer overdue" below: stop here.
      errors.push(`${org.office} overdue p.${page}: ${await response.text()}`);
      return { complete: false, marked: 0, cleared: 0, errors };
    }
    const data = await response.json();
    listed.push(...(data.invoices ?? []));
    if (!(data.page_context as Record<string, boolean>)?.has_more_page) break;
  }

  // Paged until an empty page: a bare select stops at PostgREST's row cap.
  const stored = new Set<string>();
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/invoices?select=zoho_id&office=eq.${org.office}` +
        `&status=eq.overdue&is_avoir=is.false&order=zoho_id.asc&limit=1000&offset=${offset}`,
      { headers: SB_HEADERS },
    );
    if (!res.ok) throw new Error('Overdue scan failed: ' + await res.text());
    const page = await res.json() as Array<{ zoho_id: string }>;
    if (page.length === 0) break;
    for (const r of page) stored.add(r.zoho_id);
  }
  const listedIds = new Set(listed.map((inv) => String(inv.invoice_id)));

  // The list payload is the one the incremental sync stores, so the whole row is
  // written: an overdue invoice the table has never seen lands too.
  const rows: object[] = [];
  for (const inv of listed) {
    const row = invoiceRow(inv, org.office);
    if (!row) continue;
    touched.add(String(inv.invoice_number));
    rows.push(row);
  }
  for (let i = 0; i < rows.length; i += 200) await upsertBatch(rows.slice(i, i + 200));
  const marked = [...listedIds].filter((id) => !stored.has(id)).length;

  // The detail payload lacks fields the list carries (created_by), so only the
  // status is written back. A record Books no longer has is left to the reaper.
  let cleared = 0;
  const stale = [...stored].filter((id) => !listedIds.has(id));
  for (const id of stale.slice(0, OVERDUE_RECHECK_MAX)) {
    const response = await fetch(
      `https://www.zohoapis.com/books/v3/invoices/${id}?organization_id=${org.id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) {
      errors.push(`${org.office} overdue recheck ${id}: HTTP ${response.status}`);
      await response.body?.cancel();
      continue;
    }
    const inv = ((await response.json()).invoice ?? {}) as Record<string, unknown>;
    const raw = String(inv.status ?? '').toLowerCase().replace(/_/g, '');
    const status = raw === 'void' ? 'void' : STATUS_MAP[raw];
    if (!status || status === 'overdue') {
      errors.push(`${org.office} overdue recheck ${id}: Books status "${inv.status}" left as is`);
      continue;
    }
    await setInvoiceStatus(id, status);
    cleared++;
  }
  if (stale.length > OVERDUE_RECHECK_MAX) {
    errors.push(`${org.office} overdue recheck: ${stale.length - OVERDUE_RECHECK_MAX} left for the next pass`);
  }

  return { complete: true, marked, cleared, errors };
}

// ─── Duplicate Reaper ─────────────────────────────────────────────────────────
// When the payer entity changes, accounting deletes the invoice in Zoho and re-issues
// it with the SAME number under the new customer account. We only ever upsert on
// zoho_id and never delete, so the dead row survived here and its amount was counted
// twice. Zoho is the source of truth: a zoho_id that 404s no longer exists — drop it.

const ORG_BY_OFFICE: Record<string, string> = Object.fromEntries(ORGS.map((o) => [o.office, o.id]));

interface DupRow {
  zoho_id: string;
  invoice_number: string;
  office: string | null;
  is_avoir: boolean;
  amount: number;
  client_name: string;
}

const DUP_COLS = 'zoho_id,invoice_number,office,is_avoir,amount,client_name';

/** Every invoice row, paged — a bare select is capped at PostgREST's max_rows (1000). */
async function fetchAllInvoiceRows(): Promise<DupRow[]> {
  const rows: DupRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/invoices` +
        `?select=${DUP_COLS}&order=zoho_id.asc&limit=${pageSize}&offset=${offset}`,
      { headers: SB_HEADERS },
    );
    if (!res.ok) throw new Error('Invoice scan failed: ' + await res.text());
    const page = await res.json() as DupRow[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/** Rows carrying one of the given invoice numbers. */
async function fetchRowsByNumber(numbers: string[]): Promise<DupRow[]> {
  const rows: DupRow[] = [];
  for (let i = 0; i < numbers.length; i += 100) {
    const list = numbers.slice(i, i + 100)
      .map((num) => `"${num.replace(/"/g, '\\"')}"`)
      .map(encodeURIComponent)
      .join(',');
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/invoices?select=${DUP_COLS}&invoice_number=in.(${list})`,
      { headers: SB_HEADERS },
    );
    if (!res.ok) throw new Error('Invoice lookup failed: ' + await res.text());
    rows.push(...await res.json() as DupRow[]);
  }
  return rows;
}

/** Group by (invoice_number, office), keeping only the collisions. */
function duplicateGroups(rows: DupRow[]): Map<string, DupRow[]> {
  const groups = new Map<string, DupRow[]>();
  for (const row of rows) {
    if (!row.invoice_number) continue;
    const key = `${row.invoice_number}|${row.office ?? ''}`;
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  for (const [key, group] of groups) {
    if (group.length < 2) groups.delete(key);
  }
  return groups;
}

type Existence = 'alive' | 'deleted' | 'unknown';

/** Ask Zoho whether one record still exists. Anything inconclusive stays 'unknown'. */
async function checkZohoExistence(row: DupRow, accessToken: string): Promise<Existence> {
  const orgId = row.office ? ORG_BY_OFFICE[row.office] : undefined;
  if (!orgId) return 'unknown';
  const resource = row.is_avoir ? 'creditnotes' : 'invoices';
  const url = `https://www.zohoapis.com/books/v3/${resource}/${row.zoho_id}` +
    `?organization_id=${orgId}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.ok) { await res.body?.cancel(); return 'alive'; }

  let code: number | null = null;
  try { code = Number((await res.json())?.code ?? NaN); } catch { /* non-JSON error body */ }
  // 1002 = "the requested resource could not be found or accessed" — deleted in Zoho.
  if (res.status === 404 || code === 1002) return 'deleted';
  return 'unknown'; // 401/429/500 etc. — never delete on an answer we can't trust
}

/**
 * Resolve every duplicate group against Zoho and delete the rows Zoho no longer has.
 * Deliberately conservative — a group is left untouched unless every one of its rows
 * gave an unambiguous answer and at least one of them survives.
 *
 * `touched` limits the search to the numbers this run just upserted, which is all an
 * incremental sync needs: a collision can only appear when a new row lands. Pass null
 * to sweep the whole table (full sync, or a one-off x-prune-only run).
 */
async function pruneDeletedDuplicates(
  accessToken: string,
  dryRun: boolean,
  touched: Set<string> | null,
): Promise<{ deleted: string[]; skipped: string[] }> {
  const deleted: string[] = [];
  const skipped: string[] = [];

  const rows = touched
    ? (touched.size === 0 ? [] : await fetchRowsByNumber([...touched]))
    : await fetchAllInvoiceRows();

  for (const [key, group] of duplicateGroups(rows)) {
    const verdicts = await Promise.all(group.map((r) => checkZohoExistence(r, accessToken)));

    if (verdicts.includes('unknown')) {
      skipped.push(`${key}: Zoho lookup inconclusive`);
      continue;
    }
    const dead = group.filter((_, i) => verdicts[i] === 'deleted');
    if (dead.length === 0) {
      skipped.push(`${key}: all ${group.length} rows still exist in Zoho — number reused, review manually`);
      continue;
    }
    if (dead.length === group.length) {
      skipped.push(`${key}: all ${group.length} rows gone from Zoho — review manually`);
      continue;
    }

    if (!dryRun) await deleteBatch(dead.map((r) => r.zoho_id));
    for (const r of dead) {
      deleted.push(`${key} id=${r.zoho_id} ${r.amount} ${r.client_name}`);
    }
  }

  return { deleted, skipped };
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'authorization, x-sync-source, x-full-sync, x-org, x-status, x-date-start, x-probe, ' +
      'x-date-end, x-prune, x-prune-only, x-dry-run, x-overdue-check, content-type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // ── x-probe: read-only reconnaissance, writes nothing ──
  //
  // Answers two questions that cannot be answered from the database, and that
  // both block work asked for in the 2026-09-04 meeting:
  //
  //   1. How many Zoho Books organisations can this token see? ORGS below is
  //      hardcoded to QC + MTL, but the Royer & Fils / VotreLogo.ca business is
  //      billed in neither, and $5.5M of CRM revenue has no invoice behind it
  //      here. If a third org is visible, that money is reachable.
  //
  //   2. Does an estimate or an invoice carry the person who CREATED it, as
  //      opposed to salesperson_name (who owns the sale)? Dominic asked to count
  //      "les devis creees par" Morgane and Guillaume even when someone else is
  //      the salesperson, which needs a different field from the one we store.
  //
  // Returns the org list plus every key present on one estimate and one invoice,
  // so the answer is what Zoho actually sends rather than what the docs claim.
  if (req.headers.get('x-probe') === 'true') {
    try {
      const token = await getAccessToken();
      const zh = { Authorization: `Zoho-oauthtoken ${token}` };

      const orgRes = await fetch('https://www.zohoapis.com/books/v3/organizations', { headers: zh });
      const orgBody = await orgRes.json().catch(() => ({}));
      const orgs = (orgBody.organizations ?? []).map((o: Record<string, unknown>) => ({
        organization_id: o.organization_id,
        name: o.name,
        is_default_org: o.is_default_org,
        currency_code: o.currency_code,
      }));

      // One record from each module, at detail level: Zoho's LIST payload is a
      // subset of the DETAIL payload, so both are sampled - a field that exists
      // only on detail still means one extra call per record to sync it.
      const sample = async (module: string, listKey: string, idKey: string) => {
        const qc = ORGS[0].id;
        const listRes = await fetch(
          `https://www.zohoapis.com/books/v3/${module}?organization_id=${qc}&per_page=1`,
          { headers: zh },
        );
        const listBody = await listRes.json().catch(() => ({}));
        const first = (listBody[listKey] ?? [])[0];
        if (!first) return { module, error: `no ${listKey} returned`, status: listRes.status };
        const id = first[idKey];
        const detRes = await fetch(
          `https://www.zohoapis.com/books/v3/${module}/${id}?organization_id=${qc}`,
          { headers: zh },
        );
        const detBody = await detRes.json().catch(() => ({}));
        const detail = detBody[listKey.replace(/s$/, '')] ?? {};
        const creatorish = (obj: Record<string, unknown>) =>
          Object.fromEntries(Object.entries(obj).filter(([k]) =>
            /creat|author|user|owner|salesperson|last_modified/i.test(k)));
        return {
          module,
          list_keys: Object.keys(first).sort(),
          detail_keys: Object.keys(detail).sort(),
          list_creator_fields: creatorish(first),
          detail_creator_fields: creatorish(detail),
        };
      };

      // Estimates carry only created_by_id, so a name needs the org's user list.
      // Confirm it is readable and how many rows it holds before planning a sync
      // that depends on it.
      const usersOut: Record<string, unknown> = {};
      for (const org of ORGS) {
        const uRes = await fetch(
          `https://www.zohoapis.com/books/v3/users?organization_id=${org.id}&per_page=200`,
          { headers: zh },
        );
        const uBody = await uRes.json().catch(() => ({}));
        const users = (uBody.users ?? []) as Record<string, unknown>[];
        usersOut[org.office] = {
          status: uRes.status,
          count: users.length,
          sample: users.slice(0, 3).map((u) => ({ user_id: u.user_id, name: u.name, email: u.email, status: u.status })),
        };
      }

      return new Response(JSON.stringify({
        orgs_visible: orgs,
        orgs_configured: ORGS,
        estimates: await sample('estimates', 'estimates', 'estimate_id'),
        invoices: await sample('invoices', 'invoices', 'invoice_id'),
        users: usersOut,
      }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  const startTime = Date.now();
  const isManual = req.headers.get('x-sync-source') !== 'cron';
  const isFullSync = req.headers.get('x-full-sync') === 'true';
  // x-org: optional — restrict to a single office (QC or MTL).
  const orgFilter = req.headers.get('x-org')?.toUpperCase() ?? null;
  // x-status: optional — restrict full sync to a single Zoho status (e.g. "Sent", "Overdue").
  // Use this to back-fill a single status without re-fetching all paid/partial records.
  const statusOverride = req.headers.get('x-status') ?? null;
  // x-date-start: optional — move the full-sync window back, e.g. "2021-01-01" to
  // reach invoices older than the default. Rejected unless it is a plain ISO date,
  // since it goes straight into the Zoho query string.
  const rawDateStart = req.headers.get('x-date-start');
  if (rawDateStart && !/^\d{4}-\d{2}-\d{2}$/.test(rawDateStart)) {
    return new Response(
      JSON.stringify({ error: 'x-date-start must be YYYY-MM-DD' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
  const dateStart = rawDateStart ?? DEFAULT_FULL_SYNC_DATE_START;
  // x-date-end: optional upper bound, so a deep back-fill can be run one year at
  // a time. QC alone has 11k invoices — an unbounded 2021→today pass exceeds 150s.
  const rawDateEnd = req.headers.get('x-date-end');
  if (rawDateEnd && !/^\d{4}-\d{2}-\d{2}$/.test(rawDateEnd)) {
    return new Response(
      JSON.stringify({ error: 'x-date-end must be YYYY-MM-DD' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
  const dateEnd = rawDateEnd ?? null;
  // Duplicate reaper: runs after every sync. x-prune: false opts out,
  // x-prune-only: true skips the sync, x-dry-run: true reports without deleting.
  const isPruneOnly = req.headers.get('x-prune-only') === 'true';
  const skipPrune = req.headers.get('x-prune') === 'false';
  const isDryRun = req.headers.get('x-dry-run') === 'true';
  // x-overdue-check: true runs the overdue pass now instead of waiting for the hour.
  const forceOverdueCheck = req.headers.get('x-overdue-check') === 'true';
  const action = isPruneOnly
    ? 'prune_invoice_duplicates'
    : isManual
    ? (isFullSync ? 'sync_invoices_manual_full' : 'sync_invoices_manual')
    : 'sync_invoices_auto';

  let totalUpserted = 0;
  const overdue = { checked: false, marked: 0, cleared: 0 };
  let pruneResult: { deleted: string[]; skipped: string[] } = { deleted: [], skipped: [] };
  const allErrors: string[] = [];

  const orgsToProcess = orgFilter ? ORGS.filter(o => o.office === orgFilter) : ORGS;

  try {
    const accessToken = await getAccessToken();

    // Record sync start BEFORE calling Zoho so anything modified during this run
    // is picked up by the next run (no gap between runs).
    const syncStart = new Date();

    // Full sync: no time filter (fetch 2025-01-01 → today with status filter).
    // Incremental: read last_modified_time from sync_state.
    const lastModified = isFullSync ? null : await readSyncState('invoices');

    const touched = new Set<string>();

    if (!isPruneOnly) {
      for (const org of orgsToProcess) {
        const invResult = await syncInvoices(org, accessToken, lastModified, touched, statusOverride, dateStart, dateEnd);
        totalUpserted += invResult.upserted;
        allErrors.push(...invResult.errors);

        const cnResult = await syncCreditNotes(org, accessToken, lastModified, touched, dateStart, dateEnd);
        totalUpserted += cnResult.upserted;
        allErrors.push(...cnResult.errors);
      }

      // Overdue pass, isolated like the reaper below: its failure must not fail
      // the sync. The hourly pointer moves only after a clean pass over both orgs.
      try {
        const due = forceOverdueCheck || isFullSync ||
          Date.now() - (await readSyncState(OVERDUE_CHECK_KEY)).getTime() >= OVERDUE_CHECK_EVERY_MS;
        if (due) {
          const checkStart = new Date();
          let clean = true;
          for (const org of orgsToProcess) {
            const r = await reconcileOverdue(org, accessToken, touched);
            overdue.marked += r.marked;
            overdue.cleared += r.cleared;
            if (!r.complete) clean = false;
            allErrors.push(...r.errors);
          }
          overdue.checked = true;
          if (clean && !orgFilter) await writeSyncState(OVERDUE_CHECK_KEY, checkStart);
        }
      } catch (err) {
        allErrors.push('overdue: ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    // Reap rows for invoices that were deleted in Zoho and re-issued under the same
    // number. An incremental run only has to look at what it just touched; a prune-only
    // or full run sweeps the whole table. Isolated from the sync result — a reaper
    // failure must not fail the sync.
    if (!skipPrune) {
      try {
        const scope = (isPruneOnly || isFullSync) ? null : touched;
        pruneResult = await pruneDeletedDuplicates(accessToken, isDryRun, scope);
      } catch (err) {
        allErrors.push('prune: ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    // Persist timestamp. Skip on full sync so we don't overwrite the incremental pointer.
    if (!isFullSync && !isPruneOnly) {
      await writeSyncState('invoices', syncStart);
    }

    const durationMs = Date.now() - startTime;
    const result = {
      upserted: totalUpserted,
      overdue_checked: overdue.checked,
      overdue_marked: overdue.marked,
      overdue_cleared: overdue.cleared,
      pruned: isDryRun ? 0 : pruneResult.deleted.length,
      prune_dry_run: isDryRun,
      prune_deleted: pruneResult.deleted,
      prune_skipped: pruneResult.skipped,
      errors: allErrors,
      duration_ms: durationMs,
    };
    const notes = [
      ...pruneResult.deleted.map((d) => `pruned: ${d}`),
      ...pruneResult.skipped.map((s) => `prune skipped: ${s}`),
      ...allErrors,
    ];
    await logSync(action, 200, notes.length > 0 ? notes.join(' | ') : undefined);
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
