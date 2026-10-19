-- Nightly account summaries, and the cost of every model call.
--
-- At 1 AM Montreal time the account-summary function lists the CRM accounts with
-- activity since the previous run (notes, tasks, meetings, new contacts and
-- accounts, Books quotes and invoices) and queues one summary for each. A worker
-- started every minute by pg_cron claims the queue a few accounts at a time.
--
-- Every request sent to the model, manual or nightly, successful or not, is one
-- row of ai_model_calls with its tokens, the provider's prices and its cost.
--
-- pg_cron reaches the function with the x-summary-key header read from the Vault
-- secret `account_summary_key` (the value of the SUMMARY_API_KEY function secret).
-- Without that secret both jobs run and post nothing.

-- ─── Runs ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.account_ai_summary_runs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The Montreal date the run belongs to; its window ends at 1 AM that day.
  local_date      DATE        NOT NULL UNIQUE,
  window_start    TIMESTAMPTZ NOT NULL,
  window_end      TIMESTAMPTZ NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'detecting'
                  CHECK (status IN ('detecting', 'queued', 'failed')),
  attempts        INTEGER     NOT NULL DEFAULT 1,
  accounts_found  INTEGER,
  queued          INTEGER,
  skipped_fresh   INTEGER,
  skipped_queued  INTEGER,
  skipped_limit   INTEGER,
  detection       JSONB,
  error           TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  detected_at     TIMESTAMPTZ,
  CHECK (window_end > window_start)
);
COMMENT ON TABLE public.account_ai_summary_runs IS
  'One row per nightly summary run: the activity window, what was found and what was queued.';
COMMENT ON COLUMN public.account_ai_summary_runs.window_start IS
  'End of the last successful run (24 h earlier by default, 7 days at most), so a failed night is covered by the next one.';
COMMENT ON COLUMN public.account_ai_summary_runs.detection IS
  'Items found per activity kind, items not tied to an account, internal accounts left out, API calls and duration.';
-- ─── Summaries: the queue ─────────────────────────────────────────────────────

