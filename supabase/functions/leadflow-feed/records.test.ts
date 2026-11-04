// deno test --allow-env supabase/functions/leadflow-feed/records.test.ts
import { assertEquals } from 'jsr:@std/assert@1';
import {
  creditNoteRecord, customerRecord, decodeCursor, descriptor, encodeCursor, idList, invoiceRecord, invoiceStatus, modifiedAfter, pageLimit, quoteRecord,
  quoteStatus, SOURCES,
} from './records.ts';

Deno.test('the descriptor: the contract name and version, four kinds, all by modification time', () => {
  const d = descriptor();
  assertEquals([d.feed, d.version, d.source.currency], ['leadflow-feed', 1, 'CAD']);
  assertEquals(d.kinds.map((k) => k.kind), ['quote', 'invoice', 'credit_note', 'account']);
  assertEquals(d.kinds.every((k) => k.cursor_mode === 'modified' && k.ids === true), true);
  // Every column a mapper reads is in its SOURCES list (a column missing there comes back undefined, silently).
  for (const k of ['quote', 'invoice', 'credit_note', 'account'] as const) assertEquals(SOURCES[k].columns.includes(SOURCES[k].idCol), true);
});

Deno.test('a quote: our sales row as a canonical quote (pre-tax amount, department and office, the customer reference)', () => {
  const r = quoteRecord({
    zoho_id: '602700000012345', quote_number: 'EST-004321', status: 'accepted', zoho_status: 'Accepted', quote_date: '2026-09-20',
    sale_date: '2026-09-25', accepted_date: '2026-09-25', total_incl_tax: '574.88', tax_total: '74.88', amount: '500.00',
    client_name: 'Roy inc.', rep_name: 'Marie Roy', created_at: '2026-09-20T13:00:00+00:00', updated_at: '2026-11-04T15:02:11.123456+00:00',
    department: 'NUMERIQUE', zoho_department_label: 'Numérique', office: 'QC', books_customer_id: '602700000000777',
  });
  assertEquals(r, {
    external_id: '602700000012345', modified_at: '2026-11-04T15:02:11.123Z',
    fields: {
      number: 'EST-004321', status: 'accepted', vendor_status: 'accepted', date: '2026-09-20', accepted_date: '2026-09-25', currency: 'CAD',
      total: 574.88, tax_total: 74.88, total_before_tax: 500, customer_name: 'Roy inc.', salesperson_name: 'Marie Roy',
      created_at: '2026-09-20T13:00:00.000Z', department: 'NUMERIQUE', office: 'QC',
    },
    refs: [{ role: 'account', kind: 'account', external_id: '602700000000777' }],
  });
  // No quote date: the sale date; no department: Zoho's label; no customer: no reference; an unknown status is null.
  const bare = quoteRecord({ zoho_id: 1, status: 'won?', sale_date: '2025-01-02', zoho_department_label: 'Autre', updated_at: null });
  assertEquals(bare && [bare.modified_at, bare.fields.date, bare.fields.status, bare.fields.department, bare.refs], [null, '2025-01-02', null, 'Autre', []]);
  assertEquals(quoteRecord({ quote_number: 'x' }), null);
  assertEquals(['draft', 'sent', 'accepted', 'declined', 'expired', 'invoiced'].map(quoteStatus), ['draft', 'sent', 'accepted', 'declined', 'expired', 'invoiced']);
});

