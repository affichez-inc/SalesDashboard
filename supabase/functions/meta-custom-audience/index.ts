// supabase/functions/meta-custom-audience/index.ts
// Creates a Meta customer-list custom audience from the contacts of the accounts
// filtered on Comptes · Détail.
//
//   POST { action: "status" }
//     → whether the Meta side is ready: token, permission, ad account, terms.
//   POST { action: "create", name, description?, account_ids, exclude_opted_out }
//     → creates the audience on the ad account and uploads the contacts.
//
// Who may call it: a signed-in user with both the Comptes and the Publicité
// sections (an admin has both), asked of the database with the caller's own
// token (app_can_push_meta_audience). The contacts are read with that same
// token, so row-level security decides what goes out, exactly as it decides
// what the page shows.
//
// What leaves for Meta: per contact, the email(s), phone(s), first and last
// name, and the account's city, province, postal code and country, each
// normalised and SHA-256 hashed here (see normalize.ts). Nothing in clear text.
// Contacts who refused marketing email are left out unless the caller says
// otherwise, and so are contacts whose refusal status has not been synced yet.
//
// Each audience created is recorded in meta_audience_log: who, when, the page's
// filters, the counts and the Zoho ids of the contacts sent (ids only).
//
// Secrets:
//   META_AUDIENCE_ACCESS_TOKEN   system-user token with ads_management;
//                                falls back to META_ACCESS_TOKEN
//   META_AUDIENCE_AD_ACCOUNT_ID  the ad account the audiences are created on;
//                                falls back to the first of META_AD_ACCOUNT_ID
//   META_GRAPH_VERSION           default v25.0

import { contactRows, sha256Hex, SCHEMA, type ContactInput } from './normalize.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Identifies the project to the API gateway; the role comes from the caller's token.
const API_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? SERVICE_KEY;

const GRAPH_VERSION = Deno.env.get('META_GRAPH_VERSION') ?? 'v25.0';
const META_TOKEN = Deno.env.get('META_AUDIENCE_ACCESS_TOKEN') ?? Deno.env.get('META_ACCESS_TOKEN') ?? '';
const AD_ACCOUNT_ID = (
  Deno.env.get('META_AUDIENCE_AD_ACCOUNT_ID')
  ?? (Deno.env.get('META_AD_ACCOUNT_ID') ?? '').split(',')[0]
).trim().replace(/^act_/, '');