ALTER TABLE public.account_ai_summaries
  ADD COLUMN IF NOT EXISTS trigger          TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS run_id           BIGINT REFERENCES public.account_ai_summary_runs (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS started_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempts         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activity         JSONB,
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ready_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS skip_reason      TEXT;
ALTER TABLE public.account_ai_summaries DROP CONSTRAINT IF EXISTS account_ai_summaries_status_check;
ALTER TABLE public.account_ai_summaries ADD CONSTRAINT account_ai_summaries_status_check
  CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped'));
ALTER TABLE public.account_ai_summaries DROP CONSTRAINT IF EXISTS account_ai_summaries_trigger_check;
ALTER TABLE public.account_ai_summaries ADD CONSTRAINT account_ai_summaries_trigger_check
  CHECK (trigger IN ('manual', 'nightly'));
ALTER TABLE public.account_ai_summaries DROP CONSTRAINT IF EXISTS account_ai_summaries_skip_reason_check;
ALTER TABLE public.account_ai_summaries ADD CONSTRAINT account_ai_summaries_skip_reason_check
  CHECK (skip_reason IN ('fresh', 'already_queued', 'limit'));
-- Rows from before this migration started when they were created.
UPDATE public.account_ai_summaries
SET started_at = created_at, attempts = 1
WHERE started_at IS NULL AND status <> 'queued';
-- One queued generation per account; a manual one may run beside it.
CREATE UNIQUE INDEX IF NOT EXISTS account_ai_summaries_one_queued_idx
  ON public.account_ai_summaries (zoho_account_id)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS account_ai_summaries_claim_idx
  ON public.account_ai_summaries (next_attempt_at, id)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS account_ai_summaries_run_idx
  ON public.account_ai_summaries (run_id)
  WHERE run_id IS NOT NULL;
COMMENT ON COLUMN public.account_ai_summaries.trigger IS
  'manual: the Zoho widget''s button; nightly: the 1 AM run.';
COMMENT ON COLUMN public.account_ai_summaries.started_at IS
  'When the data was read. A summary includes the activity up to this moment.';
COMMENT ON COLUMN public.account_ai_summaries.activity IS
  'Nightly only: the activity that queued the account, counted per kind.';
COMMENT ON COLUMN public.account_ai_summaries.ready_at IS
  'Nightly only: from when the summary can see all of that activity (the mirror syncs lag the CRM). A summary started after it is fresh.';
COMMENT ON COLUMN public.account_ai_summaries.skip_reason IS
  'fresh: a summary started after ready_at already exists; already_queued: an earlier run still holds it; limit: over the nightly cap.';
-- ─── Model calls ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_model_calls (
  id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  feature                     TEXT        NOT NULL DEFAULT 'account_summary',
  summary_id                  BIGINT REFERENCES public.account_ai_summaries (id) ON DELETE SET NULL,
  zoho_account_id             TEXT,
  run_id                      BIGINT REFERENCES public.account_ai_summary_runs (id) ON DELETE SET NULL,
  trigger                     TEXT CHECK (trigger IN ('manual', 'nightly')),
  attempt                     SMALLINT    NOT NULL,
  api                         TEXT        NOT NULL DEFAULT 'openrouter',
  generation_id               TEXT,
  model_requested             TEXT        NOT NULL,
  model_used                  TEXT,
  provider                    TEXT,
  reasoning_effort            TEXT,
  max_tokens                  INTEGER,
  outcome                     TEXT        NOT NULL
                              CHECK (outcome IN ('ok', 'http_error', 'network_error', 'timeout', 'empty',
                                                 'invalid_output', 'truncated', 'refused')),
  http_status                 SMALLINT,
  finish_reason               TEXT,
  native_finish_reason        TEXT,
  error                       TEXT,

  -- Tokens as billed. prompt_tokens includes the cached ones.
  prompt_tokens               INTEGER,
  cached_tokens               INTEGER,
  cache_write_tokens          INTEGER,
  completion_tokens           INTEGER,
  reasoning_tokens            INTEGER,
  total_tokens                INTEGER,
  uncached_input_tokens       INTEGER GENERATED ALWAYS AS
                              (prompt_tokens - COALESCE(cached_tokens, 0) - COALESCE(cache_write_tokens, 0)) STORED,
  output_text_tokens          INTEGER GENERATED ALWAYS AS
                              (completion_tokens - COALESCE(reasoning_tokens, 0)) STORED,

  -- The serving provider's list prices, USD per million tokens, at call time.
  price_input_per_mtok        NUMERIC(12, 6),
  price_cached_input_per_mtok NUMERIC(12, 6),
  price_cache_write_per_mtok  NUMERIC(12, 6),
  price_output_per_mtok       NUMERIC(12, 6),
  price_reasoning_per_mtok    NUMERIC(12, 6),

  -- Each part of the cost, from the tokens and the prices above. A part with no
  -- tokens costs 0 even when the provider lists no price for it (no cache
  -- writes on most providers).
  cost_input_usd              NUMERIC(16, 10) GENERATED ALWAYS AS
    ((prompt_tokens - COALESCE(cached_tokens, 0) - COALESCE(cache_write_tokens, 0)) * price_input_per_mtok / 1000000) STORED,
  cost_cached_input_usd       NUMERIC(16, 10) GENERATED ALWAYS AS
    (CASE WHEN COALESCE(cached_tokens, 0) = 0 THEN 0 ELSE cached_tokens * price_cached_input_per_mtok / 1000000 END) STORED,
  cost_cache_write_usd        NUMERIC(16, 10) GENERATED ALWAYS AS
    (CASE WHEN COALESCE(cache_write_tokens, 0) = 0 THEN 0 ELSE cache_write_tokens * price_cache_write_per_mtok / 1000000 END) STORED,
  cost_output_usd             NUMERIC(16, 10) GENERATED ALWAYS AS
    ((completion_tokens - COALESCE(reasoning_tokens, 0)) * price_output_per_mtok / 1000000) STORED,
  cost_reasoning_usd          NUMERIC(16, 10) GENERATED ALWAYS AS
    (CASE WHEN COALESCE(reasoning_tokens, 0) = 0 THEN 0 ELSE reasoning_tokens * price_reasoning_per_mtok / 1000000 END) STORED,
  cost_computed_usd           NUMERIC(16, 10) GENERATED ALWAYS AS (
      (prompt_tokens - COALESCE(cached_tokens, 0) - COALESCE(cache_write_tokens, 0)) * price_input_per_mtok / 1000000
    + CASE WHEN COALESCE(cached_tokens, 0) = 0 THEN 0 ELSE cached_tokens * price_cached_input_per_mtok / 1000000 END
    + CASE WHEN COALESCE(cache_write_tokens, 0) = 0 THEN 0 ELSE cache_write_tokens * price_cache_write_per_mtok / 1000000 END
    + (completion_tokens - COALESCE(reasoning_tokens, 0)) * price_output_per_mtok / 1000000
    + CASE WHEN COALESCE(reasoning_tokens, 0) = 0 THEN 0 ELSE reasoning_tokens * price_reasoning_per_mtok / 1000000 END) STORED,

  -- What OpenRouter charged: the figure that counts.
  cost_usd                    NUMERIC(16, 10),
  cost_upstream_usd           NUMERIC(16, 10),
  is_byok                     BOOLEAN,

  latency_ms                  INTEGER,
  prompt_chars                INTEGER,
  response_chars              INTEGER,
  usage                       JSONB
);
CREATE INDEX IF NOT EXISTS ai_model_calls_created_idx ON public.ai_model_calls (created_at);
CREATE INDEX IF NOT EXISTS ai_model_calls_account_idx ON public.ai_model_calls (zoho_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_model_calls_summary_idx ON public.ai_model_calls (summary_id) WHERE summary_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_model_calls_run_idx ON public.ai_model_calls (run_id) WHERE run_id IS NOT NULL;
COMMENT ON TABLE public.ai_model_calls IS
  'Every request sent to a language model, one row per attempt, with its tokens, prices and cost. Written by the edge functions only.';
COMMENT ON COLUMN public.ai_model_calls.cost_usd IS
  'Amount OpenRouter charged for the call (usage.cost). Failed attempts that reached a provider are charged too.';
COMMENT ON COLUMN public.ai_model_calls.cost_computed_usd IS
  'Sum of the cost_* parts from the list prices. Equal to cost_usd unless the provider applied a discount.';
COMMENT ON COLUMN public.ai_model_calls.reasoning_tokens IS
  'Thinking tokens, part of completion_tokens and billed at the output price.';
COMMENT ON COLUMN public.ai_model_calls.usage IS
  'The usage object as OpenRouter returned it.';
-- ─── Access ───────────────────────────────────────────────────────────────────
-- Admins read; the edge functions write with the service role.

ALTER TABLE public.account_ai_summary_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_model_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS listed_users_only ON public.account_ai_summary_runs;
CREATE POLICY listed_users_only ON public.account_ai_summary_runs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.app_is_listed()));
DROP POLICY IF EXISTS account_ai_summary_runs_select_admin ON public.account_ai_summary_runs;
CREATE POLICY account_ai_summary_runs_select_admin ON public.account_ai_summary_runs
  FOR SELECT TO authenticated
  USING ((SELECT public.app_is_admin()));
