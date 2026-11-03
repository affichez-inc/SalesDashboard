-- Comptes: a service filter shows that service. Follows
-- 20261102120000_comptes_billed_service_and_detail_filters.sql.
--
-- REVENUE. Filtered on a service, every amount on both Comptes screens is what was
-- invoiced in that service, not the account's whole total: a client with 1 k$ in
-- NUMERIQUE and 9 k$ in PROMOTIONNEL reads 1 k$ when filtered on NUMERIQUE. The
-- count of "comptes facturés", the first-invoice delay and the Montant facturé
-- filter follow, since they read the same amounts.
--
-- A credit note counts against the department it carries. One with no department
-- (116 since 2025, -341 k$ on 2026-11-02) belongs to no service, so it reduces the
-- unfiltered total and no service's: the services can add up to more than the total.
--
-- PAR SERVICE. The breakdown reads invoice departments rather than the CRM field,
-- and takes p_services, unlike the other breakdowns and their own dimension, because
-- filtered on a service the page shows that service only.
--
-- zoho_accounts_enriched_for(p_departments) is the view's query with the invoices
-- narrowed to those departments, keeping only the accounts billed in one of them,
-- and the view is now that function with no list: one copy of the date arithmetic.
-- SECURITY INVOKER with no SET clause, so it inlines (CLAUDE.md, performance rule 1)
-- and RLS follows the caller.
--
-- Publicité is untouched: its calls leave p_billed_services NULL and its own RPCs
-- are not changed here.

-- ─── 1. The view, as a function of the departments ───────────────────────────
CREATE FUNCTION public.zoho_accounts_enriched_for(p_departments text[] DEFAULT NULL::text[])
 RETURNS TABLE(
   zoho_account_id text, account_name text, phone text, website text, description text,
   billing_street text, billing_city text, billing_state text, billing_code text, billing_country text,
   owner_name text, owner_email text, rep_name text, charge_de_projets text,
   created_time timestamp with time zone, created_date date, modified_time timestamp with time zone,
   last_activity_time timestamp with time zone, origine_du_client text, service_interest text[],
   domaine_activite text, region_administrative text, region_cible text[], type_marche text[],
   periode_publicitaire text[], nombre_employes text, budget_publicitaire_annuel numeric,
   potentiel_multi_annonceurs text, potentiel_services_ia boolean, revendeur boolean, rating text,
   tags text[], parent_account_id text, parent_account_name text, nombre_taches integer,
   derniere_tache_fermee date, ventes_totales numeric, ventes_2026 numeric, ventes_2025 numeric,
   zoho_crm_url text, invoice_count integer, credit_count integer, revenue_lifetime numeric,
   first_invoice_date date, last_invoice_date date, has_invoices boolean, is_bulk_import boolean,
   is_internal boolean, service_resolved text[], service_origin text, revenue_30d numeric,
   revenue_last_month numeric, revenue_12m numeric, revenue_ytd numeric, revenue_prev_year numeric,
   mail_street text, mail_city text, mail_state text, mail_code text, mail_country text,
   mail_source text, invoice_departments text[])
 LANGUAGE sql
 STABLE
AS $function$
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
    public.zoho_local_date(a.created_time) AS created_date,
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
    public.zoho_account_is_bulk_import(a.origine_du_client) AS is_bulk_import,
    COALESCE(a.rating = ANY (public.zoho_internal_ratings()), false) AS is_internal,
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
   FROM public.zoho_accounts a
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
           FROM public.invoices inv
             CROSS JOIN ( SELECT t.today,
                    t.today - 30 AS d30_after,
                    (t.today - '1 year'::interval)::date AS m12_after,
                    date_trunc('month'::text, t.today::timestamp with time zone)::date AS month_start,
                    (date_trunc('month'::text, t.today::timestamp with time zone) - '1 mon'::interval)::date AS last_month_start,
                    date_trunc('year'::text, t.today::timestamp with time zone)::date AS year_start,
                    (date_trunc('year'::text, t.today::timestamp with time zone) + '1 year'::interval)::date AS next_year_start,
                    (date_trunc('year'::text, t.today::timestamp with time zone) - '1 year'::interval)::date AS prev_year_start
                   FROM ( SELECT public.zoho_local_date(now()) AS today) t
                 OFFSET 0) d
          WHERE inv.crm_account_id IS NOT NULL
            AND (p_departments IS NULL OR inv.department = ANY (p_departments))
          GROUP BY inv.crm_account_id) i ON i.crm_account_id = a.zoho_account_id
  WHERE p_departments IS NULL OR i.departments IS NOT NULL;