/** Meta accepts up to 10,000 rows a request; half that keeps a request near 3 MB. */
const UPLOAD_BATCH = 5_000;
/** Account ids per database read, and rows per page of it (the API's row cap). */
const ACCOUNT_CHUNK = 500;
const PAGE_ROWS = 1_000;
/** More than the whole CRM holds; a request beyond it is a mistake, not a list. */
const MAX_ACCOUNTS = 25_000;
const NAME_MAX = 150;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** Meta error text can echo the request URL, which carries the token. */
function redact(text: string): string {
  let out = text.replace(/(access_token)=[^&\s"')]+/gi, '$1=[redacted]');
  if (META_TOKEN) out = out.split(META_TOKEN).join('[redacted]');
  return out;
}

// ─── Caller ───────────────────────────────────────────────────────────────────

type Caller = { auth: string; email: string };

/**
 * The gateway has already checked the token's signature (verify_jwt), but the
 * anon key shipped in the frontend is a valid token too, so the right to push
 * is asked of the database with the caller's own token. Anything but a clean
 * `true` is a refusal.
 */
async function authorise(req: Request): Promise<Caller | null> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+/i.test(auth)) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/app_can_push_meta_audience`, {
      method: 'POST',
      headers: { apikey: API_KEY, Authorization: auth, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok || (await res.json()) !== true) return null;
    const payload = JSON.parse(atob(auth.split(' ')[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return { auth, email: String(payload.email ?? '').toLowerCase() };
  } catch (err) {
    console.error('meta-custom-audience: authorisation check failed', err);
    return null;
  }
}

// ─── Meta ─────────────────────────────────────────────────────────────────────

class MetaError extends Error {
  code: number | null;
  subcode: number | null;
  constructor(message: string, code: number | null, subcode: number | null) {
    super(message);
    this.code = code;
    this.subcode = subcode;
  }
}

// Throttling: app, user, page and ad-account level, including the custom
// audience budget (80003). A throttled request did nothing, so it is safe to
// send again.
const THROTTLED = new Set([4, 17, 32, 613, 80000, 80003, 80004, 80014]);
const RETRY_DELAYS_MS = [2_000, 6_000];

/**
 * One Graph call, retried on throttling and on transient server errors.
 *
 * `onlyIfThrottled` is for calls that create something: a 5xx can arrive after
 * Meta has created the audience, and sending the create again would leave a
 * second, empty one behind. Those calls are retried only when Meta says
 * explicitly that nothing was done.
 */
async function meta(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string> = {},
  opts: { onlyIfThrottled?: boolean } = {},
): Promise<Record<string, unknown>> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
  for (let attempt = 0; ; attempt++) {
    const body = new URLSearchParams({ ...params, access_token: META_TOKEN });
    // Graph reads the token from the query string on GET and DELETE, and from
    // the form body on POST, where the upload payload is too large for a URL.
    const res = method === 'POST'
      ? await fetch(url, { method, body })
      : await fetch(`${url}?${body}`, { method });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
    if (res.ok) return parsed;

    const err = (parsed.error ?? {}) as {
      message?: string; code?: number; error_subcode?: number;
      is_transient?: boolean; error_user_msg?: string;
    };
    const throttled = THROTTLED.has(err.code ?? -1);
    const retry = opts.onlyIfThrottled
      ? throttled
      : throttled || res.status >= 500 || Boolean(err.is_transient) || err.code === 1 || err.code === 2;
    if (retry && attempt < RETRY_DELAYS_MS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    const message = err.error_user_msg || err.message || text.slice(0, 300);
    throw new MetaError(redact(message), err.code ?? null, err.error_subcode ?? null);
  }
}

/** A sentence the page can show, for the failures someone can actually fix. */
function explain(e: unknown): string {
  if (!(e instanceof MetaError)) return redact(String(e)).slice(0, 300);
  const sub = e.subcode ?? 0;
  if (e.code === 190) return 'Le jeton Meta est invalide ou révoqué : il faut en générer un nouveau.';
  if ([1870034, 1870090].includes(sub)) {
    return "Les conditions d'utilisation des audiences personnalisées n'ont pas été acceptées pour ce compte publicitaire.";
  }
  if (sub === 1870092) return "Les conditions des outils professionnels Meta n'ont pas été acceptées.";
  if (sub === 1870050) return "Le compte publicitaire n'est pas rattaché au portefeuille d'entreprise.";
  if (e.code === 200 || e.code === 10 || e.code === 270 || e.code === 294
      || sub === 1713092 || (e.code === 100 && sub === 33)) {
    return "Le jeton Meta n'a pas le droit de gérer les audiences de ce compte publicitaire "
      + '(permission ads_management et contrôle total du compte requis).';
  }
  // Meta flags an audience whose name or description suggests health or
  // financial status, and then refuses uploads to it.
  if (sub === 1713230) {
    return "Meta a bloqué cette audience : son nom ou sa description évoque la santé ou la situation financière. "
      + 'Recommencez avec un nom neutre.';
  }
  if (THROTTLED.has(e.code ?? -1)) {
    return 'Meta limite le nombre de requêtes pour le moment. Réessayez dans quelques minutes.';
  }
  return `Meta : ${e.message}`.slice(0, 300);
}

type Status = {
  configured: boolean;
  ad_account: { id: string; name: string | null } | null;
  has_permission: boolean | null;
  terms_accepted: boolean | null;
  terms_url: string | null;
  /** Blocks sending. */
  problem: string | null;
  /** Shown, does not block. */
  warning: string | null;
};

async function metaStatus(): Promise<Status> {
  const base: Status = {
    configured: Boolean(META_TOKEN && AD_ACCOUNT_ID),
    ad_account: AD_ACCOUNT_ID ? { id: AD_ACCOUNT_ID, name: null } : null,
    has_permission: null,
    terms_accepted: null,
    terms_url: AD_ACCOUNT_ID
      ? `https://business.facebook.com/ads/manage/customaudiences/tos/?act=${AD_ACCOUNT_ID}`
      : null,
    problem: null,
    warning: null,
  };
  if (!base.configured) {
    return { ...base, problem: "La connexion Meta n'est pas configurée (jeton ou compte publicitaire manquant)." };
  }
  // The permission list is a convenience, not a gate. Meta documents it for
  // user tokens; if it fails or comes back empty for this System User token,
  // the answer is "unknown" and the create call itself will say what is wrong.
  try {
    const perms = await meta('GET', 'me/permissions');
    const list = (perms.data ?? []) as Array<{ permission: string; status: string }>;
    if (list.length > 0) {
      base.has_permission = list.some(p => p.permission === 'ads_management' && p.status === 'granted');
    }
  } catch { /* unknown */ }

  try {
    const acct = await meta('GET', `act_${AD_ACCOUNT_ID}`, { fields: 'name,tos_accepted' });
    base.ad_account = { id: AD_ACCOUNT_ID, name: (acct.name as string) ?? null };
    const tos = (acct.tos_accepted ?? {}) as Record<string, number>;
    base.terms_accepted = tos.custom_audience_tos === 1;
  } catch (e) {
    base.problem = explain(e);
    return base;
  }

  // An explicit permission list without ads_management is definitive: block.
  // The terms flag is a warning only - if it reads differently for a System
  // User than for the person who accepted, a block would lock the feature for
  // good, whereas Meta refusing the create says the same thing (1870034).
  if (base.has_permission === false) {
    base.problem = "Le jeton Meta n'a pas la permission ads_management : il ne peut que lire les statistiques.";
  } else if (!base.terms_accepted) {
    base.warning = "Meta n'indique pas que les conditions des audiences personnalisées sont acceptées pour ce compte publicitaire. "
      + 'Si la création échoue, faites-les accepter par un administrateur du compte.';
  }
  return base;
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

