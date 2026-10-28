-- Toutes les factures / Tous les devis: month, department, office and shipping
-- filters, and a sort on every column the lists show.
--
-- New parameters are appended, so each list function is dropped and created
-- again rather than overloaded: two signatures for one name make PostgREST
-- refuse the call (PGRST203). Nothing calls the old signatures yet.
--
--   p_month          1-12, applied only with p_year (a month of no year is no
--                    period at all)
--   p_depts          department, the mapped value; a document whose Zoho label
--                    has no mapping (department NULL) matches no selection
--   p_office         QC | MTL
--   p_with_shipping  invoices only: documents carrying a shipping charge
--   p_sort           date | amount | number | client | rep | department | status
--
-- Text sorts read the column as shown, status sorts in the order a document
-- moves through its statuses, and every sort leaves empty values last in both
-- directions, then breaks ties newest first. The page is still an
-- ORDER BY ... LIMIT over the filtered set, which Postgres answers with a top-N
-- sort.

DROP FUNCTION IF EXISTS public.get_invoice_list(text, text[], text[], integer, text, boolean, integer, integer);
DROP FUNCTION IF EXISTS public.get_quote_list(text, text[], text[], integer, text, boolean, integer, integer);

-- ─── Invoices and credit notes ────────────────────────────────────────────────

