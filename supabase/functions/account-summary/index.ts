// supabase/functions/account-summary/index.ts
// AI relationship summary of a Zoho CRM account, for the card on the Account page.
//
//   POST { action: "get", account_id }
//     → the latest summary, plus the generation in progress or the last failure.
//   POST { action: "generate", account_id, user: { id, name, email } }
//     → starts a generation in the background and answers at once; the widget
//       polls "get" until it is done. A second request for the same account
//       joins the one already running.
//   POST { action: "nightly", date?, dry_run?, limit?, wait? }
//     → pg_cron at 1 AM Montreal: lists the accounts with activity since the
//       previous run and queues a summary for each (activity.ts). `dry_run`
//       returns what was found and writes nothing.
//   POST { action: "work", wait? }
//     → pg_cron every minute while the queue holds work: claims queued
//       summaries one at a time and generates them.
//
// Who may call it: the Zoho widget, through a Zoho Connection that adds the
// x-summary-key header (SUMMARY_API_KEY), and pg_cron, which reads the same key
// from Vault. The key never reaches the browser. The widget's user is recorded,
// not verified.
//
// Secrets:
//   SUMMARY_API_KEY             shared with the Zoho Connection and Vault
//   OPENROUTER_API_KEY          the model, through OpenRouter (openrouter.ts)
//   SUMMARY_MODEL / SUMMARY_EFFORT / SUMMARY_PROVIDERS   see openrouter.ts
//   SUMMARY_NIGHTLY_LIMIT       accounts queued per night at most, default 1500
//   ZOHO_SUMMARY_REFRESH_TOKEN  CRM token with notes, emails, events and COQL
//                               read; falls back to ZOHO_CRM_REFRESH_TOKEN
//   ZOHO_SUMMARY_CLIENT_ID / _SECRET  fall back to ZOHO_CRM_CLIENT_* then ZOHO_CLIENT_*
//   ZOHO_CLIENT_ID / _SECRET / ZOHO_REFRESH_TOKEN  the Books token the syncs use

import { detectActivity } from './activity.ts';
import { dropCurrentYear } from './clean.ts';
import { type Db, gatherDossier, WINDOW_MONTHS } from './gather.ts';
import { summarize } from './model.ts';
import { type CallRecord, ModelCallError } from './openrouter.ts';
import { buildPrompt, day, settleTemperature, SYSTEM_PROMPT, userMessage } from './prompt.ts';
import { SB_HEADERS } from './zoho.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const API_KEY = Deno.env.get('SUMMARY_API_KEY') ?? '';

/**
 * A generation older than this without an answer was interrupted. Above the
 * edge function's 400 s wall clock, so a run still in progress is never expired.
 */
const STALE_MS = 7 * 60 * 1000;
/** Every model attempt must have ended by then, counted from the request. */
const WALL_MS = 380_000;
const MAX_DUE_DAYS = 60;
const MAX_STEPS = 3;
const MAX_POINTS = 5;

const NIGHTLY_LIMIT = Math.max(1, Number(Deno.env.get('SUMMARY_NIGHTLY_LIMIT')) || 1500);
/** Nightly generations running at once, across workers (Zoho allows 20 concurrent calls per org). */
const MAX_RUNNING = 3;
const MAX_ATTEMPTS = 3;
/** A worker claims no new account after this, nor after this many accounts. */
const WORKER_BUDGET_MS = 110_000;
const WORKER_MAX_ITEMS = 6;
/** Before the next attempt of a failed nightly summary, by attempt number. */
const RETRY_DELAY_MS = [10 * 60_000, 30 * 60_000];
/** An account created after the last zoho-account-sync is in the mirror within 2 h. */
const MISSING_ACCOUNT_DELAY_MS = 2 * 60 * 60_000;
const MISSING_ACCOUNT = 'Compte introuvable dans le miroir Supabase.';

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

/** Runs `work` after the response when deployed; inline when `wait` or run locally. */
function background(work: Promise<unknown>, wait: boolean): Promise<unknown> | null {
  if (!wait && typeof EdgeRuntime !== 'undefined') {
    EdgeRuntime.waitUntil(work);
    return null;
  }
  return work;
}

// ─── Database ─────────────────────────────────────────────────────────────────

const REST = `${SUPABASE_URL}/rest/v1`;