type ContactRow = ContactInput & {
  zoho_record_id: string;
  email_opt_out: boolean | null;
  no_marketing: boolean | null;
  /** The account came from an acquired client list, not from Affichez's own clients. */
  is_bulk_import: boolean;
};

/**
 * Only the columns the upload uses. Parsing the RPC's full rows was the largest
 * CPU cost of a big audience (Supabase stops a function at 2 s of CPU). The two
 * sort columns must be in the list: PostgREST orders the projected rows.
 */
const CONTACT_COLUMNS = [
  'account_id', 'zoho_record_id', 'email', 'secondary_email', 'phone', 'mobile', 'first_name', 'last_name',
  'mail_city', 'mail_state', 'mail_code', 'mail_country', 'email_opt_out', 'no_marketing', 'is_bulk_import',
].join(',');

/** get_accounts_contacts, read as the caller, in chunks and pages. */
async function readContacts(auth: string, accountIds: string[]): Promise<ContactRow[]> {
  const out: ContactRow[] = [];
  for (let i = 0; i < accountIds.length; i += ACCOUNT_CHUNK) {
    const chunk = accountIds.slice(i, i + ACCOUNT_CHUNK);
    for (let offset = 0; ; offset += PAGE_ROWS) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/get_accounts_contacts?select=${CONTACT_COLUMNS}` +
          `&order=account_id,zoho_record_id&limit=${PAGE_ROWS}&offset=${offset}`,
        {
          method: 'POST',
          headers: { apikey: API_KEY, Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_account_ids: chunk }),
        },
      );
      if (!res.ok) throw new Error(`Lecture des contacts : ${res.status} ${(await res.text()).slice(0, 200)}`);
      const page = await res.json() as ContactRow[];
      out.push(...page);
      // Stop on an empty page, not a short one: if the API's row cap were ever
      // below PAGE_ROWS, a "short" first page would end the read early.
      if (page.length === 0) break;
    }
  }
  return out;
}

/**
 * Left out when exclusion is on: a refusal recorded in Zoho on either field, or
 * either field not known (NULL - not synced yet, or not returned to the sync).
 * Unknown is treated as a refusal, never as a consent. Only contacts reach this,
 * so the NULL that leads carry in no_marketing never applies.
 */
function refusedMarketing(c: ContactRow): boolean {
  return c.email_opt_out !== false || c.no_marketing !== false;
}

// ─── Audit ────────────────────────────────────────────────────────────────────
//
// The row is written BEFORE anything is sent to Meta, as 'pending' with the
// contacts about to be sent, and updated after each step. A worker stopped
// halfway (CPU or wall-clock limit) therefore still leaves a record of who may
// be in the audience, and nothing is sent at all if the record cannot be made.

const SERVICE_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

/** The new row's id, or null when it could not be written. */
async function logInsert(row: Record<string, unknown>): Promise<number | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/meta_audience_log?select=id`, {
      method: 'POST',
      headers: { ...SERVICE_HEADERS, Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.error('meta-custom-audience: audit insert failed', res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const rows = await res.json() as Array<{ id: number }>;
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error('meta-custom-audience: audit insert failed', err);
    return null;
  }
}

async function logUpdate(id: number, patch: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/meta_audience_log?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...SERVICE_HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) console.error('meta-custom-audience: audit update failed', res.status, (await res.text()).slice(0, 300));
    return res.ok;
  } catch (err) {
    console.error('meta-custom-audience: audit update failed', err);
    return false;
  }
}

// ─── Create ───────────────────────────────────────────────────────────────────

type CreateBody = {
  name?: unknown;
  description?: unknown;
  account_ids?: unknown;
  exclude_opted_out?: unknown;
  filters?: unknown;
};

/**
 * The page's filters, kept as sent but bounded: parameter names are the page's
 * own (lowercase and underscores), each a short list of short strings. They
 * are stored to describe the audience, never used to query anything, so a
 * malformed entry is dropped rather than refused. Null when none were sent.
 */
function cleanFilters(v: unknown): Record<string, string[]> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(v as Record<string, unknown>).slice(0, 40)) {
    if (!/^[a-z_]{1,40}$/.test(key) || !Array.isArray(values)) continue;
    const list = values
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 50)
      .map(s => s.slice(0, 200));
    if (list.length > 0) out[key] = list;
  }
  return out;
}

