-- Schedules for the pre-tax back-fill and the hourly comparison with Zoho.
--
--   zoho-pretax-sync-2m          reads Zoho's tax for every document still on an
--                                estimate (~35,700 at the start, 2026 first), then
--                                the quotes zoho-sync writes as they land. Each run
--                                stops at 110s, under both the 2-minute interval
--                                (so runs never overlap) and the 150s request cap;
--                                an idle run costs one queue read.
--
--   zoho-invoice-reconcile-*-1h  zoho-invoice-sync with x-reconcile: lists every
--                                document from January of last year, rewrites rows
--                                that disagree with Zoho and removes the ones Zoho
--                                deleted or voided. One job per office: measured
--                                2026-10-19 at 11s (MTL) and 45s (QC) on the first
--                                pass, which also had ~8,600 rows to rewrite.
--                                Offset to :23/:53 so they never land on the
--                                5-minute syncs or on each other.
--
-- Long runs survive pg_net's own HTTP timeout: during the quote-creator back-fill
-- 170 cron-started runs logged their result 60-130s after the tick. Same call
-- shape as every other sync schedule here.
--
-- cron.schedule upserts by job name, so re-running this re-points the jobs.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed - skipping pre-tax and reconcile schedules';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'zoho-pretax-sync-2m',
    '*/2 * * * *',
    $job$
      SELECT net.http_post(
        url     := 'https://auyfucbskylougsmmrks.supabase.co/functions/v1/zoho-pretax-sync',
        headers := '{"Content-Type":"application/json","x-sync-source":"cron"}'::jsonb
      );
    $job$
  );

  PERFORM cron.schedule(
    'zoho-invoice-reconcile-qc-1h',
    '23 * * * *',
    $job$
      SELECT net.http_post(
        url     := 'https://auyfucbskylougsmmrks.supabase.co/functions/v1/zoho-invoice-sync',
        headers := '{"Content-Type":"application/json","x-sync-source":"cron","x-reconcile":"true","x-org":"QC"}'::jsonb
      );
    $job$
  );

  PERFORM cron.schedule(
    'zoho-invoice-reconcile-mtl-1h',
    '53 * * * *',
    $job$
      SELECT net.http_post(
        url     := 'https://auyfucbskylougsmmrks.supabase.co/functions/v1/zoho-invoice-sync',
        headers := '{"Content-Type":"application/json","x-sync-source":"cron","x-reconcile":"true","x-org":"MTL"}'::jsonb
      );
    $job$
  );
END
$do$;
