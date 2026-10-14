// supabase/functions/account-summary/index.ts
// AI relationship summary of a Zoho CRM account, for the card on the Account page.
//
//   POST { action: "get", account_id }
//     → the latest summary, plus the generation in progress or the last failure.
//   POST { action: "generate", account_id, user: { id, name, email } }
//     → starts a generation in the background and answers at once; the widget
//       polls "get" until it is done. A second request for the same account
//       joins the one already running.
//
// Who may call it: the Zoho widget, through a Zoho Connection that adds the
// x-summary-key header (SUMMARY_API_KEY). The key never reaches the browser.
// The user is as reported by the widget and is recorded, not verified.
//
// Secrets:
//   SUMMARY_API_KEY             shared with the Zoho Connection
//   ANTHROPIC_API_KEY
//   SUMMARY_MODEL               default claude-sonnet-5-5
//   SUMMARY_EFFORT              low | medium | high (default high)
//   ZOHO_SUMMARY_REFRESH_TOKEN  CRM token with notes, emails, calls, events and
//                               COQL read; falls back to ZOHO_CRM_REFRESH_TOKEN
//   ZOHO_SUMMARY_CLIENT_ID / _SECRET  fall back to ZOHO_CRM_CLIENT_* then ZOHO_CLIENT_*
//   ZOHO_CLIENT_ID / _SECRET / ZOHO_REFRESH_TOKEN  the Books token the syncs use

import { type Db, gatherDossier, WINDOW_MONTHS } from './gather.ts';
import { summarize } from './model.ts';
import { buildPrompt, day, SYSTEM_PROMPT, userMessage } from './prompt.ts';
import { SB_HEADERS } from './zoho.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const API_KEY = Deno.env.get('SUMMARY_API_KEY') ?? '';

/**
 * A generation older than this without an answer was interrupted. Above the
 * edge function's 400 s wall clock, so a run still in progress is never expired.
 */
const STALE_MS = 7 * 60 * 1000;
const MAX_DUE_DAYS = 60;
const MAX_STEPS = 3;
const MAX_POINTS = 5;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-summary-key',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ─── Database ─────────────────────────────────────────────────────────────────

const db: Db = {
  async select<T>(table: string, q: { select: string; eq?: Record<string, string>; order?: string }) {
    const params = new URLSearchParams({ select: q.select });
    for (const [k, v] of Object.entries(q.eq ?? {})) params.set(k, `eq.${v}`);
    if (q.order) params.set('order', q.order);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers: SB_HEADERS });
    if (!res.ok) throw new Error(`Lecture ${table} impossible : ${res.status} ${await res.text()}`);
    return await res.json() as T[];
  },
};

