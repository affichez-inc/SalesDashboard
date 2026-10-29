// The database side of the connector: one login, mcp_reader, which can read
// `public` and write nothing (migration 20261030120000_claude_connector.sql).
//
// MCP_DB_URL is that login through the shared pooler in transaction mode:
//   postgresql://mcp_reader.<project-ref>:<password>@aws-1-us-east-1.pooler.supabase.com:6543/postgres
// Transaction mode has no prepared statements, hence `prepare: false`.

import postgres from 'npm:postgres@3.4.9';

const sql = postgres(Deno.env.get('MCP_DB_URL')!, {
  prepare: false,
  max: 3,
  idle_timeout: 20,
  connect_timeout: 10,
});

export type Access = 'ok' | 'not_enabled' | 'has_password' | 'unknown';

/**
 * Whether the token's user may use the connector: listed with the flag on, and
 * an account without a password (mcp_claude_access, migration
 * 20261030140000_claude_connector_token_lock.sql).
 */
export async function claudeAccess(userId: string): Promise<Access> {
  const [row] = await sql<{ verdict: Access }[]>`
    SELECT public.mcp_claude_access(${userId}::uuid) AS verdict`;
  return row.verdict;
}

export interface QueryResult {
  columns: string[];
  /** Each value exactly as Postgres prints it, NULL as null. */
  rows: (string | null)[][];
  /** More rows exist than were returned. */
  truncated: boolean;
}

const decoder = new TextDecoder();

// unsafe() reads `simple` (src/index.js) but the package's typings omit it.
const ONE_STATEMENT = { simple: false } as postgres.UnsafeQueryOptions;

/**
 * Runs one statement written by Claude, read-only, and returns at most
 * `maxRows` rows.
 *
 * Four things keep it read-only, and each would hold without the others:
 *   - mcp_reader has no write privilege on anything;
 *   - the transaction is READ ONLY, and its first statement takes the snapshot
 *     after which Postgres refuses to switch it back to read-write;
 *   - `simple: false` sends the text through the extended protocol, which
 *     accepts exactly one statement, so "...; COMMIT; DELETE ..." is an error
 *     rather than three statements (postgres.js uses the simple protocol, which
 *     runs several, for a query with no parameters unless told otherwise);
 *   - the text is the FROM item of a SELECT, so only a query fits there: SET,
 *     COMMIT, DO or a data-modifying WITH are syntax errors.
 *
 * Rows come back raw, as the text Postgres prints, so a date stays a date and
 * a numeric keeps every digit, instead of going through JavaScript types.
 *
 * One thing a read-only query can still leave behind is a session-level
 * advisory lock (pg_advisory_lock is open to every role), and on a pooled
 * connection it would outlive the request: account_ai_summary_claim() takes an
 * advisory lock and would wait on it. So the query runs in a savepoint and the
 * locks are released on the same connection afterwards, failed query or not.
 */
export async function runQuery(text: string, maxRows: number): Promise<QueryResult> {
  const wrapped = `SELECT * FROM (\n${withoutTrailingSemicolons(text)}\n) AS q LIMIT ${maxRows + 1}`;

  return await sql.begin('read only', async (tx) => {
    await tx`
      SELECT set_config('statement_timeout', '20s', true),
             set_config('TimeZone', 'America/Toronto', true),
             set_config('search_path', 'public', true)`;
    try {
      const result = await tx.savepoint((sp) => sp.unsafe(wrapped, [], ONE_STATEMENT).raw());
      const rows = (result as unknown as (Uint8Array | null)[][]).map(
        (row) => row.map((v) => (v === null ? null : decoder.decode(v))),
      );
      return {
        columns: result.columns.map((c) => c.name),
        rows: rows.slice(0, maxRows),
        truncated: rows.length > maxRows,
      };
    } finally {
      // Never masks the query's own error: a connection that cannot run this
      // is gone, and its locks with it.
      await tx`SELECT pg_advisory_unlock_all()`.catch(() => {});
    }
  });
}