DROP POLICY IF EXISTS listed_users_only ON public.ai_model_calls;
CREATE POLICY listed_users_only ON public.ai_model_calls
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.app_is_listed()));
DROP POLICY IF EXISTS ai_model_calls_select_admin ON public.ai_model_calls;
CREATE POLICY ai_model_calls_select_admin ON public.ai_model_calls
  FOR SELECT TO authenticated
  USING ((SELECT public.app_is_admin()));
REVOKE ALL ON public.account_ai_summary_runs, public.ai_model_calls FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_ai_summary_runs, public.ai_model_calls TO authenticated;
GRANT ALL ON public.account_ai_summary_runs, public.ai_model_calls TO service_role;
-- ─── Cost views ───────────────────────────────────────────────────────────────
-- security_invoker: each reads with the caller's rights, so admins only.

CREATE OR REPLACE VIEW public.ai_summary_costs
WITH (security_invoker = true) AS
SELECT
  s.id                                                 AS summary_id,
  s.zoho_account_id,
  a.account_name,
  s.trigger,
  s.run_id,
  s.status,
  s.skip_reason,
  s.created_at,
  s.started_at,
  s.completed_at,
  s.attempts,
  count(c.id)                                          AS calls,
  count(c.id) FILTER (WHERE c.outcome <> 'ok')         AS failed_calls,
  sum(c.prompt_tokens)                                 AS prompt_tokens,
  sum(c.cached_tokens)                                 AS cached_tokens,
  sum(c.uncached_input_tokens)                         AS uncached_input_tokens,
  sum(c.completion_tokens)                             AS completion_tokens,
  sum(c.reasoning_tokens)                              AS reasoning_tokens,
  sum(c.output_text_tokens)                            AS output_text_tokens,
  sum(c.cost_input_usd)                                AS cost_input_usd,
  sum(c.cost_cached_input_usd)                         AS cost_cached_input_usd,
  sum(c.cost_output_usd)                               AS cost_output_usd,
  sum(c.cost_reasoning_usd)                            AS cost_reasoning_usd,
  sum(c.cost_usd)                                      AS cost_usd,
  sum(c.latency_ms)                                    AS model_ms
