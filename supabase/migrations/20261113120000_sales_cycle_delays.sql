-- Sales cycle delays on Comptes: from a lead's arrival to the first won quote of
-- its account, then to the payment of the first invoice after that quote.
--
-- 1. invoices.last_payment_date: Zoho Books' own field, on the list payload
--    (checked on the live API 2026-11-12). zoho-invoice-sync writes it; the hourly
--    reconcile fills rows dated since January of last year, older rows need one
--    full walk (scripts/zoho-books-history-backfill.sh invoices 2014 2024).
-- 2. get_zoho_sales_cycle: one row of counts and delays for the Comptes page.
--    SECURITY DEFINER because Comptes does not read `sales`; it returns
--    aggregates only and refuses a caller without the section.
--
-- Rollback: DROP FUNCTION public.get_zoho_sales_cycle(...);
--           ALTER TABLE public.invoices DROP COLUMN last_payment_date;

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS last_payment_date date;

COMMENT ON COLUMN public.invoices.last_payment_date IS
  'Zoho Books last_payment_date: the latest payment recorded on the invoice. On a paid invoice, the day it was settled. NULL when nothing was paid, and on an invoice settled only by a credit note. NULL on credit notes.';

DROP FUNCTION IF EXISTS public.get_zoho_sales_cycle(integer, integer, text, integer, text[], text[], text[], text[], text[], text[], text[], boolean, text, numeric, numeric, text, text);

CREATE FUNCTION public.get_zoho_sales_cycle(
  p_year integer DEFAULT NULL::integer,
  p_month integer DEFAULT NULL::integer,
  p_rep text DEFAULT NULL::text,
  p_window_months integer DEFAULT 12,
  p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text],
  p_reps text[] DEFAULT NULL::text[],
  p_sources text[] DEFAULT NULL::text[],
  p_services text[] DEFAULT NULL::text[],
  p_domaines text[] DEFAULT NULL::text[],
  p_regions text[] DEFAULT NULL::text[],
  p_ratings text[] DEFAULT NULL::text[],
  p_invoiced boolean DEFAULT NULL::boolean,
  p_amount_period text DEFAULT NULL::text,
  p_amount_min numeric DEFAULT NULL::numeric,
  p_amount_max numeric DEFAULT NULL::numeric,
  p_search text DEFAULT NULL::text,
  p_search_phone text DEFAULT NULL::text)
