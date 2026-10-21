-- The Zoho Books document behind an invoice or credit note, as the account
-- summary reads it: lines with their descriptions, totals, payments, how it was
-- sent, notes and terms.
--
-- `invoices` holds one amount per document; the lines are only on Books'
-- detail endpoint, one API call each. The account-summary function keeps what
-- it read here and reads a document again when the mirror's status or amount
-- has moved (`mirror_key`), when an unpaid invoice's copy is a day old, or when
-- the function's DETAIL_FORMAT is raised. Only that function writes; a missing
-- or failing table only costs it more Books calls.

CREATE TABLE IF NOT EXISTS public.invoice_details (
  -- invoices.zoho_id: an invoice id, or a credit note id for an is_avoir row.
  zoho_id     TEXT        PRIMARY KEY,
  office      TEXT        NOT NULL,
  kind        TEXT        NOT NULL CHECK (kind IN ('invoice', 'creditnote')),
  format      SMALLINT    NOT NULL,
  mirror_key  TEXT        NOT NULL,
  detail      JSONB       NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.invoice_details IS
  'Zoho Books invoice and credit note documents read by account-summary (lines, totals, payments, notes, terms). A cache: written by that function only.';
COMMENT ON COLUMN public.invoice_details.mirror_key IS
  'invoices status|amount when the document was read; a different value makes the next summary read it again.';
COMMENT ON COLUMN public.invoice_details.format IS
  'Shape of `detail` (DETAIL_FORMAT in account-summary/gather.ts); older rows are read again.';

-- Admins read; the edge function writes with the service role.
ALTER TABLE public.invoice_details ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listed_users_only ON public.invoice_details;
CREATE POLICY listed_users_only ON public.invoice_details
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.app_is_listed()));

DROP POLICY IF EXISTS invoice_details_select_admin ON public.invoice_details;
CREATE POLICY invoice_details_select_admin ON public.invoice_details
  FOR SELECT TO authenticated
  USING ((SELECT public.app_is_admin()));

REVOKE ALL ON public.invoice_details FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.invoice_details TO authenticated;
GRANT ALL ON public.invoice_details TO service_role;