$function$;

GRANT EXECUTE ON FUNCTION public.zoho_accounts_enriched_for(p_departments text[]) TO anon, authenticated, service_role, mcp_reader;

-- WITH (security_invoker) is not decoration: CREATE OR REPLACE VIEW replaces the
-- view options, and without it the view would read every table as its owner.
CREATE OR REPLACE VIEW public.zoho_accounts_enriched WITH (security_invoker = true) AS
  SELECT * FROM public.zoho_accounts_enriched_for(NULL::text[]);

-- ─── 2. The shared scope: the amount filter ──────────────────────────────────
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
    -- Comptes · Détail keeps, and with a service selected they are that service's.
    -- An uncorrelated subquery, built once and only when the period is set: the
    -- function aggregates every invoice.
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
            FROM public.zoho_accounts_enriched_for(p_billed_services) v
          ) e
          WHERE (p_amount_min IS NULL OR e.amount >= p_amount_min)
            AND (p_amount_max IS NULL OR e.amount <= p_amount_max)
        ));
$function$;

-- ─── 3. Revenue: the selected services' invoices ─────────────────────────────
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
      AND (p_services IS NULL OR i.department = ANY(p_services))
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
      AND (p_services IS NULL OR i.department = ANY(p_services))
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
      AND (p_services IS NULL OR i.department = ANY(p_services))
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
      AND (p_services IS NULL OR i.department = ANY(p_services))
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
      AND (p_services IS NULL OR i.department = ANY(p_services))
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

-- ─── 4. Par service: invoice departments ─────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_zoho_accounts_by_service(p_year integer, p_month integer, p_rep text, p_source text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_domaines text[], p_regions text[], p_ratings text[], p_invoiced boolean, p_amount_period text, p_amount_min numeric, p_amount_max numeric, p_search text, p_search_phone text);

CREATE FUNCTION public.get_zoho_accounts_by_service(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[], p_invoiced boolean DEFAULT NULL::boolean, p_amount_period text DEFAULT NULL::text, p_amount_min numeric DEFAULT NULL::numeric, p_amount_max numeric DEFAULT NULL::numeric, p_search text DEFAULT NULL::text, p_search_phone text DEFAULT NULL::text, p_services text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, NULL, p_domaine, p_region, p_exclude_ratings, p_reps,
      p_sources, NULL, p_domaines, p_regions, p_ratings,
      p_billed_services => p_services, p_invoiced => p_invoiced, p_amount_period => p_amount_period,
      p_amount_min => p_amount_min, p_amount_max => p_amount_max, p_search => p_search, p_search_phone => p_search_phone)
  ),
  -- One row per account and department it holds a real invoice in, the rule the
  -- Service filter applies: credit notes count in the amount, not in the match.
  per_acct AS (
    SELECT
      i.department AS label,
      s.zoho_account_id,
      COALESCE(sum(i.amount) FILTER (
        WHERE i.invoice_date >= s.created_date
          AND i.invoice_date <  zoho_account_window_end(s.created_time, p_window_months)
      ), 0) AS amount
    FROM scoped s
    JOIN invoices i ON i.crm_account_id = s.zoho_account_id
    WHERE i.department IS NOT NULL
      AND (p_services IS NULL OR i.department = ANY(p_services))
    GROUP BY 1, 2
    HAVING bool_or(NOT i.is_avoir)
  )
  SELECT p.label, count(*), count(*) FILTER (WHERE p.amount <> 0),
         COALESCE(sum(p.amount), 0),
         ROUND(COALESCE(sum(p.amount), 0) / NULLIF(count(*), 0), 2),
         FALSE
  FROM per_acct p
  GROUP BY p.label
  ORDER BY 4 DESC, 2 DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_by_service(p_year integer, p_month integer, p_rep text, p_source text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_domaines text[], p_regions text[], p_ratings text[], p_invoiced boolean, p_amount_period text, p_amount_min numeric, p_amount_max numeric, p_search text, p_search_phone text, p_services text[]) TO anon, authenticated, service_role, mcp_reader;
