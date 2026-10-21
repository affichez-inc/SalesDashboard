// Turns the model's answer into the stored card: citations checked against the
// dossier, next steps tied to the records they act on, the temperature settled
// against the figures, and the day the card goes stale by date.

import { dropCurrentYear } from './clean.ts';
import { type Dossier, WINDOW_MONTHS } from './gather.ts';
import type { ModelSummary } from './model.ts';
import { type BuiltPrompt, day, OPEN_QUOTE, refreshAt, settleTemperature } from './prompt.ts';
import { booksUrl } from './zoho.ts';

const MAX_DUE_DAYS = 60;
const MAX_STEPS = 3;
const MAX_POINTS = 5;

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

/** The record a step acts on, with what the widget shows and needs to act. */
export type StepTarget =
  | { id: string; kind: 'task'; record_id: string; label: string; due: string | null }
  | { id: string; kind: 'quote'; record_id: string; label: string; number: string; total: number; status: string; office: string; url: string | null };

export interface NextStep {
  action: ModelSummary['next_steps'][number]['action'];
  title: string;
  /** Written into the task's description or the quote's comment. */
  reason: string;
  target: StepTarget | null;
  /** update_task only: the task's new subject, or null to keep it. */
  new_subject: string | null;
  /** create_task: the new task's due date; update_task: the new due date. */
  due_in_days: number | null;
  due_date: string | null;
  contact_id: string | null;
  contact_name: string | null;
  sources: string[];
}

export function buildCard(accountId: string, dossier: Dossier, built: BuiltPrompt, answer: ModelSummary, startedMs: number) {
  const year = day(new Date().toISOString()).slice(0, 4);
  const tidy = (s: string) => dropCurrentYear(s, year);
  // Keep only citations that exist; map next-step contacts to their CRM ids.
  const cite = (ids: string[]) => [...new Set(ids.map((s) => s.replace(/[[\]\s]/g, '')))].filter((s) => s in built.sources);
  const byName = new Map(built.contacts.map((c) => [nameKey(c.name), c]));
  const keyPoints = answer.key_points.slice(0, MAX_POINTS).map((p) => ({ text: tidy(p.text), tone: p.tone, sources: cite(p.sources) }));

  const nextSteps: NextStep[] = [];
  const acted = new Set<string>();
  for (const s of answer.next_steps) {
    if (nextSteps.length >= MAX_STEPS) break;
    const contact = s.contact_name ? byName.get(nameKey(s.contact_name)) ?? null : null;
    const dueIn = Math.min(MAX_DUE_DAYS, Math.max(0, Math.round(s.due_in_days)));
    const dated = s.action === 'create_task' || s.action === 'update_task';

    // A step that acts on a record must name one the dossier offers for that
    // action; otherwise it is dropped, never guessed.
    let target: StepTarget | null = null;
    if (s.action !== 'create_task') {
      const ref = (s.target ?? '').replace(/[[\]\s]/g, '');
      const t = built.targets[ref];
      const onTask = s.action === 'close_task' || s.action === 'update_task';
      const valid = t && !acted.has(ref) && (onTask
        ? t.kind === 'task' && !t.automated
        : t.kind === 'quote' && (s.action === 'revise_quote' || OPEN_QUOTE.has(t.status)));
      if (!valid) {
        console.warn('account-summary: step dropped', accountId, s.action, s.target);
        continue;
      }
      acted.add(ref);
      target = t.kind === 'task'
        ? { id: ref, kind: 'task', record_id: t.record_id, label: t.subject, due: t.due }
        : {
          id: ref, kind: 'quote', record_id: t.record_id, label: t.title ? `${t.number} « ${t.title} »` : t.number,
          number: t.number, total: t.total, status: t.status, office: t.office, url: booksUrl(t.office, 'quotes', t.record_id),
        };
    }
    const newSubject = s.action === 'update_task' ? tidy(s.new_subject ?? '').trim().slice(0, 120) || null : null;
    // An update that would change nothing is not a step.
    if (s.action === 'update_task' && !newSubject && target?.kind === 'task' && target.due === dueDate(dueIn)) continue;
    nextSteps.push({
      action: s.action,
      title: tidy(s.title).slice(0, 120),
      reason: tidy(s.reason).slice(0, 300),
      target,
      new_subject: newSubject,
      due_in_days: dated ? dueIn : null,
      due_date: dated ? dueDate(dueIn) : null,
      contact_id: contact?.id ?? null,
      contact_name: contact?.name ?? null,
      sources: cite(s.sources),
    });
  }

  // The figures set the temperature; the model may only raise it on cited evidence.
  const temp = settleTemperature(built.base, answer.temperature, tidy(answer.temperature_reason), cite(answer.temperature_sources));
  if (temp.adjusted) console.warn('account-summary: temperature reset to base', accountId, answer.temperature, '->', temp.temperature);
  const summary = tidy(answer.summary);
  const cited = new Set([...keyPoints, ...nextSteps, temp].flatMap((x) => x.sources));
  const sources = Object.fromEntries(Object.entries(built.sources).filter(([id]) => cited.has(id)));
  const unverified = unverifiedAmounts(
    [summary, temp.reason, ...keyPoints.map((p) => p.text), ...nextSteps.map((s) => s.title), ...nextSteps.map((s) => s.reason)],
    built.text,
  );
  if (unverified.length) console.warn('account-summary: amounts not found in the dossier', accountId, unverified);

  const result = {
    // 2: next steps carry an action and its target.
    version: 2,
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
      temperature: { base: built.base.temperature, model: answer.temperature, adjusted: temp.adjusted },
    },
    duration_ms: Date.now() - startedMs,
  };
  return { result, refresh_at: refreshAt(built, temp.temperature, temp.sources) };
}
