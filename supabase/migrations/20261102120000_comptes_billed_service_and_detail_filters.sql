-- Comptes: the Service filter reads what was billed, and the dashboard takes the
-- filters of the detail page.
--
-- SERVICE. p_services on the six Comptes RPCs, and the list the dropdown offers,
-- now mean invoice departments: an account matches when it holds a real invoice
-- (not a credit note) in one of them, whatever its CRM Service field says. It
-- used to read that field, which says what a client was interested in, not what
-- they bought. An account never billed matches no service. Invoices dated before
-- departments existed carry none, so an account billed only then matches none
-- either.
--
-- Publicité keeps the CRM field: get_ad_filter_options, get_ad_performance and
-- get_ad_monthly call zoho_accounts_scoped positionally and still reach
-- p_services there. That is why the billed list is a parameter of its own. So do
-- the "Par service" breakdown and the Service column of the detail table.
--
-- DASHBOARD. p_invoiced, p_amount_* and p_search* are the Factures, Montant
-- facturé and Recherche filters of Comptes · Détail, on the same definitions: the
-- amounts come from zoho_accounts_enriched itself rather than a second copy of
-- its date arithmetic. Unlike a breakdown's own dimension, none of them is
-- dropped anywhere: no breakdown is by any of them.
--
-- zoho_accounts_enriched gains invoice_departments, which the detail page filters
-- on through PostgREST.
--
-- Appended, never reordered, and DROP + CREATE rather than an overload (PGRST203).
-- Bodies are pg_get_functiondef output from the live database. zoho_accounts_scoped
-- stays SECURITY INVOKER with no SET clause, so the planner still inlines it
-- (CLAUDE.md, performance rule 1).

