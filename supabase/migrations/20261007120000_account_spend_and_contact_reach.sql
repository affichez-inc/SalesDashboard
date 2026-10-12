-- Comptes · Détail: filter accounts by the amount they were billed, export them
-- with their contacts, and push those contacts to a Meta custom audience.
--
-- 1. zoho_leads gains the reach fields the syncs did not ask Zoho for: mobile,
--    second email, job title, language and the two marketing refusals. Email
--    and phone were already there.
-- 2. zoho_accounts gains the shipping address. Contacts carry no address of
--    their own in this org (the Mailing_* fields are not in use), so the
--    account's address is the only postal address a contact has.
-- 3. zoho_accounts_enriched gains the amount billed over five rolling or
--    calendar periods, and one postal address per account (`mail_*`).
-- 4. get_accounts_contacts: the contacts of a list of accounts, for the export
--    and for the audience upload.
-- 5. get_account_spend_max: the largest amount per period, which sets the top of
--    the range slider.
-- 6. app_can_push_meta_audience and meta_audience_log: who may create an
--    audience, and a record of every one created.
--
-- The new columns are NULL until the next full CRM walk
-- (scripts/zoho-crm-full-sync.sh) has read every record once. The syncs must be
-- deployed after this migration: their payloads name the new columns, and
-- PostgREST rejects an upsert naming a column that does not exist.

-- ─── 1. Contact reach ─────────────────────────────────────────────────────────
-- NULL means "not read from Zoho yet", which is not the same as "no". The two
-- refusals in particular stay NULL until the walk, so an audience built before
-- it can tell an unknown status from a consent.

ALTER TABLE public.zoho_leads
  ADD COLUMN IF NOT EXISTS mobile          TEXT,
  ADD COLUMN IF NOT EXISTS secondary_email TEXT,
  ADD COLUMN IF NOT EXISTS title           TEXT,
  ADD COLUMN IF NOT EXISTS language        TEXT,
  -- Unsubscribed from our emails (unsubscribe link or Zoho Campaigns): Zoho's
  -- Email_Opt_Out, or Unsubscribed_Mode set. The sync reads both because the
  -- checkbox never reaches it on Contacts; see emailOptOut() in zoho-lead-sync.
  ADD COLUMN IF NOT EXISTS email_opt_out   BOOLEAN,
  -- The org's own "Ne veut pas recevoir nos courriels marketing" checkbox, ticked
  -- by hand. Contacts only; NULL on leads.
  ADD COLUMN IF NOT EXISTS no_marketing    BOOLEAN,
  -- "Email de masse non remis": a mass email to this address bounced. Contacts only.
  ADD COLUMN IF NOT EXISTS email_bounced   BOOLEAN;

COMMENT ON COLUMN public.zoho_leads.email_opt_out IS
  'Unsubscribed from emails: Zoho Email_Opt_Out or Unsubscribed_Mode set. NULL until the record has been synced since 2026-10-07.';
COMMENT ON COLUMN public.zoho_leads.no_marketing IS
  'Zoho "Ne veut pas recevoir nos courriels marketing" (Contacts). NULL on leads and before the first sync.';

-- ─── 2. Shipping address ──────────────────────────────────────────────────────

ALTER TABLE public.zoho_accounts
  ADD COLUMN IF NOT EXISTS shipping_street  TEXT,
  ADD COLUMN IF NOT EXISTS shipping_city    TEXT,
  ADD COLUMN IF NOT EXISTS shipping_state   TEXT,
  ADD COLUMN IF NOT EXISTS shipping_code    TEXT,
  ADD COLUMN IF NOT EXISTS shipping_country TEXT;

-- ─── 3. The view ──────────────────────────────────────────────────────────────
-- Same columns, same order, as 20260908150000; the new ones are appended, which
-- is the only change CREATE OR REPLACE VIEW accepts.
--
-- Amounts by period are net, like revenue_lifetime: credit notes are subtracted
-- in the period they are dated. "Today" is Montreal's date, so a period turns at
-- midnight in Quebec and not at 20:00 when UTC does.
--
--   revenue_30d         invoice_date in (today - 30, today]
--   revenue_last_month  the previous calendar month
--   revenue_12m         invoice_date in (today - 12 months, today]
--   revenue_ytd         the current calendar year
--   revenue_prev_year   the previous calendar year
--
-- mail_* is one postal address per account, taken whole from one block: the
-- shipping address when it has a street, a city or a postal code, the billing
-- address otherwise. Mixing fields from the two would produce an address that
-- exists nowhere. mail_source says which block it came from.