const db: Db = {
  async select<T>(table: string, q: { select: string; eq?: Record<string, string>; in?: Record<string, string[]>; order?: string }) {
    const params = new URLSearchParams({ select: q.select });
    for (const [k, v] of Object.entries(q.eq ?? {})) params.set(k, `eq.${v}`);
    for (const [k, ids] of Object.entries(q.in ?? {})) {
      for (const id of ids) if (!/^\d+$/.test(id)) throw new Error(`Identifiant invalide : ${id}`);
      params.set(k, `in.(${ids.join(',')})`);
    }
    if (q.order) params.set('order', q.order);
    const res = await fetch(`${REST}/${table}?${params}`, { headers: SB_HEADERS });
    if (!res.ok) throw new Error(`Lecture ${table} impossible : ${res.status} ${await res.text()}`);
    return await res.json() as T[];
  },
};

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${REST}/rpc/${name}`, { method: 'POST', headers: SB_HEADERS, body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`${name} : ${res.status} ${await res.text()}`);
  return await res.json() as T;
}

interface SummaryRow {
  id: number;
  zoho_account_id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  trigger: 'manual' | 'nightly';
  run_id: number | null;
  attempts: number;
  requested_by_name: string | null;
  model: string | null;
  result: unknown;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const TABLE = `${REST}/account_ai_summaries`;

/** Only a row still running can be finished: an expired one stays as it was set. */
async function finishRow(id: number, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${TABLE}?id=eq.${id}&status=eq.running`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) console.error('account-summary: update failed', id, res.status, await res.text());
}

/** Every model attempt, with what it cost. A failed write is logged, never fatal. */
async function recordCalls(row: SummaryRow, calls: CallRecord[]): Promise<void> {
  if (!calls.length) return;
  const res = await fetch(`${REST}/ai_model_calls`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify(calls.map((c) => ({
      ...c,
      feature: 'account_summary',
      summary_id: row.id,
      zoho_account_id: row.zoho_account_id,
      run_id: row.run_id,
      trigger: row.trigger,
    }))),
  });
  if (!res.ok) console.error('account-summary: cost record failed', row.id, res.status, await res.text());
}

/**
 * The newest row by the moment its data was read: a nightly row is created when
 * it is queued, which can be hours before it runs.
 */
async function readRows(accountId: string, filter: string, select: string): Promise<SummaryRow[]> {
  const res = await fetch(
    `${TABLE}?zoho_account_id=eq.${accountId}&${filter}&order=started_at.desc.nullslast,created_at.desc&limit=1&select=${select}`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) throw new Error(`Lecture des résumés impossible : ${res.status}`);
  return await res.json() as SummaryRow[];
}

/** A manual generation the function lost. Nightly ones are re-queued by the claim. */
async function expireStale(accountId: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  await fetch(
    `${TABLE}?zoho_account_id=eq.${accountId}&status=eq.running&trigger=eq.manual&started_at=lt.${cutoff}`,
    {
      method: 'PATCH',
      headers: SB_HEADERS,
      body: JSON.stringify({ status: 'failed', error: 'Génération interrompue.', completed_at: new Date().toISOString() }),
    },
  );
}

// ─── Widget actions ───────────────────────────────────────────────────────────

async function getState(accountId: string) {
  await expireStale(accountId);
  // The latest summary and the latest attempt, read apart so that a run of
  // failures can never push the last good summary out of view. A nightly
  // failure is not the user's: only a failed click is reported.
  const [doneRows, latestRows] = await Promise.all([
    readRows(accountId, 'status=eq.done', 'id,status,requested_by_name,model,result,error,created_at,started_at,completed_at'),
    readRows(accountId, 'or=(status.eq.running,and(status.eq.failed,trigger.eq.manual))',
      'id,status,requested_by_name,model,error,created_at,started_at,completed_at'),
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
    running: running ? { id: running.id, created_at: running.started_at ?? running.created_at } : null,
    // A failure is only news when it is newer than the summary on screen.
    failed: failed && (!done || (failed.started_at ?? failed.created_at) > (done.started_at ?? done.created_at))
      ? { id: failed.id, created_at: failed.created_at, error: failed.error }
      : null,
  };
}

interface Requester { id?: string; name?: string; email?: string }

async function startGeneration(accountId: string, user: Requester, deadline: number) {
  await expireStale(accountId);
  const res = await fetch(TABLE, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify({
      zoho_account_id: accountId,
      status: 'running',
      trigger: 'manual',
      started_at: new Date().toISOString(),
      attempts: 1,
      requested_by: user.email?.slice(0, 200) ?? null,
      requested_by_name: user.name?.slice(0, 200) ?? null,
    }),
  });
  // 409: the partial unique index — a generation is already running.
  if (res.status === 409) return await getState(accountId);
  if (!res.ok) throw new Error(`Création de la génération impossible : ${res.status} ${await res.text()}`);
  const [row] = await res.json() as SummaryRow[];

  const work = runGeneration(row, deadline);
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work);
  else await work;

  return await getState(accountId);
}

