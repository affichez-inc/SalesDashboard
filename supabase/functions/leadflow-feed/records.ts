// The pure part of the LeadFlow Feed (docs/LEADFLOW-FEED.md, and LeadFlow's docs/feed-contract-v1.md):
// what this app serves, how a row of ours becomes one of LeadFlow's canonical records, and the page
// cursor. No database call here (index.ts makes them), so records.test.ts covers every mapping.
//
// Canonical field names come from LeadFlow's kinds (supabase/functions/_shared/sync/kinds/*.ts there):
// nothing of ours (zoho_id, rep_name, is_avoir, ...) passes this file under its own name.

export const FEED_NAME = 'leadflow-feed';
export const FEED_VERSION = 1;
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;
export const MAX_IDS = 100;

export type Kind = 'quote' | 'invoice' | 'credit_note' | 'account';
export const KINDS: Kind[] = ['quote', 'invoice', 'credit_note', 'account'];

export interface FeedRecord {
  external_id: string;
  modified_at: string | null;
  fields: Record<string, unknown>;
  refs: Array<{ role: string; kind: string; external_id: string }>;
}

/** What GET /v1/feed answers: the four kinds, all listed by modification time, all with an ids sweep. */
export function descriptor() {
  return {
    feed: FEED_NAME,
    version: FEED_VERSION,
    source: { name: 'Affichez Ventes', currency: 'CAD', time_zone: 'America/Toronto' },
    kinds: KINDS.map((kind) => ({ kind, cursor_mode: 'modified', ids: true })),
  };
}

/** Where each kind lives: its table, its id and change-time columns, the columns the mapping reads. */
export const SOURCES: Record<Kind, { table: string; idCol: string; tsCol: string; columns: string; avoir: boolean | null }> = {
  quote: {
    table: 'sales', idCol: 'zoho_id', tsCol: 'updated_at', avoir: null,
    columns: 'zoho_id, quote_number, status, zoho_status, quote_date, sale_date, accepted_date, total_incl_tax, tax_total, amount, client_name, rep_name, created_at, updated_at, department, zoho_department_label, office, books_customer_id',
  },
  invoice: {
    table: 'invoices', idCol: 'zoho_id', tsCol: 'updated_at', avoir: false,
    columns: 'zoho_id, invoice_number, status, invoice_date, total_incl_tax, tax_total, amount, client_name, rep_name, updated_at, department, zoho_department_label, office, books_customer_id, is_avoir',
  },
  credit_note: {
    table: 'invoices', idCol: 'zoho_id', tsCol: 'updated_at', avoir: true,
    columns: 'zoho_id, invoice_number, status, invoice_date, total_incl_tax, tax_total, amount, client_name, rep_name, updated_at, department, zoho_department_label, office, books_customer_id, is_avoir',
  },
  account: {
    table: 'zoho_books_customers', idCol: 'books_customer_id', tsCol: 'synced_at', avoir: null,
    columns: 'books_customer_id, customer_name, crm_account_id, crm_contact_id, link_status, synced_at, office',
  },
};

type Row = Record<string, unknown>;
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const idOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const instant = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
/** A money column as a positive number to the cent, or null (the contract: amounts positive, credits too). */
const money = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) / 100 : null;
};

/** Our quote statuses are already the canonical words (sale_status_enum). */
const QUOTE_STATUSES = new Set(['draft', 'sent', 'accepted', 'declined', 'expired', 'invoiced']);
export function quoteStatus(v: unknown): string | null {
  const s = text(v)?.toLowerCase() ?? null;
  return s && QUOTE_STATUSES.has(s) ? s : null;
}

/** Our invoice_status_enum as LeadFlow's invoice status (a credit note never reaches this). */
export function invoiceStatus(v: unknown): string | null {
  switch (text(v)?.toLowerCase() ?? '') {
    case 'sent': case 'viewed': return 'sent';
    case 'partial': return 'partially_paid';
    case 'paid': return 'paid';
    case 'overdue': return 'overdue';
    case 'void': return 'void';
    default: return null;
  }
}

/** The department label as the app shows it: the normalized one, else Zoho's own. */
const department = (r: Row): string | null => text(r.department) ?? text(r.zoho_department_label);
const customerRef = (r: Row) => {
  const id = idOf(r.books_customer_id);
  return id ? [{ role: 'account', kind: 'account', external_id: id }] : [];
};

export function quoteRecord(r: Row): FeedRecord | null {
  const id = idOf(r.zoho_id);
  if (!id) return null;
  return {
    external_id: id,
    modified_at: instant(r.updated_at),
    fields: {
      number: text(r.quote_number),
      status: quoteStatus(r.status),
      vendor_status: text(r.zoho_status)?.toLowerCase() ?? null,
      date: day(r.quote_date) ?? day(r.sale_date),
      accepted_date: day(r.accepted_date),
      currency: 'CAD',
      total: money(r.total_incl_tax),
      tax_total: money(r.tax_total),
      total_before_tax: money(r.amount),
      customer_name: text(r.client_name),
      salesperson_name: text(r.rep_name),
      created_at: instant(r.created_at),
      department: department(r),
      office: text(r.office),
    },
    refs: customerRef(r),
  };
}

