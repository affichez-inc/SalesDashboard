// Which CRM accounts had activity in a time window, for the nightly summaries.
//
//   Zoho CRM (COQL)  notes, tasks created or closed, meetings booked or held,
//                    contacts and accounts created
//   Zoho Books       quotes and invoices modified in the window (created, sent,
//                    accepted, declined, paid…), both orgs
//
// Each item is tied to its account directly, or through its contact, its task,
// its deal or the Books customer's CRM link. Emails and calls are not read:
// listing a day's emails would mean reading every contact's mailbox.

import type { Db } from './gather.ts';
import { booksGet, BOOKS_ORG_IDS, chunk, coql, coqlIds, mapLimit, ZohoError } from './zoho.ts';

export type ActivityKind =
  | 'note' | 'task_created' | 'task_closed' | 'meeting_booked' | 'meeting_held'
  | 'contact_created' | 'account_created' | 'quote' | 'invoice'
  // Not activity: the account's card went stale by date (index.ts adds these).
  | 'temperature_expired';

const MIN = 60_000;

/**
 * How long after it happens the summary can see an item. Notes, tasks, meetings
 * and quotes are read live; invoices, contacts and the account itself come from
 * the mirror, refreshed every 5 minutes (invoices) and every 2 hours (CRM).
 */
const VISIBLE_AFTER_MS: Record<ActivityKind, number> = {
  note: 0,
  task_created: 0,
  task_closed: 0,
  meeting_booked: 0,
  meeting_held: 0,
  quote: 0,
  invoice: 10 * MIN,
  contact_created: 130 * MIN,
  account_created: 130 * MIN,
  temperature_expired: 0,
};

/** Affichez's own entities and its suppliers are never summarised. */
export const INTERNAL_RATINGS = new Set(['Compte interne : Ne pas reprendre', 'Fournisseur']);

const COQL_LIMIT = 2000;
const COQL_IDS = 50;
const DB_IDS = 100;
const BOOKS_PAGE = 200;
const BOOKS_MAX_PAGES = 50;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AccountActivity {
  account_id: string;
  last_activity_at: string;
  /** From this moment a summary sees every item below. */
  ready_at: string;
  activity: { kinds: Partial<Record<ActivityKind, number>> };
}

export interface DetectionStats {
  window: { start: string; end: string };
  /** Items found per kind, before they are tied to an account. */
  items: Partial<Record<ActivityKind, number>>;
  /** Accounts with at least one item of the kind (an account counts under several). */
  accounts_by_kind: Partial<Record<ActivityKind, number>>;
  /** Items tied to no account, by reason. */
  unresolved: Record<string, number>;
  internal_excluded: number;
  books_status: Record<string, number>;
  api_calls: { crm: number; books: number };
  warnings: string[];
  duration_ms: number;
}

export interface Detection {
  accounts: AccountActivity[];
  stats: DetectionStats;
}

interface Lookup { id: string; name?: string | null }
type Row = Record<string, unknown>;

/** The record an item hangs on, and a fallback (a task's or meeting's contact). */
interface Ref { module: string; id: string }
interface Item { kind: ActivityKind; at: number; ref: Ref | null; alt: Ref | null }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function coqlTime(t: number): string {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function booksTime(t: number): string {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, '+0000');
}