/**
 * The query cut just after its last token, so that a closing ";" (and any
 * comment or blank after it) does not end up inside the parentheses of
 * runQuery's wrapper. Quoted text, quoted names, dollar quotes and comments are
 * skipped whole, so a ";" or "--" inside them is left alone. A semicolon between
 * two statements is kept, and the server refuses the second statement.
 */
function withoutTrailingSemicolons(text: string): string {
  let end = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
    } else if (c === '/' && text[i + 1] === '*') {
      // Block comments nest in Postgres.
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2; }
        else if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
    } else if (c === "'" || c === '"') {
      // '' or "" inside is an escaped quote; E'...' also escapes with a
      // backslash (an E standing alone, not the end of a word like LIKE).
      const backslash = c === "'" && /[eE]/.test(text[i - 1] ?? '') && !/[\w$]/.test(text[i - 2] ?? '');
      i++;
      while (i < text.length) {
        if (backslash && text[i] === '\\') i += 2;
        else if (text[i] === c && text[i + 1] === c) i += 2;
        else if (text[i] === c) { i++; break; }
        else i++;
      }
      end = i;
    } else if (c === '$' && !/[\w$]/.test(text[i - 1] ?? '') && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(text.slice(i))) {
      // A dollar quote; "a$b$" is an identifier, hence the check on the character before.
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))![0];
      const close = text.indexOf(tag, i + tag.length);
      i = close === -1 ? text.length : close + tag.length;
      end = i;
    } else {
      i++;
      if (c !== ';' && !/\s/.test(c)) end = i;
    }
  }
  return text.slice(0, end);
}

/**
 * The live schema: every table, view and function mcp_reader can use, so the
 * list never drifts from the database. Comments are included where they exist.
 */
export async function describeSchema(): Promise<string> {
  const relations = await sql<{ name: string; kind: string; est_rows: string | null; comment: string | null; columns: string }[]>`
    SELECT c.relname AS name,
           CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind,
           CASE WHEN c.relkind IN ('r', 'p', 'm') AND c.reltuples >= 0 THEN c.reltuples::bigint::text END AS est_rows,
           obj_description(c.oid, 'pg_class') AS comment,
           string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum) AS columns
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p', 'v', 'm')
       AND has_table_privilege(c.oid, 'SELECT')
     GROUP BY c.oid
     ORDER BY c.relname`;

  const enums = await sql<{ name: string; labels: string }[]>`
    SELECT t.typname AS name, string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typnamespace = 'public'::regnamespace
     GROUP BY t.typname
     ORDER BY t.typname`;

  const functions = await sql<{ name: string; args: string; result: string; comment: string | null }[]>`
    SELECT p.proname AS name,
           pg_get_function_arguments(p.oid) AS args,
           pg_get_function_result(p.oid) AS result,
           obj_description(p.oid, 'pg_proc') AS comment
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prokind = 'f'
       AND p.proname LIKE 'get\\_%'
       AND p.proname NOT LIKE 'get\\_leads\\_%'
       AND has_function_privilege(p.oid, 'EXECUTE')
     ORDER BY p.proname`;

  const lines: string[] = ['## Tables and views (schema public)'];
  for (const r of relations) {
    const size = r.est_rows === null ? '' : `, about ${r.est_rows} rows`;
    lines.push(`- ${r.name} (${r.kind}${size}): ${r.columns}`);
    if (r.comment) lines.push(`  ${r.comment}`);
  }
  lines.push('', '## Enum types');
  for (const e of enums) lines.push(`- ${e.name}: ${e.labels}`);
  lines.push('', '## Functions (SELECT * FROM name(arg => value, ...))');
  for (const f of functions) {
    lines.push(`- ${f.name}(${f.args}) → ${f.result}`);
    if (f.comment) lines.push(`  ${f.comment}`);
  }
  return lines.join('\n');
}
