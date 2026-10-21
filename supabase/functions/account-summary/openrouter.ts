// Chat completions through OpenRouter, with retries, and a record of every
// attempt (tokens, the serving provider's prices, the amount charged) for the
// ai_model_calls table.
//
// Secrets:
//   OPENROUTER_API_KEY
//   SUMMARY_MODEL       default z-ai/glm-5.3
//   SUMMARY_EFFORT      reasoning effort, default high
//   SUMMARY_PROVIDERS   provider slugs tried in this order, default parasail,fireworks,nebius
//                       (Nebius last: it bills cached prompt tokens at the full price)

const API = 'https://openrouter.ai/api/v1';

const DEFAULT_MODEL = 'z-ai/glm-5.3';
const envModel = Deno.env.get('SUMMARY_MODEL')?.trim();
// OpenRouter ids are vendor/model; a bare id is a leftover from the Anthropic API.
if (envModel && !envModel.includes('/')) console.warn(`openrouter: SUMMARY_MODEL "${envModel}" ignored, using ${DEFAULT_MODEL}`);
export const MODEL = envModel?.includes('/') ? envModel : DEFAULT_MODEL;

type Effort = 'low' | 'medium' | 'high' | 'xhigh';
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh'];
const envEffort = Deno.env.get('SUMMARY_EFFORT') as Effort | undefined;
export const EFFORT: Effort = envEffort && EFFORTS.includes(envEffort) ? envEffort : 'high';

const PROVIDERS = (Deno.env.get('SUMMARY_PROVIDERS') ?? 'parasail,fireworks,nebius')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The model's list price, USD per million tokens. A provider slug also matches
 * its dearer variants (fireworks/fast costs 1.5x), so routing is capped here.
 */
const MAX_PRICE = { prompt: 1.4, completion: 4.4 };

/**
 * Reasoning counts against max_tokens. At high effort the summary's thinking has
 * stayed under 2.1k tokens; the cap only stops a runaway, which is billed.
 */
const MAX_TOKENS = 16_000;

const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 90_000;
/** No attempt starts with less time than this before the caller's deadline. */
const MIN_ATTEMPT_MS = 30_000;
const BACKOFF_MS = [2_000, 6_000];
const MAX_RETRY_AFTER_MS = 30_000;

/** Requests that will fail the same way however often they are sent. */
const FINAL_STATUSES = new Set([400, 401, 402, 403, 404, 413, 422]);

// ─── Types ────────────────────────────────────────────────────────────────────

export type Outcome =
  | 'ok' | 'http_error' | 'network_error' | 'timeout' | 'empty' | 'invalid_output' | 'truncated' | 'refused';

/** One attempt, shaped as a row of ai_model_calls (without the context columns). */
export interface CallRecord {
  created_at: string;
  attempt: number;
  api: 'openrouter';
  generation_id: string | null;
  model_requested: string;
  model_used: string | null;
  provider: string | null;
  reasoning_effort: string;
  max_tokens: number;
  outcome: Outcome;
  http_status: number | null;
  finish_reason: string | null;
  native_finish_reason: string | null;
  error: string | null;
  prompt_tokens: number | null;
  cached_tokens: number | null;
  cache_write_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  price_input_per_mtok: number | null;
  price_cached_input_per_mtok: number | null;
  price_cache_write_per_mtok: number | null;
  price_output_per_mtok: number | null;
  price_reasoning_per_mtok: number | null;
  cost_usd: number | null;
  cost_upstream_usd: number | null;
  is_byok: boolean | null;
  latency_ms: number;
  prompt_chars: number;
  response_chars: number | null;
  usage: unknown;
}

export interface ChatRequest<T> {
  system: string;
  user: string;
  /** JSON Schema of the answer, sent as a strict response format. */
  schema: unknown;
  schemaName: string;
  /** Parses the answer; throws when it is not acceptable, which triggers a retry. */
  parse: (text: string) => T;
  /** Epoch ms after which no attempt may still be running. */
  deadline: number;
}

export interface ChatResult<T> {
  value: T;
  model: string;
  calls: CallRecord[];
}

/** The request failed; `calls` holds every attempt, billed ones included. */
export class ModelCallError extends Error {
  calls: CallRecord[];
  constructor(message: string, calls: CallRecord[]) {
    super(message);
    this.calls = calls;
  }
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  is_byok?: boolean;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
  cost_details?: { upstream_inference_cost?: number | null } | null;
}

interface CompletionBody {
  id?: string;
  model?: string;
  provider?: string;
  choices?: Array<{
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null } | null;
    error?: { code?: number | string; message?: string } | null;
  }>;
  usage?: Usage;
  error?: { code?: number | string; message?: string; metadata?: { provider_name?: string; raw?: unknown } };
}

// ─── Prices ───────────────────────────────────────────────────────────────────

