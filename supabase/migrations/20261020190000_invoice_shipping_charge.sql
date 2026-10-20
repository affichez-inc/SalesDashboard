-- Shipping fees, visible next to the amount.
--
-- `amount` includes shipping, deliberately: commission is paid on it
-- (20261019190000_zoho_pretax_amount.sql). That is also exactly what tripped up
-- the hand-kept commission sheets: QC-022298 is $3,050 of goods + $312.15 of
-- shipping, the sheet recorded $3,050, and the rep was underpaid on $312.15.
-- Nothing on screen said the $3,362.15 contained shipping. This column is what
-- lets the invoice lists and Ma Paye say so.
--
-- Zoho's shipping_charge, before tax, same sign as amount (negative on a credit
-- note). Read from the detail payload alongside tax_total, by zoho-pretax-sync
-- and by zoho-invoice-sync for what it just wrote. NULL = not read yet.

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS shipping_charge numeric(12,2);

COMMENT ON COLUMN public.invoices.shipping_charge IS
  'Zoho shipping_charge before tax, same sign as amount. Included in amount (commission is paid on it); shown beside it so nobody re-derives it. NULL until the detail read.';

-- The queue now also holds invoices whose amount is already exact but whose
-- shipping has not been read — the 12,000 rows the pre-tax back-fill finished
-- before this column existed. Re-reading them does not touch amount: the detail
-- pass rewrites the same total and tax, so the trigger keeps the exact figure.
CREATE OR REPLACE FUNCTION public.get_pretax_queue(p_office text, p_limit integer)
RETURNS TABLE (source text, zoho_id text, doc_date date)
LANGUAGE sql
STABLE
AS $$
  SELECT q.source, q.zoho_id, q.doc_date
  FROM (
    SELECT CASE WHEN i.is_avoir THEN 'creditnote' ELSE 'invoice' END AS source,
           i.zoho_id, i.invoice_date AS doc_date
    FROM public.invoices i
    WHERE i.office = p_office
      AND i.pretax_error IS NULL
      AND (i.tax_checked_total IS NULL OR i.tax_checked_total IS DISTINCT FROM i.total_incl_tax
           OR i.shipping_charge IS NULL)
    UNION ALL
    SELECT 'estimate', s.zoho_id, s.sale_date
    FROM public.sales s
    WHERE s.office::text = p_office
      AND s.zoho_id IS NOT NULL
      AND s.pretax_error IS NULL
      AND (s.tax_checked_total IS NULL OR s.tax_checked_total IS DISTINCT FROM s.total_incl_tax)
  ) q
  ORDER BY q.doc_date DESC NULLS LAST
  LIMIT p_limit;
$$;

CREATE INDEX IF NOT EXISTS invoices_shipping_pending_idx
  ON public.invoices (office, invoice_date DESC)
  WHERE pretax_error IS NULL AND shipping_charge IS NULL;

-- Weekly invoice detail (Factures > Détail hebdomadaire): + shipping_charge.
-- Body copied from production (it exists in no earlier migration, only in the
-- schema dump); a changed RETURNS TABLE cannot be CREATE OR REPLACEd, hence the
-- DROP, and the grants are restored as production had them.
DROP FUNCTION IF EXISTS public.get_inv_weekly_detail(date, text, text, text);

CREATE FUNCTION public.get_inv_weekly_detail(
  p_week_start date,
  p_office text DEFAULT NULL::text,
  p_status text DEFAULT NULL::text,
  p_rep text DEFAULT NULL::text
)
RETURNS TABLE (
  invoice_date text, client_name text, amount numeric, invoice_number text,
  rep_name text, department text, zoho_department_label text, office text,
  status text, is_avoir boolean, zoho_id text, shipping_charge numeric
)
LANGUAGE sql
AS $$
  SELECT i.invoice_date::text, i.client_name, i.amount::numeric, i.invoice_number,
    i.rep_name, i.department, i.zoho_department_label, i.office::text, i.status::text, i.is_avoir, i.zoho_id,
    i.shipping_charge
  FROM invoices i
  WHERE i.invoice_date >= p_week_start
    AND i.invoice_date < p_week_start + 7
    AND (p_office IS NULL OR i.office::text = p_office)
    AND (p_rep    IS NULL OR i.rep_name = p_rep)
    AND i.client_name NOT IN (SELECT client_name FROM excluded_clients)
    AND (i.rep_name IS NULL OR i.rep_name NOT IN (SELECT rep_name FROM excluded_reps))
    AND (CASE WHEN p_status IS NULL THEN i.status::text NOT IN ('void')
              ELSE i.status::text = p_status END)
  ORDER BY i.invoice_date DESC;
$$;

GRANT ALL ON FUNCTION public.get_inv_weekly_detail(date, text, text, text) TO anon;
GRANT ALL ON FUNCTION public.get_inv_weekly_detail(date, text, text, text) TO authenticated;
GRANT ALL ON FUNCTION public.get_inv_weekly_detail(date, text, text, text) TO service_role;