Deno.test('an invoice: our statuses as the canonical ones; a credit note row is never an invoice', () => {
  assertEquals(['sent', 'viewed', 'partial', 'paid', 'overdue', 'void', 'avoir', null].map(invoiceStatus), ['sent', 'sent', 'partially_paid', 'paid', 'overdue', 'void', null, null]);
  const r = invoiceRecord({
    zoho_id: '421000000099', invoice_number: 'INV-000123', status: 'partial', invoice_date: '2026-10-28', total_incl_tax: 1149.75, tax_total: 149.75,
    amount: 1000, client_name: 'Roy inc.', rep_name: 'Marie Roy', updated_at: '2026-11-04T15:02:11Z', department: null, zoho_department_label: 'Application',
    office: 'MTL', books_customer_id: '421000000005', is_avoir: false,
  });
  assertEquals(r, {
    external_id: '421000000099', modified_at: '2026-11-04T15:02:11.000Z',
    fields: {
      number: 'INV-000123', status: 'partially_paid', vendor_status: 'partial', date: '2026-10-28', currency: 'CAD', total: 1149.75, tax_total: 149.75,
      total_before_tax: 1000, customer_name: 'Roy inc.', salesperson_name: 'Marie Roy', department: 'Application', office: 'MTL',
    },
    refs: [{ role: 'account', kind: 'account', external_id: '421000000005' }],
  });
  assertEquals(invoiceRecord({ zoho_id: '1', is_avoir: true }), null);
});

Deno.test('a credit note: the negative row served positive, open unless void', () => {
  const r = creditNoteRecord({
    zoho_id: '421000000100', invoice_number: 'CN-00012', status: 'avoir', invoice_date: '2026-10-30', total_incl_tax: -229.95, tax_total: -29.95, amount: -200,
    client_name: 'Roy inc.', updated_at: '2026-11-01T00:00:00Z', department: 'NUMERIQUE', office: 'MTL', books_customer_id: '421000000005', is_avoir: true,
  });
  assertEquals(r && [r.fields.status, r.fields.vendor_status, r.fields.total, r.fields.tax_total, r.fields.total_before_tax, r.refs.length], ['open', 'avoir', 229.95, 29.95, 200, 1]);
  const voided = creditNoteRecord({ zoho_id: '2', status: 'void', is_avoir: true, amount: -1 });
  assertEquals(voided?.fields.status, 'void');
  assertEquals(creditNoteRecord({ zoho_id: '1', is_avoir: false }), null);
});

Deno.test("a customer: the CRM's account and contact as references, only once Books confirmed the link", () => {
  const linked = customerRecord({ books_customer_id: '602700000000777', customer_name: 'Roy inc.', crm_account_id: 'A1', crm_contact_id: 'C1', link_status: 'linked', synced_at: '2026-10-01T00:00:00Z' });
  assertEquals(linked, {
    external_id: '602700000000777', modified_at: '2026-10-01T00:00:00.000Z', fields: { name: 'Roy inc.', detailed: true },
    refs: [{ role: 'crm_account', kind: 'account', external_id: 'A1' }, { role: 'crm_contact', kind: 'contact', external_id: 'C1' }],
  });
  const pending = customerRecord({ books_customer_id: '1', customer_name: 'X', crm_account_id: 'A1', link_status: 'pending', synced_at: null });
  assertEquals(pending && [pending.refs, pending.modified_at], [[], null]);
});

Deno.test('the cursor round trip, and what is refused; the limit and the ids as the contract bounds them', () => {
  const c = encodeCursor({ t: '2026-11-04T15:02:11.123456+00:00', i: '602700000012345' });
  assertEquals(/^[A-Za-z0-9_-]+$/.test(c), true);
  assertEquals(decodeCursor(c), { t: '2026-11-04T15:02:11.123456+00:00', i: '602700000012345' });
  assertEquals(decodeCursor(encodeCursor({ i: '7' })), { i: '7' });
  for (const bad of ['', 'not base64!', btoa('{"i":""}'), btoa('{"t":"x","i":"1"}'), btoa('[]'), null, 'a'.repeat(401)]) assertEquals(decodeCursor(bad), null, String(bad));
  assertEquals([pageLimit(null), pageLimit('50'), pageLimit('0'), pageLimit('9999'), pageLimit('abc'), pageLimit('2.5')], [200, 50, 1, 500, 200, 200]);
  assertEquals(idList(null), null);
  assertEquals(idList(' 1, 2 ,,2'), ['1', '2']);
  assertEquals(idList(Array.from({ length: 101 }, (_, i) => String(i)).join(',')), 'too_many');
  assertEquals([modifiedAfter(null), modifiedAfter('2026-11-04T15:02:11Z'), modifiedAfter('yesterday')], [null, '2026-11-04T15:02:11.000Z', 'bad']);
});