interface Prices {
  input: number;
  cachedInput: number;
  cacheWrite: number | null;
  output: number;
  reasoning: number;
}

interface Endpoint { provider: string; prices: Prices }

const PRICE_TTL_MS = 60 * 60 * 1000;
let endpointCache: { at: number; model: string; list: Endpoint[] } | null = null;

/** Per-token price strings → USD per million tokens. */
function perMillion(v: unknown): number | null {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : Math.round(n * 1e12) / 1e6;
}

/** The model's endpoints and their list prices. Public; cached for an hour. */
async function endpoints(model: string): Promise<Endpoint[]> {
  if (endpointCache && endpointCache.model === model && Date.now() - endpointCache.at < PRICE_TTL_MS) {
    return endpointCache.list;
  }
  const res = await fetch(`${API}/models/${model}/endpoints`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OpenRouter endpoints ${res.status}`);
  const body = await res.json() as {
    data?: { endpoints?: Array<{ provider_name?: string; pricing?: Record<string, string> }> };
  };
  const list: Endpoint[] = [];
  for (const e of body.data?.endpoints ?? []) {
    const p = e.pricing ?? {};
    const input = perMillion(p.prompt);
    const output = perMillion(p.completion);
    if (!e.provider_name || input === null || output === null) continue;
    list.push({
      provider: e.provider_name,
      prices: {
        input,
        // A provider without a cache price bills every prompt token at the input price.
        cachedInput: perMillion(p.input_cache_read) ?? input,
        cacheWrite: perMillion(p.input_cache_write),
        output,
        reasoning: perMillion(p.internal_reasoning) ?? output,
      },
    });
  }
  endpointCache = { at: Date.now(), model, list };
  return list;
}

function priceOf(p: Prices, u: Usage): number {
  const prompt = u.prompt_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const written = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  const completion = u.completion_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  return ((prompt - cached - written) * p.input + cached * p.cachedInput + written * (p.cacheWrite ?? p.input) +
    (completion - reasoning) * p.output + reasoning * p.reasoning) / 1e6;
}

/**
 * The prices of the endpoint that served the call. A provider can list several
 * endpoints (variants); the one whose prices reproduce the amount charged wins,
 * else the cheapest within the cap.
 */
async function servedPrices(model: string, provider: string | null, usage: Usage | undefined): Promise<Prices | null> {
  if (!provider) return null;
  let list: Endpoint[];
  try {
    list = (await endpoints(model)).filter((e) => e.provider.toLowerCase() === provider.toLowerCase());
  } catch (err) {
    console.error('openrouter: price list unavailable', err);
    return null;
  }
  if (!list.length) return null;
  if (usage && typeof usage.cost === 'number') {
    const match = list.find((e) => Math.abs(priceOf(e.prices, usage) - usage.cost!) < 1e-9);
    if (match) return match.prices;
  }
  const capped = list.filter((e) => e.prices.input <= MAX_PRICE.prompt && e.prices.output <= MAX_PRICE.completion);
  return (capped.length ? capped : list).sort((a, b) => a.prices.input - b.prices.input)[0].prices;
}

// ─── Request ──────────────────────────────────────────────────────────────────

function retryAfterMs(res: Response | null): number | null {
  const v = res?.headers.get('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS) : null;
}

/** JSON text, without a code fence or prose around it. */
function jsonText(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : content).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function short(message: string): string {
  return message.replace(/\s+/g, ' ').slice(0, 500);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chatJson<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
  const apiKey = Deno.env.get('OPENROUTER_API_KEY');
  if (!apiKey) throw new ModelCallError('OPENROUTER_API_KEY non configurée.', []);

  const payload = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: req.schemaName, strict: true, schema: req.schema },
    },
    reasoning: { effort: EFFORT },
    max_tokens: MAX_TOKENS,
    provider: {
      order: PROVIDERS,
      only: PROVIDERS,
      require_parameters: true,
      data_collection: 'deny',
      max_price: MAX_PRICE,
    },
  });
  const promptChars = req.system.length + req.user.length;
  const calls: CallRecord[] = [];
  let lastError = 'Aucune tentative.';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = req.deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      lastError = `${lastError} (plus assez de temps pour réessayer)`;
      break;
    }
    const started = Date.now();
    const call: CallRecord = {
      created_at: new Date(started).toISOString(),
      attempt,
      api: 'openrouter',
      generation_id: null,
      model_requested: MODEL,
      model_used: null,
      provider: null,
      reasoning_effort: EFFORT,
      max_tokens: MAX_TOKENS,
      outcome: 'ok',
      http_status: null,
      finish_reason: null,
      native_finish_reason: null,
      error: null,
      prompt_tokens: null,
      cached_tokens: null,
      cache_write_tokens: null,
      completion_tokens: null,
      reasoning_tokens: null,
      total_tokens: null,
      price_input_per_mtok: null,
      price_cached_input_per_mtok: null,
      price_cache_write_per_mtok: null,
      price_output_per_mtok: null,
      price_reasoning_per_mtok: null,
      cost_usd: null,
      cost_upstream_usd: null,
      is_byok: null,
      latency_ms: 0,
      prompt_chars: promptChars,
      response_chars: null,
      usage: null,
    };
    calls.push(call);

    let res: Response | null = null;
    let body: CompletionBody | null = null;
    let retryable = true;
    try {
      res = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'Affichez - Resume IA',
        },
        body: payload,
        signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, remaining)),
      });
      call.http_status = res.status;
      const text = await res.text();
      try { body = JSON.parse(text) as CompletionBody; } catch { body = null; }
      if (!body) {
        call.outcome = 'http_error';
        call.error = short(`Réponse illisible (${res.status}) : ${text}`);
        retryable = !FINAL_STATUSES.has(res.status);
      }
    } catch (err) {
      const timedOut = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
      call.outcome = timedOut ? 'timeout' : 'network_error';
      call.error = short(timedOut ? `Pas de réponse en ${Math.round((Date.now() - started) / 1000)} s.` : String(err));
    }
    call.latency_ms = Date.now() - started;

    if (body) {
      const u = body.usage;
      const choice = body.choices?.[0];
      call.generation_id = body.id ?? null;
      call.model_used = body.model ?? null;
      call.provider = body.provider ?? body.error?.metadata?.provider_name ?? null;
      call.finish_reason = choice?.finish_reason ?? null;
      call.native_finish_reason = choice?.native_finish_reason ?? null;
      if (u) {
        call.usage = u;
        call.prompt_tokens = u.prompt_tokens ?? null;
        call.cached_tokens = u.prompt_tokens_details?.cached_tokens ?? 0;
        call.cache_write_tokens = u.prompt_tokens_details?.cache_write_tokens ?? 0;
        call.completion_tokens = u.completion_tokens ?? null;
        call.reasoning_tokens = u.completion_tokens_details?.reasoning_tokens ?? 0;
        call.total_tokens = u.total_tokens ?? null;
        call.cost_usd = typeof u.cost === 'number' ? u.cost : null;
        call.cost_upstream_usd = typeof u.cost_details?.upstream_inference_cost === 'number'
          ? u.cost_details.upstream_inference_cost
          : null;
        call.is_byok = typeof u.is_byok === 'boolean' ? u.is_byok : null;
        const prices = await servedPrices(MODEL, call.provider, u);
        if (prices) {
          call.price_input_per_mtok = prices.input;
          call.price_cached_input_per_mtok = prices.cachedInput;
          call.price_cache_write_per_mtok = prices.cacheWrite;
          call.price_output_per_mtok = prices.output;
          call.price_reasoning_per_mtok = prices.reasoning;
        }
      }

      const err = body.error ?? choice?.error ?? null;
      const content = choice?.message?.content ?? '';
      call.response_chars = content.length;
      if (err || !res?.ok) {
        const code = Number(err?.code ?? res?.status);
        call.outcome = 'http_error';
        call.error = short(`${err?.code ?? res?.status} ${err?.message ?? 'erreur OpenRouter'}`);
        retryable = !FINAL_STATUSES.has(code);
      } else if (call.finish_reason === 'content_filter' || choice?.message?.refusal) {
        call.outcome = 'refused';
        call.error = short(choice?.message?.refusal || 'Réponse bloquée par le filtre du fournisseur.');
        retryable = false;
      } else if (call.finish_reason === 'length') {
        call.outcome = 'truncated';
        call.error = `Réponse tronquée à ${MAX_TOKENS} jetons (dont ${call.reasoning_tokens ?? '?'} de réflexion).`;
      } else if (!content.trim()) {
        call.outcome = 'empty';
        call.error = `Réponse vide (fin : ${call.finish_reason ?? 'inconnue'}).`;
      } else {
        try {
          const value = req.parse(jsonText(content));
          return { value, model: call.model_used ?? MODEL, calls };
        } catch (parseErr) {
          call.outcome = 'invalid_output';
          call.error = short(`Réponse hors format : ${parseErr instanceof Error ? parseErr.message : parseErr}`);
        }
      }
    }

    lastError = call.error ?? call.outcome;
    console.warn('openrouter: attempt failed', attempt, call.outcome, call.http_status, call.provider, lastError);
    if (!retryable || attempt === MAX_ATTEMPTS) break;
    const wait = retryAfterMs(res) ?? BACKOFF_MS[attempt - 1] + Math.floor(Math.random() * 1_000);
    if (Date.now() + wait + MIN_ATTEMPT_MS > req.deadline) break;
    await sleep(wait);
  }

  throw new ModelCallError(`Le modèle n'a pas répondu correctement : ${lastError}`, calls);
}
