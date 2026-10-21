// Collects everything the summary is built from, for one CRM account.
//
//   Supabase mirror  account profile, contacts, invoices, Books customer links
//   Zoho CRM         emails (per contact), notes, tasks, meetings, users
//   Zoho Books       quotes of every status (the `sales` mirror has no account link),
//                    and the full document of each invoice the dossier lists
//
// Activity is read over WINDOW_MONTHS. Invoices are read whole, for yearly totals.

import { emailBody, htmlToText, isAutoReply, oneLine, truncate } from './clean.ts';
import { booksGet, BOOKS_ORG_IDS, chunk, coql, coqlIds, crmGet, mapLimit, ZohoError } from './zoho.ts';

export const WINDOW_MONTHS = 18;
/** The year the dossier lists invoice by invoice, and the computed facts total. */
export const STATS_DAYS = 365;
const MAX_INVOICE_LINES = 150;   // the busiest account has 81 invoices in a year

const MAX_CONTACTS = 60;          // the largest account holds 25
const MAX_EMAIL_PAGES = 4;       // 100 emails a page, newest first; the cursor is opaque
const MAX_EMAIL_BODIES = 60;
const EMAIL_CHARS = 3_000;
const NOTE_CHARS = 4_000;        // reps paste whole email threads into notes
const ZOHO_CONCURRENCY = 4;

/** Books totals include GST+QST; the syncs store amounts before tax, and so does this. */
const QC_TAX_FACTOR = 1.14975;

/** Mass mailings, cadences and workflow emails say nothing about this client. */
const BULK_SOURCE = /mass|workflow|campaign|cadence|auto/i;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Db {
  select<T>(table: string, q: {
    select: string;
    eq?: Record<string, string>;
    /** Values are ids: digits only. */
    in?: Record<string, string[]>;
    order?: string;
  }): Promise<T[]>;
  /** Inserts the rows, replacing those with the same primary key. */
  upsert(table: string, rows: Array<Record<string, unknown>>): Promise<void>;
}

export interface AccountProfile {
  zoho_account_id: string;
  account_name: string;
  rep_name: string | null;
  owner_name: string | null;
  created_time: string | null;
  origine_du_client: string | null;
  service_interest: string[] | null;
  domaine_activite: string | null;
  region_administrative: string | null;
  rating: string | null;
  description: string | null;
  budget_publicitaire_annuel: number | null;
  nombre_employes: string | null;
  parent_account_name: string | null;
  website: string | null;
  billing_city: string | null;
  type_marche: string[] | null;
}

export interface Contact {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  language: string | null;
}

export interface EmailItem {
  messageId: string;
  contactIds: string[];
  time: string;
  direction: 'in' | 'out';
  from: string;
  to: string[];
  subject: string;
  owner: string | null;
  text: string | null;
}

export interface NoteItem {
  id: string;
  parentModule: string;
  parentId: string;
  parentLabel: string | null;
  created: string;
  author: string;
  automated: boolean;
  title: string | null;
  text: string;
}

export interface TaskItem {
  id: string;
  subject: string;
  status: string | null;
  due: string | null;
  created: string;
  closed: string | null;
  owner: string | null;
  automated: boolean;
  contactName: string | null;
  description: string | null;
}

export interface MeetingItem {
  id: string;
  title: string;
  start: string;
  end: string | null;
  owner: string | null;
  contactName: string | null;
  description: string | null;
}

export interface QuoteItem {
  id: string;
  number: string;
  /** The rep's title for the quote ("Distribution 2027"), Books' reference field. */
  title: string | null;
  date: string;
  status: string;
  total: number;
  expiry: string | null;
  acceptedOn: string | null;
  declinedOn: string | null;
  viewedOn: string | null;
  /** Follow-up date the rep set on the quote. */
  followUp: string | null;
  department: string | null;
  contact: string | null;
  salesperson: string | null;
  office: string;
}

export interface InvoiceItem {
  id: string;
  number: string | null;
  date: string;
  amount: number;
  status: string;
  department: string | null;
  rep: string | null;
  office: string | null;
  isCredit: boolean;
  /** The Books document, for the invoices the dossier lists; null when it could not be read. */
  detail: InvoiceDetail | null;
}

export interface InvoiceLine {
  name: string | null;
  description: string | null;
  quantity: number;
  unit: string | null;
  rate: number;
  /** As Books holds it: an amount, or a percentage such as "10%". */
  discount: number | string | null;
  total: number;
}

/**
 * An invoice or credit note as Zoho Books shows it. Lines, sub-total, discount,
 * shipping and adjustment are before tax; total, balance, payments and credits
 * include it.
 */