FROM public.account_ai_summaries s
LEFT JOIN public.ai_model_calls c ON c.summary_id = s.id
LEFT JOIN public.zoho_accounts a ON a.zoho_account_id = s.zoho_account_id
GROUP BY s.id, a.account_name;
COMMENT ON VIEW public.ai_summary_costs IS
  'One row per summary generation (or skipped account), with the tokens and cost of its model calls.';
CREATE OR REPLACE VIEW public.ai_cost_by_account
WITH (security_invoker = true) AS
SELECT
  c.zoho_account_id,
  a.account_name,
  count(DISTINCT c.summary_id) FILTER (WHERE s.status = 'done')           AS summaries_done,
  count(DISTINCT c.summary_id) FILTER (WHERE s.trigger = 'nightly' AND s.status = 'done') AS nightly_done,
  count(DISTINCT c.summary_id) FILTER (WHERE s.trigger = 'manual' AND s.status = 'done')  AS manual_done,
  count(*)                                                                 AS calls,
  count(*) FILTER (WHERE c.outcome <> 'ok')                                AS failed_calls,
  sum(c.prompt_tokens)                                                     AS prompt_tokens,
  sum(c.cached_tokens)                                                     AS cached_tokens,
  sum(c.completion_tokens)                                                 AS completion_tokens,
  sum(c.reasoning_tokens)                                                  AS reasoning_tokens,
  sum(c.cost_usd)                                                          AS cost_usd,
  sum(c.cost_usd) FILTER (WHERE c.created_at >= now() - interval '30 days') AS cost_usd_30d,
  min(c.created_at)                                                        AS first_call_at,
  max(c.created_at)                                                        AS last_call_at
FROM public.ai_model_calls c
LEFT JOIN public.account_ai_summaries s ON s.id = c.summary_id
LEFT JOIN public.zoho_accounts a ON a.zoho_account_id = c.zoho_account_id
WHERE c.feature = 'account_summary'
GROUP BY c.zoho_account_id, a.account_name;
COMMENT ON VIEW public.ai_cost_by_account IS
  'Model calls and cost per CRM account, all time and over the last 30 days.';