-- ─── 1. The view ─────────────────────────────────────────────────────────────
-- WITH (security_invoker) is not decoration: CREATE OR REPLACE VIEW replaces the
-- view options, and without it the view would read every table as its owner.
CREATE OR REPLACE VIEW public.zoho_accounts_enriched WITH (security_invoker = true) AS
 SELECT a.zoho_account_id,
    a.account_name,
    a.phone,
    a.website,
    a.description,
    a.billing_street,
    a.billing_city,
    a.billing_state,
    a.billing_code,
    a.billing_country,
    a.owner_name,
    a.owner_email,
    a.rep_name,
    a.charge_de_projets,
    a.created_time,
    zoho_local_date(a.created_time) AS created_date,
    a.modified_time,
    a.last_activity_time,
    a.origine_du_client,
    a.service_interest,
    a.domaine_activite,
    a.region_administrative,
    a.region_cible,
    a.type_marche,
    a.periode_publicitaire,
    a.nombre_employes,
    a.budget_publicitaire_annuel,
    a.potentiel_multi_annonceurs,
    a.potentiel_services_ia,
    a.revendeur,
    a.rating,
    a.tags,
    a.parent_account_id,
    a.parent_account_name,
    a.nombre_taches,
    a.derniere_tache_fermee,
    a.ventes_totales,
    a.ventes_2026,
    a.ventes_2025,
    a.zoho_crm_url,
    COALESCE(i.invoice_count, 0) AS invoice_count,
    COALESCE(i.credit_count, 0) AS credit_count,
    COALESCE(i.revenue_lifetime, 0::numeric) AS revenue_lifetime,
    i.first_invoice_date,
    i.last_invoice_date,
    i.invoice_count IS NOT NULL AS has_invoices,
    zoho_account_is_bulk_import(a.origine_du_client) AS is_bulk_import,
    COALESCE(a.rating = ANY (zoho_internal_ratings()), false) AS is_internal,
        CASE
            WHEN cardinality(a.service_interest) > 0 THEN a.service_interest
            ELSE COALESCE(i.departments, '{}'::text[])
        END AS service_resolved,
        CASE
            WHEN cardinality(a.service_interest) > 0 THEN 'crm'::text
            WHEN COALESCE(cardinality(i.departments), 0) > 0 THEN 'invoice'::text
            ELSE 'none'::text
        END AS service_origin,
    COALESCE(i.revenue_30d, 0::numeric) AS revenue_30d,
    COALESCE(i.revenue_last_month, 0::numeric) AS revenue_last_month,
    COALESCE(i.revenue_12m, 0::numeric) AS revenue_12m,
    COALESCE(i.revenue_ytd, 0::numeric) AS revenue_ytd,
    COALESCE(i.revenue_prev_year, 0::numeric) AS revenue_prev_year,
        CASE
            WHEN COALESCE(a.shipping_street, a.shipping_city, a.shipping_code) IS NOT NULL THEN a.shipping_street
            ELSE a.billing_street
        END AS mail_street,
        CASE
            WHEN COALESCE(a.shipping_street, a.shipping_city, a.shipping_code) IS NOT NULL THEN a.shipping_city
            ELSE a.billing_city
        END AS mail_city,
        CASE
            WHEN COALESCE(a.shipping_street, a.shipping_city, a.shipping_code) IS NOT NULL THEN a.shipping_state
            ELSE a.billing_state
        END AS mail_state,
        CASE
            WHEN COALESCE(a.shipping_street, a.shipping_city, a.shipping_code) IS NOT NULL THEN a.shipping_code
            ELSE a.billing_code
        END AS mail_code,
        CASE
            WHEN COALESCE(a.shipping_street, a.shipping_city, a.shipping_code) IS NOT NULL THEN a.shipping_country
            ELSE a.billing_country
        END AS mail_country,
        CASE
            WHEN COALESCE(a.shipping_street, a.shipping_city, a.shipping_code) IS NOT NULL THEN 'shipping'::text
            WHEN COALESCE(a.billing_street, a.billing_city, a.billing_code, a.billing_state, a.billing_country) IS NOT NULL THEN 'billing'::text
            ELSE NULL::text
        END AS mail_source,
    i.departments AS invoice_departments
   FROM zoho_accounts a
     LEFT JOIN ( SELECT inv.crm_account_id,
            count(*) FILTER (WHERE NOT inv.is_avoir)::integer AS invoice_count,
            count(*) FILTER (WHERE inv.is_avoir)::integer AS credit_count,
            COALESCE(sum(inv.amount), 0::numeric) AS revenue_lifetime,
            min(inv.invoice_date) AS first_invoice_date,
            max(inv.invoice_date) AS last_invoice_date,
            array_agg(DISTINCT inv.department ORDER BY inv.department) FILTER (WHERE inv.department IS NOT NULL AND NOT inv.is_avoir) AS departments,
            sum(inv.amount) FILTER (WHERE inv.invoice_date > d.d30_after AND inv.invoice_date <= d.today) AS revenue_30d,
            sum(inv.amount) FILTER (WHERE inv.invoice_date >= d.last_month_start AND inv.invoice_date < d.month_start) AS revenue_last_month,
            sum(inv.amount) FILTER (WHERE inv.invoice_date > d.m12_after AND inv.invoice_date <= d.today) AS revenue_12m,
            sum(inv.amount) FILTER (WHERE inv.invoice_date >= d.year_start AND inv.invoice_date < d.next_year_start) AS revenue_ytd,
            sum(inv.amount) FILTER (WHERE inv.invoice_date >= d.prev_year_start AND inv.invoice_date < d.year_start) AS revenue_prev_year
           FROM invoices inv
             CROSS JOIN ( SELECT t.today,
                    t.today - 30 AS d30_after,
                    (t.today - '1 year'::interval)::date AS m12_after,
                    date_trunc('month'::text, t.today::timestamp with time zone)::date AS month_start,
                    (date_trunc('month'::text, t.today::timestamp with time zone) - '1 mon'::interval)::date AS last_month_start,
                    date_trunc('year'::text, t.today::timestamp with time zone)::date AS year_start,
                    (date_trunc('year'::text, t.today::timestamp with time zone) + '1 year'::interval)::date AS next_year_start,
                    (date_trunc('year'::text, t.today::timestamp with time zone) - '1 year'::interval)::date AS prev_year_start
                   FROM ( SELECT zoho_local_date(now()) AS today) t
                 OFFSET 0) d
          WHERE inv.crm_account_id IS NOT NULL
          GROUP BY inv.crm_account_id) i ON i.crm_account_id = a.zoho_account_id;