export interface InvoiceDetail {
  kind: 'invoice' | 'creditnote';
  reference: string | null;
  dueDate: string | null;
  paymentTerms: string | null;
  salesperson: string | null;
  createdBy: string | null;
  /** The document's custom fields other than the department, which the mirror already has. */
  fields: Array<{ label: string; value: string }>;
  lines: InvoiceLine[];
  subTotal: number;
  discount: number;
  shipping: number;
  adjustment: number;
  adjustmentLabel: string | null;
  tax: number;
  total: number;
  balance: number;
  paid: number;
  /** Credits applied to an invoice; on a credit note, the part of it already used. */
  credited: number;
  writtenOff: number;
  refunded: number;
  lastPayment: string | null;
  /** Credit notes: the invoices they were applied to, tax included. */
  appliedTo: Array<{ number: string; amount: number }>;
  reason: string | null;
  sentTo: string[];
  viewedOn: string | null;
  reminders: number;
  lastReminder: string | null;
  notes: string | null;
  terms: string | null;
  /** The Books customer's own fields, identical on each of its documents. */
  customer: { number: string | null; fields: Array<{ label: string; value: string }> };
  readAt: string;
}

export interface OverdueInvoice {
  id: string;
  number: string;
  date: string;
  dueDate: string | null;
  /** Before tax like every other amount; `balanceTaxIncl` is what the client owes. */
  balance: number;
  balanceTaxIncl: number;
  office: string;
}

export interface Dossier {
  account: AccountProfile;
  contacts: Contact[];
  emails: EmailItem[];
  emailCounts: { listed: number; bulk: number };
  notes: NoteItem[];
  tasks: TaskItem[];
  meetings: MeetingItem[];
  quotes: QuoteItem[];
  invoices: InvoiceItem[];
  /** Read live from Books; `live` is false when that read failed and the mirror's status is all there is. */
  overdue: { live: boolean; items: OverdueInvoice[] };
  windowStart: string;
  warnings: string[];
}

// ─── Zoho payload shapes ──────────────────────────────────────────────────────

interface Lookup { id: string; name?: string | null }

interface RawEmail {
  message_id: string;
  time: string;
  sent: boolean;
  subject: string | null;
  Source?: string | null;
  source?: string | null;
  from?: { email?: string | null; user_name?: string | null } | null;
  to?: Array<{ email?: string | null; user_name?: string | null }> | null;
  owner?: { id: string; name?: string | null } | null;
}

interface EmailListResponse {
  Emails?: RawEmail[];
  info?: { next_index?: string | number; more_records?: boolean };
}

interface RawNote {
  id: string;
  Note_Title: string | null;
  Note_Content: string | null;
  Parent_Id: { id: string; module?: { api_name?: string } } | null;
  Created_Time: string;
  Owner: Lookup | null;
}

interface RawTask {
  id: string;
  Subject: string | null;
  Status: string | null;
  Due_Date: string | null;
  Created_Time: string;
  Closed_Time: string | null;
  Owner: Lookup | null;
  Created_By: Lookup | null;
  Who_Id: Lookup | null;
  Description: string | null;
}

interface RawEvent {
  id: string;
  Event_Title: string | null;
  Start_DateTime: string;
  End_DateTime: string | null;
  Owner: Lookup | null;
  Who_Id: Lookup | null;
  Description: string | null;
}

interface RawOverdueInvoice {
  invoice_id: string;
  invoice_number: string;
  customer_id?: string;
  status?: string;
  date: string;
  due_date?: string | null;
  balance: number;
}

interface RawEstimate {
  estimate_id: string;
  estimate_number: string;
  date: string;
  status: string;
  total: number;
  customer_id?: string;
  reference_number?: string | null;
  expiry_date?: string | null;
  accepted_date?: string | null;
  declined_date?: string | null;
  is_viewed_by_client?: boolean;
  client_viewed_time?: string | null;
  cf_date_suivi_unformatted?: string | null;
  cf_d_partement?: string | null;
  cf_contact_person_name?: string | null;
  salesperson_name?: string | null;
}

interface RawCustomField {
  label?: string;
  api_name?: string;
  value?: unknown;
  value_formatted?: unknown;
}

/** GET invoices/{id} or creditnotes/{id}: the fields kept from a payload of ~17,000 characters. */
interface RawBooksDocument {
  reference_number?: string | null;
  due_date?: string | null;
  payment_terms_label?: string | null;
  salesperson_name?: string | null;
  created_by_name?: string | null;
  custom_fields?: RawCustomField[];
  customer_custom_fields?: RawCustomField[];
  contact_number?: string | null;
  line_items?: Array<{
    name?: string | null;
    description?: string | null;
    quantity?: number;
    unit?: string | null;
    rate?: number;
    discount?: number | string | null;
    item_total?: number;
  }>;
  sub_total?: number;
  discount_total?: number;
  discount_amount?: number;
  shipping_charge?: number;
  adjustment?: number;
  adjustment_description?: string | null;
  tax_total?: number;
  total?: number;
  balance?: number;
  payment_made?: number;
  credits_applied?: number;
  total_credits_used?: number;
  write_off_amount?: number;
  total_refunded_amount?: number;
  last_payment_date?: string | null;
  invoices_credited?: Array<{ invoice_number?: string; credited_amount?: number }>;
  reason?: string | null;
  contact_persons_associated?: Array<{ first_name?: string | null; last_name?: string | null; contact_person_email?: string | null }>;
  is_viewed_in_mail?: boolean;
  mail_first_viewed_time?: string | null;
  reminders_sent?: number;
  last_reminder_sent_date?: string | null;
  notes?: string | null;
  terms?: string | null;
}

