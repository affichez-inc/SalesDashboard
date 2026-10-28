-- Publicité: the same screen read from quotes as well as from invoices.
--
-- The page compares ad spend with what the accounts it brought in went on to
-- buy. Until now "buy" meant invoiced. p_basis => 'quotes' reads WON quotes
-- instead: accepted or invoiced, dated by acceptance (sale_date), the rule
-- every Devis screen uses, so a quote declined after acceptance is not counted.
-- Accounts, spend, the attribution window and every ratio are computed exactly
-- as before; only the documents summed change. A quote has no credit note, so
-- the quote figure is gross where the invoice figure is net of credits.
--
-- A quote needs the CRM account it belongs to, and `sales` has never stored
-- one. It gets the link invoices already have, through the same bridge:
--
--   quote.customer_id ──▶ Books customer ──zcrm_account_id──▶ CRM account
--                          (zoho_books_customers, resolved once per customer
--                           by zoho-books-customer-link)
--
--   * sales.books_customer_id is written by zoho-sync from the estimates list,
--     which carries customer_id (checked on both orgs). Rows already stored get
--     it from one full walk once the function is deployed.
--   * sales.crm_account_id is never written by a sync. A trigger fills it from
--     the bridge, and the bridge's propagate trigger now updates quotes as well
--     as invoices, so neither side has to know about the other.
--   * enqueue_books_customers also queues the customers named only on a quote:
--     a client quoted but never billed had no row in the bridge.
--
-- Until the walk and the resolver have run, sales.crm_account_id is NULL and the
-- quotes basis reads zero. Deploy this before zoho-sync: its payload names
-- books_customer_id, and a payload naming a missing column fails every upsert.

-- ─── 1. Quote columns ─────────────────────────────────────────────────────────

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS books_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS crm_account_id    TEXT;

COMMENT ON COLUMN public.sales.books_customer_id IS
  'Zoho Books customer_id, from the estimates list. The raw link; written by zoho-sync.';
COMMENT ON COLUMN public.sales.crm_account_id IS
  'Zoho CRM account id, resolved via zoho_books_customers. NULL when the Books '
  'customer is not resolved yet or has no CRM account. Maintained by trigger, '
  'never written by the sync.';

-- Used by the propagate trigger and by the discovery pass.
CREATE INDEX IF NOT EXISTS sales_books_customer_idx
  ON public.sales (books_customer_id)
  WHERE books_customer_id IS NOT NULL;

-- The ad RPCs look quotes up by account and read these three columns, so the
-- lookup stays an index-only scan, as invoices_crm_account_cover2_idx does for
-- invoices.
CREATE INDEX IF NOT EXISTS sales_crm_account_cover_idx
  ON public.sales (crm_account_id) INCLUDE (sale_date, amount, status)
  WHERE crm_account_id IS NOT NULL;

-- ─── 2. Keeping the link in step ──────────────────────────────────────────────

-- Direction 1: a new or re-synced quote picks up whatever the bridge knows.
CREATE OR REPLACE FUNCTION public.sales_fill_crm_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- A miss leaves it NULL, which is the right answer: the customer is not yet
  -- resolved, or has no CRM account. The resolver fills it in later through
  -- zoho_books_customers_propagate.
  SELECT c.crm_account_id
    INTO NEW.crm_account_id
    FROM zoho_books_customers c
   WHERE c.books_customer_id = NEW.books_customer_id
     AND c.link_status = 'linked';
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS sales_fill_crm_account_trg ON public.sales;
CREATE TRIGGER sales_fill_crm_account_trg
  BEFORE INSERT OR UPDATE OF books_customer_id ON public.sales
  FOR EACH ROW
  WHEN (NEW.books_customer_id IS NOT NULL)
  EXECUTE FUNCTION public.sales_fill_crm_account();

-- Direction 2: a customer that has just been resolved back-fills its invoices
-- and, now, its quotes. The invoice half is unchanged.
CREATE OR REPLACE FUNCTION public.zoho_books_customers_propagate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE invoices i
     SET crm_account_id = NEW.crm_account_id,
         crm_contact_id = NEW.crm_contact_id
   WHERE i.books_customer_id = NEW.books_customer_id
     AND (i.crm_account_id IS DISTINCT FROM NEW.crm_account_id
       OR i.crm_contact_id IS DISTINCT FROM NEW.crm_contact_id);

  UPDATE sales s
     SET crm_account_id = NEW.crm_account_id
   WHERE s.books_customer_id = NEW.books_customer_id
     AND s.crm_account_id IS DISTINCT FROM NEW.crm_account_id;
  RETURN NULL;