RETURNS TABLE(
  leads_received bigint,
  leads_won bigint,
  leads_invoiced bigint,
  leads_paid bigint,
  leads_paid_undated bigint,
  median_days_to_won numeric,
  avg_days_to_won numeric,
  median_days_won_to_paid numeric,
  avg_days_won_to_paid numeric,
  median_days_to_paid numeric,
  avg_days_to_paid numeric,
  window_ends_on date)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.app_require_section('comptes');

  WITH
  -- The page's account filters, every one but the period: the period dates the
  -- lead, not the account, which can be older than the lead.
  acct AS (
    SELECT s.zoho_account_id
    FROM public.zoho_accounts_scoped(
      NULL, NULL, p_rep, NULL, NULL, NULL, NULL, p_exclude_ratings, p_reps,
      p_sources, NULL, p_domaines, p_regions, p_ratings,
      p_billed_services => p_services, p_invoiced => p_invoiced, p_amount_period => p_amount_period,
      p_amount_min => p_amount_min, p_amount_max => p_amount_max, p_search => p_search,
      p_search_phone => p_search_phone) s
  ),
  -- Leads received in the period, on Montreal's calendar. A lead never converted
  -- has no account, so nothing after it can be followed: it is not counted.
  lead AS (
    SELECT l.converted_account_id AS account_id,
           public.zoho_lead_local_date(l.created_time) AS lead_date,
           public.zoho_account_window_end(l.created_time, p_window_months) AS window_end
    FROM public.zoho_leads l
    JOIN acct a ON a.zoho_account_id = l.converted_account_id
    WHERE l.stage = 'lead'
      AND (p_year IS NULL OR (
            l.created_time >= pg_catalog.make_timestamptz(p_year,     1, 1, 0, 0, 0, 'America/Toronto')
        AND l.created_time <  pg_catalog.make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'America/Toronto')))
      AND (p_month IS NULL OR EXTRACT(MONTH FROM l.created_time AT TIME ZONE 'America/Toronto')::int = p_month)
  ),
  -- The account's first won quote accepted on or after the lead's day, within
  -- the page's window. sale_date is the acceptance date on a won quote.
  won AS (
    SELECT l.lead_date, l.window_end, l.account_id, q.won_date
    FROM lead l
    LEFT JOIN LATERAL (
      SELECT min(s.sale_date) AS won_date
      FROM public.sales s
      WHERE s.crm_account_id = l.account_id
        AND s.status IN ('accepted', 'invoiced')
        AND s.sale_date >= l.lead_date
        AND s.sale_date <  l.window_end
        AND (p_services IS NULL OR s.department::text = ANY(p_services))
    ) q ON true
  ),
  -- The first invoice issued on or after that acceptance, and when it was paid
  -- in full. Not the first one paid: an unpaid first invoice is the delay.
  paid AS (
    SELECT w.lead_date, w.window_end, w.won_date, f.invoice_date, f.status, f.last_payment_date
    FROM won w
    LEFT JOIN LATERAL (
      SELECT i.invoice_date, i.status::text AS status, i.last_payment_date
      FROM public.invoices i
      WHERE w.won_date IS NOT NULL
        AND i.crm_account_id = w.account_id
        AND NOT i.is_avoir
        AND i.invoice_date >= w.won_date
        AND (p_services IS NULL OR i.department = ANY(p_services))
      ORDER BY i.invoice_date, i.invoice_number
      LIMIT 1
    ) f ON true
  ),
  steps AS (
    SELECT p.lead_date, p.window_end, p.won_date, p.invoice_date,
           CASE WHEN p.status = 'paid' THEN p.last_payment_date END AS paid_date,
           p.status = 'paid' AND p.last_payment_date IS NULL AS paid_undated
    FROM paid p
  )
  SELECT
    count(*),
    count(*) FILTER (WHERE s.won_date IS NOT NULL),
    count(*) FILTER (WHERE s.invoice_date IS NOT NULL),
    count(*) FILTER (WHERE s.paid_date IS NOT NULL),
    count(*) FILTER (WHERE s.paid_undated),
    ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY s.won_date - s.lead_date)
           FILTER (WHERE s.won_date IS NOT NULL))::numeric, 1),
    ROUND(AVG(s.won_date - s.lead_date) FILTER (WHERE s.won_date IS NOT NULL), 1),
    ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY s.paid_date - s.won_date)
           FILTER (WHERE s.paid_date IS NOT NULL))::numeric, 1),
    ROUND(AVG(s.paid_date - s.won_date) FILTER (WHERE s.paid_date IS NOT NULL), 1),
    ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY s.paid_date - s.lead_date)
           FILTER (WHERE s.paid_date IS NOT NULL))::numeric, 1),
    ROUND(AVG(s.paid_date - s.lead_date) FILTER (WHERE s.paid_date IS NOT NULL), 1),
    -- When the last lead of the period stops being able to sign, NULL without a
    -- window. Until that day the figures can still move.
    NULLIF(max(s.window_end), 'infinity'::date)
  FROM steps s;
$function$;

COMMENT ON FUNCTION public.get_zoho_sales_cycle(integer, integer, text, integer, text[], text[], text[], text[], text[], text[], text[], boolean, text, numeric, numeric, text, text) IS
  'Comptes: leads received in the period (stage lead, converted, account matching the filters), the first won quote of the account within the window, the first invoice after it and its payment. Medians and averages in days over the leads that reached each step.';

REVOKE ALL ON FUNCTION public.get_zoho_sales_cycle(integer, integer, text, integer, text[], text[], text[], text[], text[], text[], text[], boolean, text, numeric, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_zoho_sales_cycle(integer, integer, text, integer, text[], text[], text[], text[], text[], text[], text[], boolean, text, numeric, numeric, text, text) TO authenticated, service_role;