interface SummaryRow {
  id: number;
  status: 'running' | 'done' | 'failed';
  requested_by_name: string | null;
  model: string | null;
  result: unknown;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

const TABLE = `${SUPABASE_URL}/rest/v1/account_ai_summaries`;

/** Only a row still running can be finished: an expired one stays failed. */
async function finishRow(id: number, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${TABLE}?id=eq.${id}&status=eq.running`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) console.error('account-summary: update failed', id, res.status, await res.text());
}

async function readRows(accountId: string, filter: string, select: string): Promise<SummaryRow[]> {
  const res = await fetch(
    `${TABLE}?zoho_account_id=eq.${accountId}&${filter}&order=created_at.desc&limit=1&select=${select}`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) throw new Error(`Lecture des résumés impossible : ${res.status}`);
  return await res.json() as SummaryRow[];
}

async function expireStale(accountId: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  await fetch(
    `${TABLE}?zoho_account_id=eq.${accountId}&status=eq.running&created_at=lt.${cutoff}`,
    {
      method: 'PATCH',
      headers: SB_HEADERS,
      body: JSON.stringify({ status: 'failed', error: 'Génération interrompue.', completed_at: new Date().toISOString() }),
    },
  );
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function getState(accountId: string) {
  await expireStale(accountId);
  // The latest summary and the latest attempt, read apart so that a run of
  // failures can never push the last good summary out of view.
  const [doneRows, latestRows] = await Promise.all([
    readRows(accountId, 'status=eq.done', 'id,status,requested_by_name,model,result,error,created_at,completed_at'),
    readRows(accountId, 'status=neq.done', 'id,status,requested_by_name,model,error,created_at,completed_at'),
  ]);
  const done = doneRows[0] ?? null;
  const latest = latestRows[0] ?? null;
  const running = latest?.status === 'running' ? latest : null;
  const failed = latest?.status === 'failed' ? latest : null;
  // Every key is always present (null when empty): the widget checks the shape.
  return {
    summary: done
      ? {
        id: done.id,
        created_at: done.completed_at ?? done.created_at,
        requested_by_name: done.requested_by_name,
        result: done.result,
      }
      : null,
    running: running ? { id: running.id, created_at: running.created_at } : null,
    // A failure is only news when it is newer than the summary on screen.
    failed: failed && (!done || failed.created_at > done.created_at)
      ? { id: failed.id, created_at: failed.created_at, error: failed.error }
      : null,
  };
}

interface Requester { id?: string; name?: string; email?: string }

async function startGeneration(accountId: string, user: Requester) {
  await expireStale(accountId);
  const res = await fetch(TABLE, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify({
      zoho_account_id: accountId,
      status: 'running',
      requested_by: user.email?.slice(0, 200) ?? null,
      requested_by_name: user.name?.slice(0, 200) ?? null,
    }),
  });
  // 409: the partial unique index — a generation is already running.
  if (res.status === 409) return await getState(accountId);
  if (!res.ok) throw new Error(`Création de la génération impossible : ${res.status} ${await res.text()}`);
  const [row] = await res.json() as SummaryRow[];

  const work = runGeneration(row.id, accountId);
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work);
  else await work;

  return await getState(accountId);
}

/** A person's name compared without case, accents or extra spaces. */
function nameKey(name: string): string {
  return name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A number written the French or the English way: "1 010,11", "1,010.11", "1010.11". */
const NUMBER = /\d{1,3}(?:\s\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d+)*/g;

function parseNumber(token: string): number {
  const raw = token.replace(/\s/g, '');
  const last = Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.'));
  if (last < 0) return Number(raw);
  return raw.length - last - 1 <= 2
    ? Number(`${raw.slice(0, last).replace(/[.,]/g, '')}.${raw.slice(last + 1)}`)
    : Number(raw.replace(/[.,]/g, ''));
}

/**
 * Dollar amounts the model wrote that appear nowhere in the dossier, to within
 * a dollar of rounding. Stored with the card for review, never shown on it.
 */
function unverifiedAmounts(written: string[], dossier: string): number[] {
  const known = [...dossier.matchAll(NUMBER)].map((m) => parseNumber(m[0])).filter(Number.isFinite);
  const amounts = written.flatMap((t) => [...t.matchAll(/(\d{1,3}(?:\s\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d+)*)\s?\$/g)])
    .map((m) => parseNumber(m[1])).filter(Number.isFinite);
  return [...new Set(amounts)].filter((n) => !known.some((k) => Math.abs(k - n) <= 1));
}

function dueDate(daysFromNow: number): string {
  const d = new Date(Date.now() + Math.max(0, Math.round(daysFromNow)) * 86_400_000);
  // Weekend → next Monday.
  const dow = new Date(day(d.toISOString()) + 'T12:00:00Z').getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return day(d.toISOString());
}

async function runGeneration(rowId: number, accountId: string): Promise<void> {
  const started = Date.now();
  try {
    const dossier = await gatherDossier(accountId, db);
    const built = buildPrompt(dossier);
    const out = await summarize(SYSTEM_PROMPT, userMessage(built, dossier.account.account_name));

    // Keep only citations that exist; map next-step contacts to their CRM ids.
    const cite = (ids: string[]) => [...new Set(ids.map((s) => s.replace(/[[\]\s]/g, '')))].filter((s) => s in built.sources);
    const byName = new Map(built.contacts.map((c) => [nameKey(c.name), c]));
    const keyPoints = out.summary.key_points.slice(0, MAX_POINTS).map((p) => ({ text: p.text, tone: p.tone, sources: cite(p.sources) }));
    const nextSteps = out.summary.next_steps.slice(0, MAX_STEPS).map((s) => {
      const contact = s.contact_name ? byName.get(nameKey(s.contact_name)) ?? null : null;
      return {
        title: s.title.slice(0, 120),
        due_in_days: Math.min(MAX_DUE_DAYS, Math.max(0, Math.round(s.due_in_days))),
        due_date: dueDate(s.due_in_days),
        contact_id: contact?.id ?? null,
        contact_name: contact?.name ?? null,
        sources: cite(s.sources),
      };
    });
    const cited = new Set([...keyPoints, ...nextSteps].flatMap((x) => x.sources));
    const sources = Object.fromEntries(Object.entries(built.sources).filter(([id]) => cited.has(id)));
    const unverified = unverifiedAmounts(
      [out.summary.summary, out.summary.temperature_reason, ...keyPoints.map((p) => p.text), ...nextSteps.map((s) => s.title)],
      built.text,
    );
    if (unverified.length) console.warn('account-summary: amounts not found in the dossier', accountId, unverified);

    const result = {
      version: 1,
      account: {
        id: accountId,
        name: dossier.account.account_name,
        rep_name: dossier.account.rep_name,
      },
      temperature: out.summary.temperature,
      temperature_reason: out.summary.temperature_reason,
      summary: out.summary.summary,
      key_points: keyPoints,
      next_steps: nextSteps,
      stats: built.stats,
      basis: built.basis,
      sources,
      window_months: WINDOW_MONTHS,
      warnings: dossier.warnings,
      checks: { unverified_amounts: unverified },
      duration_ms: Date.now() - started,
    };

    await finishRow(rowId, {
      status: 'done',
      model: out.model,
      result,
      input_tokens: out.inputTokens,
      output_tokens: out.outputTokens,
      completed_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('account-summary: generation failed', accountId, err);
    await finishRow(rowId, {
      status: 'failed',
      error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      completed_at: new Date().toISOString(),
    });
  }
}

// ─── Request ──────────────────────────────────────────────────────────────────

/** The Zoho Connection may send the payload as JSON or as form fields. */
async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch { /* not JSON */ }
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(text)) {
    // Only objects are parsed: a 19-digit id read as a number loses its last digits.
    if (/^\s*[{[]/.test(v)) {
      try { out[k] = JSON.parse(v); } catch { out[k] = v; }
    } else {
      out[k] = v;
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST attendu.' }, 405);

  if (!API_KEY) return json({ error: 'SUMMARY_API_KEY non configurée.' }, 500);
  const key = req.headers.get('x-summary-key') ?? '';
  if (!safeEqual(key, API_KEY)) return json({ error: 'Non autorisé.' }, 401);

  const body = await readBody(req);
  const accountId = String(body.account_id ?? '');
  if (!/^\d{6,25}$/.test(accountId)) return json({ error: 'account_id invalide.' }, 400);

  try {
    if (body.action === 'get') return json(await getState(accountId));
    if (body.action === 'generate') {
      const user = (body.user && typeof body.user === 'object' ? body.user : {}) as Requester;
      return json(await startGeneration(accountId, user));
    }
    return json({ error: 'action inconnue.' }, 400);
  } catch (err) {
    console.error('account-summary:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
