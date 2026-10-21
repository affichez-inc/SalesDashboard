// Zoho CRM and Zoho Books reads for the account summary.
//
// Access tokens are cached in zoho_oauth_token, keyed per refresh token, and
// shared with the syncs: the Books token under 'books', the CRM sync token under
// 'crm'. This function prefers its own CRM refresh token (ZOHO_SUMMARY_*), whose
// scope adds notes, emails, calls, events and COQL to what the syncs were granted.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

export const CRM_ORG_ID = Deno.env.get('ZOHO_CRM_ORG_ID') ?? '48245615';
export const BOOKS_ORG_IDS: Record<string, string> = {
  QC: Deno.env.get('ZOHO_ORG_ID_QC') ?? '48244978',
  MTL: Deno.env.get('ZOHO_ORG_ID_MTL') ?? '815683274',
};

const CRM_API = 'https://www.zohoapis.com/crm/v8';
const BOOKS_API = 'https://www.zohoapis.com/books/v3';

// ─── Tokens ───────────────────────────────────────────────────────────────────

type Credentials = { cacheKey: string; clientId: string; clientSecret: string; refreshToken: string };

function env(...names: string[]): string {
  for (const n of names) {
    const v = Deno.env.get(n);
    if (v) return v;
  }
  return '';
}

/** FNV-1a of a refresh token: a new token gets a new cache row, never the old token's scopes. */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

function crmCredentials(): Credentials {
  if (Deno.env.get('ZOHO_SUMMARY_REFRESH_TOKEN')) {
    return {
      cacheKey: `crm_summary_${fingerprint(env('ZOHO_SUMMARY_REFRESH_TOKEN'))}`,
      clientId: env('ZOHO_SUMMARY_CLIENT_ID', 'ZOHO_CRM_CLIENT_ID', 'ZOHO_CLIENT_ID'),
      clientSecret: env('ZOHO_SUMMARY_CLIENT_SECRET', 'ZOHO_CRM_CLIENT_SECRET', 'ZOHO_CLIENT_SECRET'),
      refreshToken: env('ZOHO_SUMMARY_REFRESH_TOKEN'),
    };
  }
  return {
    cacheKey: 'crm',
    clientId: env('ZOHO_CRM_CLIENT_ID', 'ZOHO_CLIENT_ID'),
    clientSecret: env('ZOHO_CRM_CLIENT_SECRET', 'ZOHO_CLIENT_SECRET'),
    refreshToken: env('ZOHO_CRM_REFRESH_TOKEN', 'ZOHO_REFRESH_TOKEN'),
  };
}

function booksCredentials(): Credentials {
  return {
    cacheKey: 'books',
    clientId: env('ZOHO_CLIENT_ID'),
    clientSecret: env('ZOHO_CLIENT_SECRET'),
    refreshToken: env('ZOHO_REFRESH_TOKEN'),
  };
}

/** Writes go through the summary token only: it alone is granted write scopes. */
function writeCredentials(): Credentials {
  if (!Deno.env.get('ZOHO_SUMMARY_REFRESH_TOKEN')) throw new Error('ZOHO_SUMMARY_REFRESH_TOKEN non configuré : écriture impossible.');
  return crmCredentials();
}

const TOKEN_SKEW_MS = 5 * 60 * 1000;
const memo = new Map<string, { token: string; expiresAt: number }>();
const inflight = new Map<string, Promise<string>>();

/**
 * Concurrent callers share one lookup: Zoho caps how many access tokens a
 * refresh token may issue in a few minutes, and a gathering run starts a dozen
 * requests at once.
 */
function accessToken(c: Credentials, rejected: string | null = null): Promise<string> {
  const hit = memo.get(c.cacheKey);
  if (hit && hit.token !== rejected && Date.now() < hit.expiresAt - TOKEN_SKEW_MS) return Promise.resolve(hit.token);
  let pending = inflight.get(c.cacheKey);
  if (!pending) {
    pending = fetchAccessToken(c, rejected).finally(() => inflight.delete(c.cacheKey));
    inflight.set(c.cacheKey, pending);
  }
  return pending;
}