-- ─── 2. The shared scope ─────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.zoho_accounts_scoped(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[]);

CREATE OR REPLACE FUNCTION public.zoho_accounts_scoped(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[], p_billed_services text[] DEFAULT NULL::text[], p_invoiced boolean DEFAULT NULL::boolean, p_amount_period text DEFAULT NULL::text, p_amount_min numeric DEFAULT NULL::numeric, p_amount_max numeric DEFAULT NULL::numeric, p_search text DEFAULT NULL::text, p_search_phone text DEFAULT NULL::text)
 RETURNS TABLE(zoho_account_id text, account_name text, created_time timestamp with time zone, created_date date, rep_name text, origine_du_client text, service_interest text[], domaine_activite text, region_administrative text, rating text, is_bulk_import boolean, ventes_totales numeric)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    a.zoho_account_id, a.account_name, a.created_time,
    (a.created_time AT TIME ZONE 'America/Toronto')::date,
    a.rep_name, a.origine_du_client, a.service_interest,
    a.domaine_activite, a.region_administrative, a.rating,
    COALESCE(a.origine_du_client, '') IN ('Client Royer & Fils / VotreLogo.ca', 'Client PLOGG/BUCCO'),
    a.ventes_totales
  FROM public.zoho_accounts a
  WHERE a.created_time IS NOT NULL
    -- A range, not EXTRACT(YEAR ...): same rows, but this one can use the index.
    AND (p_year IS NULL OR (
          a.created_time >= pg_catalog.make_timestamptz(p_year,     1, 1, 0, 0, 0, 'America/Toronto')
      AND a.created_time <  pg_catalog.make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'America/Toronto')))
    AND (p_month IS NULL OR EXTRACT(MONTH FROM a.created_time AT TIME ZONE 'America/Toronto')::INT = p_month)
    AND (p_rep     IS NULL OR a.rep_name          = p_rep)
    AND (p_reps    IS NULL OR a.rep_name          = ANY(p_reps))
    AND (p_source  IS NULL OR a.origine_du_client = p_source)
    AND (p_sources IS NULL OR a.origine_du_client = ANY(p_sources))
    AND (p_domaine IS NULL OR a.domaine_activite  = p_domaine)
    AND (p_domaines IS NULL OR a.domaine_activite = ANY(p_domaines))
    AND (p_region  IS NULL OR a.region_administrative = p_region)
    AND (p_regions IS NULL OR a.region_administrative = ANY(p_regions))
    -- Case- and space-insensitive, like the leads side: Zoho's service picklist
    -- holds the same service under several spellings and an exact @> match
    -- silently drops all but one.
    AND (p_service IS NULL OR EXISTS (
          SELECT 1 FROM unnest(a.service_interest) AS v
           WHERE public.zoho_service_key(v) = public.zoho_service_key(p_service)
        ))
    -- Any of the selected services, folded the same way.
    AND (p_services IS NULL OR EXISTS (
          SELECT 1 FROM unnest(a.service_interest) AS v
           WHERE public.zoho_service_key(v) IN (
                   SELECT public.zoho_service_key(w) FROM unnest(p_services) AS w)
        ))
    -- NULL means "no exclusions" so a caller can ask for the unfiltered book;
    -- omitting the argument gets the dashboard's default instead. An account with
    -- no rating at all (977 of them) is never excluded by this.
    AND (p_exclude_ratings IS NULL
         OR a.rating IS NULL
         OR NOT (a.rating = ANY(p_exclude_ratings)))
    -- Any of the selected ratings, by the stored (English-session) value. NULL is
    -- no filter; an account with no rating matches no list.
    AND (p_ratings IS NULL OR a.rating = ANY(p_ratings))
    -- Billed for any of these departments. A credit note is not a sale of the
    -- service, so it does not count, the same as zoho_accounts_enriched.departments.
    AND (p_billed_services IS NULL OR EXISTS (
          SELECT 1 FROM public.invoices i
           WHERE i.crm_account_id = a.zoho_account_id
             AND NOT i.is_avoir
             AND i.department = ANY(p_billed_services)
        ))
    -- Any document at all, credit notes included: has_invoices on the view.
    AND (p_invoiced IS NULL OR p_invoiced = EXISTS (
          SELECT 1 FROM public.invoices i WHERE i.crm_account_id = a.zoho_account_id
        ))
    -- ILIKE patterns built by the caller, on the columns Comptes · Détail searches.
    AND (p_search IS NULL
         OR a.account_name ILIKE p_search
         OR a.billing_city ILIKE p_search
         OR a.website      ILIKE p_search
         OR a.phone        ILIKE COALESCE(p_search_phone, p_search))
    -- The amounts are the view's own columns, so this keeps exactly the accounts
    -- Comptes · Détail keeps. An uncorrelated subquery, built once and only when
    -- the period is set: the view aggregates every invoice.
    AND (p_amount_period IS NULL OR a.zoho_account_id IN (
          SELECT e.zoho_account_id
          FROM (
            SELECT v.zoho_account_id,
                   CASE p_amount_period
                     WHEN 'tout'    THEN v.revenue_lifetime
                     WHEN '12m'     THEN v.revenue_12m
                     WHEN 'annee'   THEN v.revenue_ytd
                     WHEN 'annee-1' THEN v.revenue_prev_year
                     WHEN 'mois-1'  THEN v.revenue_last_month
                     WHEN '30j'     THEN v.revenue_30d
                   END AS amount
            FROM public.zoho_accounts_enriched v
          ) e
          WHERE (p_amount_min IS NULL OR e.amount >= p_amount_min)
            AND (p_amount_max IS NULL OR e.amount <= p_amount_max)
        ));