async function create(caller: Caller, body: CreateBody): Promise<Response> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '';
  const excludeOptedOut = body.exclude_opted_out !== false;
  const filters = cleanFilters(body.filters);
  const accountIds = Array.isArray(body.account_ids)
    ? [...new Set(body.account_ids.filter((v): v is string => typeof v === 'string' && /^\d+$/.test(v)))]
    : [];

  if (!name || name.length > NAME_MAX) {
    return json({ error: `Le nom de l'audience est requis (${NAME_MAX} caractères au plus).` }, 400);
  }
  if (accountIds.length === 0) return json({ error: 'Aucun compte sélectionné.' }, 400);
  if (accountIds.length > MAX_ACCOUNTS) {
    return json({ error: `Trop de comptes (${accountIds.length}) : ${MAX_ACCOUNTS} au plus.` }, 400);
  }
  if (!META_TOKEN || !AD_ACCOUNT_ID) {
    return json({ error: "La connexion Meta n'est pas configurée." }, 503);
  }

  const contacts = await readContacts(caller.auth, accountIds);

  // Rows to send, deduplicated: one person can be a contact on two accounts.
  const optedOutIds: string[] = [];
  const unreachableIds: string[] = [];
  const sentIds: string[] = [];
  const seen = new Set<string>();
  const plainRows: string[][] = [];
  let fromAcquiredList = false;
  for (const c of contacts) {
    if (excludeOptedOut && refusedMarketing(c)) { optedOutIds.push(c.zoho_record_id); continue; }
    const rows = contactRows(c);
    if (rows.length === 0) { unreachableIds.push(c.zoho_record_id); continue; }
    sentIds.push(c.zoho_record_id);
    if (c.is_bulk_import) fromAcquiredList = true;
    for (const r of rows) {
      const key = r.join('\u0001');
      if (seen.has(key)) continue;
      seen.add(key);
      plainRows.push(r);
    }
  }

  const logBase = {
    created_by: caller.email || 'inconnu',
    ad_account_id: AD_ACCOUNT_ID,
    audience_name: name,
    description: description || null,
    filters,
    account_count: accountIds.length,
    contact_count: contacts.length,
    excluded_opt_out: excludeOptedOut,
  };

  if (plainRows.length === 0) {
    return json({
      error: "Aucun contact à envoyer : ces comptes n'ont ni courriel ni téléphone utilisable"
        + (excludeOptedOut && optedOutIds.length > 0 ? ', une fois les désabonnés retirés.' : '.'),
      contacts: contacts.length,
      opted_out_ids: optedOutIds,
      unreachable_ids: unreachableIds,
    }, 422);
  }

  // Hashing, synchronous (see sha256Hex): the same city, province and country
  // repeat on every row, so each distinct value is hashed once.
  const memo = new Map<string, string>();
  const hash = (v: string) => {
    if (!v) return '';
    let h = memo.get(v);
    if (h === undefined) { h = sha256Hex(v); memo.set(v, h); }
    return h;
  };
  const hashedRows = plainRows.map(r => r.map(hash));

  // Where the data comes from, declared to Meta. Accounts from an acquired
  // client list (Royer & Fils, PLOGG/BUCCO) were not collected by Affichez
  // itself, so a list holding any of them is declared as both.
  const customerFileSource = fromAcquiredList ? 'BOTH_USER_AND_PARTNER_PROVIDED' : 'USER_PROVIDED_ONLY';

  // Recorded before anything leaves: see the Audit section.
  const logId = await logInsert({
    ...logBase, contact_ids: sentIds, rows_sent: 0, status: 'pending',
  });
  if (logId === null) {
    return json({
      error: "L'audience n'a pas pu être enregistrée dans le journal de l'application : rien n'a été envoyé à Meta. Réessayez.",
    }, 503);
  }

  let audienceId: string | null = null;
  let received = 0;
  let invalid = 0;
  let rowsSent = 0;
  try {
    const created = await meta('POST', `act_${AD_ACCOUNT_ID}/customaudiences`, {
      name,
      subtype: 'CUSTOM',
      description: description || 'Créée depuis Comptes · Détail (application Ventes Affichez)',
      customer_file_source: customerFileSource,
    }, { onlyIfThrottled: true });
    audienceId = String(created.id ?? '');
    if (!audienceId) throw new Error("Meta n'a pas renvoyé d'identifiant d'audience.");
    await logUpdate(logId, { audience_id: audienceId });

    // One upload session: Meta treats the batches as one list, and the last one
    // closes it so the audience starts filling straight away.
    const sessionId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const batches = Math.ceil(hashedRows.length / UPLOAD_BATCH);
    for (let b = 0; b < batches; b++) {
      const data = hashedRows.slice(b * UPLOAD_BATCH, (b + 1) * UPLOAD_BATCH);
      const res = await meta('POST', `${audienceId}/users`, {
        payload: JSON.stringify({ schema: SCHEMA, is_raw: true, data }),
        session: JSON.stringify({
          session_id: sessionId,
          batch_seq: b + 1,
          last_batch_flag: b === batches - 1,
          estimated_num_total: hashedRows.length,
        }),
      });
      rowsSent += data.length;
      // num_received is the running total for the session.
      received = Number(res.num_received ?? received + data.length);
      invalid += Number(res.num_invalid_entries ?? 0);
    }
  } catch (e) {
    const message = explain(e);
    // A half-made audience is clutter in Ads Manager with a name that looks
    // finished. Remove it; if that fails too, say so.
    let orphan = false;
    if (audienceId) {
      try { await meta('DELETE', audienceId); } catch { orphan = true; }
    }
    // An audience that could not be deleted may hold part of the upload, so who
    // was in it is kept; one that is gone held nobody.
    await logUpdate(logId, {
      audience_id: orphan ? audienceId : null,
      rows_sent: orphan ? rowsSent : 0,
      contact_ids: orphan ? sentIds : null,
      status: 'failed', error_message: message,
    });
    const left = rowsSent > 0 ? 'incomplète' : 'vide';
    return json({
      error: message + (orphan ? ` Une audience ${left} « ${name} » est restée dans Meta : supprimez-la dans le Gestionnaire de publicités.` : ''),
    }, 502);
  }

  // Meta fills an audience asynchronously; the counts are usually not ready yet.
  let audience: Record<string, unknown> = {};
  try {
    audience = await meta('GET', audienceId, {
      fields: 'name,operation_status,delivery_status,approximate_count_lower_bound,approximate_count_upper_bound',
    });
  } catch { /* the audience exists; its status is a nicety */ }

  const logSaved = await logUpdate(logId, {
    audience_id: audienceId, rows_sent: rowsSent,
    num_received: received, num_invalid: invalid, status: 'created',
  });

  return json({
    log_saved: logSaved,
    customer_file_source: customerFileSource,
    audience_id: audienceId,
    name,
    ad_account_id: AD_ACCOUNT_ID,
    audience_url: `https://adsmanager.facebook.com/adsmanager/audiences?act=${AD_ACCOUNT_ID}&ids=${audienceId}`,
    accounts: accountIds.length,
    contacts: contacts.length,
    contacts_sent: sentIds.length,
    rows_sent: hashedRows.length,
    num_received: received,
    num_invalid_entries: invalid,
    operation_status: audience.operation_status ?? null,
    sent_ids: sentIds,
    opted_out_ids: optedOutIds,
    unreachable_ids: unreachableIds,
  });
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const caller = await authorise(req);
  if (!caller) return json({ error: 'forbidden' }, 403);

  let body: CreateBody & { action?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is a status call */ }

  try {
    if (body.action === 'create') return await create(caller, body);
    return json(await metaStatus());
  } catch (e) {
    console.error('meta-custom-audience:', redact(String(e instanceof Error ? e.stack ?? e.message : e)));
    return json({ error: explain(e) }, 500);
  }
});
