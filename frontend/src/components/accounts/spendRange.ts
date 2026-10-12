/**
 * The "Montant facturé" filter on Comptes · Détail: which amount it reads, over
 * which period, and the scale its slider moves on.
 *
 * Amounts are net (credit notes subtracted), from zoho_accounts_enriched. Each
 * period is a column of that view, computed on Montreal's calendar, so the
 * filter is a plain PostgREST comparison and the table, the count and the
 * export all read the same figure.
 */
import type { AccountSpendMax, ZohoAccountRow } from '../../types/database';

export type SpendPeriodKey = 'tout' | '12m' | 'annee' | 'annee-1' | 'mois-1' | '30j';

type SpendColumn = keyof Pick<ZohoAccountRow,
    'revenue_lifetime' | 'revenue_12m' | 'revenue_ytd' | 'revenue_prev_year'
    | 'revenue_last_month' | 'revenue_30d'>;

type MaxKey = Exclude<keyof AccountSpendMax, 'today'>;

export type SpendPeriod = {
    key: SpendPeriodKey;
    column: SpendColumn;
    maxKey: MaxKey;
};

/** In the order the chips are shown. The first is the default. */
export const SPEND_PERIODS: readonly SpendPeriod[] = [
    { key: 'tout',    column: 'revenue_lifetime',   maxKey: 'lifetime' },
    { key: '12m',     column: 'revenue_12m',        maxKey: 'last_12m' },
    { key: 'annee',   column: 'revenue_ytd',        maxKey: 'ytd' },
    { key: 'annee-1', column: 'revenue_prev_year',  maxKey: 'prev_year' },
    { key: 'mois-1',  column: 'revenue_last_month', maxKey: 'last_month' },
    { key: '30j',     column: 'revenue_30d',        maxKey: 'last_30d' },
];

export const DEFAULT_SPEND_PERIOD: SpendPeriodKey = 'tout';

export function spendPeriod(key: string): SpendPeriod {
    return SPEND_PERIODS.find(p => p.key === key) ?? SPEND_PERIODS[0];
}

const MONTH_NAMES = [
    'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

/**
 * "today" is the database's Montreal date (get_account_spend_max), so "le mois
 * dernier" names the month the figures were computed for. Without it, the
 * browser's own date stands in.
 */
function parts(today: string | null): { y: number; m: number } {
    if (today && /^\d{4}-\d{2}-\d{2}$/.test(today)) {
        return { y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) };
    }
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() + 1 };
}

