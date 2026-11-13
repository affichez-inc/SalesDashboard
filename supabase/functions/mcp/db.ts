// The database side of the connector. Two logins, neither of which can write
// anything:
//   mcp_reader  reads all of `public` (BYPASSRLS), for a user whose
//               allowed_users.claude_sections is NULL
//               (20261030120000_claude_connector.sql);
//   mcp_scoped  is subject to RLS, for a user limited to some sections: the
//               app's own policies decide what it reads, as that user
//               (20261113150000_claude_connector_modules.sql).
//
// MCP_DB_URL and MCP_SCOPED_DB_URL are those logins through the shared pooler
// in transaction mode:
//   postgresql://mcp_reader.<project-ref>:<password>@aws-1-us-east-1.pooler.supabase.com:6543/postgres
// Transaction mode has no prepared statements, hence `prepare: false`.

import postgres from 'npm:postgres@3.4.9';

const OPTIONS = { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10 };

const sql = postgres(Deno.env.get('MCP_DB_URL')!, OPTIONS);

const SCOPED_URL = Deno.env.get('MCP_SCOPED_DB_URL');
const scopedSql = SCOPED_URL ? postgres(SCOPED_URL, OPTIONS) : null;

/** Whether the mcp_scoped login is configured; without it only all-data users are served. */
export const scopedAvailable = scopedSql !== null;

export type Verdict = 'ok' | 'not_enabled' | 'has_password' | 'unknown';

export interface Grant {
  verdict: Verdict;
  /** null: all data. Otherwise the sections open to this user's Claude, possibly none. */
  sections: string[] | null;
}

/**
 * Whether the token's user may use the connector (listed with the flag on, and
 * an account without a password), and what it reads (mcp_claude_grant).
 */
export async function claudeGrant(userId: string): Promise<Grant> {
  const [row] = await sql<Grant[]>`
    SELECT verdict, sections FROM public.mcp_claude_grant(${userId}::uuid)`;
  return row;
}

/** Who a request reads as. */
export type Caller =
  | { email: string; scope: 'all' }
  | { email: string; scope: 'sections'; userId: string; sections: string[] };

/** The caller as the database sees them, once bound (mcp_scoped_bind). */
export interface Bound {
  email: string;
  rep_name: string | null;
  sections: string[];
}

/** Carries a result out of a transaction that must roll back. */
class Rollback<T> {
  constructor(readonly value: T) {}
}

/**
 * Runs `fn` on mcp_scoped in a transaction bound to the caller, then rolls it
 * back. The binding row is the first write and the last: the transaction is
 * read-only from the next statement on, and nothing of it is kept.
 */
async function asCaller<T>(userId: string, fn: (tx: postgres.TransactionSql, who: Bound) => Promise<T>): Promise<T> {
  if (!scopedSql) throw new Error('MCP_SCOPED_DB_URL is not set');
  try {
    await scopedSql.begin('read write', async (tx) => {
      const [who] = await tx<Bound[]>`
        SELECT email, rep_name, sections FROM public.mcp_scoped_bind(${userId}::uuid)`;
      if (!who || who.sections.length === 0) {
        throw new Error('This user has no section open to Claude any more.');
      }
      await tx`SET TRANSACTION READ ONLY`;
      throw new Rollback(await fn(tx, who));
    });
  } catch (err) {
    if (err instanceof Rollback) return err.value as T;
    throw err;
  }
  throw new Error('The transaction ended without a result.');
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
 *   - neither login has a write privilege on anything (mcp_scoped's one write
 *     is its own binding, through mcp_scoped_bind, before the transaction
 *     turns read-only);
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
 *
 * A caller limited to sections runs on mcp_scoped, in a transaction bound to
 * them (asCaller): the same four locks, with RLS deciding which rows exist.
 */
export async function runQuery(caller: Caller, text: string, maxRows: number): Promise<QueryResult> {
  if (caller.scope === 'sections') {
    return await asCaller(caller.userId, (tx) => queryIn(tx, text, maxRows));
  }
  return await sql.begin('read only', (tx) => queryIn(tx, text, maxRows));
}

async function queryIn(tx: postgres.TransactionSql, text: string, maxRows: number): Promise<QueryResult> {
  const wrapped = `SELECT * FROM (\n${withoutTrailingSemicolons(text)}\n) AS q LIMIT ${maxRows + 1}`;

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
 * The live schema: every table, view and function the caller can use, so the
 * list never drifts from the database. Comments are included where they exist.
 *
 * For a caller limited to sections, a relation is listed only if it returns at
 * least one row to them, since a table outside their sections answers with no
 * rows rather than an error. Row estimates count the whole table and are left
 * out for them. `who` is how the database sees that caller.
 */
export async function describeSchema(caller: Caller): Promise<{ who: Bound | null; schema: string }> {
  if (caller.scope === 'sections') {
    return await asCaller(caller.userId, async (tx, who) => {
      const schema = await readSchema(tx);
      const visible = await visibleRelations(tx, schema.relations.map((r) => r.name));
      schema.relations = schema.relations
        .filter((r) => visible.has(r.name))
        .map((r) => ({ ...r, est_rows: null }));
      return { who, schema: formatSchema(schema) };
    });
  }
  return { who: null, schema: formatSchema(await sql.begin('read only', (tx) => readSchema(tx))) };
}

/** The relations among `names` that return a row to the session's user, in one statement. */
async function visibleRelations(tx: postgres.TransactionSql, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const probe = names
    .map((n) => `SELECT '${n.replaceAll("'", "''")}' AS name WHERE EXISTS (SELECT 1 FROM public."${n.replaceAll('"', '""')}")`)
    .join('\nUNION ALL\n');
  const rows = await tx.unsafe<{ name: string }[]>(probe);
  return new Set(rows.map((r) => r.name));
}

interface Schema {
  relations: { name: string; kind: string; est_rows: string | null; comment: string | null; columns: string }[];
  enums: { name: string; labels: string }[];
  functions: { name: string; args: string; result: string; comment: string | null }[];
}

async function readSchema(sql: postgres.TransactionSql): Promise<Schema> {
  const relations = await sql<Schema['relations']>`
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

  const enums = await sql<Schema['enums']>`
    SELECT t.typname AS name, string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typnamespace = 'public'::regnamespace
     GROUP BY t.typname
     ORDER BY t.typname`;

  const functions = await sql<Schema['functions']>`
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

  return { relations, enums, functions };
}

function formatSchema({ relations, enums, functions }: Schema): string {
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