CREATE OR REPLACE VIEW public.ai_cost_daily
WITH (security_invoker = true) AS
SELECT
  (c.created_at AT TIME ZONE 'America/Toronto')::date                     AS day,
  c.feature,
  c.trigger,
  count(DISTINCT c.summary_id) FILTER (WHERE s.status = 'done')           AS summaries_done,
  count(DISTINCT c.summary_id) FILTER (WHERE s.status = 'failed')         AS summaries_failed,
  count(DISTINCT c.zoho_account_id)                                        AS accounts,
  count(*)                                                                 AS calls,
  count(*) FILTER (WHERE c.outcome <> 'ok')                                AS failed_calls,
  sum(c.prompt_tokens)                                                     AS prompt_tokens,
  sum(c.cached_tokens)                                                     AS cached_tokens,
  sum(c.uncached_input_tokens)                                             AS uncached_input_tokens,
  sum(c.completion_tokens)                                                 AS completion_tokens,
  sum(c.reasoning_tokens)                                                  AS reasoning_tokens,
  sum(c.output_text_tokens)                                                AS output_text_tokens,
  sum(c.cost_input_usd)                                                    AS cost_input_usd,
  sum(c.cost_cached_input_usd)                                             AS cost_cached_input_usd,
  sum(c.cost_output_usd)                                                   AS cost_output_usd,
  sum(c.cost_reasoning_usd)                                                AS cost_reasoning_usd,
  sum(c.cost_usd)                                                          AS cost_usd,
  round(sum(c.cost_usd) / NULLIF(count(DISTINCT c.summary_id) FILTER (WHERE s.status = 'done'), 0), 6)
                                                                           AS cost_usd_per_summary
FROM public.ai_model_calls c
LEFT JOIN public.account_ai_summaries s ON s.id = c.summary_id
GROUP BY 1, 2, 3;
COMMENT ON VIEW public.ai_cost_daily IS
  'Model calls, tokens and cost per Montreal calendar day, per feature and trigger.';
CREATE OR REPLACE VIEW public.account_ai_summary_run_report
WITH (security_invoker = true) AS
SELECT
  r.id                                                     AS run_id,
  r.local_date,
  r.window_start,
  r.window_end,
  r.status                                                 AS detection_status,
  r.error                                                  AS detection_error,
  r.accounts_found,
  r.queued,
  r.skipped_fresh,
  r.skipped_queued,
  r.skipped_limit,
  count(s.id) FILTER (WHERE s.status = 'done')             AS done,
  count(s.id) FILTER (WHERE s.status = 'failed')           AS failed,
  count(s.id) FILTER (WHERE s.status = 'skipped' AND s.skip_reason = 'fresh')
                                                           AS skipped_fresh_total,
  count(s.id) FILTER (WHERE s.status IN ('queued', 'running')) AS pending,
  (SELECT sum(c.cost_usd) FROM public.ai_model_calls c WHERE c.run_id = r.id) AS cost_usd,
  r.started_at,
  r.detected_at,
  max(s.completed_at) FILTER (WHERE s.status IN ('done', 'failed')) AS last_completed_at
FROM public.account_ai_summary_runs r
LEFT JOIN public.account_ai_summaries s ON s.run_id = r.id
GROUP BY r.id;
COMMENT ON VIEW public.account_ai_summary_run_report IS
  'Each nightly run: accounts found, queued, done, failed, skipped and still pending, and what it cost.';
REVOKE ALL ON public.ai_summary_costs, public.ai_cost_by_account, public.ai_cost_daily,
              public.account_ai_summary_run_report FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ai_summary_costs, public.ai_cost_by_account, public.ai_cost_daily,
                public.account_ai_summary_run_report TO authenticated, service_role;
-- ─── Queue functions (service role only) ──────────────────────────────────────

