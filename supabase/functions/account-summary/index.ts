// supabase/functions/account-summary/index.ts
// AI relationship summary of a Zoho CRM account, for the card on the Account page.
//
//   POST { action: "get", account_id }
//     → the latest summary, plus the generation in progress or the last failure.
//   POST { action: "generate", account_id, user: { id, name, email } }
//     → starts a generation in the background and answers at once; the widget
//       polls "get" until it is done. A second request for the same account
//       joins the one already running.
//   POST { action: "quote_decline", account_id, summary_id, step, user }
//     → the widget's "Marquer refusé" on a decline_quote step: marks the quote
//       declined in Zoho Books and comments who did it and why. Task steps are
//       applied by the widget itself, as the user.
//   POST { action: "nightly", date?, dry_run?, limit?, wait? }
//     → pg_cron at 1 AM Montreal: lists the accounts with activity since the
//       previous run, and those whose card went stale by date (refresh_at), and
//       queues a summary for each (activity.ts). `dry_run` returns what was found
//       and writes nothing.
//   POST { action: "work", wait? }
//     → pg_cron every minute while the queue holds work: claims queued
//       summaries one at a time and generates them.
//   POST { action: "push_crm", limit? }
//     → copies the latest cards not yet on their Zoho account (crm.ts); also
//       run at the end of each nightly detection.
//
// Every finished summary is copied onto the account's custom fields in Zoho
// (temperature, its reason, the first next step, open quotes, overdue), so
// list views can filter on them.
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
//   SUMMARY_CRM_FIELDS          "off" stops the copy onto the Zoho account's fields
//   ZOHO_SUMMARY_REFRESH_TOKEN  CRM token with notes, emails, events and COQL
//                               read, Accounts update and Books estimates
//                               create/update; reads fall back to
//                               ZOHO_CRM_REFRESH_TOKEN, writes require it
//   ZOHO_SUMMARY_CLIENT_ID / _SECRET  fall back to ZOHO_CRM_CLIENT_* then ZOHO_CLIENT_*
//   ZOHO_CLIENT_ID / _SECRET / ZOHO_REFRESH_TOKEN  the Books token the syncs use

