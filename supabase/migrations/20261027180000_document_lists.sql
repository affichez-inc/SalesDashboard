-- Toutes les factures / Tous les devis: every stored document, searched,
-- filtered, sorted and paged in Postgres.
--
-- Each list call answers one page as a single JSON value: the page's rows, the
-- size of the whole filtered set and its total amount. The set's figures cannot
-- be summed from a page, a second count call would double the round trips, and
-- a set-returning function says nothing at all about a page past the end.
--
-- SECURITY INVOKER, so each table's read policy decides who sees what: the
-- invoice list follows Factures and Comptes, the quote list follows Devis, the
-- same as every other screen on those tables.
--
-- These are directories, not statistics. Nothing is excluded: excluded_clients
-- is not applied, a quote of any status is listed, and a quote whose Zoho status
-- has no mapping (sales.status NULL) appears under its raw zoho_status whenever
-- no status filter is set.
--
-- A quote is dated by issue (quote_date). sale_date is the acceptance date for a
-- won quote and only a fallback to the issue date otherwise, so it cannot order
-- a list holding both. Two old rows have no quote_date; they fall back to
-- sale_date rather than drop out.

-- ─── Invoices and credit notes ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_invoice_list(
  p_search   text    DEFAULT NULL,
  p_statuses text[]  DEFAULT NULL,
  p_reps     text[]  DEFAULT NULL,
  p_year     integer DEFAULT NULL,
  p_sort     text    DEFAULT 'date',
  p_desc     boolean DEFAULT true,
  p_limit    integer DEFAULT 100,
  p_offset   integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH params AS (
    SELECT
      -- ILIKE wildcards in the term match literally.
      CASE WHEN btrim(coalesce(p_search, '')) = '' THEN NULL
           ELSE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      END                                    AS pat,
      coalesce(p_sort, 'date') = 'amount'    AS by_amount,
      coalesce(p_desc, true)                 AS descending,
      LEAST(GREATEST(coalesce(p_limit, 100), 1), 1000) AS lim,
      GREATEST(coalesce(p_offset, 0), 0)     AS off
  ),
  hits AS (
    SELECT i.zoho_id, i.invoice_number, i.invoice_date, i.client_name, i.amount,
           i.shipping_charge, i.rep_name, i.department, i.zoho_department_label,
           i.office, i.status::text AS status, i.is_avoir
      FROM public.invoices i, params p
     WHERE (p_statuses IS NULL OR i.status::text = ANY (p_statuses))
       AND (p_reps IS NULL OR i.rep_name = ANY (p_reps))
       AND (p_year IS NULL OR (i.invoice_date >= make_date(p_year, 1, 1)
                               AND i.invoice_date <  make_date(p_year + 1, 1, 1)))
       AND (p.pat IS NULL OR i.client_name    ILIKE p.pat
                          OR i.invoice_number ILIKE p.pat
                          OR i.rep_name       ILIKE p.pat)
  ),
  page AS (
    SELECT h.*,
           -- One ascending key per sort: negated for a descending one, so the
           -- page is an ORDER BY ... LIMIT (a top-N sort, not a sort of the set)
           -- and the JSON can be ordered the same way. NULL dates sort last.
           CASE WHEN p.by_amount THEN h.amount
                ELSE (h.invoice_date - DATE '2000-01-01')::numeric
           END * CASE WHEN p.descending THEN -1 ELSE 1 END AS k
      FROM hits h, params p
     ORDER BY k NULLS LAST, h.invoice_number DESC NULLS LAST, h.zoho_id
     LIMIT (SELECT lim FROM params) OFFSET (SELECT off FROM params)
  )
  SELECT jsonb_build_object(
    'total_count',  (SELECT count(*) FROM hits),
    'total_amount', (SELECT coalesce(sum(h.amount), 0) FROM hits h),
    'rows', coalesce((
      SELECT jsonb_agg(to_jsonb(pg) - 'k'
                       ORDER BY pg.k NULLS LAST, pg.invoice_number DESC NULLS LAST, pg.zoho_id)
        FROM page pg
    ), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION public.get_invoice_list(text, text[], text[], integer, text, boolean, integer, integer) IS
  'One page of every stored invoice and credit note, searched on client, number '
  'and rep. Returns {total_count, total_amount, rows}. p_sort: date | amount.';

-- ─── Quotes, every status ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_quote_list(
  p_search   text    DEFAULT NULL,
  p_statuses text[]  DEFAULT NULL,
  p_reps     text[]  DEFAULT NULL,
  p_year     integer DEFAULT NULL,
  p_sort     text    DEFAULT 'date',
  p_desc     boolean DEFAULT true,
  p_limit    integer DEFAULT 100,
  p_offset   integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH params AS (
    SELECT
      CASE WHEN btrim(coalesce(p_search, '')) = '' THEN NULL
           ELSE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      END                                    AS pat,
      coalesce(p_sort, 'date') = 'amount'    AS by_amount,
      coalesce(p_desc, true)                 AS descending,
      LEAST(GREATEST(coalesce(p_limit, 100), 1), 1000) AS lim,
      GREATEST(coalesce(p_offset, 0), 0)     AS off
  ),
  hits AS (
    SELECT s.zoho_id, s.quote_number, coalesce(s.quote_date, s.sale_date) AS quote_date,
           s.accepted_date, s.client_name, s.amount, s.rep_name,
           s.department::text AS department, s.zoho_department_label,
           s.office::text AS office, s.status::text AS status, s.zoho_status
      FROM public.sales s, params p
     WHERE (p_statuses IS NULL OR s.status::text = ANY (p_statuses))
       AND (p_reps IS NULL OR s.rep_name = ANY (p_reps))
       AND (p_year IS NULL OR (coalesce(s.quote_date, s.sale_date) >= make_date(p_year, 1, 1)
                               AND coalesce(s.quote_date, s.sale_date) <  make_date(p_year + 1, 1, 1)))
       AND (p.pat IS NULL OR s.client_name  ILIKE p.pat
                          OR s.quote_number ILIKE p.pat
                          OR s.rep_name     ILIKE p.pat)
  ),
  page AS (
    SELECT h.*,
           -- One ascending key per sort: negated for a descending one, so the
           -- page is an ORDER BY ... LIMIT (a top-N sort, not a sort of the set)
           -- and the JSON can be ordered the same way. NULL dates sort last.
           CASE WHEN p.by_amount THEN h.amount
                ELSE (h.quote_date - DATE '2000-01-01')::numeric
           END * CASE WHEN p.descending THEN -1 ELSE 1 END AS k
      FROM hits h, params p
     ORDER BY k NULLS LAST, h.quote_number DESC NULLS LAST, h.zoho_id
     LIMIT (SELECT lim FROM params) OFFSET (SELECT off FROM params)
  )
  SELECT jsonb_build_object(
    'total_count',  (SELECT count(*) FROM hits),
    'total_amount', (SELECT coalesce(sum(h.amount), 0) FROM hits h),
    'rows', coalesce((
      SELECT jsonb_agg(to_jsonb(pg) - 'k'
                       ORDER BY pg.k NULLS LAST, pg.quote_number DESC NULLS LAST, pg.zoho_id)
        FROM page pg
    ), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION public.get_quote_list(text, text[], text[], integer, text, boolean, integer, integer) IS
  'One page of every stored quote, any status, dated by issue. Searched on client, '
  'number and rep. Returns {total_count, total_amount, rows}. p_sort: date | amount.';

-- ─── Filter options ───────────────────────────────────────────────────────────
-- The years and rep names present in one table. The rep names are what lets the
-- page expand "Interne" into everyone off the sales team.

CREATE OR REPLACE FUNCTION public.get_document_list_options(p_kind text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT CASE p_kind
    WHEN 'invoices' THEN jsonb_build_object(
      'years', coalesce((
        SELECT jsonb_agg(y ORDER BY y DESC)
          FROM (SELECT DISTINCT extract(year FROM i.invoice_date)::int AS y
                  FROM public.invoices i WHERE i.invoice_date IS NOT NULL) t), '[]'::jsonb),
      'reps', coalesce((
        SELECT jsonb_agg(r ORDER BY r)
          FROM (SELECT DISTINCT i.rep_name AS r
                  FROM public.invoices i WHERE i.rep_name IS NOT NULL) t), '[]'::jsonb))
    WHEN 'quotes' THEN jsonb_build_object(
      'years', coalesce((
        SELECT jsonb_agg(y ORDER BY y DESC)
          FROM (SELECT DISTINCT extract(year FROM coalesce(s.quote_date, s.sale_date))::int AS y
                  FROM public.sales s) t), '[]'::jsonb),
      'reps', coalesce((
        SELECT jsonb_agg(r ORDER BY r)
          FROM (SELECT DISTINCT s.rep_name AS r
                  FROM public.sales s WHERE s.rep_name IS NOT NULL) t), '[]'::jsonb))
  END;
$$;

COMMENT ON FUNCTION public.get_document_list_options(text) IS
  'Years and rep names for the document lists. p_kind: invoices | quotes.';

REVOKE ALL ON FUNCTION public.get_invoice_list(text, text[], text[], integer, text, boolean, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_quote_list(text, text[], text[], integer, text, boolean, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_document_list_options(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoice_list(text, text[], text[], integer, text, boolean, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_quote_list(text, text[], text[], integer, text, boolean, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_document_list_options(text) TO authenticated, service_role;