CREATE OR REPLACE VIEW public.zoho_accounts_enriched
WITH (security_invoker = true) AS
SELECT
  a.zoho_account_id,
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

  COALESCE(i.invoice_count, 0)    AS invoice_count,
  COALESCE(i.credit_count, 0)     AS credit_count,
  COALESCE(i.revenue_lifetime, 0) AS revenue_lifetime,
  i.first_invoice_date,
  i.last_invoice_date,
  (i.invoice_count IS NOT NULL)   AS has_invoices,

  public.zoho_account_is_bulk_import(a.origine_du_client) AS is_bulk_import,

  COALESCE(a.rating = ANY(public.zoho_internal_ratings()), FALSE) AS is_internal,

  CASE
    WHEN cardinality(a.service_interest) > 0 THEN a.service_interest
    ELSE COALESCE(i.departments, '{}')
  END AS service_resolved,

  CASE
    WHEN cardinality(a.service_interest) > 0 THEN 'crm'
    WHEN COALESCE(cardinality(i.departments), 0) > 0 THEN 'invoice'
    ELSE 'none'
  END AS service_origin,

  -- Appended 2026-10-07.
  COALESCE(i.revenue_30d, 0)        AS revenue_30d,
  COALESCE(i.revenue_last_month, 0) AS revenue_last_month,
  COALESCE(i.revenue_12m, 0)        AS revenue_12m,
  COALESCE(i.revenue_ytd, 0)        AS revenue_ytd,
  COALESCE(i.revenue_prev_year, 0)  AS revenue_prev_year,

  -- The sync stores a blank field as NULL (pickOrNull trims), so IS NOT NULL is
  -- the whole test; a btrim per field per row cost the page 10 ms.
  CASE WHEN COALESCE(a.shipping_street, a.shipping_city, a.shipping_code) IS NOT NULL
       THEN a.shipping_street  ELSE a.billing_street  END AS mail_street,
  CASE WHEN COALESCE(a.shipping_street, a.shipping_city, a.shipping_code) IS NOT NULL
       THEN a.shipping_city    ELSE a.billing_city    END AS mail_city,
  CASE WHEN COALESCE(a.shipping_street, a.shipping_city, a.shipping_code) IS NOT NULL
       THEN a.shipping_state   ELSE a.billing_state   END AS mail_state,
  CASE WHEN COALESCE(a.shipping_street, a.shipping_city, a.shipping_code) IS NOT NULL
       THEN a.shipping_code    ELSE a.billing_code    END AS mail_code,
  CASE WHEN COALESCE(a.shipping_street, a.shipping_city, a.shipping_code) IS NOT NULL
       THEN a.shipping_country ELSE a.billing_country END AS mail_country,
  CASE
    WHEN COALESCE(a.shipping_street, a.shipping_city, a.shipping_code) IS NOT NULL THEN 'shipping'
    -- Any billing field, province and country included: whatever mail_* holds
    -- when the shipping block is not used comes from the billing block.
    WHEN COALESCE(a.billing_street, a.billing_city, a.billing_code,
                  a.billing_state, a.billing_country) IS NOT NULL THEN 'billing'
  END AS mail_source

FROM public.zoho_accounts a
LEFT JOIN (
  SELECT
    inv.crm_account_id,
    count(*) FILTER (WHERE NOT inv.is_avoir)::INT AS invoice_count,
    count(*) FILTER (WHERE inv.is_avoir)::INT     AS credit_count,
    COALESCE(sum(inv.amount), 0)                  AS revenue_lifetime,
    min(inv.invoice_date)                         AS first_invoice_date,
    max(inv.invoice_date)                         AS last_invoice_date,
    array_agg(DISTINCT inv.department ORDER BY inv.department)
      FILTER (WHERE inv.department IS NOT NULL AND NOT inv.is_avoir) AS departments,

    sum(inv.amount) FILTER (WHERE inv.invoice_date >  d.d30_after
                              AND inv.invoice_date <= d.today)           AS revenue_30d,
    sum(inv.amount) FILTER (WHERE inv.invoice_date >= d.last_month_start
                              AND inv.invoice_date <  d.month_start)     AS revenue_last_month,
    sum(inv.amount) FILTER (WHERE inv.invoice_date >  d.m12_after
                              AND inv.invoice_date <= d.today)           AS revenue_12m,
    sum(inv.amount) FILTER (WHERE inv.invoice_date >= d.year_start
                              AND inv.invoice_date <  d.next_year_start) AS revenue_ytd,
    sum(inv.amount) FILTER (WHERE inv.invoice_date >= d.prev_year_start
                              AND inv.invoice_date <  d.year_start)      AS revenue_prev_year
  FROM public.invoices inv
  -- Every bound computed once, as a DATE. The OFFSET 0 is what makes it once:
  -- without it the planner flattens this one-row subquery into the aggregate
  -- and re-evaluates now() AT TIME ZONE 'America/Toronto' for every bound on
  -- every invoice row, which nearly doubled the cost of the whole view
  -- (Comptes · Détail went from 47 to 88 ms with no filter set).
  CROSS JOIN (
    SELECT t.today,
           t.today - 30                                                   AS d30_after,
           (t.today - INTERVAL '12 months')::date                         AS m12_after,
           date_trunc('month', t.today)::date                             AS month_start,
           (date_trunc('month', t.today) - INTERVAL '1 month')::date      AS last_month_start,
           date_trunc('year', t.today)::date                              AS year_start,
           (date_trunc('year', t.today) + INTERVAL '1 year')::date        AS next_year_start,
           (date_trunc('year', t.today) - INTERVAL '1 year')::date        AS prev_year_start
      FROM (SELECT public.zoho_local_date(now()) AS today) t
    OFFSET 0
  ) d
  WHERE inv.crm_account_id IS NOT NULL
  GROUP BY inv.crm_account_id
) i ON i.crm_account_id = a.zoho_account_id;