END;
$function$;

-- ─── 3. Discovery ─────────────────────────────────────────────────────────────
-- Every customer named by an invoice or a quote joins the resolver queue. Cheap
-- to re-run: ON CONFLICT DO NOTHING never re-queues a resolved customer.

CREATE OR REPLACE FUNCTION public.enqueue_books_customers()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted INTEGER;
BEGIN
  WITH named AS (
    SELECT i.books_customer_id, i.office::text AS office, i.client_name,
           i.invoice_date AS doc_date
      FROM invoices i
     WHERE i.books_customer_id IS NOT NULL
       AND i.office IS NOT NULL   -- the org id is needed to call Zoho
    UNION ALL
    -- A client quoted but never billed is named on a quote and nowhere else.
    SELECT s.books_customer_id, s.office::text, s.client_name,
           COALESCE(s.quote_date, s.sale_date)
      FROM sales s
     WHERE s.books_customer_id IS NOT NULL
       AND s.office IS NOT NULL
  ), candidates AS (
    -- DISTINCT ON keeps one row per customer, preferring the most recent
    -- document so customer_name reflects the latest spelling in Books.
    SELECT DISTINCT ON (n.books_customer_id)
           n.books_customer_id, n.office, n.client_name
      FROM named n
     ORDER BY n.books_customer_id, n.doc_date DESC NULLS LAST
  ), ins AS (
    INSERT INTO zoho_books_customers (books_customer_id, office, customer_name, link_status)
    SELECT books_customer_id, office, client_name, 'pending' FROM candidates
    ON CONFLICT (books_customer_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO v_inserted FROM ins;

  RETURN v_inserted;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_books_customers() FROM PUBLIC;

-- ─── 4. The RPCs ──────────────────────────────────────────────────────────────
-- Bodies as in the live database (20261002100000), with p_basis appended and
-- the invoice join in per_acct replaced by a lateral read of either basis.
-- Like p_view, the value is lenient:
-- 'quotes' reads won quotes and anything else, NULL included, reads invoices,
-- so a browser running the previous build gets what it got before. A function
-- gaining a parameter is dropped and created, never overloaded: two signatures
-- under one name make PostgREST refuse the call.

DROP FUNCTION IF EXISTS public.get_ad_performance(p_year integer, p_month integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[]);
DROP FUNCTION IF EXISTS public.get_ad_performance(p_year integer, p_month integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[], p_basis text);
CREATE FUNCTION public.get_ad_performance(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_organic boolean DEFAULT false, p_view text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ad_accounts text[] DEFAULT NULL::text[], p_basis text DEFAULT 'invoices'::text)
 RETURNS TABLE(channel text, sources text[], currencies text[], spend numeric, impressions bigint, clicks bigint, platform_conversions numeric, platform_leads numeric, accounts_created bigint, accounts_invoiced bigint, revenue_attributed numeric, revenue_lifetime numeric, revenue_per_account numeric, cost_per_account numeric, cost_per_client numeric, roas numeric, net numeric, days_with_spend bigint, window_ends_on date, source_first_used date, cohort_from date, cohort_before date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.app_require_section('publicite');

  WITH
  -- The platforms the ad-account selection speaks for. One Google account
  -- selected leaves Meta whole: a platform with none of its accounts in the
  -- list is not filtered. platform is NOT NULL, so NOT IN is safe here.
  picked AS (
    SELECT DISTINCT a.platform
    FROM public.ad_spend_daily a
    WHERE a.ad_account_id = ANY(p_ad_accounts)
  ),
  period AS (
    SELECT * FROM public.ad_period(p_year, p_month)
  ),
  map AS (
    SELECT m.*
    FROM public.ad_channel_source_map(public.ad_resolve_view(p_view, p_organic)) m
    WHERE p_sources IS NULL OR m.source_value = ANY(p_sources)
  ),
  src AS (
    SELECT m.channel,
           array_agg(DISTINCT m.source_value ORDER BY m.source_value) AS sources,
           min(m.created_from)   AS cohort_from,
           max(m.created_before) AS cohort_before
    FROM map m
    GROUP BY m.channel
  ),
  -- Spend belongs to the paid view only: the other two cost nothing.
  sp AS (
    SELECT
      d.platform AS channel,
      COALESCE(sum(d.spend), 0)       AS spend,
      COALESCE(sum(d.impressions), 0) AS impressions,
      COALESCE(sum(d.clicks), 0)      AS clicks,
      COALESCE(sum(d.conversions), 0) AS conversions,
      COALESCE(sum(d.leads), 0)       AS leads,
      count(DISTINCT d.spend_date)    AS days_with_spend,
      array_agg(DISTINCT d.currency) FILTER (WHERE d.currency IS NOT NULL) AS currencies
    FROM public.ad_spend_daily d, period p
    WHERE public.ad_resolve_view(p_view, p_organic) = 'paid'
      AND d.spend_date >= p.period_start
      AND d.spend_date <  p.period_end
      -- The selection narrows only the platforms it names (see `picked`).
      AND (p_ad_accounts IS NULL
           OR d.ad_account_id = ANY(p_ad_accounts)
           OR d.platform NOT IN (SELECT platform FROM picked))
    GROUP BY d.platform
  ),
  scoped AS (
    SELECT s.*, m.channel
    -- The month only applies within a year, matching ad_period's spend range.
    -- Sources are narrowed by the map join, so none is passed here.
    FROM public.zoho_accounts_scoped(
           p_year, CASE WHEN p_year IS NULL THEN NULL ELSE p_month END,
           NULL, NULL, NULL, NULL, NULL, p_exclude_ratings,
           p_reps, NULL, p_services, p_domaines, p_regions) s
    JOIN map m
      ON m.source_value = s.origine_du_client
     AND (m.created_from   IS NULL OR s.created_date >= m.created_from)
     AND (m.created_before IS NULL OR s.created_date <  m.created_before)
  ),
  -- What an account bought: its invoices, credit notes included (negative), or
  -- its won quotes dated by acceptance.
  per_acct AS (
    SELECT
      s.channel,
      s.zoho_account_id,
      COALESCE(sum(d.amount) FILTER (
        WHERE d.doc_date >= s.created_date
          AND d.doc_date <  public.zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS attributed,
      COALESCE(sum(d.amount), 0) AS lifetime
    FROM scoped s
    -- LATERAL, with each branch matching the account itself, so each is an
    -- index probe per account (invoices_crm_account_cover2_idx,
    -- sales_crm_account_cover_idx) behind a one-time filter on p_basis, and the
    -- other basis's table is never read: the same plan as before for invoices.
    -- Two other shapes return the same rows and are slower: a UNION ALL of
    -- both tables joined on the account is planned as a hash join over every
    -- invoice, and two LEFT JOINs gated in their ON clauses probe both tables
    -- and discard one side's rows afterwards.
    LEFT JOIN LATERAL (
      SELECT i.invoice_date AS doc_date, i.amount
        FROM public.invoices i
       WHERE p_basis IS DISTINCT FROM 'quotes'
         AND i.crm_account_id = s.zoho_account_id
      UNION ALL
      SELECT q.sale_date, q.amount
        FROM public.sales q
       WHERE p_basis = 'quotes'
         AND q.status IN ('accepted', 'invoiced')
         AND q.crm_account_id = s.zoho_account_id
    ) d ON true
    GROUP BY 1, 2
  ),
  acct AS (
    SELECT
      p.channel,
      count(*)                                  AS accounts_created,
      -- Accounts with something on the chosen basis: invoiced, or with a won quote.
      count(*) FILTER (WHERE p.attributed <> 0) AS accounts_invoiced,
      COALESCE(sum(p.attributed), 0)            AS revenue_attributed,
      COALESCE(sum(p.lifetime), 0)              AS revenue_lifetime
    FROM per_acct p
    GROUP BY p.channel
  ),
  -- True when the accounts are a subset the spend cannot be matched to.
  flags AS (
    SELECT (p_reps IS NOT NULL OR p_services IS NOT NULL
            OR p_domaines IS NOT NULL OR p_regions IS NOT NULL) AS narrowed
  )
  SELECT
    src.channel,
    src.sources,
    COALESCE(sp.currencies, ARRAY[]::TEXT[]),
    ROUND(COALESCE(sp.spend, 0), 2),
    COALESCE(sp.impressions, 0),
    COALESCE(sp.clicks, 0),
    COALESCE(sp.conversions, 0),
    COALESCE(sp.leads, 0),
    COALESCE(acct.accounts_created, 0),
    COALESCE(acct.accounts_invoiced, 0),
    COALESCE(acct.revenue_attributed, 0),
    COALESCE(acct.revenue_lifetime, 0),
    ROUND(COALESCE(acct.revenue_attributed, 0) / NULLIF(acct.accounts_created, 0), 2),
    -- Costs only exist against a spend, and only for the whole channel. Divided
    -- by all accounts created, matching revenue_per_account on Comptes.
    CASE WHEN COALESCE(sp.spend, 0) > 0 AND NOT f.narrowed
         THEN ROUND(sp.spend / NULLIF(acct.accounts_created, 0), 2) END,
    CASE WHEN COALESCE(sp.spend, 0) > 0 AND NOT f.narrowed
         THEN ROUND(sp.spend / NULLIF(acct.accounts_invoiced, 0), 2) END,
    CASE WHEN COALESCE(acct.accounts_created, 0) > 0 AND NOT f.narrowed
         THEN ROUND(acct.revenue_attributed / NULLIF(sp.spend, 0), 2) END,
    CASE WHEN COALESCE(acct.accounts_created, 0) > 0 AND COALESCE(sp.spend, 0) > 0 AND NOT f.narrowed
         THEN ROUND(acct.revenue_attributed - sp.spend, 2) END,
    COALESCE(sp.days_with_spend, 0),
    (SELECT public.ad_window_ends_on(p.period_end, p_window_months) FROM period p),
    fu.first_used,
    src.cohort_from,
    src.cohort_before
  FROM src
  CROSS JOIN flags f
  LEFT JOIN sp   ON sp.channel   = src.channel
  LEFT JOIN acct ON acct.channel = src.channel
  LEFT JOIN public.ad_source_first_used(public.ad_resolve_view(p_view, p_organic)) fu
         ON fu.channel = src.channel
  ORDER BY src.channel;
$function$;

DROP FUNCTION IF EXISTS public.get_ad_monthly(p_year integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[]);
DROP FUNCTION IF EXISTS public.get_ad_monthly(p_year integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[], p_basis text);
CREATE FUNCTION public.get_ad_monthly(p_year integer, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_organic boolean DEFAULT false, p_view text DEFAULT NULL::text, p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ad_accounts text[] DEFAULT NULL::text[], p_basis text DEFAULT 'invoices'::text)
 RETURNS TABLE(channel text, month integer, spend numeric, platform_conversions numeric, accounts_created bigint, accounts_invoiced bigint, revenue_attributed numeric, revenue_per_account numeric, cost_per_account numeric, roas numeric, window_ends_on date, source_first_used date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.app_require_section('publicite');

  WITH
  -- The platforms the ad-account selection speaks for. One Google account
  -- selected leaves Meta whole: a platform with none of its accounts in the
  -- list is not filtered. platform is NOT NULL, so NOT IN is safe here.
  picked AS (
    SELECT DISTINCT a.platform
    FROM public.ad_spend_daily a
    WHERE a.ad_account_id = ANY(p_ad_accounts)
  ),
  map AS (
    SELECT m.*
    FROM public.ad_channel_source_map(public.ad_resolve_view(p_view, p_organic)) m
    WHERE p_sources IS NULL OR m.source_value = ANY(p_sources)
  ),
  grid AS (
    SELECT c.channel, g.month
    FROM (SELECT DISTINCT channel FROM map) c
    CROSS JOIN generate_series(1, 12) AS g(month)
  ),
  sp AS (
    SELECT
      d.platform AS channel,
      EXTRACT(MONTH FROM d.spend_date)::INT AS month,
      sum(d.spend)       AS spend,
      sum(d.conversions) AS conversions
    FROM public.ad_spend_daily d
    WHERE public.ad_resolve_view(p_view, p_organic) = 'paid'
      AND d.spend_date >= pg_catalog.make_date(p_year, 1, 1)
      AND d.spend_date <  pg_catalog.make_date(p_year + 1, 1, 1)
      -- The selection narrows only the platforms it names (see `picked`).
      AND (p_ad_accounts IS NULL
           OR d.ad_account_id = ANY(p_ad_accounts)
           OR d.platform NOT IN (SELECT platform FROM picked))
    GROUP BY 1, 2
  ),
  scoped AS (
    SELECT s.*, m.channel
    FROM public.zoho_accounts_scoped(
           p_year, NULL, NULL, NULL, NULL, NULL, NULL, p_exclude_ratings,
           p_reps, NULL, p_services, p_domaines, p_regions) s
    JOIN map m
      ON m.source_value = s.origine_du_client
     AND (m.created_from   IS NULL OR s.created_date >= m.created_from)
     AND (m.created_before IS NULL OR s.created_date <  m.created_before)
  ),
  -- Same documents as get_ad_performance, read the same way: invoices, or won
  -- quotes (see the note on the lateral read there).
  per_acct AS (
    SELECT
      s.channel,
      EXTRACT(MONTH FROM s.created_date)::INT AS month,
      s.zoho_account_id,
      COALESCE(sum(d.amount) FILTER (
        WHERE d.doc_date >= s.created_date
          AND d.doc_date <  public.zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS attributed
    FROM scoped s
    LEFT JOIN LATERAL (
      SELECT i.invoice_date AS doc_date, i.amount
        FROM public.invoices i
       WHERE p_basis IS DISTINCT FROM 'quotes'
         AND i.crm_account_id = s.zoho_account_id
      UNION ALL
      SELECT q.sale_date, q.amount
        FROM public.sales q
       WHERE p_basis = 'quotes'
         AND q.status IN ('accepted', 'invoiced')
         AND q.crm_account_id = s.zoho_account_id
    ) d ON true
    GROUP BY 1, 2, 3
  ),
  acct AS (
    SELECT
      p.channel, p.month,
      count(*)                                  AS accounts_created,
      count(*) FILTER (WHERE p.attributed <> 0) AS accounts_invoiced,
      COALESCE(sum(p.attributed), 0)            AS revenue_attributed
    FROM per_acct p
    GROUP BY 1, 2
  ),
  flags AS (
    SELECT (p_reps IS NOT NULL OR p_services IS NOT NULL
            OR p_domaines IS NOT NULL OR p_regions IS NOT NULL) AS narrowed
  )
  SELECT
    g.channel,
    g.month,
    ROUND(COALESCE(sp.spend, 0), 2),
    ROUND(COALESCE(sp.conversions, 0), 2),
    COALESCE(acct.accounts_created, 0),
    COALESCE(acct.accounts_invoiced, 0),
    COALESCE(acct.revenue_attributed, 0),
    ROUND(COALESCE(acct.revenue_attributed, 0) / NULLIF(acct.accounts_created, 0), 2),
    CASE WHEN COALESCE(sp.spend, 0) > 0 AND NOT f.narrowed
         THEN ROUND(sp.spend / NULLIF(acct.accounts_created, 0), 2) END,
    CASE WHEN COALESCE(acct.accounts_created, 0) > 0 AND NOT f.narrowed
         THEN ROUND(acct.revenue_attributed / NULLIF(sp.spend, 0), 2) END,
    public.ad_window_ends_on(
      (pg_catalog.make_date(p_year, g.month, 1) + INTERVAL '1 month')::date,
      p_window_months),
    fu.first_used
  FROM grid g
  CROSS JOIN flags f
  LEFT JOIN sp   ON sp.channel   = g.channel AND sp.month   = g.month
  LEFT JOIN acct ON acct.channel = g.channel AND acct.month = g.month
  LEFT JOIN public.ad_source_first_used(public.ad_resolve_view(p_view, p_organic)) fu
         ON fu.channel = g.channel
  ORDER BY g.channel, g.month;
$function$;

-- SECURITY DEFINER: not callable by PUBLIC or anon, as before.
REVOKE ALL ON FUNCTION public.get_ad_performance(p_year integer, p_month integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[], p_basis text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ad_performance(p_year integer, p_month integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[], p_basis text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_ad_monthly(p_year integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[], p_basis text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ad_monthly(p_year integer, p_window_months integer, p_exclude_ratings text[], p_organic boolean, p_view text, p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ad_accounts text[], p_basis text) TO authenticated, service_role;
