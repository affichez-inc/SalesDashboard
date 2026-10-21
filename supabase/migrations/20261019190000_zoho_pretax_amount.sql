-- The pre-tax amount is Zoho's, not an estimate of it.
--
-- Until now every sync stored `amount = total / 1.14975`: Zoho's tax-included
-- total with Quebec GST+QST backed out. That is exact only when every line is
-- taxed at exactly 14.975%. Audited against the live Books API on 2026-10-19
-- for three reps' complete 2026 (750 documents):
--
--   * untaxed invoices came out 13% low (Centre dentaire Montcalm, $275 billed,
--     stored $239.18);
--   * invoices with fees or line-level tax rounding drifted by dollars (Prospair
--     $3,507.14 stored $3,517.93; Buffet Pin $2,423.40 stored $2,386.67);
--   * most of the rest were a cent off.
--
-- The amount that counts — for revenue and for commission — is everything on the
-- document except the taxes: Zoho's total minus Zoho's tax_total. Shipping and
-- other fees stay in (commission is paid on them: QC-022298 is $3,050 of goods +
-- $312.15 shipping = $3,362.15). Zoho's own sub_total would drop the shipping,
-- which is why it is not used.
--
-- tax_total is on the detail payload only (one API call per document), so the
-- list syncs write total_incl_tax and the detail pass fills tax_total later.
-- tax_checked_total records WHICH total the tax was read against: if Zoho's total
-- changes afterwards, the stored tax no longer belongs to it, the row falls back
-- to the estimate and re-enters the detail queue, instead of silently pairing a
-- new total with an old tax.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS total_incl_tax    numeric(12,2),
  ADD COLUMN IF NOT EXISTS tax_total         numeric(12,2),
  ADD COLUMN IF NOT EXISTS tax_checked_total numeric(12,2);

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS total_incl_tax    numeric(12,2),
  ADD COLUMN IF NOT EXISTS tax_total         numeric(12,2),
  ADD COLUMN IF NOT EXISTS tax_checked_total numeric(12,2);

COMMENT ON COLUMN public.invoices.total_incl_tax IS
  'Zoho total, taxes included. Negative on a credit note, like amount.';

COMMENT ON COLUMN public.invoices.tax_total IS
  'Zoho tax_total (detail payload), same sign as total_incl_tax. amount = total_incl_tax - tax_total.';

COMMENT ON COLUMN public.invoices.tax_checked_total IS
  'The total_incl_tax that tax_total was read against. When it differs, amount is an estimate and the row is queued for a detail read.';

COMMENT ON COLUMN public.sales.total_incl_tax IS
  'Zoho estimate total, taxes included.';

COMMENT ON COLUMN public.sales.tax_total IS
  'Zoho tax_total (estimate detail payload). amount = total_incl_tax - tax_total.';

COMMENT ON COLUMN public.sales.tax_checked_total IS
  'The total_incl_tax that tax_total was read against. When it differs, amount is an estimate and the row is queued for a detail read.';

-- amount is derived here rather than in each sync, so no writer can get it
-- wrong and the rule lives in one place. Rows without total_incl_tax (everything
-- written before the syncs were redeployed) keep their amount untouched.
CREATE OR REPLACE FUNCTION public.zoho_pretax_amount()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.total_incl_tax IS NOT NULL THEN
    IF NEW.tax_total IS NOT NULL AND NEW.tax_checked_total = NEW.total_incl_tax THEN
      NEW.amount := NEW.total_incl_tax - NEW.tax_total;
    ELSE
      -- Not read yet, or Zoho's total moved since: the old estimate, until the
      -- detail pass reaches it.
      NEW.amount := round(NEW.total_incl_tax / 1.14975, 2);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_pretax_amount_trg ON public.invoices;

CREATE TRIGGER invoices_pretax_amount_trg
  BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.zoho_pretax_amount();

DROP TRIGGER IF EXISTS sales_pretax_amount_trg ON public.sales;

CREATE TRIGGER sales_pretax_amount_trg
  BEFORE INSERT OR UPDATE ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.zoho_pretax_amount();

-- Why a detail read failed (404: gone from Zoho). A row carrying one leaves the
-- queue, so a dead record does not cost an API call on every run for ever; the
-- hourly reconcile in zoho-invoice-sync is what removes dead invoices.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS pretax_error text;

ALTER TABLE public.sales    ADD COLUMN IF NOT EXISTS pretax_error text;

-- The back-fill queue for zoho-pretax-sync: one office, invoices, credit notes
-- and quotes together, newest first, so this year is exact long before 2021 is
-- reached. Two columns cannot be compared through PostgREST, hence an RPC.
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
      AND (i.tax_checked_total IS NULL OR i.tax_checked_total IS DISTINCT FROM i.total_incl_tax)
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

REVOKE ALL ON FUNCTION public.get_pretax_queue(text, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_pretax_queue(text, integer) TO service_role;

CREATE INDEX IF NOT EXISTS invoices_pretax_pending_idx
  ON public.invoices (office, invoice_date DESC)
  WHERE pretax_error IS NULL
    AND (tax_checked_total IS NULL OR tax_checked_total IS DISTINCT FROM total_incl_tax);

CREATE INDEX IF NOT EXISTS sales_pretax_pending_idx
  ON public.sales (office, sale_date DESC)
  WHERE pretax_error IS NULL
    AND (tax_checked_total IS NULL OR tax_checked_total IS DISTINCT FROM total_incl_tax);

-- Back-fill progress, for Settings and for checking a run did something.
CREATE OR REPLACE FUNCTION public.get_pretax_backfill_status()
RETURNS TABLE (
  source text, office text, total bigint, exact bigint, pending bigint,
  pending_2026 bigint, errors bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH d AS (
    SELECT 'invoices' AS source, i.office, i.invoice_date AS doc_date, i.pretax_error,
           (i.tax_checked_total IS NOT NULL AND i.tax_checked_total = i.total_incl_tax) AS exact
    FROM public.invoices i
    UNION ALL
    SELECT 'sales', s.office::text, s.sale_date, s.pretax_error,
           (s.tax_checked_total IS NOT NULL AND s.tax_checked_total = s.total_incl_tax)
    FROM public.sales s
    WHERE s.zoho_id IS NOT NULL
  )
  SELECT d.source, d.office, count(*),
         count(*) FILTER (WHERE d.exact),
         count(*) FILTER (WHERE NOT d.exact AND d.pretax_error IS NULL),
         count(*) FILTER (WHERE NOT d.exact AND d.pretax_error IS NULL AND d.doc_date >= DATE '2026-01-01'),
         count(*) FILTER (WHERE d.pretax_error IS NOT NULL)
  FROM d
  GROUP BY d.source, d.office
  ORDER BY 1, 2;
$$;

REVOKE ALL ON FUNCTION public.get_pretax_backfill_status() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_pretax_backfill_status() TO authenticated, service_role;
