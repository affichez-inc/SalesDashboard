-- AI relationship summaries for Zoho CRM accounts.
--
-- One row per generation. The account-summary edge function inserts a 'running'
-- row, gathers the account's CRM and Books activity, asks the model, and stores
-- the card in `result`. The Zoho widget reads the latest 'done' row.
--
-- Only the function writes (service role). Admins can read the history.

CREATE TABLE IF NOT EXISTS public.account_ai_summaries (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  zoho_account_id    TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'done', 'failed')),
  requested_by       TEXT,
  requested_by_name  TEXT,
  model              TEXT,
  result             JSONB,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS account_ai_summaries_account_idx
  ON public.account_ai_summaries (zoho_account_id, created_at DESC);

-- One generation at a time per account: a second request joins the running one.
CREATE UNIQUE INDEX IF NOT EXISTS account_ai_summaries_one_running_idx
  ON public.account_ai_summaries (zoho_account_id)
  WHERE status = 'running';

COMMENT ON TABLE public.account_ai_summaries IS
  'AI relationship summaries of Zoho CRM accounts, one row per generation. Written by the account-summary function only.';
COMMENT ON COLUMN public.account_ai_summaries.requested_by IS
  'Email of the CRM user who asked, as reported by the Zoho widget.';
COMMENT ON COLUMN public.account_ai_summaries.result IS
  'The card: model output (temperature, summary, key points, next steps), computed stats and the source index.';

ALTER TABLE public.account_ai_summaries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listed_users_only ON public.account_ai_summaries;
CREATE POLICY listed_users_only ON public.account_ai_summaries
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.app_is_listed()));

DROP POLICY IF EXISTS account_ai_summaries_select_admin ON public.account_ai_summaries;
CREATE POLICY account_ai_summaries_select_admin ON public.account_ai_summaries
  FOR SELECT TO authenticated
  USING ((SELECT public.app_is_admin()));

REVOKE ALL ON public.account_ai_summaries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_ai_summaries TO authenticated;
GRANT ALL ON public.account_ai_summaries TO service_role;