// ─── Gathering ────────────────────────────────────────────────────────────────

/** COQL datetime literal. */
function coqlTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function monthsAgo(n: number): Date {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
}

/** Full names of CRM users. COQL lookups carry only the last name. */
async function userNames(): Promise<{ names: Map<string, string>; automationIds: Set<string> }> {
  const names = new Map<string, string>();
  const automationIds = new Set<string>();
  for (let page = 1; page <= 3; page++) {
    const res = await crmGet<{ users?: Array<{ id: string; full_name?: string; email?: string }>; info?: { more_records?: boolean } }>(
      'users', { type: 'AllUsers', per_page: '200', page: String(page) },
    );
    for (const u of res?.users ?? []) {
      const name = (u.full_name ?? '').trim();
      names.set(u.id, name);
      if (/\(IA\)/i.test(name)) automationIds.add(u.id);
    }
    if (!res?.info?.more_records) break;
  }
  return { names, automationIds };
}

async function listEmails(contactId: string, since: number): Promise<RawEmail[]> {
  const out: RawEmail[] = [];
  let index: string | number = 1;
  for (let page = 0; page < MAX_EMAIL_PAGES; page++) {
    const res: EmailListResponse | null = await crmGet<EmailListResponse>(
      `Contacts/${contactId}/Emails`, { index: String(index), per_page: '100' },
    );
    const list = res?.Emails ?? [];
    out.push(...list);
    if (list.length === 0 || !res?.info?.more_records || !res.info.next_index) break;
    if (list.every((e) => Date.parse(e.time) < since)) break;
    index = res.info.next_index;
  }
  return out;
}

