-- The Claude connector, limited to chosen modules.
--
-- Until now a user with can_use_claude read the whole schema through
-- mcp_reader, which has BYPASSRLS. That stays, as "all data", for whoever has
-- no list in the new column. A user with a list reads through a second login,
-- mcp_scoped, which is subject to RLS: the policies that lock the app's
-- sections lock Claude the same way, own rows of Mon Portail included, and so
-- do the SECURITY DEFINER functions that check app_require_section().
--
--   allowed_users.claude_sections   NULL       everything, through mcp_reader
--                                   a list     those sections only, and only the
--                                              ones the user can open in the app
--
-- The policies identify the caller by the email in request.jwt.claims. That
-- cannot work here: the connector runs SQL written by Claude, and a SELECT can
-- call set_config() and rewrite that setting in the middle of its own query.
-- So on mcp_scoped the caller is bound to the transaction instead:
-- mcp_scoped_bind() writes (transaction id, address) as the first statement,
-- the function then makes the transaction read-only and rolls it back at the
-- end. Claude's statement cannot write, cannot change its transaction id, and
-- cannot change session_user, which is what tells the helpers below that they
-- are serving the connector. The row never outlives the transaction.
--
-- mcp_scoped is a member of nothing, like mcp_reader, so set_config('role', ...)
-- cannot take it anywhere: it has no BYPASSRLS, no access to `auth`, and none
-- to net.http_request_queue.
--
-- Nothing changes for the app's sessions: every helper keeps its exact body in
-- the branch they take. Nothing changes for the users enabled today either:
-- their column is NULL, which is everything.

-- ─── 1. What each person's Claude may read ──────────────────────────────────

ALTER TABLE public.allowed_users
  ADD COLUMN IF NOT EXISTS claude_sections TEXT[];

ALTER TABLE public.allowed_users
  DROP CONSTRAINT IF EXISTS allowed_users_claude_sections_check;
ALTER TABLE public.allowed_users
  ADD CONSTRAINT allowed_users_claude_sections_check CHECK (
    claude_sections IS NULL
    OR (cardinality(claude_sections) > 0
        AND claude_sections <@ ARRAY['devis', 'factures', 'comptes', 'publicite', 'portail']::TEXT[]));

COMMENT ON COLUMN public.allowed_users.claude_sections IS
  'What the Claude connector reads for this user. NULL: all data. A list of sections: only those, and only the ones the user can also open in the app.';

-- The sections of the list the user can also open in the app (an admin opens
-- every section). Empty when the column is NULL: callers test that first.
CREATE OR REPLACE FUNCTION public.claude_open_sections(u public.allowed_users)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY(
    SELECT t.s
      FROM unnest(u.claude_sections) WITH ORDINALITY AS t(s, n)
     WHERE u.role = 'admin'
        OR CASE t.s
             WHEN 'devis'     THEN u.can_access_devis
             WHEN 'factures'  THEN u.can_access_factures
             WHEN 'comptes'   THEN u.can_access_comptes
             WHEN 'publicite' THEN u.can_access_publicite
             WHEN 'portail'   THEN u.can_access_portail
             ELSE false
           END
     ORDER BY t.n);
$$;

-- ─── 2. The login ────────────────────────────────────────────────────────────
-- No password here, as for mcp_reader: it is set once by hand and stored as
-- the function's MCP_SCOPED_DB_URL secret.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_scoped') THEN
    CREATE ROLE mcp_scoped LOGIN;
  END IF;
END $$;

ALTER ROLE mcp_scoped SET default_transaction_read_only = on;
ALTER ROLE mcp_scoped SET statement_timeout = '20s';
ALTER ROLE mcp_scoped SET idle_in_transaction_session_timeout = '30s';

-- ─── 3. Who a transaction on that login reads for ───────────────────────────

CREATE TABLE IF NOT EXISTS public.mcp_scoped_caller (
  xid   XID8 PRIMARY KEY DEFAULT pg_current_xact_id(),
  email TEXT NOT NULL
);