import { type AccountActivity, detectActivity } from './activity.ts';
import { buildCard, type NextStep } from './card.ts';
import { type CardFields, writeAccountFields } from './crm.ts';
import { type Db, gatherDossier } from './gather.ts';
import { summarize } from './model.ts';
import { type CallRecord, ModelCallError } from './openrouter.ts';
import { buildPrompt, day, OPEN_QUOTE, SYSTEM_PROMPT, userMessage } from './prompt.ts';
import { booksGet, booksWrite, BOOKS_ORG_IDS, mapLimit, SB_HEADERS, ZohoError } from './zoho.ts';

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
/** SUMMARY_CRM_FIELDS=off stops the copy onto Zoho accounts; the cards wait in push_crm's backlog. */
const CRM_FIELDS_ON = Deno.env.get('SUMMARY_CRM_FIELDS') !== 'off';
/** Cards copied onto Zoho accounts per push_crm call, a few at a time. */
const CRM_PUSH_LIMIT = 200;
const CRM_PUSH_CONCURRENCY = 3;

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
  async upsert(table: string, rows: Array<Record<string, unknown>>) {
    if (rows.length === 0) return;
    const res = await fetch(`${REST}/${table}`, {
      method: 'POST',
      headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`Écriture ${table} impossible : ${res.status} ${await res.text()}`);
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

// ─── Zoho account fields ──────────────────────────────────────────────────────

async function patchRow(id: number, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${TABLE}?id=eq.${id}`, { method: 'PATCH', headers: SB_HEADERS, body: JSON.stringify(patch) });
  if (!res.ok) console.error('account-summary: update failed', id, res.status, await res.text());
}

/**
 * Copies a card onto its Zoho account while it is the account's latest summary;
 * a superseded card leaves the fields to the newer one. Never throws: a failure
 * is stored on the row and push_crm retries it.
 */
async function pushCrm(id: number, accountId: string, card: CardFields, writtenAt: string): Promise<boolean> {
  if (!CRM_FIELDS_ON) return false;
  try {
    const [latest] = await readRows(accountId, 'status=eq.done', 'id');
    if (latest?.id !== id) return false;
    await writeAccountFields(accountId, card, writtenAt);
    await patchRow(id, { crm_pushed_at: new Date().toISOString(), crm_error: null });
    return true;
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.error('account-summary: Zoho account fields not written', accountId, message);
    await patchRow(id, { crm_error: message });
    return false;
  }
}

/** The latest cards not yet copied onto their account: new ones, failed ones, older summaries. */
async function pushPending(limit: number) {
  const rows = await rpc<Array<{ id: number; zoho_account_id: string; result: CardFields; completed_at: string | null; created_at: string }>>(
    'account_ai_summary_crm_pending', { p_limit: limit },
  );
  const ok = await mapLimit(rows, CRM_PUSH_CONCURRENCY, (r) => pushCrm(r.id, r.zoho_account_id, r.result, r.completed_at ?? r.created_at));
  const pushed = ok.filter(Boolean).length;
  if (rows.length) console.log('account-summary: Zoho account fields', pushed, 'of', rows.length);
  return { pending: rows.length, pushed, failed: rows.length - pushed };
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

const QUOTE_STATUS_LABEL: Record<string, string> = {
  draft: 'brouillon', sent: 'envoyé', viewed: 'vu', accepted: 'accepté', invoiced: 'facturé',
  partially_invoiced: 'partiellement facturé', declined: 'refusé', expired: 'expiré',
};

/**
 * Marks the quote of a decline_quote step declined in Books, once its current
 * status is checked, and leaves a comment (hidden from the client) naming who
 * did it from the card and why. The step is read from the stored card, never
 * from the request.
 */
async function declineQuote(accountId: string, summaryId: number, stepIndex: number, user: Requester) {
  const res = await fetch(
    `${TABLE}?id=eq.${summaryId}&zoho_account_id=eq.${accountId}&status=eq.done&select=result`,
    { headers: SB_HEADERS },
  );
  if (!res.ok) throw new Error(`Lecture du résumé impossible : ${res.status}`);
  const [row] = await res.json() as Array<{ result: { next_steps?: NextStep[] } }>;
  const step = row?.result?.next_steps?.[stepIndex];
  const target = step?.action === 'decline_quote' && step.target?.kind === 'quote' ? step.target : null;
  const orgId = target ? BOOKS_ORG_IDS[target.office] : undefined;
  if (!target || !orgId) return { ok: false, error: 'Action introuvable sur ce résumé : régénérez-le.' };

  const current = await booksGet<{ estimate?: { status?: string } }>(`estimates/${target.record_id}`, orgId);
  const status = current?.estimate?.status ?? '';
  if (status === 'declined') return { ok: true, status, already: true };
  if (!OPEN_QUOTE.has(status)) {
    return { ok: false, status, error: `Le devis ${target.number} est maintenant « ${QUOTE_STATUS_LABEL[status] ?? status} » dans Zoho Books : rien n'a été changé.` };
  }

  try {
    await booksWrite('POST', `estimates/${target.record_id}/status/declined`, orgId);
  } catch (err) {
    if (err instanceof ZohoError && err.status === 401) {
      return { ok: false, error: "La clé Zoho du résumé n'a pas le droit de modifier les devis dans Zoho Books." };
    }
    throw err;
  }
  const who = user.name?.slice(0, 120) || 'un représentant';
  try {
    await booksWrite('POST', `estimates/${target.record_id}/comments`, orgId, {
      description: `Marqué refusé par ${who} depuis le résumé IA du compte (Zoho CRM). Motif : ${step?.reason ?? ''}`.slice(0, 2000),
      show_comment_to_clients: false,
    });
  } catch (err) {
    console.error('account-summary: quote comment not added', target.number, err instanceof Error ? err.message : err);
  }
  console.log('account-summary: quote declined', accountId, target.number, 'by', who);
  return { ok: true, status: 'declined' };
}

// ─── Generation ───────────────────────────────────────────────────────────────

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

    const { result, refresh_at } = buildCard(accountId, dossier, built, out.summary, started);

    await recordCalls(row, calls);
    const completedAt = new Date().toISOString();
    await finishRow(row.id, {
      status: 'done',
      model: out.model,
      result,
      input_tokens: calls.reduce((s, c) => s + (c.prompt_tokens ?? 0), 0),
      output_tokens: calls.reduce((s, c) => s + (c.completion_tokens ?? 0), 0),
      error: null,
      completed_at: completedAt,
      refresh_at,
    });
    await pushCrm(row.id, accountId, result, completedAt);
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

/**
 * The accounts with activity, plus those whose latest card went stale by date
 * before the window's end (refresh_at). A stale card is queued even when it
 * already covers the account's activity: it started before its refresh day.
 */
async function withExpired(found: AccountActivity[], windowEnd: string): Promise<{ accounts: AccountActivity[]; expired: number }> {
  const rows = await rpc<Array<{ account_id: string; refresh_at: string }>>('account_ai_summary_expired', { p_until: windowEnd });
  const byId = new Map(found.map((a) => [a.account_id, a]));
  for (const r of rows) {
    const refresh = new Date(r.refresh_at).toISOString();
    const a = byId.get(r.account_id);
    if (a) {
      a.activity.kinds.temperature_expired = 1;
      if (Date.parse(refresh) > Date.parse(a.ready_at)) a.ready_at = refresh;
    } else {
      byId.set(r.account_id, {
        account_id: r.account_id,
        last_activity_at: refresh,
        ready_at: refresh,
        activity: { kinds: { temperature_expired: 1 } },
      });
    }
  }
  return { accounts: [...byId.values()], expired: rows.length };
}

async function detectAndQueue(run: RunWindow, limit: number) {
  const from = Date.parse(run.window_start);
  const to = Date.parse(run.window_end);
  try {
    const found = await detectActivity(db, from, to);
    const { accounts, expired } = await withExpired(found.accounts, run.window_end);
    const detection = { ...found.stats, expired };
    const counts = await rpc<Record<string, number>>('account_ai_summary_enqueue', {
      p_run_id: run.run_id,
      p_items: accounts,
      p_limit: limit,
    });
    await fetch(`${REST}/account_ai_summary_runs?id=eq.${run.run_id}`, {
      method: 'PATCH',
      headers: SB_HEADERS,
      body: JSON.stringify({ detection }),
    });
    console.log('account-summary: nightly run queued', run.run_id, JSON.stringify(counts));
    // Cards whose copy onto the Zoho account failed get another try.
    const crm = await pushPending(CRM_PUSH_LIMIT).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
    return { run_id: run.run_id, window: found.stats.window, ...counts, detection, crm };
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
    const { accounts, expired } = await withExpired(found.accounts, w.window_end);
    return { dry_run: true, date, accounts, ...found.stats, expired };
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
    if (body.action === 'push_crm') {
      return json(await pushPending(Math.min(CRM_PUSH_LIMIT, Math.max(1, Number(body.limit) || CRM_PUSH_LIMIT))));
    }

    const accountId = String(body.account_id ?? '');
    if (!/^\d{6,25}$/.test(accountId)) return json({ error: 'account_id invalide.' }, 400);
    const user = (body.user && typeof body.user === 'object' ? body.user : {}) as Requester;
    if (body.action === 'get') return json(await getState(accountId));
    if (body.action === 'generate') return json(await startGeneration(accountId, user, deadline));
    if (body.action === 'quote_decline') {
      const summaryId = Number(body.summary_id);
      const step = Number(body.step);
      if (!Number.isInteger(summaryId) || !Number.isInteger(step) || step < 0) return json({ error: 'summary_id ou step invalide.' }, 400);
      return json(await declineQuote(accountId, summaryId, step, user));
    }
    return json({ error: 'action inconnue.' }, 400);
  } catch (err) {
    console.error('account-summary:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