// ─── Generation ───────────────────────────────────────────────────────────────

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

type Outcome = 'done' | 'failed' | 'requeued';

async function runGeneration(row: SummaryRow, deadline: number): Promise<Outcome> {
  const accountId = row.zoho_account_id;
  const started = Date.now();
  let calls: CallRecord[] = [];
  try {
    const dossier = await gatherDossier(accountId, db);
    const built = buildPrompt(dossier);
    const out = await summarize(SYSTEM_PROMPT, userMessage(built, dossier.account.account_name), deadline);
    calls = out.calls;

    const year = day(new Date().toISOString()).slice(0, 4);
    const tidy = (s: string) => dropCurrentYear(s, year);
    // Keep only citations that exist; map next-step contacts to their CRM ids.
    const cite = (ids: string[]) => [...new Set(ids.map((s) => s.replace(/[[\]\s]/g, '')))].filter((s) => s in built.sources);
    const byName = new Map(built.contacts.map((c) => [nameKey(c.name), c]));
    const keyPoints = out.summary.key_points.slice(0, MAX_POINTS).map((p) => ({ text: tidy(p.text), tone: p.tone, sources: cite(p.sources) }));
    const nextSteps = out.summary.next_steps.slice(0, MAX_STEPS).map((s) => {
      const contact = s.contact_name ? byName.get(nameKey(s.contact_name)) ?? null : null;
      const dueIn = Math.min(MAX_DUE_DAYS, Math.max(0, Math.round(s.due_in_days)));
      return {
        title: tidy(s.title).slice(0, 120),
        due_in_days: dueIn,
        due_date: dueDate(dueIn),
        contact_id: contact?.id ?? null,
        contact_name: contact?.name ?? null,
        sources: cite(s.sources),
      };
    });
    // The figures set the temperature; the model may only raise it on cited evidence.
    const temp = settleTemperature(built.base, out.summary.temperature, tidy(out.summary.temperature_reason), cite(out.summary.temperature_sources));
    if (temp.adjusted) console.warn('account-summary: temperature reset to base', accountId, out.summary.temperature, '->', temp.temperature);
    const summary = tidy(out.summary.summary);
    const cited = new Set([...keyPoints, ...nextSteps, temp].flatMap((x) => x.sources));
    const sources = Object.fromEntries(Object.entries(built.sources).filter(([id]) => cited.has(id)));
    const unverified = unverifiedAmounts(
      [summary, temp.reason, ...keyPoints.map((p) => p.text), ...nextSteps.map((s) => s.title)],
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
      temperature: temp.temperature,
      temperature_reason: temp.reason,
      temperature_sources: temp.sources,
      temperature_base: built.base,
      summary,
      key_points: keyPoints,
      next_steps: nextSteps,
      stats: built.stats,
      basis: built.basis,
      sources,
      window_months: WINDOW_MONTHS,
      warnings: dossier.warnings,
      checks: {
        unverified_amounts: unverified,
        temperature: { base: built.base.temperature, model: out.summary.temperature, adjusted: temp.adjusted },
      },
      duration_ms: Date.now() - started,
    };

    await recordCalls(row, calls);
    await finishRow(row.id, {
      status: 'done',
      model: out.model,
      result,
      input_tokens: calls.reduce((s, c) => s + (c.prompt_tokens ?? 0), 0),
      output_tokens: calls.reduce((s, c) => s + (c.completion_tokens ?? 0), 0),
      error: null,
      completed_at: new Date().toISOString(),
    });
    return 'done';
  } catch (err) {
    if (err instanceof ModelCallError) calls = err.calls;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    console.error('account-summary: generation failed', accountId, row.trigger, row.attempts, message);
    await recordCalls(row, calls);
    const tokens = {
      input_tokens: calls.length ? calls.reduce((s, c) => s + (c.prompt_tokens ?? 0), 0) : null,
      output_tokens: calls.length ? calls.reduce((s, c) => s + (c.completion_tokens ?? 0), 0) : null,
    };
    if (row.trigger === 'nightly' && row.attempts < MAX_ATTEMPTS) {
      const delay = message === MISSING_ACCOUNT ? MISSING_ACCOUNT_DELAY_MS : RETRY_DELAY_MS[row.attempts - 1] ?? RETRY_DELAY_MS.at(-1)!;
      await finishRow(row.id, {
        status: 'queued',
        error: message,
        next_attempt_at: new Date(Date.now() + delay).toISOString(),
        ...tokens,
      });
      return 'requeued';
    }
    await finishRow(row.id, { status: 'failed', error: message, completed_at: new Date().toISOString(), ...tokens });
    return 'failed';
  }
}