/** Zoho writes offsets without a colon ("-0400"). */
function parseTime(v: unknown): number {
  if (typeof v !== 'string' || !v) return NaN;
  return Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

function lookup(v: unknown): Lookup | null {
  return v && typeof v === 'object' && typeof (v as Lookup).id === 'string' ? v as Lookup : null;
}

function bump<K extends string>(o: Partial<Record<K, number>>, k: K, n = 1) {
  o[k] = (o[k] ?? 0) + n;
}

// ─── Reading ──────────────────────────────────────────────────────────────────

class Reader {
  calls = { crm: 0, books: 0 };
  warnings: string[] = [];

  /** Every row matching `where` over [from, to), halving the window while a page comes back full. */
  async coqlWindow(module: string, fields: string, where: (a: string, b: string) => string, from: number, to: number): Promise<Row[]> {
    this.calls.crm++;
    const rows = await coql<Row>(`select ${fields} from ${module} where ${where(coqlTime(from), coqlTime(to))} limit ${COQL_LIMIT}`);
    if (rows.length < COQL_LIMIT) return rows;
    if (to - from <= 1000) {
      this.warnings.push(`${module} : plus de ${COQL_LIMIT} éléments dans la seconde de ${coqlTime(from)}, liste incomplète.`);
      return rows;
    }
    // COQL times have whole seconds: split on a second, never at `from` itself.
    const mid = from + Math.max(1000, Math.floor((to - from) / 2000) * 1000);
    return [
      ...await this.coqlWindow(module, fields, where, from, mid),
      ...await this.coqlWindow(module, fields, where, mid, to),
    ];
  }

  async coqlIn(module: string, fields: string, ids: string[]): Promise<Row[]> {
    const out: Row[] = [];
    for (const part of chunk(ids, COQL_IDS)) {
      this.calls.crm++;
      out.push(...await coql<Row>(`select ${fields} from ${module} where id in (${coqlIds(part)}) limit ${COQL_LIMIT}`));
    }
    return out;
  }

  /** Books records modified in [from, to), oldest first. */
  async booksModified(kind: 'estimates' | 'invoices', orgId: string, from: number, to: number): Promise<Row[]> {
    const out: Row[] = [];
    for (let page = 1; page <= BOOKS_MAX_PAGES; page++) {
      this.calls.books++;
      const res = await booksGet<Record<string, unknown>>(kind, orgId, {
        last_modified_time: booksTime(from),
        sort_column: 'last_modified_time',
        sort_order: 'A',
        per_page: String(BOOKS_PAGE),
        page: String(page),
      });
      const list = (res?.[kind] ?? []) as Row[];
      let past = false;
      for (const r of list) {
        const at = parseTime(r.last_modified_time);
        if (at >= to) { past = true; break; }
        if (at >= from) out.push(r);
      }
      const more = (res?.page_context as { has_more_page?: boolean } | undefined)?.has_more_page;
      if (past || !more || list.length === 0) return out;
    }
    this.warnings.push(`Books ${kind} : plus de ${BOOKS_MAX_PAGES * BOOKS_PAGE} modifications, liste incomplète.`);
    return out;
  }
}

/** Mirror rows whose `column` is one of `ids`, a hundred ids per request. */
async function mirrorIn<T>(db: Db, table: string, select: string, column: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk([...new Set(ids)], DB_IDS)) {
    out.push(...await db.select<T>(table, { select, in: { [column]: part } }));
  }
  return out;
}

// ─── Detection ────────────────────────────────────────────────────────────────

