// The model call. Model and effort come from secrets so the model can be
// swapped (e.g. claude-haiku-5-5) without a code change.

import Anthropic from 'npm:@anthropic-ai/sdk@0.133.0';
import { betaZodOutputFormat } from 'npm:@anthropic-ai/sdk@0.133.0/helpers/beta/zod';
import { z } from 'npm:zod@4.6.0';

export const MODEL = Deno.env.get('SUMMARY_MODEL') ?? 'claude-sonnet-5-5';

// `high` by default: the card is judged on factual accuracy, and the run is in
// the background, so latency matters less than care. xhigh and max spend more of
// max_tokens on thinking than a summary needs.
type Effort = 'low' | 'medium' | 'high';
const EFFORTS: Effort[] = ['low', 'medium', 'high'];
const envEffort = Deno.env.get('SUMMARY_EFFORT') as Effort | undefined;
const EFFORT: Effort = envEffort && EFFORTS.includes(envEffort) ? envEffort : 'high';

// Server-side refusal fallback exists for Sonnet 5.5 and the Opus/Fable tiers;
// Haiku has none and would reject the parameter.
const FALLBACK_MODELS = /^claude-(sonnet-5-5|opus-5|fable-5)/;

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
    title: z.string().describe("Verbe à l'infinitif, 80 caractères au plus."),
    contact_name: z.string().nullable().describe('Nom exact d\'un contact [P…], ou null.'),
    due_in_days: z.number().describe("Délai en jours à partir d'aujourd'hui."),
  })).describe('0 à 3 actions.'),
  temperature_sources: z.array(z.string()).describe('Identifiants qui prouvent une température plus haute que la base ; vide sinon.'),
  temperature_reason: z.string().describe('Une phrase qui nomme le fait décisif.'),
  temperature: z.enum(['a_risque', 'chaud', 'client_actif', 'tiede', 'dormant', 'froid']),
});

export type ModelSummary = z.infer<typeof SummarySchema>;

export interface ModelResult {
  summary: ModelSummary;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function summarize(system: string, user: string): Promise<ModelResult> {
  // Well inside the edge function's wall clock; a hung call fails the row instead.
  const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY'), timeout: 100_000, maxRetries: 2 });
  const fallback = FALLBACK_MODELS.test(MODEL)
    ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
    : {};

  const res = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16_000,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT, format: betaZodOutputFormat(SummarySchema) },
    system,
    messages: [{ role: 'user', content: user }],
    ...fallback,
  });

  if (res.stop_reason === 'refusal') {
    throw new Error(`Le modèle a refusé la demande${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}.`);
  }
  if (res.stop_reason === 'max_tokens') throw new Error('Réponse du modèle tronquée (max_tokens).');
  if (!res.parsed_output) throw new Error('Réponse du modèle illisible.');

  return {
    summary: res.parsed_output,
    model: res.model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  };
}
