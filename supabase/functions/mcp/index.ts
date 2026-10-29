// supabase/functions/mcp/index.ts
// Remote MCP server: Claude, added as a custom connector, reads the database
// read-only on behalf of a user whose allowed_users row has can_use_claude.
//
// Sign-in is Supabase Auth's OAuth 2.1 server. A request without a valid token
// gets a 401 pointing at this resource's metadata, which names the project's
// Auth as the authorization server; Claude then sends the user to
// /auth/v1/oauth/authorize, Auth sends them to the app's consent page
// (/oauth/consent, which signs them in with Zoho first if needed), and Claude
// receives a token for the "Claude" OAuth client registered in the dashboard.
//
// A token is accepted only if it was issued to that client
// (MCP_OAUTH_CLIENT_ID): an app session token, or one issued to another
// client, is refused. Then its user must be listed with the flag on and have
// no password, checked on every request, so turning the flag off takes effect
// at once. The reverse holds too: app_session_trusted() refuses a token that
// carries a client_id, so this token opens nothing in the app.
//
// verify_jwt is off for this function (config.toml): the gateway's own 401
// carries no WWW-Authenticate header, and without it Claude cannot discover
// where to sign in.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { createMcpHandler, McpServer } from 'npm:@modelcontextprotocol/server@2.3.1';
import { z } from 'npm:zod@4.6.0';
import { type Access, claudeAccess, describeSchema, runQuery } from './db.ts';
import { GUIDE, INSTRUCTIONS } from './guide.ts';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!;
const OAUTH_CLIENT_ID = Deno.env.get('MCP_OAUTH_CLIENT_ID')!;

const ISSUER       = `${SUPABASE_URL}/auth/v1`;
/** The URL entered in Claude. Must match it exactly. */
const RESOURCE     = `${SUPABASE_URL}/functions/v1/mcp`;
const METADATA_URL = `${RESOURCE}/.well-known/oauth-protected-resource`;
/** Supabase Auth's default scope; nothing here depends on scopes. */
const SCOPE        = 'email';

/** Room for a few hundred rows; past it Claude is told to aggregate instead. */
const MAX_RESULT_CHARS = 100_000;

const auth = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
}).auth;

/** RFC 9728 protected resource metadata. */
function resourceMetadata(): Response {
  return Response.json({
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Affichez Ventes',
  });
}

/** 401 with the challenge that tells Claude where to sign in (RFC 6750, RFC 9728). */
function challenge(error?: 'invalid_token', description?: string): Response {
  let header = `Bearer resource_metadata="${METADATA_URL}", scope="${SCOPE}"`;
  if (error) header += `, error="${error}", error_description="${description}"`;
  return Response.json(
    { error: error ?? 'unauthorized', error_description: description ?? 'Sign-in required.' },
    { status: 401, headers: { 'WWW-Authenticate': header } },
  );
}

function forbidden(message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', id: null, error: { code: -32001, message } },
    { status: 403 },
  );
}