GRANT SELECT ON public.zoho_accounts_enriched TO authenticated;

-- The comment survives CREATE OR REPLACE and said "revenue is lifetime".
COMMENT ON VIEW public.zoho_accounts_enriched IS
  'One row per Zoho CRM account with its invoice rollup: lifetime and by period '
  '(revenue_30d, revenue_last_month, revenue_12m, revenue_ytd, revenue_prev_year, '
  'net, Montreal calendar), plus one postal address (mail_*). Backs Comptes · Détail, '
  'which filters and paginates server-side. The 12-month attribution window of the '
  'cohort dashboard lives in get_zoho_account_kpis and the breakdown RPCs, not here.';

-- ─── 4. Contacts of a list of accounts ────────────────────────────────────────
-- Contacts only. A lead carries an account_id only once it has been converted,
-- and then the contact it became is already in the list: including leads would
-- list the same person twice.
--
-- The postal address is the account's (mail_*), joined from the view. Only
-- columns of zoho_accounts are read from it, and its invoice aggregate is unique
-- on the join key, so the planner drops that join and does not aggregate the
-- invoices table here.
--
-- SECURITY INVOKER: the caller reads what zoho_leads and zoho_accounts let them
-- read. An array of account ids goes in a POST body, so 20,000 of them is a
-- request, not a URL.

