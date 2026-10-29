-- The Claude connector: who may use it, and the login it reads the database with.
--
-- The `mcp` edge function is a remote MCP server. Someone adds it to Claude as
-- a custom connector, signs in through Supabase Auth's OAuth server (the Zoho
-- sign-in, then the consent page at /oauth/consent), and Claude can then run
-- read-only SQL against the public schema. Two things here make that safe.
--
-- 1. allowed_users.can_use_claude, off for everyone. The OAuth server issues a
--    token to any listed user who completes the sign-in; the function answers
--    only a user whose row carries this flag, and the consent page refuses the
--    others before a token exists. Turning it on or off is one UPDATE.
--
-- 2. mcp_reader, the login the function connects with. It is deliberately not
--    a member of `authenticated`: that role can also read Supabase's own
--    schemas (net.http_request_queue carries the headers of pg_net calls, keys
--    included), and arbitrary SQL run as it could SET ROLE to whatever the
--    session user may become. mcp_reader is a member of nothing, so the only
--    rights it ever has are the ones below:
--
--      * SELECT on every table, view and materialized view of `public`, and on
--        the ones created later, except zoho_oauth_token (Zoho credentials,
--        which `authenticated` cannot read either). A new table that holds a
--        credential needs the same REVOKE.
--      * EXECUTE on the functions of `public`, so the dashboard's own RPCs
--        answer the figures the screens show.
--      * BYPASSRLS: the policies are written for `authenticated` and would
--        show it nothing. The function admits only users with the flag, and
--        what they get is the whole schema, read-only.
--
--    No INSERT, UPDATE, DELETE or TRUNCATE anywhere. On top of that the
--    function runs every query in a READ ONLY transaction, one statement at a
--    time, so a SECURITY DEFINER function that writes fails too.
--
-- The role has no password here, so it cannot log in yet. The password is set
-- once by hand and stored as the function's MCP_DB_URL secret; it never goes
-- into the repository.

-- ─── 1. Who may use the connector ────────────────────────────────────────────

ALTER TABLE public.allowed_users
  ADD COLUMN IF NOT EXISTS can_use_claude BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.allowed_users.can_use_claude IS
  'May use the Claude connector (mcp edge function). Off by default.';

-- ─── 2. The read-only login ──────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
    CREATE ROLE mcp_reader LOGIN BYPASSRLS;
  END IF;
END $$;

-- Defaults for any session opened with this login. The function sets the same
-- per transaction; these cover a session opened some other way.
ALTER ROLE mcp_reader SET default_transaction_read_only = on;
ALTER ROLE mcp_reader SET statement_timeout = '20s';
ALTER ROLE mcp_reader SET idle_in_transaction_session_timeout = '30s';

-- USAGE on schema public comes from PUBLIC, as for every role; postgres holds
-- no grant option on that schema (its owner is pg_database_owner).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
REVOKE ALL ON public.zoho_oauth_token FROM mcp_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO mcp_reader;

-- The functions a signed-in user of the app may call, and no others: the
-- internal ones (the AI summary queue, the Books customer queue, the label
-- refresh) are revoked from `authenticated` and stay out of reach. Only those
-- postgres owns: the rest of `public` belongs to the pg_trgm extension, on
-- which postgres holds no grant option. New functions get EXECUTE by default,
-- as they do for `authenticated`; an internal one should be revoked from
-- mcp_reader too, though inside a READ ONLY transaction it cannot write.
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proowner = 'postgres'::regrole
       AND p.prokind = 'f'
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO mcp_reader', f);
  END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO mcp_reader;