CREATE FUNCTION public.get_invoice_list(
  p_search        text    DEFAULT NULL,
  p_statuses      text[]  DEFAULT NULL,
  p_reps          text[]  DEFAULT NULL,
  p_year          integer DEFAULT NULL,
  p_sort          text    DEFAULT 'date',
  p_desc          boolean DEFAULT true,
  p_limit         integer DEFAULT 100,
  p_offset        integer DEFAULT 0,
  p_month         integer DEFAULT NULL,
  p_depts         text[]  DEFAULT NULL,
  p_office        text    DEFAULT NULL,
  p_with_shipping boolean DEFAULT NULL
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
      coalesce(p_sort, 'date')               AS sort_key,
      coalesce(p_desc, true)                 AS descending,
      -- Half-open range on the date, never EXTRACT, so the index serves it.
      CASE WHEN p_year IS NULL THEN NULL
           WHEN p_month BETWEEN 1 AND 12 THEN make_date(p_year, p_month, 1)
           ELSE make_date(p_year, 1, 1)
      END                                    AS date_from,
      CASE WHEN p_year IS NULL THEN NULL
           WHEN p_month BETWEEN 1 AND 12 THEN (make_date(p_year, p_month, 1) + interval '1 month')::date
           ELSE make_date(p_year + 1, 1, 1)
      END                                    AS date_to,
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
       AND (p.date_from IS NULL OR (i.invoice_date >= p.date_from AND i.invoice_date < p.date_to))
       AND (p_depts IS NULL OR i.department = ANY (p_depts))
       AND (p_office IS NULL OR i.office::text = p_office)
       AND (p_with_shipping IS NOT TRUE OR coalesce(i.shipping_charge, 0) <> 0)
       AND (p.pat IS NULL OR i.client_name    ILIKE p.pat
                          OR i.invoice_number ILIKE p.pat
                          OR i.rep_name       ILIKE p.pat)
  ),
  keyed AS (
    SELECT h.*,
           -- A text sort: one column per direction, the other one NULL.
           CASE WHEN NOT p.descending THEN t.k END AS tk_asc,
           CASE WHEN p.descending     THEN t.k END AS tk_desc,
           -- A numeric sort, negated for a descending one.
           CASE p.sort_key
             WHEN 'amount' THEN h.amount
             WHEN 'status' THEN array_position(
               ARRAY['sent', 'overdue', 'partial', 'paid', 'avoir'],
               CASE WHEN h.is_avoir THEN 'avoir' ELSE h.status END)::numeric
             WHEN 'date'   THEN (h.invoice_date - DATE '2000-01-01')::numeric
           END * CASE WHEN p.descending THEN -1 ELSE 1 END AS nk
      FROM hits h, params p,
           LATERAL (SELECT CASE p.sort_key
                             WHEN 'number'     THEN h.invoice_number
                             WHEN 'client'     THEN h.client_name
                             WHEN 'rep'        THEN h.rep_name
                             WHEN 'department' THEN coalesce(h.department, h.zoho_department_label)
                           END AS k) t
  ),
  page AS (
    SELECT * FROM keyed
     ORDER BY tk_asc ASC NULLS LAST, tk_desc DESC NULLS LAST, nk ASC NULLS LAST,
              invoice_date DESC NULLS LAST, invoice_number DESC NULLS LAST, zoho_id
     LIMIT (SELECT lim FROM params) OFFSET (SELECT off FROM params)
  )
  SELECT jsonb_build_object(
    'total_count',  (SELECT count(*) FROM hits),
    'total_amount', (SELECT coalesce(sum(h.amount), 0) FROM hits h),
    'rows', coalesce((
      SELECT jsonb_agg(to_jsonb(pg) - ARRAY['tk_asc', 'tk_desc', 'nk']
                       ORDER BY pg.tk_asc ASC NULLS LAST, pg.tk_desc DESC NULLS LAST, pg.nk ASC NULLS LAST,
                                pg.invoice_date DESC NULLS LAST, pg.invoice_number DESC NULLS LAST, pg.zoho_id)
        FROM page pg
    ), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION public.get_invoice_list(text, text[], text[], integer, text, boolean, integer, integer, integer, text[], text, boolean) IS
  'One page of every stored invoice and credit note, searched on client, number '
  'and rep. Returns {total_count, total_amount, rows}. p_sort: date | amount | '
  'number | client | rep | department | status.';

-- ─── Quotes, every status ─────────────────────────────────────────────────────

CREATE FUNCTION public.get_quote_list(
  p_search   text    DEFAULT NULL,
  p_statuses text[]  DEFAULT NULL,
  p_reps     text[]  DEFAULT NULL,
  p_year     integer DEFAULT NULL,
  p_sort     text    DEFAULT 'date',
  p_desc     boolean DEFAULT true,
  p_limit    integer DEFAULT 100,
  p_offset   integer DEFAULT 0,
  p_month    integer DEFAULT NULL,
  p_depts    text[]  DEFAULT NULL,
  p_office   text    DEFAULT NULL
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
      coalesce(p_sort, 'date')               AS sort_key,
      coalesce(p_desc, true)                 AS descending,
      CASE WHEN p_year IS NULL THEN NULL
           WHEN p_month BETWEEN 1 AND 12 THEN make_date(p_year, p_month, 1)
           ELSE make_date(p_year, 1, 1)
      END                                    AS date_from,
      CASE WHEN p_year IS NULL THEN NULL
           WHEN p_month BETWEEN 1 AND 12 THEN (make_date(p_year, p_month, 1) + interval '1 month')::date
           ELSE make_date(p_year + 1, 1, 1)
      END                                    AS date_to,
      LEAST(GREATEST(coalesce(p_limit, 100), 1), 1000) AS lim,
      GREATEST(coalesce(p_offset, 0), 0)     AS off
  ),
  hits AS (
    -- Dated by issue. sale_date is the acceptance date on a won quote and only a
    -- fallback otherwise; it stands in for a missing quote_date.
    SELECT s.zoho_id, s.quote_number, coalesce(s.quote_date, s.sale_date) AS quote_date,
           s.accepted_date, s.client_name, s.amount, s.rep_name,
           s.department::text AS department, s.zoho_department_label,
           s.office::text AS office, s.status::text AS status, s.zoho_status
      FROM public.sales s, params p
     WHERE (p_statuses IS NULL OR s.status::text = ANY (p_statuses))
       AND (p_reps IS NULL OR s.rep_name = ANY (p_reps))
       AND (p.date_from IS NULL OR (coalesce(s.quote_date, s.sale_date) >= p.date_from
                                    AND coalesce(s.quote_date, s.sale_date) <  p.date_to))
       AND (p_depts IS NULL OR s.department::text = ANY (p_depts))
       AND (p_office IS NULL OR s.office::text = p_office)
       AND (p.pat IS NULL OR s.client_name  ILIKE p.pat
                          OR s.quote_number ILIKE p.pat
                          OR s.rep_name     ILIKE p.pat)
  ),
  keyed AS (
    SELECT h.*,
           CASE WHEN NOT p.descending THEN t.k END AS tk_asc,
           CASE WHEN p.descending     THEN t.k END AS tk_desc,
           CASE p.sort_key
             WHEN 'amount' THEN h.amount
             WHEN 'status' THEN array_position(
               ARRAY['draft', 'sent', 'accepted', 'invoiced', 'declined', 'expired'], h.status)::numeric
             WHEN 'date'   THEN (h.quote_date - DATE '2000-01-01')::numeric
           END * CASE WHEN p.descending THEN -1 ELSE 1 END AS nk
      FROM hits h, params p,
           LATERAL (SELECT CASE p.sort_key
                             WHEN 'number'     THEN h.quote_number
                             WHEN 'client'     THEN h.client_name
                             WHEN 'rep'        THEN h.rep_name
                             WHEN 'department' THEN coalesce(h.department, h.zoho_department_label)
                           END AS k) t
  ),
  page AS (
    SELECT * FROM keyed
     ORDER BY tk_asc ASC NULLS LAST, tk_desc DESC NULLS LAST, nk ASC NULLS LAST,
              quote_date DESC NULLS LAST, quote_number DESC NULLS LAST, zoho_id
     LIMIT (SELECT lim FROM params) OFFSET (SELECT off FROM params)
  )
  SELECT jsonb_build_object(
    'total_count',  (SELECT count(*) FROM hits),
    'total_amount', (SELECT coalesce(sum(h.amount), 0) FROM hits h),
    'rows', coalesce((
      SELECT jsonb_agg(to_jsonb(pg) - ARRAY['tk_asc', 'tk_desc', 'nk']
                       ORDER BY pg.tk_asc ASC NULLS LAST, pg.tk_desc DESC NULLS LAST, pg.nk ASC NULLS LAST,
                                pg.quote_date DESC NULLS LAST, pg.quote_number DESC NULLS LAST, pg.zoho_id)
        FROM page pg
    ), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION public.get_quote_list(text, text[], text[], integer, text, boolean, integer, integer, integer, text[], text) IS
  'One page of every stored quote, any status, dated by issue. Searched on client, '
  'number and rep. Returns {total_count, total_amount, rows}. p_sort: date | amount | '
  'number | client | rep | department | status.';

REVOKE ALL ON FUNCTION public.get_invoice_list(text, text[], text[], integer, text, boolean, integer, integer, integer, text[], text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_quote_list(text, text[], text[], integer, text, boolean, integer, integer, integer, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoice_list(text, text[], text[], integer, text, boolean, integer, integer, integer, text[], text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_quote_list(text, text[], text[], integer, text, boolean, integer, integer, integer, text[], text) TO authenticated, service_role;
