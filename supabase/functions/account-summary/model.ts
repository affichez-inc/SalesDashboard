// The model call: the card's schema, sent to the model as a strict JSON Schema
// through OpenRouter (openrouter.ts holds the model, effort and retries).

import { z } from 'npm:zod@4.6.0';
import { type CallRecord, chatJson } from './openrouter.ts';

// The model writes the fields in this order: evidence before each claim, the
// key facts before the summary built on them, the reason before the label.
export const SummarySchema = z.object({
  key_points: z.array(z.object({
    sources: z.array(z.string()).describe('Identifiants du dossier qui prouvent le point, ex. ["F1", "N2"].'),
    text: z.string().describe('Une phrase autonome, vérifiable dans les sources citées.'),
    tone: z.enum(['positif', 'attention', 'neutre']),
  })).describe('3 à 5 faits, du plus utile au moins utile.'),
  summary: z.string().describe('2 à 4 phrases.'),
  next_steps: z.array(z.object({
    sources: z.array(z.string()).describe("Identifiants qui justifient l'action."),
    action: z.enum(['create_task', 'close_task', 'update_task', 'decline_quote', 'revise_quote']),
    target: z.string().nullable().describe('[T…] pour close_task et update_task, [D…] pour decline_quote et revise_quote, null pour create_task.'),
    reason: z.string().describe("Pourquoi, en une phrase vérifiable dans les sources citées."),
    title: z.string().describe("Verbe à l'infinitif, 80 caractères au plus."),
    contact_name: z.string().nullable().describe('Nom exact d\'un contact [P…], ou null.'),
    due_in_days: z.number().describe("create_task : échéance ; update_task : nouvelle échéance ; sinon 0. En jours à partir d'aujourd'hui."),
    new_subject: z.string().nullable().describe('update_task : nouveau titre de la tâche, ou null pour le garder ; null pour les autres actions.'),
  })).describe('0 à 3 actions.'),
  temperature_sources: z.array(z.string()).describe('Identifiants qui prouvent une température plus haute que la base ; vide sinon.'),
  temperature_reason: z.string().describe('Une phrase qui nomme le fait décisif.'),
  temperature: z.enum(['a_risque', 'chaud', 'client_actif', 'tiede', 'dormant', 'froid']),
});

export type ModelSummary = z.infer<typeof SummarySchema>;

/** Strict mode: every object closed and every property required. */
function strict(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(strict);
  if (!s || typeof s !== 'object') return s;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) if (k !== '$schema') o[k] = strict(v);
  if (o.type === 'object' && o.properties) {
    o.additionalProperties = false;
    o.required = Object.keys(o.properties as object);
  }
  return o;
}

const JSON_SCHEMA = strict(z.toJSONSchema(SummarySchema));

export interface ModelResult {
  summary: ModelSummary;
  model: string;
  /** Every attempt, the failed ones included: they are billed too. */
  calls: CallRecord[];
}

export async function summarize(system: string, user: string, deadline: number): Promise<ModelResult> {
  const out = await chatJson({
    system,
    user,
    schema: JSON_SCHEMA,
    schemaName: 'account_summary',
    parse: (text) => SummarySchema.parse(JSON.parse(text)),
    deadline,
  });
  return { summary: out.value, model: out.model, calls: out.calls };
}