-- The activity window of a Montreal date's run: up to 1 AM that day, from the
-- end of the last successful earlier run (24 h by default, 7 days at most).
CREATE OR REPLACE FUNCTION public.account_ai_summary_window(p_local_date DATE)
RETURNS TABLE (window_start TIMESTAMPTZ, window_end TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_end   TIMESTAMPTZ := make_timestamptz(
    EXTRACT(YEAR FROM p_local_date)::int, EXTRACT(MONTH FROM p_local_date)::int,
    EXTRACT(DAY FROM p_local_date)::int, 1, 0, 0, 'America/Toronto');
  v_start TIMESTAMPTZ;
BEGIN
  SELECT max(r.window_end) INTO v_start
  FROM public.account_ai_summary_runs r
  WHERE r.status = 'queued' AND r.local_date < p_local_date;
  v_start := GREATEST(COALESCE(v_start, v_end - interval '24 hours'), v_end - interval '7 days');
  RETURN QUERY SELECT v_start, v_end;
END
$$;
-- Opens the run of a Montreal date, or reopens it when its detection failed or
-- stalled. `started` is false when the run already exists and is not retried.
CREATE OR REPLACE FUNCTION public.account_ai_summary_start_run(p_local_date DATE)
RETURNS TABLE (run_id BIGINT, window_start TIMESTAMPTZ, window_end TIMESTAMPTZ, started BOOLEAN, status TEXT)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_start TIMESTAMPTZ;
  v_end   TIMESTAMPTZ;
  v_run   public.account_ai_summary_runs;
BEGIN
  SELECT w.window_start, w.window_end INTO v_start, v_end
  FROM public.account_ai_summary_window(p_local_date) w;
  IF v_end > now() THEN
    RAISE EXCEPTION 'The activity window of % ends at %, not yet reached', p_local_date, v_end
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.account_ai_summary_runs (local_date, window_start, window_end)
  VALUES (p_local_date, v_start, v_end)
  ON CONFLICT (local_date) DO NOTHING
  RETURNING * INTO v_run;
  IF v_run.id IS NOT NULL THEN
    RETURN QUERY SELECT v_run.id, v_run.window_start, v_run.window_end, true, v_run.status;
    RETURN;
  END IF;

  UPDATE public.account_ai_summary_runs r
  SET status = 'detecting', attempts = r.attempts + 1, error = NULL, started_at = now(), window_start = v_start
  WHERE r.local_date = p_local_date
    AND (r.status = 'failed' OR (r.status = 'detecting' AND r.started_at < now() - interval '15 minutes'))
  RETURNING * INTO v_run;
  IF v_run.id IS NOT NULL THEN
    RETURN QUERY SELECT v_run.id, v_run.window_start, v_run.window_end, true, v_run.status;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT r.id, r.window_start, r.window_end, false, r.status
  FROM public.account_ai_summary_runs r
  WHERE r.local_date = p_local_date;
END
$$;
-- Queues the accounts a run found, at most p_limit, most recent activity first.
-- An account is skipped when a summary started after its ready_at already exists
-- (it includes the activity) or when an earlier run still holds it in the queue.
-- p_items: [{ account_id, last_activity_at, ready_at, activity }].
CREATE OR REPLACE FUNCTION public.account_ai_summary_enqueue(p_run_id BIGINT, p_items JSONB, p_limit INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_counts JSONB;
BEGIN
  WITH items AS (
    SELECT DISTINCT ON (x.account_id) x.account_id, x.last_activity_at, x.ready_at, x.activity
    FROM jsonb_to_recordset(p_items)
      AS x(account_id TEXT, last_activity_at TIMESTAMPTZ, ready_at TIMESTAMPTZ, activity JSONB)
    WHERE x.account_id ~ '^\d{6,25}$' AND x.ready_at IS NOT NULL
    ORDER BY x.account_id, x.ready_at DESC
  ), judged AS (
    SELECT i.*,
      EXISTS (
        SELECT 1 FROM public.account_ai_summaries s
        WHERE s.zoho_account_id = i.account_id AND s.status = 'done'
          AND COALESCE(s.started_at, s.created_at) >= i.ready_at
      ) AS is_fresh,
      EXISTS (
        SELECT 1 FROM public.account_ai_summaries s
        WHERE s.zoho_account_id = i.account_id AND s.status = 'queued'
      ) AS is_queued
    FROM items i
  ), ranked AS (
    SELECT j.*,
      row_number() OVER (PARTITION BY (j.is_fresh OR j.is_queued)
                         ORDER BY j.last_activity_at DESC, j.account_id) AS rnk
    FROM judged j
  ), decided AS (
    SELECT r.*,
      CASE WHEN r.is_fresh THEN 'fresh'
           WHEN r.is_queued THEN 'already_queued'
           WHEN r.rnk > p_limit THEN 'limit' END AS reason
    FROM ranked r
  ), ins AS (
    INSERT INTO public.account_ai_summaries
      (zoho_account_id, status, trigger, run_id, requested_by_name, activity, last_activity_at, ready_at,
       next_attempt_at, skip_reason, completed_at)
    SELECT d.account_id,
      CASE WHEN d.reason IS NULL THEN 'queued' ELSE 'skipped' END,
      'nightly', p_run_id, 'Automatique', d.activity, d.last_activity_at, d.ready_at,
      CASE WHEN d.reason IS NULL THEN GREATEST(now(), d.ready_at) END,
      d.reason,
      CASE WHEN d.reason IS NOT NULL THEN now() END
    FROM decided d
    RETURNING status, skip_reason
  )
  SELECT jsonb_build_object(
    'found',          (SELECT count(*) FROM items),
    'queued',         count(*) FILTER (WHERE status = 'queued'),
    'skipped_fresh',  count(*) FILTER (WHERE skip_reason = 'fresh'),
    'skipped_queued', count(*) FILTER (WHERE skip_reason = 'already_queued'),
    'skipped_limit',  count(*) FILTER (WHERE skip_reason = 'limit'))
  INTO v_counts
  FROM ins;

  UPDATE public.account_ai_summary_runs
  SET status = 'queued',
      accounts_found = (v_counts->>'found')::int,
      queued = (v_counts->>'queued')::int,
      skipped_fresh = (v_counts->>'skipped_fresh')::int,
      skipped_queued = (v_counts->>'skipped_queued')::int,
      skipped_limit = (v_counts->>'skipped_limit')::int,
      detected_at = now()
  WHERE id = p_run_id;

  RETURN v_counts;
END
$$;
-- Claims the next queued summary that is due, or returns no row. At most
-- p_max_running nightly generations run at once; claims are serialised so the
-- cap holds. Expires generations interrupted by the function's wall clock first:
-- a nightly one goes back to the queue until p_max_attempts, a manual one fails.
-- A queued account that has meanwhile got a summary covering its activity is
-- skipped instead of claimed.
CREATE OR REPLACE FUNCTION public.account_ai_summary_claim(p_max_running INTEGER DEFAULT 3, p_max_attempts INTEGER DEFAULT 3)
RETURNS SETOF public.account_ai_summaries
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.account_ai_summaries;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('public.account_ai_summary_claim'));

  UPDATE public.account_ai_summaries s
  SET status = 'queued', next_attempt_at = now() + interval '5 minutes', error = 'Génération interrompue.'
  WHERE s.status = 'running' AND s.trigger = 'nightly' AND s.attempts < p_max_attempts
    AND COALESCE(s.started_at, s.created_at) < now() - interval '7 minutes'
    AND NOT EXISTS (
      SELECT 1 FROM public.account_ai_summaries q
      WHERE q.zoho_account_id = s.zoho_account_id AND q.status = 'queued');

  UPDATE public.account_ai_summaries s
  SET status = 'failed', error = 'Génération interrompue.', completed_at = now()
  WHERE s.status = 'running'
    AND COALESCE(s.started_at, s.created_at) < now() - interval '7 minutes';

  IF (SELECT count(*) FROM public.account_ai_summaries s
      WHERE s.status = 'running' AND s.trigger = 'nightly') >= p_max_running THEN
    RETURN;
  END IF;

  LOOP
    SELECT * INTO v_row
    FROM public.account_ai_summaries q
    WHERE q.status = 'queued' AND q.next_attempt_at <= now()
      AND NOT EXISTS (
        SELECT 1 FROM public.account_ai_summaries r
        WHERE r.zoho_account_id = q.zoho_account_id AND r.status = 'running')
    ORDER BY q.next_attempt_at, q.id
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
    IF v_row.id IS NULL THEN
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.account_ai_summaries s
      WHERE s.zoho_account_id = v_row.zoho_account_id AND s.status = 'done'
        AND COALESCE(s.started_at, s.created_at) >= v_row.ready_at
    ) THEN
      UPDATE public.account_ai_summaries
      SET status = 'skipped', skip_reason = 'fresh', next_attempt_at = NULL, completed_at = now()
      WHERE id = v_row.id;
      v_row := NULL;
      CONTINUE;
    END IF;

    BEGIN
      UPDATE public.account_ai_summaries
      SET status = 'running', attempts = attempts + 1, started_at = now(), next_attempt_at = NULL
      WHERE id = v_row.id
      RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
      -- A manual generation of this account started in the meantime.
      RETURN;
    END;
    RETURN NEXT v_row;
    RETURN;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION public.account_ai_summary_window(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_ai_summary_start_run(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_ai_summary_window(DATE) TO service_role;
REVOKE ALL ON FUNCTION public.account_ai_summary_enqueue(BIGINT, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_ai_summary_claim(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_ai_summary_start_run(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.account_ai_summary_enqueue(BIGINT, JSONB, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.account_ai_summary_claim(INTEGER, INTEGER) TO service_role;
-- ─── Cron entry points ────────────────────────────────────────────────────────

-- Posts { action } to account-summary with the key from Vault. Returns false
-- when the secret is missing.
CREATE OR REPLACE FUNCTION public.account_ai_summary_post(p_action TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_key TEXT;
BEGIN
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'account_summary_key';
  IF v_key IS NULL THEN
    RAISE WARNING 'Vault secret account_summary_key is missing: account-summary % not started', p_action;
    RETURN false;
  END IF;
  PERFORM net.http_post(
    url     := 'https://auyfucbskylougsmmrks.supabase.co/functions/v1/account-summary',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-summary-key', v_key),
    body    := jsonb_build_object('action', p_action)
  );
  RETURN true;
END
$$;
-- pg_cron runs in UTC, so the job fires at 05:00 and 06:00 UTC and only the one
-- that falls at 1 AM in Montreal (EDT or EST) posts. On the night clocks fall
-- back both do; the run is unique per date, so the second is a no-op.
CREATE OR REPLACE FUNCTION public.account_ai_summary_nightly_tick()
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF EXTRACT(HOUR FROM now() AT TIME ZONE 'America/Toronto') <> 1 THEN
    RETURN false;
  END IF;
  RETURN public.account_ai_summary_post('nightly');
END
$$;
-- Starts workers for the queue, up to p_max_running at once. Posts nothing when
-- no queued summary is due and nothing is stuck running, so an idle minute costs
-- one query. A generation running for over 7 minutes was interrupted: it does not
-- hold a slot, and the worker's claim expires it.
CREATE OR REPLACE FUNCTION public.account_ai_summary_dispatch(p_max_running INTEGER DEFAULT 3)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_due     INTEGER;
  v_running INTEGER;
  v_stale   INTEGER;
  v_n       INTEGER;
BEGIN
  SELECT
    count(*) FILTER (WHERE status = 'queued' AND next_attempt_at <= now()),
    count(*) FILTER (WHERE status = 'running' AND trigger = 'nightly'
                       AND COALESCE(started_at, created_at) >= now() - interval '7 minutes'),
    count(*) FILTER (WHERE status = 'running'
                       AND COALESCE(started_at, created_at) < now() - interval '7 minutes')
  INTO v_due, v_running, v_stale
  FROM public.account_ai_summaries
  WHERE status IN ('queued', 'running');
  IF v_due = 0 AND v_stale = 0 THEN
    RETURN 0;
  END IF;
  v_n := LEAST(GREATEST(v_due, 1), p_max_running - v_running);
  FOR i IN 1..v_n LOOP
    IF NOT public.account_ai_summary_post('work') THEN
      RETURN i - 1;
    END IF;
  END LOOP;
  RETURN GREATEST(v_n, 0);
END
$$;
REVOKE ALL ON FUNCTION public.account_ai_summary_post(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_ai_summary_nightly_tick() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_ai_summary_dispatch(INTEGER) FROM PUBLIC, anon, authenticated;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Local/shadow databases have no pg_cron; skipping keeps `db reset` working.
    RAISE NOTICE 'pg_cron not installed - skipping the account summary schedules';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'account-summary-nightly',
    '0 5,6 * * *',
    $job$ SELECT public.account_ai_summary_nightly_tick(); $job$
  );

  PERFORM cron.schedule(
    'account-summary-worker-1m',
    '* * * * *',
    $job$ SELECT public.account_ai_summary_dispatch(); $job$
  );
END
$do$;