$function$;

GRANT EXECUTE ON FUNCTION public.zoho_accounts_scoped(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[], p_billed_services text[], p_invoiced boolean, p_amount_period text, p_amount_min numeric, p_amount_max numeric, p_search text, p_search_phone text) TO anon, authenticated, service_role, mcp_reader;

-- ─── 3. The Comptes RPCs ─────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_zoho_account_kpis(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_account_kpis(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[], p_invoiced boolean DEFAULT NULL::boolean, p_amount_period text DEFAULT NULL::text, p_amount_min numeric DEFAULT NULL::numeric, p_amount_max numeric DEFAULT NULL::numeric, p_search text DEFAULT NULL::text, p_search_phone text DEFAULT NULL::text)
 RETURNS TABLE(accounts_created bigint, accounts_invoiced bigint, invoiced_rate numeric, revenue_attributed numeric, revenue_lifetime numeric, revenue_per_account numeric, avg_days_to_first_invoice numeric, ventes_royer numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, p_service, p_domaine, p_region, p_exclude_ratings, p_reps,
      p_sources, NULL, p_domaines, p_regions, p_ratings,
      p_billed_services => p_services, p_invoiced => p_invoiced, p_amount_period => p_amount_period,
      p_amount_min => p_amount_min, p_amount_max => p_amount_max, p_search => p_search, p_search_phone => p_search_phone)
  ),
  -- One pass over invoices per account. No GROUP BY on account_id first, unlike
  -- the leads version: scoped rows are already one per account.
  per_acct AS (
    SELECT
      s.zoho_account_id,
      s.created_date,
      s.ventes_totales,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS attributed,
      COALESCE(sum(i.amount), 0) AS lifetime,
      min(i.invoice_date) FILTER (WHERE i.invoice_date >= s.created_date) AS first_inv
    FROM scoped s
    LEFT JOIN invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY s.zoho_account_id, s.created_date, s.created_time, s.ventes_totales
  )
  SELECT
    count(*),
    count(*) FILTER (WHERE p.attributed <> 0),
    CASE WHEN count(*) = 0 THEN 0
         ELSE ROUND(count(*) FILTER (WHERE p.attributed <> 0) * 100.0 / count(*), 1) END,
    COALESCE(sum(p.attributed), 0),
    COALESCE(sum(p.lifetime), 0),
    CASE WHEN count(*) = 0 THEN 0
         ELSE ROUND(COALESCE(sum(p.attributed), 0) / count(*), 2) END,
    ROUND(AVG(p.first_inv - p.created_date) FILTER (WHERE p.first_inv IS NOT NULL), 1),
    COALESCE(sum(p.ventes_totales), 0)
  FROM per_acct p;
