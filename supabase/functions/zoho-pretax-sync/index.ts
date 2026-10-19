// supabase/functions/zoho-pretax-sync/index.ts
//
// Reads Zoho's real tax for every invoice, credit note and quote, so `amount` is
// Zoho's total minus Zoho's tax instead of total / 1.14975.
//
// Why a separate function: the tax is on the DETAIL payload only — the list
// endpoints the syncs walk carry `total` and nothing else (verified against the
// live Books API on 2026-10-19). That is one API call per document, ~27,000 for
// the history, which no 150s invocation can spend, and which must never delay
// the 5-minute syncs the dashboards depend on. Same shape as
// zoho-quote-creator-sync: a bounded, paced, resumable slice per run.
//
// The database does the arithmetic. This function only writes what Zoho said —
// total_incl_tax, tax_total and tax_checked_total — and the zoho_pretax_amount
// trigger derives amount from them. zoho-invoice-sync already reads new and
// modified invoices in detail as it writes them; this is the back-fill, plus
// quotes, plus anything that sync ran out of budget for.
//
// Quota: QC's daily allowance is 50,000 calls and MTL's 10,000 (Zoho's
// x-rate-limit headers, 2026-10-19). Every response reports what is left, and an
// org stops for the run once fewer than DAILY_RESERVE_SHARE of its allowance
// remain, so the back-fill can never starve the live syncs.
//
// Usage:
//   curl -X POST .../zoho-pretax-sync                         # one slice
//   curl -X POST .../zoho-pretax-sync -H 'x-max: 20'          # smaller slice
//   curl      .../zoho-pretax-sync -H 'x-status-only: true'   # just report

const ORGS = [
  { id: Deno.env.get('ZOHO_ORG_ID_QC') ?? '48244978', office: 'QC' },
  { id: Deno.env.get('ZOHO_ORG_ID_MTL') ?? '815683274', office: 'MTL' },
];

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// Requests are killed at 150s; stop at 110s so results are written and reported.
const BUDGET_MS = 110_000;
// Zoho's ceiling is 100/min/org. 50 leaves room for zoho-sync and
// zoho-invoice-sync (every 5 min) and the hourly reconcile's list burst.
const CALLS_PER_MIN = 50;
const DEFAULT_MAX_PER_ORG = 90;
// Stop an org for the run when less than this share of its daily allowance is left.
const DAILY_RESERVE_SHARE = 0.3;

// ─── Zoho auth ────────────────────────────────────────────────────────────────
// Shares the 'books' token row with the other Books syncs: Zoho throttles the
// refresh endpoint per refresh token, and a token lasts an hour.

const TOKEN_CACHE_KEY = 'books';
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
  if (!res.ok) return null; // a cache miss must never break the run
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
  await writeCachedToken(data.access_token, Number(data.expires_in) || 3600);
  return data.access_token;
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

class Pacer {
  private stamps: number[] = [];
  constructor(private readonly perMinute: number) {}

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, 60_000 - (now - this.stamps[0]) + 50));
    }
  }
}

// ─── The queue ────────────────────────────────────────────────────────────────

type Source = 'invoice' | 'creditnote' | 'estimate';
interface QueueRow { source: Source; zoho_id: string; doc_date: string | null }

async function fetchQueue(office: string, limit: number): Promise<QueueRow[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_pretax_queue`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({ p_office: office, p_limit: limit }),
  });
  if (!res.ok) throw new Error('queue fetch failed: ' + await res.text());
  return await res.json() as QueueRow[];
}

const MODULE: Record<Source, string> = { invoice: 'invoices', creditnote: 'creditnotes', estimate: 'estimates' };
const TABLE: Record<Source, string> = { invoice: 'invoices', creditnote: 'invoices', estimate: 'sales' };

async function patchRow(source: Source, zohoId: string, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${TABLE[source]}?zoho_id=eq.${encodeURIComponent(zohoId)}`,
    { method: 'PATCH', headers: SB_HEADERS, body: JSON.stringify(patch) },
  );
  if (!res.ok) throw new Error(`${TABLE[source]} update failed: ` + await res.text());
}

