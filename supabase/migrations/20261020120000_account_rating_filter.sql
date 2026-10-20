-- Comptes: filter on the account's Rating ("Évaluation" in Zoho's French UI).
--
-- zoho_accounts.rating is already mirrored on every account (zoho-account-sync
-- reads Rating; counts per value match a COQL GROUP BY on Zoho). Nothing to
-- back-fill. What it stores is the label an English session reads, which for
-- five options differs from what a French user sees; the French wording is a
-- display concern and lives in the frontend (src/lib/accountRating.ts). The
-- filter is always on the stored value.
--
-- zoho_accounts_scoped and the six Comptes RPCs built on it gain p_ratings, a
-- list of stored values; NULL is no filter. It ANDs with p_exclude_ratings, so
-- the Statut switch keeps working as before. No breakdown is by rating, so all
-- six pass it through.
--
-- Appended, never reordered: get_ad_filter_options, get_ad_monthly,
-- get_ad_performance and get_zoho_account_filter_options call
-- zoho_accounts_scoped positionally with 8 or 13 arguments and keep resolving to
-- the same rows. DROP + CREATE rather than an overload: two signatures for one
-- name make PostgREST refuse the call (PGRST203).
--
-- Bodies are pg_get_functiondef output from the live database; the parameter,
-- the argument passed to zoho_accounts_scoped and its one predicate are the
-- only changes. zoho_accounts_scoped stays SECURITY INVOKER with no SET clause,
-- so the planner still inlines it (CLAUDE.md, performance rule 1).

DROP FUNCTION IF EXISTS public.zoho_accounts_scoped(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]);

CREATE OR REPLACE FUNCTION public.zoho_accounts_scoped(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[])
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
    AND (p_ratings IS NULL OR a.rating = ANY(p_ratings));
$function$
;

GRANT EXECUTE ON FUNCTION public.zoho_accounts_scoped(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_account_kpis(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_account_kpis(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[])
 RETURNS TABLE(accounts_created bigint, accounts_invoiced bigint, invoiced_rate numeric, revenue_attributed numeric, revenue_lifetime numeric, revenue_per_account numeric, avg_days_to_first_invoice numeric, ventes_royer numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, p_service, p_domaine, p_region, p_exclude_ratings, p_reps,
      p_sources, p_services, p_domaines, p_regions, p_ratings)
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
$function$
;

GRANT EXECUTE ON FUNCTION public.get_zoho_account_kpis(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_by_rep(p_year integer, p_month integer, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_rep(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, NULL, p_source, p_service, p_domaine, p_region, p_exclude_ratings, p_reps,
      p_sources, p_services, p_domaines, p_regions, p_ratings)
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
$function$
;

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_by_rep(p_year integer, p_month integer, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_by_source(p_year integer, p_month integer, p_rep text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_services text[], p_domaines text[], p_regions text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_source(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, NULL, p_service, p_domaine, p_region, p_exclude_ratings, p_reps,
      NULL, p_services, p_domaines, p_regions, p_ratings)
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
$function$
;

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_by_source(p_year integer, p_month integer, p_rep text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_by_service(p_year integer, p_month integer, p_rep text, p_source text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_domaines text[], p_regions text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_service(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, NULL, p_domaine, p_region, p_exclude_ratings, p_reps,
      p_sources, NULL, p_domaines, p_regions, p_ratings)
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
$function$
;

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_by_service(p_year integer, p_month integer, p_rep text, p_source text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_domaines text[], p_regions text[], p_ratings text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_by_domaine(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_regions text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_by_domaine(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[])
 RETURNS TABLE(label text, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric, is_bulk_import boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, p_month, p_rep, p_source, p_service, NULL, p_region, p_exclude_ratings, p_reps,
      p_sources, p_services, NULL, p_regions, p_ratings)
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
$function$
;

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_by_domaine(p_year integer, p_month integer, p_rep text, p_source text, p_service text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_regions text[], p_ratings text[]) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_zoho_accounts_monthly_summary(p_year integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[]);

CREATE OR REPLACE FUNCTION public.get_zoho_accounts_monthly_summary(p_year integer DEFAULT NULL::integer, p_rep text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_domaine text DEFAULT NULL::text, p_region text DEFAULT NULL::text, p_window_months integer DEFAULT 12, p_exclude_ratings text[] DEFAULT ARRAY['Compte interne : Ne pas reprendre'::text, 'Fournisseur'::text], p_reps text[] DEFAULT NULL::text[], p_sources text[] DEFAULT NULL::text[], p_services text[] DEFAULT NULL::text[], p_domaines text[] DEFAULT NULL::text[], p_regions text[] DEFAULT NULL::text[], p_ratings text[] DEFAULT NULL::text[])
 RETURNS TABLE(month integer, nb_accounts bigint, nb_invoiced bigint, total_amount numeric, revenue_per_account numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT * FROM zoho_accounts_scoped(
      p_year, NULL, p_rep, p_source, p_service, p_domaine, p_region, p_exclude_ratings, p_reps,
      p_sources, p_services, p_domaines, p_regions, p_ratings)
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
$function$
;

GRANT EXECUTE ON FUNCTION public.get_zoho_accounts_monthly_summary(p_year integer, p_rep text, p_source text, p_service text, p_domaine text, p_region text, p_window_months integer, p_exclude_ratings text[], p_reps text[], p_sources text[], p_services text[], p_domaines text[], p_regions text[], p_ratings text[]) TO authenticated, service_role;