CREATE OR REPLACE FUNCTION public.get_accounts_contacts(p_account_ids TEXT[])
RETURNS TABLE (
  account_id      TEXT,
  zoho_record_id  TEXT,
  full_name       TEXT,
  first_name      TEXT,
  last_name       TEXT,
  title           TEXT,
  email           TEXT,
  secondary_email TEXT,
  phone           TEXT,
  mobile          TEXT,
  language        TEXT,
  email_opt_out   BOOLEAN,
  no_marketing    BOOLEAN,
  email_bounced   BOOLEAN,
  rep_name        TEXT,
  created_time    TIMESTAMPTZ,
  zoho_crm_url    TEXT,
  mail_street     TEXT,
  mail_city       TEXT,
  mail_state      TEXT,
  mail_code       TEXT,
  mail_country    TEXT,
  mail_source     TEXT,
  -- The account came from an acquired client list (Royer & Fils, PLOGG/BUCCO):
  -- the Meta upload declares such data as partner-provided.
  is_bulk_import  BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT z.account_id, z.zoho_record_id, z.full_name, z.first_name, z.last_name,
         z.title, z.email, z.secondary_email, z.phone, z.mobile, z.language,
         z.email_opt_out, z.no_marketing, z.email_bounced,
         z.rep_name, z.created_time, z.zoho_crm_url,
         e.mail_street, e.mail_city, e.mail_state, e.mail_code, e.mail_country, e.mail_source,
         e.is_bulk_import
    FROM public.zoho_leads z
    JOIN public.zoho_accounts_enriched e ON e.zoho_account_id = z.account_id
   WHERE z.stage = 'contact'
     AND z.account_id = ANY(p_account_ids)
   ORDER BY z.account_id, z.created_time ASC NULLS LAST, z.zoho_record_id;
$$;

REVOKE ALL ON FUNCTION public.get_accounts_contacts(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_accounts_contacts(TEXT[]) TO authenticated;

-- ─── 5. Top of the range slider ───────────────────────────────────────────────
-- The largest amount any client account was billed in each period, and the date
-- the periods were computed from, so the page labels "le mois dernier" with the
-- month the database means. Internal accounts are left out: one of Affichez's
-- own entities must not stretch the scale the clients are read on. The end of
-- the track means "no maximum", so they stay reachable when included.

CREATE OR REPLACE FUNCTION public.get_account_spend_max()
RETURNS TABLE (
  today       DATE,
  lifetime    NUMERIC,
  last_30d    NUMERIC,
  last_month  NUMERIC,
  last_12m    NUMERIC,
  ytd         NUMERIC,
  prev_year   NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT public.zoho_local_date(now()),
         max(e.revenue_lifetime), max(e.revenue_30d), max(e.revenue_last_month),
         max(e.revenue_12m), max(e.revenue_ytd), max(e.revenue_prev_year)
    FROM public.zoho_accounts_enriched e
   WHERE NOT e.is_internal;
$$;

REVOKE ALL ON FUNCTION public.get_account_spend_max() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_spend_max() TO authenticated;

-- ─── 6. Meta custom audiences ─────────────────────────────────────────────────
-- Creating an audience sends client contact data to Meta, from the ad account.
-- It needs both sides: the client list (Comptes) and the ad accounts
-- (Publicité). An admin has both. The edge function asks this with the caller's
-- own token.

CREATE OR REPLACE FUNCTION public.app_can_push_meta_audience()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT public.app_can_access('comptes') AND public.app_can_access('publicite');
$$;

REVOKE ALL ON FUNCTION public.app_can_push_meta_audience() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.app_can_push_meta_audience() TO authenticated;

-- One row per audience created (or attempted) from the app: who, when, on which
-- ad account, with which filters, how many people and which ones. Written by
-- the meta-custom-audience function with the service role; read by admins.
--
-- Two columns exist for what can only be captured at creation time:
--
--   filters      the Comptes · Détail filters that produced the list, as the
--                page's URL parameters ({"montant_min": ["10000"], "source":
--                ["Meta Ads", "Google Ads"]}), plus "recherche" for the search
--                box, which is not in the URL. A parameter that is absent was at
--                its default. Enough to show what the audience was and to rebuild
--                the same list later.
--   contact_ids  the Zoho record ids of the contacts actually sent. Ids only:
--                emails, phones and names stay in zoho_leads. It is what makes it
--                possible to say who is in an audience, and to find the audiences
--                someone is in when they later ask to be removed, which Meta's
--                terms require.
--
-- Both are NULL on a row with nothing sent, and filters is NULL when the call
-- came from a page that did not send them. A row still 'pending' long after its
-- created_at belongs to a function that was stopped mid-way: its audience_id,
-- when set, may hold part of the list.

CREATE TABLE IF NOT EXISTS public.meta_audience_log (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        TEXT        NOT NULL,
  ad_account_id     TEXT        NOT NULL,
  audience_id       TEXT,
  audience_name     TEXT        NOT NULL,
  description       TEXT,
  filters           JSONB,
  account_count     INT         NOT NULL,
  contact_count     INT         NOT NULL,
  contact_ids       TEXT[],
  rows_sent         INT         NOT NULL DEFAULT 0,
  num_received      INT,
  num_invalid       INT,
  excluded_opt_out  BOOLEAN     NOT NULL,
  -- pending: written before anything is sent to Meta, so a function stopped
  -- halfway still leaves a record of who may be in the audience.
  status            TEXT        NOT NULL CHECK (status IN ('pending', 'created', 'failed')),
  error_message     TEXT
);

CREATE INDEX IF NOT EXISTS meta_audience_log_created_idx
  ON public.meta_audience_log (created_at DESC);

-- "Which audiences is this contact in?": contact_ids @> ARRAY['<id>'].
CREATE INDEX IF NOT EXISTS meta_audience_log_contacts_idx
  ON public.meta_audience_log USING gin (contact_ids);

COMMENT ON TABLE public.meta_audience_log IS
  'Meta custom audiences created from Comptes · Détail: who, when, the filters used and the Zoho ids of the contacts sent. No emails, phones or names.';
COMMENT ON COLUMN public.meta_audience_log.filters IS
  'Comptes · Détail URL parameters at creation, each a list of values, plus "recherche" for the search box. Absent = default.';
COMMENT ON COLUMN public.meta_audience_log.contact_ids IS
  'zoho_leads.zoho_record_id of every contact sent to Meta. Ids only.';

ALTER TABLE public.meta_audience_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listed_users_only ON public.meta_audience_log;
CREATE POLICY listed_users_only ON public.meta_audience_log
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.app_is_listed()));

DROP POLICY IF EXISTS meta_audience_log_select_admin ON public.meta_audience_log;
CREATE POLICY meta_audience_log_select_admin ON public.meta_audience_log
  FOR SELECT TO authenticated
  USING ((SELECT public.app_is_admin()));

REVOKE ALL ON public.meta_audience_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.meta_audience_log TO authenticated;
GRANT ALL ON public.meta_audience_log TO service_role;
