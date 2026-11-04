// supabase/functions/leadflow-feed/index.ts
// The LeadFlow Feed (docs/LEADFLOW-FEED.md): LeadFlow reads this app's quotes, invoices, credit notes and
// Books customers as its own canonical records, through LeadFlow's Feed contract v1. GET only, read only.
//
//   GET /v1/feed                                   what we serve
//   GET /v1/records?kind=&limit=&cursor=           every record of a kind, by id (the full pass)
//   GET /v1/records?kind=&modified_after=&...      the records changed at or after that instant, newest first
//   GET /v1/records?kind=&ids=a,b,c                some records by id (LeadFlow verifies a deletion this way)
//   GET /v1/ids?kind=&limit=&cursor=               every id of a kind, by id (LeadFlow's deletion sweep)
//
// Access: `Authorization: Bearer <LEADFLOW_FEED_KEY>`, compared in constant time; the key is a project secret
// that LeadFlow holds in its Vault. Without the secret the function answers 503 to everything. The reads use
// the service role with explicit columns (records.ts), so RLS is bypassed on purpose and nothing else is
// reachable: the mapping names the columns it reads and never writes.
//
// verify_jwt is off for this function (config.toml): the caller is LeadFlow's sync worker, not a user.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  decodeCursor, descriptor, encodeCursor, type FeedRecord, idList, type Kind, KINDS, MAPPERS, MAX_IDS, modifiedAfter, pageLimit, SOURCES,
} from './records.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FEED_KEY = Deno.env.get('LEADFLOW_FEED_KEY') ?? '';

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status: number, error: string, message: string) => json(status, { error, message });

/** The two keys hashed, then compared byte by byte without an early exit. */
async function sameKey(given: string, expected: string): Promise<boolean> {
  if (!given || !expected) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const isKind = (v: string | null): v is Kind => !!v && (KINDS as string[]).includes(v);

/** A PostgREST filter value quoted (a timestamp holds colons and a plus sign). */
const quoted = (v: string) => `"${v.replace(/"/g, '')}"`;

async function listRecords(kind: Kind, p: { limit: number; cursor: string | null; modifiedAfter: string | null; ids: string[] | null }): Promise<Response> {
  const src = SOURCES[kind];
  let q = db.from(src.table).select(src.columns);
  if (src.avoir !== null) q = q.eq('is_avoir', src.avoir);
  let cursor: ReturnType<typeof decodeCursor> = null;
  if (p.cursor !== null) {
    cursor = decodeCursor(p.cursor);
    if (!cursor) return fail(422, 'bad_cursor', 'the cursor is not one this feed gave');
  }
  if (p.ids) {
    q = q.in(src.idCol, p.ids).limit(p.ids.length);
  } else if (p.modifiedAfter) {
    // Newest first from the instant, keyset on (time, id) descending.
    q = q.gte(src.tsCol, p.modifiedAfter).order(src.tsCol, { ascending: false }).order(src.idCol, { ascending: false }).limit(p.limit + 1);
    if (cursor) {
      if (!cursor.t) return fail(422, 'bad_cursor', 'the cursor is not a changes cursor');
      q = q.or(`${src.tsCol}.lt.${quoted(cursor.t)},and(${src.tsCol}.eq.${quoted(cursor.t)},${src.idCol}.lt.${quoted(cursor.i)})`);
    }
  } else {
    // The full pass: a stable order by id, keyset on the id.
    q = q.order(src.idCol, { ascending: true }).limit(p.limit + 1);
    if (cursor) q = q.gt(src.idCol, cursor.i);
  }
  const { data, error } = await q;
  if (error) {
    console.error(JSON.stringify({ fn: 'leadflow-feed', kind, msg: 'read failed', error: error.message }));
    return fail(500, 'read_failed', 'the feed could not read its records');
  }
  // The select is a column list in a string, so supabase-js cannot type the rows: the mapping checks each value.
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const more = !p.ids && rows.length > p.limit;
  const page = more ? rows.slice(0, p.limit) : rows;
  const records: FeedRecord[] = [];
  for (const r of page) {
    const rec = MAPPERS[kind](r);
    if (rec) records.push(rec);
  }
  let next: string | null = null;
  if (more) {
    const last = page[page.length - 1];
    const i = String(last[src.idCol]);
    next = p.modifiedAfter ? encodeCursor({ t: String(last[src.tsCol]), i }) : encodeCursor({ i });
  }
  return json(200, { records, next_cursor: next });
}

async function listIds(kind: Kind, p: { limit: number; cursor: string | null }): Promise<Response> {
  const src = SOURCES[kind];
  let q = db.from(src.table).select(src.idCol).order(src.idCol, { ascending: true }).limit(p.limit + 1);
  if (src.avoir !== null) q = q.eq('is_avoir', src.avoir);
  if (p.cursor !== null) {
    const cursor = decodeCursor(p.cursor);
    if (!cursor) return fail(422, 'bad_cursor', 'the cursor is not one this feed gave');
    q = q.gt(src.idCol, cursor.i);
  }
  const { data, error } = await q;
  if (error) {
    console.error(JSON.stringify({ fn: 'leadflow-feed', kind, msg: 'ids read failed', error: error.message }));
    return fail(500, 'read_failed', 'the feed could not read its ids');
  }
  // The select is a column list in a string, so supabase-js cannot type the rows: the mapping checks each value.
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const more = rows.length > p.limit;
  const page = more ? rows.slice(0, p.limit) : rows;
  const ids = page.map((r) => String(r[src.idCol]));
  return json(200, { ids, next_cursor: more ? encodeCursor({ i: ids[ids.length - 1] }) : null });
}

Deno.serve(async (req) => {
  if (req.method !== 'GET') return fail(405, 'method_not_allowed', 'GET only');
  if (!FEED_KEY) return fail(503, 'not_configured', 'LEADFLOW_FEED_KEY is not set');
  const given = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  if (!(await sameKey(given, FEED_KEY))) return fail(401, 'unauthorized', 'the key is missing or wrong');

  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/leadflow-feed/, '').replace(/\/+$/, '') || '/';
  const q = url.searchParams;

  if (path === '/v1/feed') return json(200, descriptor());

  if (path === '/v1/records' || path === '/v1/ids') {
    const kind = q.get('kind');
    if (!isKind(kind)) return fail(422, 'unknown_kind', `kind must be one of ${KINDS.join(', ')}`);
    const limit = pageLimit(q.get('limit'));
    const cursor = q.get('cursor');
    if (path === '/v1/ids') return listIds(kind, { limit, cursor });
    const ids = idList(q.get('ids'));
    if (ids === 'too_many') return fail(422, 'too_many_ids', `at most ${MAX_IDS} ids a call`);
    const after = modifiedAfter(q.get('modified_after'));
    if (after === 'bad') return fail(422, 'bad_modified_after', 'modified_after must be an ISO instant');
    if (ids && ids.length === 0) return json(200, { records: [], next_cursor: null });
    return listRecords(kind, { limit, cursor, modifiedAfter: ids ? null : after, ids });
  }

  return fail(404, 'not_found', 'the feed answers /v1/feed, /v1/records and /v1/ids');
});