$function$;

GRANT EXECUTE ON FUNCTION public.get_zoho_account_kpis(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[], p_invoiced boolean, p_amount_period text, p_amount_min numeric, p_amount_max numeric, p_search text, p_search_phone text) TO anon, authenticated, service_role, mcp_reader;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_by_rep(p_year integer, p_month integer, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_rep(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[], p_invoiced boolean DEFAULT NULL::boolean, p_amount_period text DEFAULT NULL::text, p_amount_min numeric DEFAULT NULL::numeric, p_amount_max numeric DEFAULT NULL::numeric, p_search text DEFAULT NULL::text, p_search_phone text DEFAULT NULL::text)
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, NULL, p_source, p_service, p_domaine, p_region, p_exclude_ratings, p_reps,
      p_sources, NULL, p_domaines, p_regions, p_ratings,
      p_billed_services => p_services, p_invoiced => p_invoiced, p_amount_period => p_amount_period,
      p_amount_min => p_amount_min, p_amount_max => p_amount_max, p_search => p_search, p_search_phone => p_search_phone)
  ),
  per_acct AS (
    SELECT
      COALESCE(s.rep_name, 'Non assigné') AS label,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS amount
    FROM scoped s
    LEFT JOIN invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY 1, 2
  )
  SELECT p.label, count(*), count(*) FILTER (WHERE p.amount <> 0),
         COALESCE(sum(p.amount), 0),
         ROUND(COALESCE(sum(p.amount), 0) / NULLIF(count(*), 0), 2),
         FALSE
  FROM per_acct p
  GROUP BY p.label
  ORDER BY 4 DESC, 2 DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_by_rep(p_year integer, p_month integer, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[], p_invoiced boolean, p_amount_period text, p_amount_min numeric, p_amount_max numeric, p_search text, p_search_phone text) TO anon, authenticated, service_role, mcp_reader;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_by_source(p_year integer, p_month integer, p_rep text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_source(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[], p_invoiced boolean DEFAULT NULL::boolean, p_amount_period text DEFAULT NULL::text, p_amount_min numeric DEFAULT NULL::numeric, p_amount_max numeric DEFAULT NULL::numeric, p_search text DEFAULT NULL::text, p_search_phone text DEFAULT NULL::text)
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, NULL, p_service, p_domaine, p_region, p_exclude_ratings, p_reps,
      NULL, NULL, p_domaines, p_regions, p_ratings,
      p_billed_services => p_services, p_invoiced => p_invoiced, p_amount_period => p_amount_period,
      p_amount_min => p_amount_min, p_amount_max => p_amount_max, p_search => p_search, p_search_phone => p_search_phone)
  ),
  per_acct AS (
    SELECT
      COALESCE(s.origine_du_client, 'Non renseignée') AS label,
      s.is_bulk_import,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS amount
    FROM scoped s
    LEFT JOIN invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY 1, 2, 3
  )
  SELECT p.label, count(*), count(*) FILTER (WHERE p.amount <> 0),
         COALESCE(sum(p.amount), 0),
         ROUND(COALESCE(sum(p.amount), 0) / NULLIF(count(*), 0), 2),
         bool_or(p.is_bulk_import)
  FROM per_acct p
  GROUP BY p.label
  ORDER BY 4 DESC, 2 DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_by_source(p_year integer, p_month integer, p_rep text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[], p_invoiced boolean, p_amount_period text, p_amount_min numeric, p_amount_max numeric, p_search text, p_search_phone text) TO anon, authenticated, service_role, mcp_reader;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_by_service(p_year integer, p_month integer, p_rep text, p_source text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_domaines text[], p_regions text[], p_ratings text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_service(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[], p_invoiced boolean DEFAULT NULL::boolean, p_amount_period text DEFAULT NULL::text, p_amount_min numeric DEFAULT NULL::numeric, p_amount_max numeric DEFAULT NULL::numeric, p_search text DEFAULT NULL::text, p_search_phone text DEFAULT NULL::text)
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, NULL, p_domaine, p_region, p_exclude_ratings, p_reps,
      p_sources, NULL, p_domaines, p_regions, p_ratings,
      p_invoiced => p_invoiced, p_amount_period => p_amount_period, p_amount_min => p_amount_min,
      p_amount_max => p_amount_max, p_search => p_search, p_search_phone => p_search_phone)
  ),
  -- Folded through zoho_service_key so "Distribution publicitaire" and
  -- "Distribution Publicitaire" land in one bar, then labelled from
  -- zoho_service_labels so the bar keeps Zoho's own spelling.
  per_acct AS (
    SELECT
      COALESCE(l.label, btrim(v))    AS label,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS amount
    FROM scoped s
    CROSS JOIN LATERAL unnest(s.service_interest) AS v
    LEFT JOIN zoho_service_labels l ON l.key = zoho_service_key(v)
    LEFT JOIN invoices i ON i.crm_account_id = s.zoho_account_id
    WHERE btrim(v) <> ''
    GROUP BY 1, 2
  )
  SELECT p.label, count(*), count(*) FILTER (WHERE p.amount <> 0),
         COALESCE(sum(p.amount), 0),
         ROUND(COALESCE(sum(p.amount), 0) / NULLIF(count(*), 0), 2),
         FALSE
  FROM per_acct p
  GROUP BY p.label
  ORDER BY 4 DESC, 2 DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_by_service(p_year integer, p_month integer, p_rep text, p_source text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_domaines text[], p_regions text[], p_ratings text[], p_invoiced boolean, p_amount_period text, p_amount_min numeric, p_amount_max numeric, p_search text, p_search_phone text) TO anon, authenticated, service_role, mcp_reader;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_by_domaine(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_regions text[], p_ratings text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_domaine(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[], p_invoiced boolean DEFAULT NULL::boolean, p_amount_period text DEFAULT NULL::text, p_amount_min numeric DEFAULT NULL::numeric, p_amount_max numeric DEFAULT NULL::numeric, p_search text DEFAULT NULL::text, p_search_phone text DEFAULT NULL::text)
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, p_service, NULL, p_region, p_exclude_ratings, p_reps,
      p_sources, NULL, NULL, p_regions, p_ratings,
      p_billed_services => p_services, p_invoiced => p_invoiced, p_amount_period => p_amount_period,
      p_amount_min => p_amount_min, p_amount_max => p_amount_max, p_search => p_search, p_search_phone => p_search_phone)
  ),
  per_acct AS (
    SELECT
      COALESCE(s.domaine_activite, 'Non renseigné') AS label,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS amount
    FROM scoped s
    LEFT JOIN invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY 1, 2
  )
  SELECT p.label, count(*), count(*) FILTER (WHERE p.amount <> 0),
         COALESCE(sum(p.amount), 0),
         ROUND(COALESCE(sum(p.amount), 0) / NULLIF(count(*), 0), 2),
         FALSE
  FROM per_acct p
  GROUP BY p.label
  ORDER BY 4 DESC, 2 DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_by_domaine(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_regions text[], p_ratings text[], p_invoiced boolean, p_amount_period text, p_amount_min numeric, p_amount_max numeric, p_search text, p_search_phone text) TO anon, authenticated, service_role, mcp_reader;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_monthly_summary(p_year integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_monthly_summary(p_year integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[], p_invoiced boolean DEFAULT NULL::boolean, p_amount_period text DEFAULT NULL::text, p_amount_min numeric DEFAULT NULL::numeric, p_amount_max numeric DEFAULT NULL::numeric, p_search text DEFAULT NULL::text, p_search_phone text DEFAULT NULL::text)
 RETURNS TABLE(month integer, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, NULL, p_rep, p_source, p_service, p_domaine, p_region, p_exclude_ratings, p_reps,
      p_sources, NULL, p_domaines, p_regions, p_ratings,
      p_billed_services => p_services, p_invoiced => p_invoiced, p_amount_period => p_amount_period,
      p_amount_min => p_amount_min, p_amount_max => p_amount_max, p_search => p_search, p_search_phone => p_search_phone)
  ),
  per_acct AS (
    SELECT
      EXTRACT(MONTH FROM s.created_date)::INT AS m,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS amount
    FROM scoped s
    LEFT JOIN invoices i ON i.crm_account_id = s.zoho_account_id
    GROUP BY 1, 2
  ),
  agg AS (
    SELECT p.m, count(*) AS nb, count(*) FILTER (WHERE p.amount <> 0) AS inv,
           COALESCE(sum(p.amount), 0) AS amt
    FROM per_acct p GROUP BY p.m
  )
  SELECT g.m,
         COALESCE(a.nb, 0), COALESCE(a.inv, 0), COALESCE(a.amt, 0),
         ROUND(COALESCE(a.amt, 0) / NULLIF(COALESCE(a.nb, 0), 0), 2)
  FROM generate_series(1, 12) AS g(m)
  LEFT JOIN agg a ON a.m = g.m
  ORDER BY g.m;