/** `rejected` is a token Zoho just refused: skip it if the cache still holds it. */
async function fetchAccessToken(c: Credentials, rejected: string | null): Promise<string> {
  // A cache miss or a cache error falls through to a live refresh.
  try {
    const cached = await fetch(
      `${SUPABASE_URL}/rest/v1/zoho_oauth_token?key=eq.${c.cacheKey}&select=access_token,expires_at`,
      { headers: SB_HEADERS },
    );
    if (cached.ok) {
      const rows = await cached.json() as Array<{ access_token: string; expires_at: string }>;
      const expiresAt = rows.length ? new Date(rows[0].expires_at).getTime() : 0;
      if (rows.length && rows[0].access_token !== rejected && Date.now() < expiresAt - TOKEN_SKEW_MS) {
        memo.set(c.cacheKey, { token: rows[0].access_token, expiresAt });
        return rows[0].access_token;
      }
    }
  } catch (err) {
    console.error('account-summary: token cache read failed', err);
  }

  const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: c.refreshToken,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json() as { access_token?: string; expires_in?: number; error?: string };
  if (!data.access_token) throw new Error(`Zoho token refresh failed (${c.cacheKey}): ${data.error ?? res.status}`);

  const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  memo.set(c.cacheKey, { token: data.access_token, expiresAt });
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/zoho_oauth_token?on_conflict=key`, {
      method: 'POST',
      headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        key: c.cacheKey,
        access_token: data.access_token,
        expires_at: new Date(expiresAt).toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error('account-summary: token cache write failed', err);
  }
  return data.access_token;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

export class ZohoError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const RETRY_DELAYS_MS = [1_500, 4_000];

// Zoho allows 20 concurrent calls per org, shared with the syncs.
const MAX_IN_FLIGHT = 6;
let inFlight = 0;
const waiting: Array<() => void> = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  while (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

/**
 * One request, retried when Zoho throttles or fails on its side. A write is
 * retried on throttling only: after a 5xx it may have been applied. Returns null
 * on 204 (no data).
 */
async function zohoRequest<T>(
  url: string,
  creds: Credentials,
  init: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown; write?: boolean } = {},
): Promise<T | null> {
  let rejected: string | null = null;
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(creds, rejected);
    const res = await slot(() => fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    }));
    if (res.status === 204 || res.status === 304) return null;
    if (res.ok) return await res.json() as T;

    const text = await res.text();
    let code: string | null = null;
    let message = '';
    try {
      // CRM puts a write's error on the record (data[0]); Books answers a numeric code.
      const body = JSON.parse(text) as { code?: string | number; message?: string; data?: Array<{ code?: string; message?: string }> };
      const item = body.data?.[0];
      code = String(body.code ?? item?.code ?? '') || null;
      message = String(body.message ?? item?.message ?? '');
    } catch { /* not JSON */ }

    if (res.status === 401 && attempt === 0 && code === 'INVALID_TOKEN') {
      rejected = token;
      continue;
    }
    if ((res.status === 429 || (!init.write && res.status >= 500)) && attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    throw new ZohoError(`Zoho ${res.status} ${code ?? ''} on ${url.split('?')[0]}${message ? ` : ${message.slice(0, 200)}` : ''}`, res.status, code);
  }
}

export function crmGet<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
  const qs = new URLSearchParams(params).toString();
  return zohoRequest<T>(`${CRM_API}/${path}${qs ? `?${qs}` : ''}`, crmCredentials());
}

/** COQL rows, or [] when nothing matches. One page of up to `limit` rows. */
export async function coql<T>(query: string): Promise<T[]> {
  const res = await zohoRequest<{ data?: T[] }>(`${CRM_API}/coql`, crmCredentials(), {
    method: 'POST',
    body: { select_query: query },
  });
  return res?.data ?? [];
}

export function booksGet<T>(path: string, orgId: string, params: Record<string, string> = {}): Promise<T | null> {
  const qs = new URLSearchParams({ organization_id: orgId, ...params }).toString();
  return zohoRequest<T>(`${BOOKS_API}/${path}?${qs}`, booksCredentials());
}

/** Updates one CRM record without triggering workflows, approvals or blueprints. */
export async function crmUpdate(module: string, id: string, data: Record<string, unknown>): Promise<void> {
  if (!/^\d+$/.test(id)) throw new Error(`Invalid Zoho id: ${id}`);
  const res = await zohoRequest<{ data?: Array<{ code?: string; message?: string; details?: unknown }> }>(
    `${CRM_API}/${module}/${id}`,
    writeCredentials(),
    { method: 'PUT', body: { data: [data], trigger: [] }, write: true },
  );
  const row = res?.data?.[0];
  if (row?.code !== 'SUCCESS') {
    throw new ZohoError(`Zoho CRM ${row?.code ?? 'sans réponse'} : ${row?.message ?? ''} ${JSON.stringify(row?.details ?? '')}`, 200, row?.code ?? null);
  }
}

export function booksWrite<T>(method: 'POST' | 'PUT', path: string, orgId: string, body?: unknown): Promise<T | null> {
  return zohoRequest<T>(`${BOOKS_API}/${path}?organization_id=${orgId}`, writeCredentials(), { method, body, write: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Runs `fn` over `items`, at most `limit` at a time, keeping the input order. */
export async function mapLimit<I, O>(items: I[], limit: number, fn: (item: I) => Promise<O>): Promise<O[]> {
  const out = new Array<O>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** COQL string literal: ids are digits only, anything else is refused. */
export function coqlIds(ids: string[]): string {
  for (const id of ids) if (!/^\d+$/.test(id)) throw new Error(`Invalid Zoho id: ${id}`);
  return ids.map((id) => `'${id}'`).join(', ');
}

export function crmRecordUrl(module: string, id: string): string {
  return `https://crm.zoho.com/crm/org${CRM_ORG_ID}/tab/${module}/${id}`;
}

export function booksUrl(office: string | null, kind: 'quotes' | 'invoices' | 'creditnotes', id: string): string | null {
  const org = office ? BOOKS_ORG_IDS[office] : undefined;
  return org ? `https://books.zoho.com/app/${org}#/${kind}/${id}` : null;
}