// ─── Nightly ──────────────────────────────────────────────────────────────────

/** Today's date in Montreal, YYYY-MM-DD. */
function montrealToday(): string {
  return day(new Date().toISOString());
}

interface RunWindow { run_id?: number; window_start: string; window_end: string; started?: boolean; status?: string }

async function detectAndQueue(run: RunWindow, limit: number) {
  const from = Date.parse(run.window_start);
  const to = Date.parse(run.window_end);
  try {
    const found = await detectActivity(db, from, to);
    const counts = await rpc<Record<string, number>>('account_ai_summary_enqueue', {
      p_run_id: run.run_id,
      p_items: found.accounts,
      p_limit: limit,
    });
    await fetch(`${REST}/account_ai_summary_runs?id=eq.${run.run_id}`, {
      method: 'PATCH',
      headers: SB_HEADERS,
      body: JSON.stringify({ detection: found.stats }),
    });
    console.log('account-summary: nightly run queued', run.run_id, JSON.stringify(counts));
    return { run_id: run.run_id, window: found.stats.window, ...counts, detection: found.stats };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    console.error('account-summary: nightly detection failed', run.run_id, message);
    await fetch(`${REST}/account_ai_summary_runs?id=eq.${run.run_id}`, {
      method: 'PATCH',
      headers: SB_HEADERS,
      body: JSON.stringify({ status: 'failed', error: message }),
    });
    throw err;
  }
}

async function nightly(body: Record<string, unknown>) {
  const date = typeof body.date === 'string' ? body.date : montrealToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date invalide (AAAA-MM-JJ).');
  const limit = Math.min(NIGHTLY_LIMIT, Math.max(1, Number(body.limit) || NIGHTLY_LIMIT));

  if (body.dry_run === true) {
    const [w] = await rpc<RunWindow[]>('account_ai_summary_window', { p_local_date: date });
    if (Date.parse(w.window_end) > Date.now()) throw new Error(`La fenêtre du ${date} n'est pas terminée.`);
    const found = await detectActivity(db, Date.parse(w.window_start), Date.parse(w.window_end));
    return { dry_run: true, date, accounts: found.accounts, ...found.stats };
  }

  const [run] = await rpc<RunWindow[]>('account_ai_summary_start_run', { p_local_date: date });
  if (!run.started) return { date, run_id: run.run_id, started: false, status: run.status };
  const work = background(detectAndQueue(run, limit), body.wait === true);
  return work ? { date, started: true, ...await work as object } : { date, run_id: run.run_id, started: true };
}

async function work(deadline: number) {
  const begun = Date.now();
  const counts = { claimed: 0, done: 0, failed: 0, requeued: 0 };
  while (counts.claimed < WORKER_MAX_ITEMS && Date.now() - begun < WORKER_BUDGET_MS) {
    const [row] = await rpc<SummaryRow[]>('account_ai_summary_claim', {
      p_max_running: MAX_RUNNING,
      p_max_attempts: MAX_ATTEMPTS,
    });
    if (!row) break;
    counts.claimed++;
    counts[await runGeneration(row, deadline)]++;
  }
  if (counts.claimed) console.log('account-summary: worker', JSON.stringify(counts));
  return counts;
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
  const deadline = Date.now() + WALL_MS;
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST attendu.' }, 405);

  if (!API_KEY) return json({ error: 'SUMMARY_API_KEY non configurée.' }, 500);
  const key = req.headers.get('x-summary-key') ?? '';
  if (!safeEqual(key, API_KEY)) return json({ error: 'Non autorisé.' }, 401);

  const body = await readBody(req);
  try {
    if (body.action === 'nightly') return json(await nightly(body));
    if (body.action === 'work') {
      const job = background(work(deadline), body.wait === true);
      return job ? json(await job) : json({ started: true }, 202);
    }

    const accountId = String(body.account_id ?? '');
    if (!/^\d{6,25}$/.test(accountId)) return json({ error: 'account_id invalide.' }, 400);
    if (body.action === 'get') return json(await getState(accountId));
    if (body.action === 'generate') {
      const user = (body.user && typeof body.user === 'object' ? body.user : {}) as Requester;
      return json(await startGeneration(accountId, user, deadline));
    }
    return json({ error: 'action inconnue.' }, 400);
  } catch (err) {
    console.error('account-summary:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
