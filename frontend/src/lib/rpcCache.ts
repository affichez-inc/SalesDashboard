import { supabase } from './supabase';

/**
 * A short-lived cache in front of `supabase.rpc`, so navigating back to a page
 * you were just on does not refetch everything from zero.
 *
 * Three things, and only three:
 *
 * 1. **A TTL.** Inside it, a repeat call resolves from memory with no network
 *    at all - the page paints on the next frame. This is what makes moving
 *    between screens instant.
 * 2. **In-flight de-duplication.** Two callers asking for the same thing before
 *    the first reply lands share one request. That is what makes `prefetch()`
 *    worth anything: hovering a nav link starts the query, and the page's own
 *    call a moment later joins it instead of starting a second one.
 * 3. **Explicit invalidation**, for the Realtime subscriptions and the
 *    "Actualiser" buttons.
 *
 * **Stale data is never served.** A common trick here is stale-while-
 * revalidate: paint the old numbers immediately, fetch in the background, swap
 * them when it lands. It is faster still, and it is the wrong trade for this
 * app - these are sales figures people quote in meetings, and a revenue total
 * that silently changes a second after you read it is worse than one that took
 * a second to arrive. Past the TTL we wait for the real answer.
 *
 * The TTLs are set against how often the data underneath can actually change,
 * which is the Zoho sync cadence - five minutes for invoices, twelve hours for
 * accounts and leads. Sixty seconds is comfortably inside all of them.
 */

type Key = string;

interface Entry {
    /** When the value landed. */
    at: number;
    value: unknown;
}

const cache = new Map<Key, Entry>();
const inflight = new Map<Key, Promise<unknown>>();

/** Enough for a session's worth of filter combinations without growing forever. */
const MAX_ENTRIES = 240;

const DEFAULT_TTL = 60_000;

/**
 * Filter dropdowns, rep lists, available weeks: derived from whole tables, and
 * they only change when a sync brings in a value nobody had used before. They
 * are also the slowest queries in the app, so they are the ones worth holding.
 */
const LONG_TTL = 10 * 60_000;

const TTL_BY_FN: Record<string, number> = {
    get_zoho_account_filter_options: LONG_TTL,
    get_zoho_lead_filter_options: LONG_TTL,
    get_ad_filter_options: LONG_TTL,
    get_tasks_available_weeks: LONG_TTL,
    get_available_weeks: LONG_TTL,
    get_inv_available_weeks: LONG_TTL,
    get_zoho_accounts_filter_regions: LONG_TTL,
    get_document_list_options: LONG_TTL,
    // The top of the amount slider: a scale, not a figure anyone reads.
    get_account_spend_max: LONG_TTL,
};

/**
 * Object key order is not guaranteed across call sites, and `{a:1,b:2}` and
 * `{b:2,a:1}` are the same query. Sorting the keys means they share a cache
 * entry instead of quietly doubling the traffic.
 */
function stableKey(fn: string, args?: Record<string, unknown>): Key {
    if (!args) return fn;
    const parts: string[] = [];
    for (const k of Object.keys(args).sort()) {
        const v = args[k];
        if (v === undefined) continue;
        parts.push(`${k}=${JSON.stringify(v)}`);
    }
    return `${fn}(${parts.join(',')})`;
}

function remember(key: Key, value: unknown) {
    cache.set(key, { at: Date.now(), value });
    if (cache.size > MAX_ENTRIES) {
        // Map preserves insertion order, so the first key is the oldest write.
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
}

export interface CachedRpcOptions {
    /** Override the TTL in ms. 0 forces a fresh read and still fills the cache. */
    ttl?: number;
    /**
     * The RPC returns one row and the caller wants the row, not an array -
     * the cached equivalent of `.single()`. Unlike `.single()` this does not
     * error when the RPC returns nothing; it resolves to null, which is what
     * every call site here already handles.
     */
    single?: boolean;
}

export interface CachedRpcResult<T> {
    data: T | null;
    error: unknown;
}

/**
 * `supabase.rpc(fn, args)`, cached.
 *
 * Errors are returned, never cached - a failed request must not pin a page to
 * an error for the next minute.
 */
// `T` defaults the way supabase.rpc's own `data` is typed. Every call site here
// already casts the result to a row type from src/types/database.ts - narrowing
// the default to `unknown` would only force those same casts to be written
// twice. Pass the type parameter where the result is used directly, as the
// `single: true` callers do.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cachedRpc<T = any>(
    fn: string,
    args?: Record<string, unknown>,
    opts: CachedRpcOptions = {},
): Promise<CachedRpcResult<T>> {
    const key = stableKey(fn, args) + (opts.single ? '#single' : '');
    const ttl = opts.ttl ?? TTL_BY_FN[fn] ?? DEFAULT_TTL;

    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) {
        return Promise.resolve({ data: hit.value as T, error: null });
    }

    const pending = inflight.get(key);
    if (pending) return pending as Promise<CachedRpcResult<T>>;

    const run = (async (): Promise<CachedRpcResult<T>> => {
        try {
            const { data, error } = await supabase.rpc(fn, args ?? {});
            if (error) return { data: null, error };
            const value = opts.single
                ? ((Array.isArray(data) ? data[0] : data) ?? null)
                : (data ?? null);
            remember(key, value);
            return { data: value as T, error: null };
        } finally {
            inflight.delete(key);
        }
    })();

    inflight.set(key, run);
    return run;
}

/**
 * Warm the cache without caring about the answer.
 *
 * Used on nav-link hover. Failures are swallowed on purpose: this is
 * speculative work the user never asked for, and it must not surface an error
 * or reject unhandled.
 */
export function prefetchRpc(fn: string, args?: Record<string, unknown>, opts: CachedRpcOptions = {}): void {
    void cachedRpc(fn, args, opts).catch(() => undefined);
}

/**
 * Drop cached answers.
 *
 * With no argument, everything - what a Realtime event or a sign-out wants.
 * With a prefix, just the functions whose name starts with it, so
 * `invalidateRpcCache('get_inv_')` clears the invoice screens and leaves the
 * rest alone.
 */
export function invalidateRpcCache(fnPrefix?: string): void {
    if (!fnPrefix) {
        cache.clear();
        return;
    }
    for (const key of [...cache.keys()]) {
        if (key.startsWith(fnPrefix)) cache.delete(key);
    }
}