async function emailText(contactId: string, e: RawEmail): Promise<string | null> {
  if (!e.owner?.id) return null;
  try {
    const res = await crmGet<{ Emails?: Array<{ content?: string | null }> }>(
      `Contacts/${contactId}/Emails/${e.message_id}`, { user_id: e.owner.id },
    );
    const content = res?.Emails?.[0]?.content;
    return content ? emailBody(content, EMAIL_CHARS) : null;
  } catch (err) {
    if (err instanceof ZohoError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}

async function gatherEmails(contacts: Contact[], since: number, warnings: string[]) {
  const lists = await mapLimit(contacts, ZOHO_CONCURRENCY, async (c) => {
    try {
      return { contact: c, list: await listEmails(c.id, since) };
    } catch (err) {
      warnings.push(`Courriels de ${c.name} non lus (${err instanceof Error ? err.message : err}).`);
      return { contact: c, list: [] as RawEmail[] };
    }
  });

  let listed = 0;
  const bulkIds = new Set<string>();
  const byId = new Map<string, { raw: RawEmail; contactIds: string[] }>();
  for (const { contact, list } of lists) {
    for (const e of list) {
      listed++;
      if (Date.parse(e.time) < since) continue;
      const source = e.Source ?? e.source ?? '';
      if (BULK_SOURCE.test(source) || isAutoReply(e.subject)) { bulkIds.add(e.message_id); continue; }
      const seen = byId.get(e.message_id);
      if (seen) seen.contactIds.push(contact.id);
      else byId.set(e.message_id, { raw: e, contactIds: [contact.id] });
    }
  }

  const kept = [...byId.values()].sort((a, b) => Date.parse(b.raw.time) - Date.parse(a.raw.time));
  const texts = await mapLimit(kept.slice(0, MAX_EMAIL_BODIES), ZOHO_CONCURRENCY, (k) => emailText(k.contactIds[0], k.raw));

  const emails: EmailItem[] = kept.map((k, i) => ({
    messageId: k.raw.message_id,
    contactIds: k.contactIds,
    time: k.raw.time,
    direction: k.raw.sent ? 'out' : 'in',
    from: k.raw.from?.user_name || k.raw.from?.email || '',
    to: (k.raw.to ?? []).map((t) => t.user_name || t.email || '').filter(Boolean),
    subject: oneLine(k.raw.subject),
    owner: k.raw.owner?.name ?? null,
    text: i < texts.length ? texts[i] : null,
  }));
  return { emails, emailCounts: { listed, bulk: bulkIds.size } };
}

/** Overdue invoices with their balance due, live: the mirror never sees a void. */
/** One CRM account is one Books customer per office, two at most; more means a filter was dropped. */
const MAX_CUSTOMERS_PER_ACCOUNT = 3;

/**
 * Overdue invoices from two lookups merged on the invoice id: by the CRM account
 * id with `status=overdue`, and by each linked Books customer with
 * `filter_by=Status.OverDue`. Never `zcrm_account_id` with `filter_by`: Books
 * then drops the account filter and returns the whole org's overdue list.
 */
async function gatherOverdue(
  accountId: string,
  links: Array<{ books_customer_id: string; office: string }>,
  warnings: string[],
): Promise<{ live: boolean; items: OverdueInvoice[] }> {
  const byId = new Map<string, OverdueInvoice>();
  let live = true;
  const lookups: Array<{ office: string; query: Record<string, string>; byAccount: boolean }> = [
    ...Object.keys(BOOKS_ORG_IDS).map((office) => ({ office, query: { zcrm_account_id: accountId, status: 'overdue' }, byAccount: true })),
    ...links.map((l) => ({ office: l.office, query: { customer_id: l.books_customer_id, filter_by: 'Status.OverDue' }, byAccount: false })),
  ];
  await mapLimit(lookups, 2, async (lookup) => {
    const orgId = BOOKS_ORG_IDS[lookup.office];
    if (!orgId) return;
    try {
      const res = await booksGet<{ invoices?: RawOverdueInvoice[] }>('invoices', orgId, { ...lookup.query, per_page: '200' });
      const list = (res?.invoices ?? []).filter((i) => !i.status || i.status === 'overdue');
      if (lookup.byAccount && new Set(list.map((i) => i.customer_id)).size > MAX_CUSTOMERS_PER_ACCOUNT) {
        warnings.push(`Factures en retard ${lookup.office} par compte ignorées (filtre non appliqué par Books).`);
        return;
      }
      for (const i of list) {
        if (byId.has(i.invoice_id)) continue;
        byId.set(i.invoice_id, {
          id: i.invoice_id,
          number: i.invoice_number,
          date: i.date,
          dueDate: i.due_date || null,
          balance: Math.round(((Number(i.balance) || 0) / QC_TAX_FACTOR) * 100) / 100,
          balanceTaxIncl: Number(i.balance) || 0,
          office: lookup.office,
        });
      }
    } catch (err) {
      live = false;
      warnings.push(`Factures en retard ${lookup.office} non vérifiées dans Books (${err instanceof Error ? err.message : err}).`);
    }
  });
  return { live, items: [...byId.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

/**
 * Quotes of every status, from two lookups merged on the estimate id: by the
 * CRM account id, and by each Books customer linked in the mirror. The mirror's
 * links come from invoices, so a client quoted but never billed is found only by
 * the first. Books drops `zcrm_account_id` silently when `filter_by` is also
 * sent, so it is never combined with one.
 */
async function gatherQuotes(
  accountId: string,
  links: Array<{ books_customer_id: string; office: string }>,
  sinceDay: string,
  warnings: string[],
): Promise<QuoteItem[]> {
  // A Books failure leaves the summary without quotes, not without a summary.
  const byId = new Map<string, QuoteItem>();
  const add = (q: RawEstimate, office: string) => {
    if (q.date < sinceDay || byId.has(q.estimate_id)) return;
    const plainDate = (v: string | null | undefined) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
    byId.set(q.estimate_id, {
      id: q.estimate_id,
      number: q.estimate_number,
      title: q.reference_number?.trim() || null,
      date: q.date,
      status: q.status,
      total: Math.round(((Number(q.total) || 0) / QC_TAX_FACTOR) * 100) / 100,
      expiry: q.expiry_date || null,
      acceptedOn: plainDate(q.accepted_date),
      declinedOn: plainDate(q.declined_date),
      viewedOn: q.is_viewed_by_client ? q.client_viewed_time || q.date : null,
      followUp: plainDate(q.cf_date_suivi_unformatted),
      department: q.cf_d_partement?.trim() || null,
      contact: q.cf_contact_person_name?.trim() || null,
      salesperson: q.salesperson_name || null,
      office,
    });
  };
  const lookups: Array<{ office: string; query: Record<string, string>; byAccount: boolean }> = [
    ...Object.keys(BOOKS_ORG_IDS).map((office) => ({ office, query: { zcrm_account_id: accountId }, byAccount: true })),
    ...links.map((l) => ({ office: l.office, query: { customer_id: l.books_customer_id }, byAccount: false })),
  ];
  await mapLimit(lookups, 2, async (lookup) => {
    const orgId = BOOKS_ORG_IDS[lookup.office];
    if (!orgId) return;
    try {
      const res = await booksGet<{ estimates?: RawEstimate[] }>('estimates', orgId, {
        ...lookup.query, per_page: '200', sort_column: 'date', sort_order: 'D',
      });
      const list = res?.estimates ?? [];
      if (lookup.byAccount && new Set(list.map((q) => q.customer_id)).size > MAX_CUSTOMERS_PER_ACCOUNT) {
        warnings.push(`Devis ${lookup.office} par compte ignorés (filtre non appliqué par Books).`);
        return;
      }
      for (const q of list) add(q, lookup.office);
    } catch (err) {
      warnings.push(`Devis ${lookup.office} non lus (${err instanceof Error ? err.message : err}).`);
    }
  });
  return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date));
}

// ─── Invoice documents ────────────────────────────────────────────────────────
// The mirror holds one amount per invoice. The lines, payments, notes and terms
// are only on Books' detail endpoint, one call per document, so what was read is
// kept in invoice_details and read again when the mirror's status or amount has
// moved, when an unpaid invoice's copy is a day old (payments, reminders), or
// when DETAIL_FORMAT changes.

/** Bump to read every cached document again after changing what is kept. */
const DETAIL_FORMAT = 1;
const UNPAID_STATUSES = new Set(['sent', 'overdue', 'partial', 'draft']);
const UNPAID_DETAIL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Detail reads per Books org per rolling minute, per function instance. Zoho
 * allows 100 a minute per org, shared with the syncs and up to three workers.
 */
const DETAIL_CALLS_PER_MIN = 20;
/** Reading stops after this; the documents left keep their summary line until the next generation. */
const DETAIL_BUDGET_MS = 40_000;
const DETAIL_CONCURRENCY = 3;
const DETAIL_TEXT_CHARS = 2_000;

/**
 * The invoices the dossier lists one by one, newest first: every overdue one
 * whatever its age, those of the last STATS_DAYS, and the last invoice in any
 * case (the computed facts name it).
 */
export function listedInvoices(invoices: InvoiceItem[], overdueIds: Set<string>, nowMs: number): InvoiceItem[] {
  const since = nowMs - STATS_DAYS * 86_400_000;
  const late = invoices.filter((i) => overdueIds.has(i.id) || i.status === 'overdue');
  const lastInvoice = invoices.find((i) => !i.isCredit);
  const recentOthers = invoices.filter((i) => Date.parse(i.date) >= since && !late.includes(i));
  if (lastInvoice && !late.includes(lastInvoice) && !recentOthers.includes(lastInvoice)) recentOthers.unshift(lastInvoice);
  return [...late, ...recentOthers.slice(0, Math.max(0, MAX_INVOICE_LINES - late.length))]
    .sort((x, y) => y.date.localeCompare(x.date))
    .slice(0, MAX_INVOICE_LINES);
}

/** What the mirror says of a document; a change means the cached copy may be out of date. */
function mirrorKey(inv: InvoiceItem): string {
  return `${inv.status}|${inv.amount}`;
}

const detailCalls = new Map<string, number[]>();

/** Waits for room in the org's rolling minute; false when that would pass `deadline`. */
async function detailSlot(office: string, deadline: number): Promise<boolean> {
  for (;;) {
    const now = Date.now();
    const recent = (detailCalls.get(office) ?? []).filter((t) => t > now - 60_000);
    detailCalls.set(office, recent);
    if (recent.length < DETAIL_CALLS_PER_MIN) {
      recent.push(now);
      return true;
    }
    const wait = recent[0] + 60_000 - now;
    if (now + wait > deadline) return false;
    await new Promise((r) => setTimeout(r, wait));
  }
}

function amount(v: unknown): number {
  return Number(v) || 0;
}

function docText(v: string | null | undefined): string | null {
  const text = (v ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text ? truncate(text, DETAIL_TEXT_CHARS) : null;
}

/** Custom fields as "label: value"; a check box reads oui or non. */
function customFields(fields: RawCustomField[] | undefined, skip: Set<string>): Array<{ label: string; value: string }> {
  return (fields ?? []).flatMap((f) => {
    const label = f.label?.trim();
    const raw = f.value_formatted ?? f.value;
    const value = raw === true || raw === 'true' ? 'oui' : raw === false || raw === 'false' ? 'non' : String(raw ?? '').trim();
    return label && value && !skip.has(f.api_name ?? '') ? [{ label, value }] : [];
  });
}

function toDetail(r: RawBooksDocument, kind: InvoiceDetail['kind'], readAt: string): InvoiceDetail {
  const plainDate = (v: string | null | undefined) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  return {
    kind,
    reference: r.reference_number?.trim() || null,
    dueDate: plainDate(r.due_date),
    paymentTerms: r.payment_terms_label?.trim() || null,
    salesperson: r.salesperson_name?.trim() || null,
    createdBy: r.created_by_name?.trim() || null,
    fields: customFields(r.custom_fields, new Set(['cf_d_partement'])),
    lines: (r.line_items ?? []).map((l) => ({
      name: l.name?.trim() || null,
      description: docText(l.description),
      quantity: amount(l.quantity),
      unit: l.unit?.trim() || null,
      rate: amount(l.rate),
      discount: typeof l.discount === 'string' ? l.discount.trim() || null : amount(l.discount) || null,
      total: amount(l.item_total),
    })),
    subTotal: amount(r.sub_total),
    discount: amount(r.discount_total ?? r.discount_amount),
    shipping: amount(r.shipping_charge),
    adjustment: amount(r.adjustment),
    adjustmentLabel: r.adjustment_description?.trim() || null,
    tax: amount(r.tax_total),
    total: amount(r.total),
    balance: amount(r.balance),
    paid: amount(r.payment_made),
    credited: amount(kind === 'creditnote' ? r.total_credits_used : r.credits_applied),
    writtenOff: amount(r.write_off_amount),
    refunded: amount(r.total_refunded_amount),
    lastPayment: plainDate(r.last_payment_date),
    appliedTo: (r.invoices_credited ?? []).flatMap((c) => (c.invoice_number ? [{ number: c.invoice_number, amount: amount(c.credited_amount) }] : [])),
    reason: r.reason?.trim() || null,
    sentTo: (r.contact_persons_associated ?? []).map((p) => {
      const name = [p.first_name, p.last_name].map((s) => s?.trim()).filter(Boolean).join(' ');
      const email = p.contact_person_email?.trim();
      return name && email ? `${name} <${email}>` : name || email || '';
    }).filter(Boolean),
    viewedOn: r.is_viewed_in_mail ? plainDate(r.mail_first_viewed_time) : null,
    reminders: amount(r.reminders_sent),
    lastReminder: plainDate(r.last_reminder_sent_date),
    notes: docText(r.notes),
    terms: docText(r.terms),
    customer: { number: r.contact_number?.trim() || null, fields: customFields(r.customer_custom_fields, new Set()) },
    readAt,
  };
}

interface CachedDetail {
  zoho_id: string;
  format: number;
  mirror_key: string;
  detail: InvoiceDetail;
  fetched_at: string;
}

/**
 * Sets `detail` on each invoice: from invoice_details when the copy is current,
 * otherwise from Books, paced per org and within DETAIL_BUDGET_MS, newest first.
 * A failed read leaves the invoice its summary line; the cache is optional.
 */
async function gatherInvoiceDetails(invoices: InvoiceItem[], db: Db, warnings: string[]): Promise<void> {
  if (invoices.length === 0) return;
  let cached: CachedDetail[] = [];
  try {
    cached = (await mapLimit(chunk(invoices.map((i) => i.id), 100), 2, (ids) =>
      db.select<CachedDetail>('invoice_details', { select: 'zoho_id,format,mirror_key,detail,fetched_at', in: { zoho_id: ids } }))).flat();
  } catch (err) {
    console.error('account-summary: invoice_details read failed', err instanceof Error ? err.message : err);
  }
  const copyOf = new Map(cached.filter((c) => c.format === DETAIL_FORMAT).map((c) => [c.zoho_id, c]));

  const now = Date.now();
  const toRead: InvoiceItem[] = [];
  for (const inv of invoices) {
    const copy = copyOf.get(inv.id);
    // A copy taken at another status or amount may hold other lines; one that is only old still says what was sold.
    if (copy?.mirror_key === mirrorKey(inv)) inv.detail = copy.detail;
    const current = !!copy && copy.mirror_key === mirrorKey(inv) &&
      !(UNPAID_STATUSES.has(inv.status) && now - Date.parse(copy.fetched_at) > UNPAID_DETAIL_MAX_AGE_MS);
    if (!current && inv.office && BOOKS_ORG_IDS[inv.office]) toRead.push(inv);
  }
  if (toRead.length === 0) return;

  const deadline = now + DETAIL_BUDGET_MS;
  const rows: Array<Record<string, unknown>> = [];
  let failed = 0;
  let notReached = 0;
  let lastError = '';
  await mapLimit(toRead, DETAIL_CONCURRENCY, async (inv) => {
    const office = inv.office!;
    if (!await detailSlot(office, deadline)) { notReached++; return; }
    const kind: InvoiceDetail['kind'] = inv.isCredit ? 'creditnote' : 'invoice';
    try {
      const res = await booksGet<{ invoice?: RawBooksDocument; creditnote?: RawBooksDocument }>(`${kind}s/${inv.id}`, BOOKS_ORG_IDS[office]);
      const raw = kind === 'creditnote' ? res?.creditnote : res?.invoice;
      if (!raw) throw new Error('réponse vide');
      const readAt = new Date().toISOString();
      inv.detail = toDetail(raw, kind, readAt);
      rows.push({
        zoho_id: inv.id, office, kind, format: DETAIL_FORMAT, mirror_key: mirrorKey(inv), detail: inv.detail, fetched_at: readAt,
      });
    } catch (err) {
      failed++;
      lastError = err instanceof Error ? err.message : String(err);
    }
  });
  if (failed) warnings.push(`Détail de ${failed} facture(s) non lu dans Zoho Books (${lastError.slice(0, 200)}).`);
  if (notReached) console.log(`account-summary: ${notReached} invoice detail(s) left for the next generation (pacing)`);
  if (rows.length) {
    try {
      await db.upsert('invoice_details', rows);
    } catch (err) {
      console.error('account-summary: invoice_details write failed', err instanceof Error ? err.message : err);
    }
  }
}

export async function gatherDossier(accountId: string, db: Db): Promise<Dossier> {
  const warnings: string[] = [];
  const sinceDate = monthsAgo(WINDOW_MONTHS);
  const since = sinceDate.getTime();
  const sinceCoql = coqlTime(sinceDate);

  const [accounts, contactRows, invoiceRows, booksLinks] = await Promise.all([
    db.select<AccountProfile>('zoho_accounts', {
      select: 'zoho_account_id,account_name,rep_name,owner_name,created_time,origine_du_client,service_interest,' +
        'domaine_activite,region_administrative,rating,description,budget_publicitaire_annuel,nombre_employes,' +
        'parent_account_name,website,billing_city,type_marche',
      eq: { zoho_account_id: accountId },
    }),
    db.select<{ zoho_record_id: string; full_name: string | null; title: string | null; email: string | null; language: string | null }>(
      'zoho_leads', {
        select: 'zoho_record_id,full_name,title,email,language',
        eq: { account_id: accountId, stage: 'contact' },
        order: 'created_time.desc',
      },
    ),
    db.select<{ zoho_id: string; invoice_number: string | null; invoice_date: string; amount: number; status: string; department: string | null; zoho_department_label: string | null; rep_name: string | null; office: string | null; is_avoir: boolean }>(
      'invoices', {
        select: 'zoho_id,invoice_number,invoice_date,amount,status,department,zoho_department_label,rep_name,office,is_avoir',
        eq: { crm_account_id: accountId },
        order: 'invoice_date.desc',
      },
    ),
    db.select<{ books_customer_id: string; office: string }>('zoho_books_customers', {
      select: 'books_customer_id,office',
      eq: { crm_account_id: accountId },
    }),
  ]);

  const account = accounts[0];
  if (!account) throw new Error('Compte introuvable dans le miroir Supabase.');

  const contacts: Contact[] = contactRows.slice(0, MAX_CONTACTS).map((c) => ({
    id: c.zoho_record_id,
    name: c.full_name?.trim() || c.email || 'Contact sans nom',
    title: c.title,
    email: c.email,
    language: c.language,
  }));
  const contactName = new Map(contacts.map((c) => [c.id, c.name]));
  const contactIdList = contacts.length ? coqlIds(contacts.map((c) => c.id)) : null;
  const accountLit = coqlIds([accountId]);

  // Everything that only needs the contact list starts at once. Notes wait for
  // the tasks: they are also written on tasks, so the task ids feed that query.
  const taskFields = 'Subject, Status, Due_Date, Created_Time, Closed_Time, Owner, Created_By, Who_Id, Description';
  const eventFields = 'Event_Title, Start_DateTime, End_DateTime, Owner, Who_Id, Description';
  const byContacts = <T>(query: string): Promise<T[]> => (contactIdList ? coql<T>(query) : Promise.resolve([]));
  // Meetings and notes: a failed read leaves a warning on the card, not a failed summary.
  const soft = <T>(label: string, p: Promise<T[]>): Promise<T[]> => p.catch((err) => {
    warnings.push(`${label} non lus (${err instanceof Error ? err.message : err}).`);
    return [] as T[];
  });

  const usersP = userNames();
  const tasksP = Promise.all([
    coql<RawTask>(`select ${taskFields} from Tasks where What_Id = ${accountLit} order by Created_Time desc limit 2000`),
    byContacts<RawTask>(`select ${taskFields} from Tasks where Who_Id in (${contactIdList}) order by Created_Time desc limit 2000`),
  ]);
  const activityP = Promise.all([
    soft('Rencontres', coql<RawEvent>(`select ${eventFields} from Events where What_Id = ${accountLit} and Start_DateTime >= '${sinceCoql}' order by Start_DateTime desc limit 2000`)),
    soft('Rencontres des contacts', byContacts<RawEvent>(`select ${eventFields} from Events where Who_Id in (${contactIdList}) and Start_DateTime >= '${sinceCoql}' order by Start_DateTime desc limit 2000`)),
  ]);
  const emailsP = gatherEmails(contacts, since, warnings);
  const quotesP = gatherQuotes(accountId, booksLinks, sinceDate.toISOString().slice(0, 10), warnings);
  const overdueP = gatherOverdue(accountId, booksLinks, warnings);

  const invoices: InvoiceItem[] = invoiceRows.map((i) => ({
    id: i.zoho_id,
    number: i.invoice_number,
    date: i.invoice_date,
    amount: Number(i.amount) || 0,
    status: i.status,
    department: i.department ?? i.zoho_department_label,
    rep: i.rep_name,
    office: i.office,
    isCredit: i.is_avoir,
    detail: null,
  }));
  // The overdue list decides which old invoices are listed, so their documents are read after it.
  const detailsP = overdueP.then((o) => gatherInvoiceDetails(
    listedInvoices(invoices, new Set(o.live ? o.items.map((i) => i.id) : []), Date.now()), db, warnings,
  ));

  const [taskOnAccount, taskOnContacts] = await tasksP;
  const taskById = new Map<string, RawTask>();
  for (const t of [...taskOnAccount, ...taskOnContacts]) taskById.set(t.id, t);
  const allTasks = [...taskById.values()];
  const isRecent = (iso: string | null | undefined) => !!iso && Date.parse(iso) >= since;
  const relevantTasks = allTasks.filter((t) => !t.Closed_Time || isRecent(t.Closed_Time) || isRecent(t.Created_Time));

  // Notes on the account, on its contacts and on its tasks.
  const parentIds = [accountId, ...contacts.map((c) => c.id), ...relevantTasks.map((t) => t.id)];
  const notesP = mapLimit(chunk(parentIds, 50), 2, (ids) =>
    soft('Notes', coql<RawNote>(
      `select Note_Title, Note_Content, Parent_Id, Created_Time, Owner from Notes ` +
      `where Parent_Id in (${coqlIds(ids)}) and Created_Time >= '${sinceCoql}' order by Created_Time desc limit 2000`,
    )));

  const [users, noteBatches, [eventsA, eventsC], emailPart, quotes, overdue] =
    await Promise.all([usersP, notesP, activityP, emailsP, quotesP, overdueP, detailsP]);
  const person = (l: Lookup | null | undefined) => (l?.id ? users.names.get(l.id) || l.name || null : null);
  const who = (l: Lookup | null | undefined) => (l?.id ? contactName.get(l.id) ?? l.name ?? null : null);

  const tasks: TaskItem[] = relevantTasks.map((t) => ({
    id: t.id,
    subject: oneLine(t.Subject) || '(sans objet)',
    status: t.Status,
    due: t.Due_Date,
    created: t.Created_Time,
    closed: t.Closed_Time,
    owner: person(t.Owner),
    automated: !!t.Created_By?.id && users.automationIds.has(t.Created_By.id),
    contactName: who(t.Who_Id),
    description: t.Description ? truncate(htmlToText(t.Description), 400) : null,
  }));
  const taskSubject = new Map(allTasks.map((t) => [t.id, oneLine(t.Subject)]));

  const notes: NoteItem[] = noteBatches.flat()
    .map((n) => {
      const parentId = n.Parent_Id?.id ?? accountId;
      const parentModule = n.Parent_Id?.module?.api_name ?? 'Accounts';
      return {
        id: n.id,
        parentModule,
        parentId,
        parentLabel: parentModule === 'Tasks'
          ? `tâche « ${taskSubject.get(parentId) ?? '?'} »`
          : parentModule === 'Contacts' ? `contact ${contactName.get(parentId) ?? ''}`.trim() : null,
        created: n.Created_Time,
        author: person(n.Owner) ?? 'Inconnu',
        automated: !!n.Owner?.id && users.automationIds.has(n.Owner.id),
        title: n.Note_Title ? oneLine(n.Note_Title, 80) : null,
        text: truncate(htmlToText(n.Note_Content), NOTE_CHARS),
      };
    })
    .filter((n) => n.text || n.title)
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));

  const eventById = new Map<string, RawEvent>();
  for (const e of [...eventsA, ...eventsC]) eventById.set(e.id, e);
  const meetings: MeetingItem[] = [...eventById.values()].map((e) => ({
    id: e.id,
    title: oneLine(e.Event_Title) || 'Rencontre',
    start: e.Start_DateTime,
    end: e.End_DateTime,
    owner: person(e.Owner),
    contactName: who(e.Who_Id),
    description: e.Description ? truncate(htmlToText(e.Description), 600) : null,
  })).sort((a, b) => Date.parse(b.start) - Date.parse(a.start));

  return {
    account,
    contacts,
    emails: emailPart.emails,
    emailCounts: emailPart.emailCounts,
    notes,
    tasks,
    meetings,
    quotes,
    overdue,
    invoices,
    windowStart: sinceDate.toISOString(),
    warnings,
  };
}