async function logSync(action: string, statusCode: number, message?: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/webhook_log`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({ action, status_code: statusCode, zoho_id: null, error_message: message ?? null }),
  });
}

// ─── Resolution ───────────────────────────────────────────────────────────────

interface OrgResult {
  office: string;
  examined: number;
  exact: number;
  gone: number;
  errors: number;
  quota_remaining: number | null;
  stopped_for_quota: boolean;
}

async function processOrg(
  org: { id: string; office: string },
  token: string,
  maxPerOrg: number,
  deadline: number,
  errors: string[],
): Promise<OrgResult> {
  const result: OrgResult = {
    office: org.office, examined: 0, exact: 0, gone: 0, errors: 0,
    quota_remaining: null, stopped_for_quota: false,
  };
  const pacer = new Pacer(CALLS_PER_MIN);
  const queue = await fetchQueue(org.office, maxPerOrg);

  for (const row of queue) {
    if (Date.now() > deadline) break;
    await pacer.take();
    result.examined++;

    try {
      const res = await fetch(
        `https://www.zohoapis.com/books/v3/${MODULE[row.source]}/${encodeURIComponent(row.zoho_id)}` +
          `?organization_id=${org.id}`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
      );

      const limit = Number(res.headers.get('x-rate-limit-limit'));
      const remaining = Number(res.headers.get('x-rate-limit-remaining'));
      if (Number.isFinite(remaining) && res.headers.has('x-rate-limit-remaining')) {
        result.quota_remaining = remaining;
      }

      if (res.status === 404) {
        // Gone from Zoho. Leave the queue; zoho-invoice-sync's reconcile removes
        // dead invoices, and a dead quote is zoho-sync's orphan sweep's to judge.
        await res.body?.cancel();
        await patchRow(row.source, row.zoho_id, { pretax_error: 'not found in Zoho (404)' });
        result.gone++;
      } else if (!res.ok) {
        // Transient (429, 5xx): stays queued, retried next run.
        const body = (await res.text()).slice(0, 160);
        result.errors++;
        errors.push(`${org.office} ${row.source} ${row.zoho_id}: HTTP ${res.status} ${body}`);
        if (res.status === 429) break;
      } else {
        const body = await res.json();
        const doc = body[row.source] as Record<string, unknown> | undefined;
        if (!doc || doc.total === undefined || doc.tax_total === undefined) {
          await patchRow(row.source, row.zoho_id, { pretax_error: 'no total/tax_total in Zoho payload' });
          result.errors++;
        } else {
          const sign = row.source === 'creditnote' ? -1 : 1;
          const total = sign * Number(doc.total);
          await patchRow(row.source, row.zoho_id, {
            total_incl_tax: total,
            tax_total: sign * Number(doc.tax_total),
            tax_checked_total: total,
            pretax_error: null,
          });
          result.exact++;
        }
      }

      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining) &&
          res.headers.has('x-rate-limit-remaining') && remaining < limit * DAILY_RESERVE_SHARE) {
        result.stopped_for_quota = true;
        break;
      }
    } catch (e) {
      result.errors++;
      errors.push(`${org.office} ${row.source} ${row.zoho_id}: ${String(e).slice(0, 160)}`);
    }
  }

  return result;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type, x-max, x-status-only, x-sync-source',
    },
  });
}

async function readStatus(): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_pretax_backfill_status`, {
    method: 'POST', headers: SB_HEADERS, body: '{}',
  });
  return res.ok ? await res.json() : { error: await res.text() };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return json({}, 200);

  if (req.headers.get('x-status-only') === 'true') {
    return json(await readStatus());
  }

  const maxPerOrg = Number(req.headers.get('x-max')) || DEFAULT_MAX_PER_ORG;
  const deadline = Date.now() + BUDGET_MS;
  const errors: string[] = [];

  try {
    const token = await getAccessToken();
    // Both orgs at once: Zoho's per-minute ceiling is per organisation, so
    // running them side by side doubles throughput without crowding either.
    const results = await Promise.all(
      ORGS.map((org) => processOrg(org, token, maxPerOrg, deadline, errors)),
    );

    const examined = results.reduce((s, r) => s + r.examined, 0);
    if (examined > 0 || errors.length > 0) {
      await logSync('pretax_sync', errors.length ? 500 : 200,
                    errors.length ? errors.join(' | ').slice(0, 500) : undefined);
    }

    return json({ results, status: await readStatus(), errors: errors.slice(0, 10) });
  } catch (e) {
    await logSync('pretax_sync', 500, String(e));
    return json({ error: String(e) }, 500);
  }
});