/** The chip label. */
export function spendPeriodLabel(key: SpendPeriodKey, today: string | null): string {
    const { y, m } = parts(today);
    switch (key) {
        case 'tout': return 'Depuis toujours';
        case '12m': return '12 derniers mois';
        case 'annee': return `Année ${y}`;
        case 'annee-1': return `Année ${y - 1}`;
        case 'mois-1': {
            const pm = m === 1 ? 12 : m - 1;
            const py = m === 1 ? y - 1 : y;
            const name = MONTH_NAMES[pm - 1];
            return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${py}`;
        }
        case '30j': return '30 derniers jours';
    }
}

/** The short form, for the trigger and a table heading. */
export function spendPeriodShort(key: SpendPeriodKey, today: string | null): string {
    switch (key) {
        case 'tout': return 'total';
        case '12m': return '12 mois';
        case '30j': return '30 jours';
        default: return spendPeriodLabel(key, today).toLowerCase().replace(/^année /, '');
    }
}

// ─── Amounts as text ──────────────────────────────────────────────────────────

/** 10 000 → "10 k$", 2 500 000 → "2,5 M$", 750 → "750 $". For labels, not cells. */
export function formatCompactAmount(v: number): string {
    const fmt = (n: number, unit: string) =>
        `${n.toLocaleString('fr-CA', { maximumFractionDigits: n < 10 ? 1 : 0 })} ${unit}`;
    if (Math.abs(v) >= 1_000_000) return fmt(v / 1_000_000, 'M$');
    if (Math.abs(v) >= 1_000) return fmt(v / 1_000, 'k$');
    return `${Math.round(v).toLocaleString('fr-CA')} $`;
}

/** 10000 → "10 000 $", the form an input shows once it loses focus. */
export function formatInputAmount(v: number): string {
    return `${Math.round(v).toLocaleString('fr-CA')} $`;
}

/**
 * What a person types, as dollars: "10000", "10 000 $", "10k", "2,5 M",
 * "1.5m". Null for an empty or unreadable entry.
 */
export function parseAmount(raw: string): number | null {
    let s = raw.trim().toLowerCase().replace(/\$/g, '').replace(/\s/g, '');
    if (!s) return null;
    // "25,000" or "1,250,000" with no k/M is a thousands separator typed the
    // English way, not 25 dollars. "2,5" and "2,5 M" stay decimals.
    if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
    const m = s.match(/^(\d+(?:[.,]\d+)?)(k|m)?$/);
    if (!m) return null;
    const n = Number(m[1].replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    const mult = m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1;
    return Math.round(n * mult);
}

// ─── The slider scale ─────────────────────────────────────────────────────────
//
// Billed amounts are spread over five orders of magnitude: half the invoiced
// accounts are under about 2 k$ and one is near 5 M$. On a straight line from 0
// to 5 M$ everything under 50 k$ would sit in the first 1% of the track, which is
// where nearly every account is. So the track is a ladder of round values at
// equal spacing, with a geometric step inside each rung: 1 k$ to 10 k$ takes as
// much track as 100 k$ to 1 M$.

const LADDER = [
    0, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000,
    100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000,
    10_000_000, 25_000_000, 50_000_000,
];

/** The track never stops below this, so a quiet month still has a usable scale. */
const MIN_TOP = 10_000;

/** Slider resolution: an integer position in [0, SLIDER_STEPS]. */
export const SLIDER_STEPS = 1000;

export type SpendScale = {
    /** Round values at equal spacing along the track; the last is the top. */
    stops: number[];
};

/** The scale for a period whose largest amount is `max`. */
export function spendScale(max: number | null | undefined): SpendScale {
    const target = Math.max(MIN_TOP, max ?? 0);
    const idx = LADDER.findIndex(v => v >= target);
    const stops = LADDER.slice(0, (idx === -1 ? LADDER.length - 1 : idx) + 1);
    return { stops };
}

export function scaleTop(scale: SpendScale): number {
    return scale.stops[scale.stops.length - 1];
}

/** The rounding step for an amount of this size. */
function stepFor(v: number): number {
    return v < 1_000 ? 10 : v < 10_000 ? 100 : v < 100_000 ? 500 : v < 1_000_000 ? 5_000 : 25_000;
}

/** Rounds to a step that suits the magnitude, so a dragged thumb lands on 12 500, not 12 487. */
function niceRound(v: number): number {
    const step = stepFor(v);
    return Math.round(v / step) * step;
}

/**
 * The next round amount from `v` in direction `dir`. An arrow key moves the
 * slider one position, which near a round value can round straight back to it
 * (1 000 → 1 014 → 1 000) and leave the thumb stuck; the slider steps to this
 * instead when that happens.
 */
export function nextRoundAmount(v: number, dir: 1 | -1): number {
    if (dir > 0) return v + stepFor(v);
    const down = Math.max(0, v - stepFor(Math.max(0, v - 1)));
    return down;
}

export function positionToValue(pos: number, scale: SpendScale): number {
    const { stops } = scale;
    const segs = stops.length - 1;
    const p = Math.min(1, Math.max(0, pos / SLIDER_STEPS)) * segs;
    const i = Math.min(segs - 1, Math.floor(p));
    const t = p - i;
    const a = stops[i], b = stops[i + 1];
    // The first rung starts at zero, where a geometric step is undefined.
    const v = a === 0 ? b * t : a * Math.pow(b / a, t);
    return Math.min(scaleTop(scale), niceRound(v));
}

export function valueToPosition(v: number, scale: SpendScale): number {
    const { stops } = scale;
    const segs = stops.length - 1;
    if (v <= 0) return 0;
    if (v >= scaleTop(scale)) return SLIDER_STEPS;
    let i = stops.findIndex(s => s > v) - 1;
    if (i < 0) i = 0;
    const a = stops[i], b = stops[i + 1];
    const t = a === 0 ? v / b : Math.log(v / a) / Math.log(b / a);
    return Math.round(((i + t) / segs) * SLIDER_STEPS);
}

/**
 * Labels closer than this (a share of the track) would print over each other
 * on a phone, where the track is about 300px and the last label, aligned to the
 * end, takes its whole width to the left of it.
 */
const MIN_TICK_GAP = 0.17 * SLIDER_STEPS;

/**
 * The labelled ticks under the track: zero, each power of ten from 1 k$, and
 * the top. Walking down from the top, a tick too close to the one kept after
 * it is dropped, so "1 M$" never prints over "2,5 M$+".
 */
export function scaleTicks(scale: SpendScale): Array<{ value: number; pos: number }> {
    const segs = scale.stops.length - 1;
    const all = scale.stops.map((value, i) => ({ value, pos: (i / segs) * SLIDER_STEPS }));
    const candidates = all.filter((t, i) =>
        t.value === 0 || i === segs || (t.value >= 1_000 && Math.log10(t.value) % 1 === 0));
    const kept: Array<{ value: number; pos: number }> = [];
    for (let i = candidates.length - 1; i >= 0; i--) {
        const t = candidates[i];
        const next = kept[0];
        if (!next || next.pos - t.pos >= MIN_TICK_GAP || t.value === 0) kept.unshift(t);
    }
    // Zero is always kept; if that crowded the first power of ten, drop the latter.
    if (kept.length > 2 && kept[1].pos - kept[0].pos < MIN_TICK_GAP) kept.splice(1, 1);
    return kept;
}

// ─── The applied filter ───────────────────────────────────────────────────────

/** null on either side is "no bound". Both null is "no filter". */
export type SpendRange = { min: number | null; max: number | null; period: SpendPeriodKey };

export function isSpendFilterActive(r: SpendRange): boolean {
    return (r.min !== null && r.min > 0) || r.max !== null;
}

/** "≥ 10 k$", "≤ 5 k$", "5 k$ – 20 k$". */
export function describeSpendRange(r: Pick<SpendRange, 'min' | 'max'>): string {
    const lo = r.min !== null && r.min > 0 ? r.min : null;
    if (lo !== null && r.max !== null) return `${formatCompactAmount(lo)} – ${formatCompactAmount(r.max)}`;
    if (lo !== null) return `≥ ${formatCompactAmount(lo)}`;
    if (r.max !== null) return `≤ ${formatCompactAmount(r.max)}`;
    return 'Tous les montants';
}