COMMENT ON TABLE public.mcp_scoped_caller IS
  'The user a transaction of the mcp_scoped login reads for. Written by mcp_scoped_bind() and rolled back with the transaction; normally empty.';

-- Read and written only by the SECURITY DEFINER functions below, as their
-- owner. No API role and neither connector login has any right on it.
ALTER TABLE public.mcp_scoped_caller ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mcp_scoped_caller FROM PUBLIC, anon, authenticated, service_role, mcp_reader;

-- The user a query on mcp_scoped reads for, with the sections their Claude
-- may open. No row in any other session, nor for a user whose flag is off or
-- who has no list.
CREATE OR REPLACE FUNCTION public.app_mcp_caller()
RETURNS TABLE (email TEXT, rep_name TEXT, sections TEXT[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.email, NULLIF(btrim(u.rep_name), ''), public.claude_open_sections(u)
    FROM public.mcp_scoped_caller c
    JOIN public.allowed_users u ON lower(u.email) = c.email
   WHERE session_user = 'mcp_scoped'
     AND c.xid = pg_catalog.pg_current_xact_id_if_assigned()
     AND u.can_use_claude
     AND u.claude_sections IS NOT NULL
   LIMIT 1;
$$;

-- First statement of every mcp_scoped transaction, from the function, with
-- the user of the verified token. The key is the transaction, so a second call
-- in it is a unique violation; and once the function has made the transaction
-- read-only, nothing can be written at all.
CREATE OR REPLACE FUNCTION public.mcp_scoped_bind(p_user_id UUID)
RETURNS TABLE (email TEXT, rep_name TEXT, sections TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_email TEXT;
BEGIN
  IF session_user <> 'mcp_scoped' THEN
    RAISE EXCEPTION 'only the mcp_scoped login binds a caller'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = p_user_id;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'no user %', p_user_id USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.mcp_scoped_caller (email) VALUES (v_email);

  RETURN QUERY SELECT c.email, c.rep_name, c.sections FROM public.app_mcp_caller() c;
END;
$$;

-- ─── 4. Whether a token's user may use the connector, and how ───────────────
-- The verdicts of mcp_claude_access() (20261030140000), plus what to read:
-- sections NULL for all data, else the sections that are open (possibly none).
CREATE OR REPLACE FUNCTION public.mcp_claude_grant(p_user_id UUID, OUT verdict TEXT, OUT sections TEXT[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
           WHEN u.id IS NULL THEN 'unknown'
           WHEN a.email IS NULL THEN 'not_enabled'
           WHEN COALESCE(u.encrypted_password, '') <> '' THEN 'has_password'
           ELSE 'ok'
         END,
         CASE WHEN a.claude_sections IS NOT NULL THEN a.open END
    FROM (SELECT 1) AS one
    LEFT JOIN auth.users u ON u.id = p_user_id
    LEFT JOIN LATERAL (
      SELECT x.email, x.claude_sections, public.claude_open_sections(x) AS open
        FROM public.allowed_users x
       WHERE lower(x.email) = lower(u.email)
         AND x.can_use_claude
       LIMIT 1
    ) a ON true;
$$;

-- The function deployed before this migration asks mcp_claude_access() and
-- reads everything through mcp_reader on 'ok'. Until the new build replaces
-- it, a user limited to modules must get a refusal from it, never 'ok'.
CREATE OR REPLACE FUNCTION public.mcp_claude_access(p_user_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN g.verdict = 'ok' AND g.sections IS NOT NULL THEN 'not_enabled' ELSE g.verdict END
    FROM public.mcp_claude_grant(p_user_id) g;
$$;

-- ─── 5. The helpers answer for the connector's caller on mcp_scoped ─────────
-- Each keeps its body unchanged in the ELSE branch, which every app session
-- takes. On mcp_scoped the caller is never an admin, holds only the sections
-- of app_mcp_caller(), and has own rows (Mon Portail, own pay) only when
-- Mon Portail is one of them.

CREATE OR REPLACE FUNCTION public.app_is_listed()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN session_user = 'mcp_scoped' THEN
      COALESCE((SELECT cardinality(c.sections) > 0 FROM public.app_mcp_caller() c), false)
    ELSE
      public.app_session_trusted() AND EXISTS (
        SELECT 1 FROM public.allowed_users u
         WHERE lower(u.email) = lower(auth.jwt() ->> 'email'))
  END;
$$;

CREATE OR REPLACE FUNCTION public.app_is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN session_user = 'mcp_scoped' THEN false
    ELSE
      public.app_session_trusted() AND EXISTS (
        SELECT 1 FROM public.allowed_users u
         WHERE lower(u.email) = lower(auth.jwt() ->> 'email')
           AND u.role = 'admin')
  END;
$$;

CREATE OR REPLACE FUNCTION public.app_can_access(p_section TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN session_user = 'mcp_scoped' THEN
      COALESCE((SELECT p_section = ANY(c.sections) FROM public.app_mcp_caller() c), false)
    ELSE
      public.app_session_trusted() AND EXISTS (
        SELECT 1 FROM public.allowed_users u
         WHERE lower(u.email) = lower(auth.jwt() ->> 'email')
           AND (u.role = 'admin'
                OR CASE p_section
                     WHEN 'devis'     THEN u.can_access_devis
                     WHEN 'factures'  THEN u.can_access_factures
                     WHEN 'comptes'   THEN u.can_access_comptes
                     WHEN 'publicite' THEN u.can_access_publicite
                     WHEN 'portail'   THEN u.can_access_portail
                     ELSE false
                   END))
  END;
$$;

CREATE OR REPLACE FUNCTION public.app_can_access_any(VARIADIC p_sections TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN session_user = 'mcp_scoped' THEN
      COALESCE((SELECT c.sections && p_sections FROM public.app_mcp_caller() c), false)
    ELSE
      public.app_session_trusted() AND EXISTS (
        SELECT 1 FROM public.allowed_users u
         WHERE lower(u.email) = lower(auth.jwt() ->> 'email')
           AND (u.role = 'admin'
                OR (u.can_access_devis     AND 'devis'     = ANY(p_sections))
                OR (u.can_access_factures  AND 'factures'  = ANY(p_sections))
                OR (u.can_access_comptes   AND 'comptes'   = ANY(p_sections))
                OR (u.can_access_publicite AND 'publicite' = ANY(p_sections))
                OR (u.can_access_portail   AND 'portail'   = ANY(p_sections))))
  END;
$$;

CREATE OR REPLACE FUNCTION public.app_portal_rep()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN session_user = 'mcp_scoped' THEN
      (SELECT c.rep_name FROM public.app_mcp_caller() c WHERE 'portail' = ANY(c.sections))
    ELSE
      (SELECT NULLIF(btrim(u.rep_name), '')
         FROM public.allowed_users u
        WHERE public.app_session_trusted()
          AND lower(u.email) = lower(auth.jwt() ->> 'email')
          AND (u.role = 'admin' OR u.can_access_portail)
        LIMIT 1)
  END;
$$;

-- Own pay (paye_entries, paye_meta, rep_comm_rates). In the app any listed
-- user reads their own; through Claude, only with Mon Portail, where Ma Paye is.
CREATE OR REPLACE FUNCTION public.app_rep_name()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN session_user = 'mcp_scoped' THEN
      (SELECT c.rep_name FROM public.app_mcp_caller() c WHERE 'portail' = ANY(c.sections))
    ELSE
      (SELECT au.rep_name
         FROM public.allowed_users au
        WHERE lower(au.email) = lower(auth.jwt() ->> 'email')
        LIMIT 1)
  END;
$$;

-- The guard of the SECURITY DEFINER RPCs let any caller without an API role
-- through (a sync, the SQL editor, mcp_reader). mcp_scoped carries no API role
-- either, and is checked like one.
CREATE OR REPLACE FUNCTION public.app_require_section(p_section TEXT)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF session_user = 'mcp_scoped' THEN
    IF NOT public.app_can_access(p_section) THEN
      RAISE EXCEPTION 'section "%" is not open to this user', p_section
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF COALESCE(auth.jwt() ->> 'role', '') IN ('anon', 'authenticated')
     AND NOT public.app_can_access(p_section) THEN
    RAISE EXCEPTION 'section "%" is not open to this user', p_section
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- Reads the address in request.jwt.claims, which a statement on mcp_scoped can
-- rewrite. Nothing in the app calls it; the roles that hold an explicit grant
-- keep it, PUBLIC (and so mcp_scoped) loses it.
REVOKE EXECUTE ON FUNCTION public.get_my_permissions() FROM PUBLIC;

-- ─── 6. Rights of mcp_scoped ─────────────────────────────────────────────────

GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_scoped;
-- allowed_users: the helpers read it as their owner; its own policies read the
-- address from request.jwt.claims and are not extended to mcp_scoped.
REVOKE ALL ON public.zoho_oauth_token, public.allowed_users, public.mcp_scoped_caller FROM mcp_scoped;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO mcp_scoped;

-- The functions a signed-in user of the app may call, as for mcp_reader:
-- the policies call the app_* helpers, which are not open to PUBLIC. There is
-- no default grant on new functions: one revoked from PUBLIC stays out of reach
-- until a migration grants it to mcp_scoped, as a new table's rows do until
-- its policies name mcp_scoped.
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
       AND p.oid <> 'public.get_my_permissions()'::regprocedure
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO mcp_scoped', f);
  END LOOP;
END $$;

-- The connector's own functions: each for its login only. claude_open_sections
-- and app_mcp_caller are called by the definer functions, as their owner.
REVOKE ALL ON FUNCTION public.claude_open_sections(public.allowed_users) FROM PUBLIC, anon, authenticated, service_role, mcp_reader, mcp_scoped;
REVOKE ALL ON FUNCTION public.app_mcp_caller()          FROM PUBLIC, anon, authenticated, service_role, mcp_reader, mcp_scoped;
REVOKE ALL ON FUNCTION public.mcp_scoped_bind(UUID)     FROM PUBLIC, anon, authenticated, service_role, mcp_reader;
REVOKE ALL ON FUNCTION public.mcp_claude_grant(UUID)    FROM PUBLIC, anon, authenticated, service_role, mcp_scoped;
GRANT EXECUTE ON FUNCTION public.mcp_scoped_bind(UUID)  TO mcp_scoped;
GRANT EXECUTE ON FUNCTION public.mcp_claude_grant(UUID) TO mcp_reader;

-- ─── 7. The policies apply to mcp_scoped ─────────────────────────────────────
-- Every read policy written for `authenticated`, restrictive ones included
-- (listed_users_only), now names mcp_scoped too. Their expressions call the
-- helpers above, so on mcp_scoped they test the connector's caller. Write-only
-- policies are left alone: mcp_scoped holds no write privilege. allowed_users
-- is left out (section 6).
--
-- A policy created later for `authenticated` alone shows mcp_scoped nothing.

DO $$
DECLARE
  p RECORD;
BEGIN
  FOR p IN
    SELECT tablename, policyname, roles
      FROM pg_policies
     WHERE schemaname = 'public'
       AND cmd IN ('SELECT', 'ALL')
       AND 'authenticated' = ANY(roles)
       AND NOT 'mcp_scoped' = ANY(roles)
       AND tablename <> 'allowed_users'
  LOOP
    EXECUTE format('ALTER POLICY %I ON public.%I TO %s',
      p.policyname, p.tablename,
      (SELECT string_agg(quote_ident(r), ', ') FROM unnest(p.roles || 'mcp_scoped'::name) AS r));
  END LOOP;
END $$;
