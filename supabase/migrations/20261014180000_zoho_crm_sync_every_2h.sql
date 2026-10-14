-- Run the CRM account and lead/contact syncs every two hours instead of twelve.
--
-- The account summary (account-summary) reads the account and its contacts from
-- the mirror. A client opened in the CRM was missing from it until the next
-- twelve-hourly run, so its card failed ("Compte introuvable dans le miroir
-- Supabase"), and a new contact's emails were not read. Both syncs are
-- incremental on Modified Time, so a run with nothing new costs one page per
-- module.
--
-- The jobs are renamed with their interval, so the old names are unscheduled
-- first. The account sync stays half an hour off the lead sync so the two do not
-- refresh the shared CRM token at the same moment.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Local/shadow databases have no pg_cron; skipping keeps `db reset` working.
    RAISE NOTICE 'pg_cron not installed - skipping the CRM sync schedules';
    RETURN;
  END IF;

  PERFORM cron.unschedule(jobname)
  FROM cron.job
  WHERE jobname IN ('zoho-lead-sync-12h', 'zoho-account-sync-12h');

  PERFORM cron.schedule(
    'zoho-lead-sync-2h',
    '0 */2 * * *',    -- every even hour UTC, on the hour
    $job$
      SELECT net.http_post(
        url     := 'https://auyfucbskylougsmmrks.supabase.co/functions/v1/zoho-lead-sync',
        headers := '{"Content-Type":"application/json","x-sync-source":"cron"}'::jsonb
      );
    $job$
  );

  PERFORM cron.schedule(
    'zoho-account-sync-2h',
    '30 */2 * * *',   -- half an hour after the lead sync
    $job$
      SELECT net.http_post(
        url     := 'https://auyfucbskylougsmmrks.supabase.co/functions/v1/zoho-account-sync',
        headers := '{"Content-Type":"application/json","x-sync-source":"cron"}'::jsonb
      );
    $job$
  );
END
$do$;
