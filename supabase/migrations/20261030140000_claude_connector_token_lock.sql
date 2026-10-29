-- The Claude connector, second half: what its OAuth token may open, and which
-- accounts it may come from.
--
-- 20261030120000 gave the connector its flag (allowed_users.can_use_claude) and
-- its database login (mcp_reader). That login is deliberately not a member of
-- `authenticated`, which can also read Supabase's own schemas
-- (net.http_request_queue carries the headers of pg_net calls, keys included),
-- and the SQL does not go through PostgREST, whose session user (authenticator)
-- may SET ROLE service_role. Two holes remained, both in how Supabase Auth's
-- OAuth server issues tokens.

-- ─── 1. A connector token opens the connector and nothing else ──────────────
-- An OAuth client's token is an ordinary user token plus a client_id claim the
-- app's own sessions never carry. Without this, the token Claude holds would
-- also open PostgREST as that user: read-write for an admin. And its amr is
-- always "oauth_provider/authorization_code", whatever session gave the
-- consent, so a password session could otherwise be turned into one that
-- passes this check. Same body otherwise, and still LANGUAGE sql without SET,
-- so it keeps being inlined into the policies.
CREATE OR REPLACE FUNCTION public.app_session_trusted()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT NOT (COALESCE(auth.jwt() -> 'amr', '[]'::jsonb) @> '[{"method": "password"}]'::jsonb)
     AND NOT (COALESCE(auth.jwt(), '{}'::jsonb) ? 'client_id');
$$;

-- ─── 2. Whether a token's user may use the connector ────────────────────────
-- The consent endpoint accepts any session, a password one included, and the
-- token does not say which. So the account itself must have no password: then
-- the only session it can have is the Zoho sign-in's one-time link. The flag is
-- read through the auth user, by id, so the address is the account's own and
-- not a claim. mcp_reader has no access to `auth`, hence SECURITY DEFINER; it
-- returns a verdict, never the row.
--   ok            listed, flag on, no password
--   not_enabled   no such listed address, or the flag is off
--   has_password  the account has a password; clear it (auth.users) first
--   unknown       no auth user with this id
CREATE OR REPLACE FUNCTION public.mcp_claude_access(p_user_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
           WHEN u.id IS NULL THEN 'unknown'
           WHEN NOT EXISTS (
             SELECT 1 FROM public.allowed_users a
              WHERE lower(a.email) = lower(u.email) AND a.can_use_claude
           ) THEN 'not_enabled'
           WHEN COALESCE(u.encrypted_password, '') <> '' THEN 'has_password'
           ELSE 'ok'
         END
    FROM (SELECT 1) AS one
    LEFT JOIN auth.users u ON u.id = p_user_id;
$$;

REVOKE ALL ON FUNCTION public.mcp_claude_access(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mcp_claude_access(UUID) TO mcp_reader;