$function$;

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_monthly_summary(p_year integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[], p_invoiced boolean, p_amount_period text, p_amount_min numeric, p_amount_max numeric, p_search text, p_search_phone text) TO anon, authenticated, service_role, mcp_reader;

-- ─── 4. The filter options ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_zoho_account_filter_options(p_year integer DEFAULT NULL::integer, p_exclude_ratings text[] DEFAULT NULL::text[])
 RETURNS TABLE(years integer[], sources text[], services text[], service_variants jsonb, reps text[], domaines text[], regions text[], ratings text[])
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, NULL, NULL, NULL, NULL, NULL, NULL, p_exclude_ratings)
  ),
  -- Years come from the whole table, never from the scoped set: the year picker
  -- must still offer 2024 while 2026 is selected.
  yrs AS (
    SELECT array_agg(DISTINCT EXTRACT(YEAR FROM created_time AT TIME ZONE 'America/Toronto')::INT
                     ORDER BY EXTRACT(YEAR FROM created_time AT TIME ZONE 'America/Toronto')::INT DESC) AS v
    FROM zoho_accounts WHERE created_time IS NOT NULL
  ),
  src AS (
    SELECT array_agg(DISTINCT origine_du_client ORDER BY origine_du_client) AS v
    FROM scoped WHERE COALESCE(btrim(origine_du_client), '') NOT IN ('', '-None-')
  ),
  -- What the accounts in scope were billed, the only thing the Service filter
  -- reads. Invoice departments have one spelling, so there are no variants.
  svc AS (
    SELECT array_agg(DISTINCT i.department ORDER BY i.department) AS labels,
           '{}'::jsonb AS variants
    FROM scoped s
    JOIN public.invoices i ON i.crm_account_id = s.zoho_account_id
    WHERE NOT i.is_avoir AND i.department IS NOT NULL
  ),
  rp AS (
    SELECT array_agg(DISTINCT rep_name ORDER BY rep_name) AS v
    FROM scoped WHERE COALESCE(btrim(rep_name), '') <> ''
  ),
  dom AS (
    SELECT array_agg(DISTINCT domaine_activite ORDER BY domaine_activite) AS v
    FROM scoped WHERE COALESCE(btrim(domaine_activite), '') NOT IN ('', '-None-')
  ),
  reg AS (
    SELECT array_agg(DISTINCT region_administrative ORDER BY region_administrative) AS v
    FROM scoped WHERE COALESCE(btrim(region_administrative), '') NOT IN ('', '-None-')
  ),
  -- Ratings deliberately read the unscoped table: the rating filter has to offer
  -- "Compte interne : Ne pas reprendre" precisely so someone can switch it back
  -- on, and scoping would remove it from its own dropdown.
  rat AS (
    SELECT array_agg(DISTINCT rating ORDER BY rating) AS v
    FROM zoho_accounts WHERE COALESCE(btrim(rating), '') NOT IN ('', '-None-')
  )
  SELECT
    COALESCE((SELECT v FROM yrs), '{}'),
    COALESCE((SELECT v FROM src), '{}'),
    COALESCE((SELECT labels FROM svc), '{}'),
    COALESCE((SELECT variants FROM svc), '{}'::jsonb),
    COALESCE((SELECT v FROM rp),  '{}'),
    COALESCE((SELECT v FROM dom), '{}'),
    COALESCE((SELECT v FROM reg), '{}'),
    COALESCE((SELECT v FROM rat), '{}');
$function$;