export async function detectActivity(db: Db, from: number, to: number): Promise<Detection> {
  const started = Date.now();
  const r = new Reader();
  const items: Item[] = [];
  const unresolved: Record<string, number> = {};
  const createdRating = new Map<string, string | null>();
  const booksStatus: Record<string, number> = {};
  const between = (field: string) => (a: string, b: string) => `${field} >= '${a}' and ${field} < '${b}'`;

  const [notes, tasksCreated, tasksClosed, events, contacts, accounts] = await Promise.all([
    r.coqlWindow('Notes', 'Parent_Id, Created_Time', between('Created_Time'), from, to),
    r.coqlWindow('Tasks', 'What_Id, Who_Id, $se_module, Created_Time', between('Created_Time'), from, to),
    r.coqlWindow('Tasks', 'What_Id, Who_Id, $se_module, Closed_Time', between('Closed_Time'), from, to),
    r.coqlWindow('Events', 'What_Id, Who_Id, $se_module, Created_Time, Start_DateTime',
      (a, b) => `(Created_Time >= '${a}' and Created_Time < '${b}') or (Start_DateTime >= '${a}' and Start_DateTime < '${b}')`,
      from, to),
    r.coqlWindow('Contacts', 'Account_Name, Created_Time', between('Created_Time'), from, to),
    r.coqlWindow('Accounts', 'Rating, Created_Time', between('Created_Time'), from, to),
  ]);

  const whatRef = (row: Row): Ref | null => {
    const what = lookup(row.What_Id);
    const module = typeof row.$se_module === 'string' ? row.$se_module : null;
    return what && module ? { module, id: what.id } : null;
  };
  const whoRef = (row: Row): Ref | null => {
    const who = lookup(row.Who_Id);
    return who ? { module: 'Contacts', id: who.id } : null;
  };

  for (const n of notes) {
    const parent = n.Parent_Id as { id?: string; module?: { api_name?: string } } | null;
    const module = parent?.module?.api_name;
    items.push({
      kind: 'note',
      at: parseTime(n.Created_Time),
      ref: parent?.id && module ? { module, id: parent.id } : null,
      alt: null,
    });
  }
  for (const t of tasksCreated) items.push({ kind: 'task_created', at: parseTime(t.Created_Time), ref: whatRef(t), alt: whoRef(t) });
  for (const t of tasksClosed) items.push({ kind: 'task_closed', at: parseTime(t.Closed_Time), ref: whatRef(t), alt: whoRef(t) });
  for (const e of events) {
    const created = parseTime(e.Created_Time);
    const start = parseTime(e.Start_DateTime);
    if (created >= from && created < to) items.push({ kind: 'meeting_booked', at: created, ref: whatRef(e), alt: whoRef(e) });
    if (start >= from && start < to) items.push({ kind: 'meeting_held', at: start, ref: whatRef(e), alt: whoRef(e) });
  }
  for (const c of contacts) {
    const account = lookup(c.Account_Name);
    items.push({ kind: 'contact_created', at: parseTime(c.Created_Time), ref: account ? { module: 'Accounts', id: account.id } : null, alt: null });
  }
  for (const a of accounts) {
    const id = String(a.id);
    createdRating.set(id, typeof a.Rating === 'string' ? a.Rating : null);
    items.push({ kind: 'account_created', at: parseTime(a.Created_Time), ref: { module: 'Accounts', id }, alt: null });
  }

  // Books: the customer stands in for the account until its link is known.
  await mapLimit(Object.entries(BOOKS_ORG_IDS), 2, async ([office, orgId]) => {
    for (const kind of ['estimates', 'invoices'] as const) {
      const list = await r.booksModified(kind, orgId, from, to);
      for (const q of list) {
        bump(booksStatus, `${kind === 'estimates' ? 'quote' : 'invoice'}:${q.status ?? '?'}`);
        const customer = typeof q.customer_id === 'string' && q.customer_id ? q.customer_id : null;
        items.push({
          kind: kind === 'estimates' ? 'quote' : 'invoice',
          at: parseTime(q.last_modified_time),
          ref: customer ? { module: `Books:${office}`, id: customer } : null,
          alt: null,
        });
      }
    }
  });

  // ─── Tie each item to an account ───────────────────────────────────────────
  // Notes on tasks first: a task leads to its account, contact, deal or lead.
  const taskIds = [...new Set(items.filter((i) => i.ref?.module === 'Tasks').map((i) => i.ref!.id))];
  const taskRefs = new Map<string, { ref: Ref | null; alt: Ref | null }>();
  if (taskIds.length) {
    for (const t of await r.coqlIn('Tasks', 'What_Id, Who_Id, $se_module', taskIds)) {
      taskRefs.set(String(t.id), { ref: whatRef(t), alt: whoRef(t) });
    }
  }
  for (const i of items) {
    if (i.ref?.module !== 'Tasks') continue;
    const t = taskRefs.get(i.ref.id);
    i.ref = t?.ref ?? null;
    i.alt = t?.alt ?? null;
  }

  const idsOf = (module: string) => [...new Set(items.flatMap((i) => [i.ref, i.alt])
    .filter((x): x is Ref => x?.module === module).map((x) => x.id))];

  const dealAccount = new Map<string, string | null>();
  const dealIds = idsOf('Deals');
  if (dealIds.length) {
    try {
      for (const d of await r.coqlIn('Deals', 'Account_Name', dealIds)) dealAccount.set(String(d.id), lookup(d.Account_Name)?.id ?? null);
    } catch (err) {
      r.warnings.push(`Affaires non lues (${err instanceof Error ? err.message : err}).`);
    }
  }

  const contactAccount = new Map<string, string | null>();
  const contactIds = idsOf('Contacts');
  for (const c of await mirrorIn<{ zoho_record_id: string; account_id: string | null }>(
    db, 'zoho_leads', 'zoho_record_id,account_id', 'zoho_record_id', contactIds,
  )) {
    if (c.account_id) contactAccount.set(c.zoho_record_id, c.account_id);
  }
  const missingContacts = contactIds.filter((id) => !contactAccount.has(id));
  if (missingContacts.length) {
    for (const c of await r.coqlIn('Contacts', 'Account_Name', missingContacts)) {
      contactAccount.set(String(c.id), lookup(c.Account_Name)?.id ?? null);
    }
  }

  const customerAccount = new Map<string, string | null>();
  for (const office of Object.keys(BOOKS_ORG_IDS)) {
    const ids = idsOf(`Books:${office}`);
    if (!ids.length) continue;
    const linked = new Set<string>();
    for (const c of await mirrorIn<{ books_customer_id: string; office: string; crm_account_id: string | null; link_status: string }>(
      db, 'zoho_books_customers', 'books_customer_id,office,crm_account_id,link_status', 'books_customer_id', ids,
    )) {
      if (c.office !== office) continue;
      if (c.crm_account_id) customerAccount.set(`${office}:${c.books_customer_id}`, c.crm_account_id);
      // Checked before and tied to no CRM account: not worth another call.
      if (c.crm_account_id || c.link_status === 'unlinked') linked.add(c.books_customer_id);
    }
    // A customer quoted but never invoiced is not in the mirror: ask Books.
    await mapLimit(ids.filter((id) => !linked.has(id)), 2, async (id) => {
      r.calls.books++;
      try {
        const res = await booksGet<{ contact?: { zcrm_account_id?: string } }>(`contacts/${id}`, BOOKS_ORG_IDS[office]);
        const account = String(res?.contact?.zcrm_account_id ?? '').trim();
        if (account) customerAccount.set(`${office}:${id}`, account);
      } catch (err) {
        if (!(err instanceof ZohoError && err.status === 404)) {
          r.warnings.push(`Client Books ${office} ${id} non lu (${err instanceof Error ? err.message : err}).`);
        }
      }
    });
  }

  const accountOf = (ref: Ref | null): { id: string | null; reason: string } => {
    if (!ref) return { id: null, reason: 'no_parent' };
    switch (ref.module) {
      case 'Accounts': return { id: ref.id, reason: '' };
      case 'Contacts': return { id: contactAccount.get(ref.id) ?? null, reason: 'contact_without_account' };
      case 'Deals': return { id: dealAccount.get(ref.id) ?? null, reason: 'deal_without_account' };
      case 'Leads': return { id: null, reason: 'lead' };
      default:
        if (ref.module.startsWith('Books:')) {
          return { id: customerAccount.get(`${ref.module.slice(6)}:${ref.id}`) ?? null, reason: 'books_customer_without_account' };
        }
        return { id: null, reason: `module_${ref.module}` };
    }
  };

  const byAccount = new Map<string, { kinds: Partial<Record<ActivityKind, number>>; last: number; ready: number }>();
  const itemCounts: Partial<Record<ActivityKind, number>> = {};
  for (const i of items) {
    bump(itemCounts, i.kind);
    if (!Number.isFinite(i.at)) { bump(unresolved, 'no_time'); continue; }
    let found = accountOf(i.ref);
    if (!found.id && i.alt) {
      const fallback = accountOf(i.alt);
      if (fallback.id) found = fallback;
    }
    if (!found.id) { bump(unresolved, found.reason); continue; }
    const a = byAccount.get(found.id) ?? { kinds: {}, last: 0, ready: 0 };
    bump(a.kinds, i.kind);
    a.last = Math.max(a.last, i.at);
    a.ready = Math.max(a.ready, i.at + VISIBLE_AFTER_MS[i.kind]);
    byAccount.set(found.id, a);
  }

  // Ratings: from the mirror, or from the CRM for an account created in the window.
  const rating = new Map<string, string | null>();
  for (const a of await mirrorIn<{ zoho_account_id: string; rating: string | null }>(
    db, 'zoho_accounts', 'zoho_account_id,rating', 'zoho_account_id', [...byAccount.keys()],
  )) rating.set(a.zoho_account_id, a.rating);

  let internal = 0;
  const out: AccountActivity[] = [];
  const accountsByKind: Partial<Record<ActivityKind, number>> = {};
  for (const [id, a] of byAccount) {
    const known = rating.has(id) || createdRating.has(id);
    if (!known) {
      // Neither in the mirror nor created in the window: deleted, or merged away.
      bump(unresolved, 'account_not_found', Object.values(a.kinds).reduce((s, n) => s + (n ?? 0), 0));
      continue;
    }
    if (INTERNAL_RATINGS.has((rating.get(id) ?? createdRating.get(id)) ?? '')) { internal++; continue; }
    for (const k of Object.keys(a.kinds) as ActivityKind[]) bump(accountsByKind, k);
    out.push({
      account_id: id,
      last_activity_at: new Date(a.last).toISOString(),
      ready_at: new Date(a.ready).toISOString(),
      activity: { kinds: a.kinds },
    });
  }
  out.sort((x, y) => y.last_activity_at.localeCompare(x.last_activity_at));

  return {
    accounts: out,
    stats: {
      window: { start: new Date(from).toISOString(), end: new Date(to).toISOString() },
      items: itemCounts,
      accounts_by_kind: accountsByKind,
      unresolved,
      internal_excluded: internal,
      books_status: booksStatus,
      api_calls: r.calls,
      warnings: r.warnings,
      duration_ms: Date.now() - started,
    },
  };
}
