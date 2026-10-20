-- Account summaries: refresh by date, and the copy onto the Zoho account.
--
-- refresh_at: the first day a card goes stale with no new activity (a quote
-- passing 30 days or expiring, an invoice falling due or passing 30 days late, a
-- last purchase or exchange leaving its window). Books moves neither record's
-- modified time, so the nightly activity detection never sees these; the 1 AM
-- run also queues every account whose latest card has reached its refresh_at.
--
-- crm_pushed_at / crm_error: every finished card is copied onto custom fields of
-- the Zoho account (temperature, its reason, first next step, open quotes,
-- overdue) so list views can filter on them. A failed copy is retried at night.

ALTER TABLE public.account_ai_summaries
  ADD COLUMN IF NOT EXISTS refresh_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS crm_pushed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS crm_error     TEXT;
COMMENT ON COLUMN public.account_ai_summaries.refresh_at IS
  'Done rows: when the card goes stale by date alone (midnight UTC of that Montreal day); the 1 AM run of that day rewrites it. NULL: nothing on the card expires by date.';
COMMENT ON COLUMN public.account_ai_summaries.crm_pushed_at IS
  'When the card was copied onto the Zoho account''s custom fields. NULL on the latest card of an account: not copied yet, or the copy failed (crm_error).';
COMMENT ON COLUMN public.account_ai_summaries.crm_error IS
  'Why the last copy onto the Zoho account failed.';
-- The latest card of each account, as the widget picks it.
CREATE INDEX IF NOT EXISTS account_ai_summaries_latest_done_idx
  ON public.account_ai_summaries (zoho_account_id, started_at DESC, id DESC)
  WHERE status = 'done';
-- Accounts whose latest card has reached its refresh day by p_until. Internal
-- and supplier accounts, and accounts gone from the mirror, are left out.
CREATE OR REPLACE FUNCTION public.account_ai_summary_expired(p_until TIMESTAMPTZ)
RETURNS TABLE (account_id TEXT, refresh_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT l.zoho_account_id, l.refresh_at
  FROM (
    SELECT DISTINCT ON (s.zoho_account_id) s.zoho_account_id, s.refresh_at
    FROM public.account_ai_summaries s
    WHERE s.status = 'done'
    ORDER BY s.zoho_account_id, s.started_at DESC NULLS LAST, s.id DESC
  ) l
  JOIN public.zoho_accounts a ON a.zoho_account_id = l.zoho_account_id
  WHERE l.refresh_at <= p_until
    AND a.rating IS DISTINCT FROM 'Compte interne : Ne pas reprendre'
    AND a.rating IS DISTINCT FROM 'Fournisseur';
$$;
-- The latest card of each account not yet copied onto the Zoho account, newest
-- first.
CREATE OR REPLACE FUNCTION public.account_ai_summary_crm_pending(p_limit INTEGER DEFAULT 200)
RETURNS TABLE (id BIGINT, zoho_account_id TEXT, result JSONB, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT l.id, l.zoho_account_id, l.result, l.completed_at, l.created_at
  FROM (
    SELECT DISTINCT ON (s.zoho_account_id) s.id, s.zoho_account_id, s.result, s.completed_at, s.created_at, s.crm_pushed_at
    FROM public.account_ai_summaries s
    WHERE s.status = 'done'
    ORDER BY s.zoho_account_id, s.started_at DESC NULLS LAST, s.id DESC
  ) l
  WHERE l.crm_pushed_at IS NULL AND l.result IS NOT NULL
  ORDER BY l.completed_at DESC NULLS LAST, l.id DESC
  LIMIT p_limit;
$$;
REVOKE ALL ON FUNCTION public.account_ai_summary_expired(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_ai_summary_crm_pending(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_ai_summary_expired(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.account_ai_summary_crm_pending(INTEGER) TO service_role;