/** The caller's address, or the response that refuses them. */
async function authenticate(req: Request): Promise<string | Response> {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') ?? '');
  if (!match) return challenge();

  // Signature against the project's published keys, and expiry. getClaims
  // throws, rather than returning an error, on a token it cannot even decode.
  let claims: Record<string, unknown>;
  try {
    const { data, error } = await auth.getClaims(match[1]);
    if (error || !data) return challenge('invalid_token', 'The access token is invalid or expired.');
    claims = data.claims as Record<string, unknown>;
  } catch {
    return challenge('invalid_token', 'The access token is invalid or expired.');
  }

  const aud = claims.aud;
  const audOk = aud === 'authenticated' || (Array.isArray(aud) && aud.includes('authenticated'));
  if (claims.iss !== ISSUER || !audOk || claims.role !== 'authenticated') {
    return challenge('invalid_token', 'The access token was not issued by this project.');
  }
  if (claims.client_id !== OAUTH_CLIENT_ID) {
    return challenge('invalid_token', 'The access token was not issued to this connector.');
  }
  const userId = typeof claims.sub === 'string' ? claims.sub : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return challenge('invalid_token', 'The access token names no user.');
  }
  const email = typeof claims.email === 'string' ? claims.email : userId;

  // A connector token's amr is always the OAuth code exchange, whatever session
  // gave the consent, so it cannot tell a Zoho sign-in from a password one. The
  // account having no password can: see mcp_claude_access().
  let access: Access;
  try {
    access = await claudeAccess(userId);
  } catch (err) {
    console.error('mcp: access lookup failed:', err);
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Database unavailable, try again.' } },
      { status: 503 },
    );
  }
  if (access === 'unknown') return challenge('invalid_token', 'The user of this token no longer exists.');
  if (access === 'not_enabled') {
    return forbidden(`Claude n'est pas activé pour ${email}. Demandez à un administrateur.`);
  }
  if (access === 'has_password') {
    return forbidden(
      `Le compte ${email} a un mot de passe Supabase. Claude n'est permis qu'aux comptes sans mot de passe, ` +
      'qui ne s’ouvrent que par la connexion Zoho. Demandez à un administrateur.',
    );
  }
  return email;
}

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function buildServer(email: string): McpServer {
  const server = new McpServer(
    { name: 'affichez-ventes', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'describe_database',
    {
      title: 'Décrire la base de données',
      description:
        'Explains what each table really contains (several do not hold what their name suggests), ' +
        'then lists every table and view with its columns, the enum values and the dashboard functions. ' +
        'Call it before the first query of a conversation.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text(`${GUIDE}\n${await describeSchema()}`),
  );

  server.registerTool(
    'query',
    {
      title: 'Interroger la base de données',
      description:
        'Runs one read-only SQL query (PostgreSQL 17) against the Affichez sales database and returns ' +
        'the rows as JSON, each value as Postgres prints it. One SELECT or WITH ... SELECT per call; ' +
        'the session time zone is America/Toronto. Read describe_database first: a sales figure from ' +
        "`sales` must keep status IN ('accepted','invoiced'), and dashboard figures are best taken " +
        'from the dashboard functions it lists.',
      inputSchema: z.object({
        sql: z.string().min(1).max(20_000).describe('One PostgreSQL SELECT statement.'),
        max_rows: z.number().int().min(1).max(2_000).default(200)
          .describe('Rows to return at most (default 200). Aggregate in SQL rather than raising it.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sql, max_rows }) => {
      const started = Date.now();
      try {
        const result = await runQuery(sql, max_rows);
        let shown = result.rows.length;
        let out = JSON.stringify({ ...result, row_count: shown });
        while (out.length > MAX_RESULT_CHARS && shown > 0) {
          shown = Math.floor(shown / 2);
          out = JSON.stringify({ ...result, rows: result.rows.slice(0, shown), row_count: shown, truncated: true });
        }
        console.log(JSON.stringify({ email, ms: Date.now() - started, rows: shown, truncated: shown < result.rows.length || result.truncated, sql: sql.slice(0, 500) }));
        if (shown < result.rows.length || result.truncated) {
          out += '\nThe result was cut short. Aggregate in SQL, select fewer columns, or add a LIMIT.';
        }
        return text(out);
      } catch (err) {
        const e = err as { message?: string; hint?: string; detail?: string };
        console.log(JSON.stringify({ email, ms: Date.now() - started, error: e.message, sql: sql.slice(0, 500) }));
        const parts = [`Query failed: ${e.message ?? String(err)}`];
        if (e.detail) parts.push(`Detail: ${e.detail}`);
        if (e.hint) parts.push(`Hint: ${e.hint}`);
        return { ...text(parts.join('\n')), isError: true };
      }
    },
  );

  return server;
}

Deno.serve(async (req: Request) => {
  if (new URL(req.url).pathname.endsWith('/.well-known/oauth-protected-resource')) {
    return resourceMetadata();
  }

  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;

  // A fresh server per request: the function keeps no session between calls.
  return createMcpHandler(() => buildServer(caller)).fetch(req);
});