export function invoiceRecord(r: Row): FeedRecord | null {
  const id = idOf(r.zoho_id);
  if (!id || r.is_avoir === true) return null;
  return {
    external_id: id,
    modified_at: instant(r.updated_at),
    fields: {
      number: text(r.invoice_number),
      status: invoiceStatus(r.status),
      vendor_status: text(r.status)?.toLowerCase() ?? null,
      date: day(r.invoice_date),
      currency: 'CAD',
      total: money(r.total_incl_tax),
      tax_total: money(r.tax_total),
      total_before_tax: money(r.amount),
      customer_name: text(r.client_name),
      salesperson_name: text(r.rep_name),
      department: department(r),
      office: text(r.office),
    },
    refs: customerRef(r),
  };
}

/** A credit note is an `invoices` row with is_avoir: stored negative here, served positive (LeadFlow subtracts). */
export function creditNoteRecord(r: Row): FeedRecord | null {
  const id = idOf(r.zoho_id);
  if (!id || r.is_avoir !== true) return null;
  return {
    external_id: id,
    modified_at: instant(r.updated_at),
    fields: {
      number: text(r.invoice_number),
      // Books' credit note state is not kept here: `open` counts it (only draft and void do not), the
      // vendor's word says where it came from.
      status: text(r.status)?.toLowerCase() === 'void' ? 'void' : 'open',
      vendor_status: text(r.status)?.toLowerCase() ?? null,
      date: day(r.invoice_date),
      currency: 'CAD',
      total: money(r.total_incl_tax),
      tax_total: money(r.tax_total),
      total_before_tax: money(r.amount),
      customer_name: text(r.client_name),
      department: department(r),
      office: text(r.office),
    },
    refs: customerRef(r),
  };
}

/** A Books customer, with the Zoho CRM account and contact it is linked to (the join to LeadFlow's CRM mirror). */
export function customerRecord(r: Row): FeedRecord | null {
  const id = idOf(r.books_customer_id);
  if (!id) return null;
  const linked = r.link_status === 'linked';
  const refs: FeedRecord['refs'] = [];
  const account = idOf(r.crm_account_id);
  const contact = idOf(r.crm_contact_id);
  if (linked && account) refs.push({ role: 'crm_account', kind: 'account', external_id: account });
  if (linked && contact) refs.push({ role: 'crm_contact', kind: 'contact', external_id: contact });
  return {
    external_id: id,
    modified_at: instant(r.synced_at),
    fields: { name: text(r.customer_name), detailed: true },
    refs,
  };
}

export const MAPPERS: Record<Kind, (r: Row) => FeedRecord | null> = {
  quote: quoteRecord, invoice: invoiceRecord, credit_note: creditNoteRecord, account: customerRecord,
};

// ── Paging ────────────────────────────────────────────────────────────────────────────────────

/** A page cursor: the last row's change time (changes pages) and id, as base64url JSON. Opaque to LeadFlow. */
export interface Cursor { t?: string; i: string }
export function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeCursor(s: unknown): Cursor | null {
  if (typeof s !== 'string' || !s || s.length > 400) return null;
  try {
    const json = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const c = JSON.parse(json);
    if (!c || typeof c !== 'object' || typeof c.i !== 'string' || !c.i) return null;
    if (c.t !== undefined && (typeof c.t !== 'string' || Number.isNaN(Date.parse(c.t)))) return null;
    return c.t === undefined ? { i: c.i } : { t: c.t, i: c.i };
  } catch {
    return null;
  }
}

/** `limit` as the contract bounds it: 1 to MAX_LIMIT, DEFAULT_LIMIT when absent or not a number. */
export function pageLimit(raw: string | null): number {
  const n = raw === null || raw === '' ? NaN : Number(raw);
  if (!Number.isInteger(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/** `ids=a,b,c` as a list: trimmed, non-empty, at most MAX_IDS, or null when the parameter is absent. */
export function idList(raw: string | null): string[] | null | 'too_many' {
  if (raw === null) return null;
  const ids = [...new Set(raw.split(',').map((x) => x.trim()).filter((x) => x))];
  if (ids.length > MAX_IDS) return 'too_many';
  return ids;
}

/** An ISO instant for `modified_after`, or null when absent, or 'bad' when it does not parse. */
export function modifiedAfter(raw: string | null): string | null | 'bad' {
  if (raw === null || raw === '') return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 'bad' : new Date(t).toISOString();
}
