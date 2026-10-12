import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { AccountSpendMax } from '../../types/database';
import {
    SPEND_PERIODS, SLIDER_STEPS, spendPeriod, spendPeriodLabel, spendPeriodShort,
    spendScale, scaleTop, scaleTicks, positionToValue, valueToPosition, nextRoundAmount,
    parseAmount, formatInputAmount, formatCompactAmount, describeSpendRange,
    isSpendFilterActive,
    type SpendRange, type SpendPeriodKey,
} from './spendRange';

/** "≥ X" shortcuts: the thresholds people actually ask for. */
const PRESETS = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000];

/** How long the draft has to sit still before the count is asked for. */
const PREVIEW_DEBOUNCE_MS = 350;

/**
 * "Montant facturé": a min/max filter on what an account was billed, over a
 * period.
 *
 * A popover rather than an inline control, because a slider the width of a
 * filter dropdown cannot be aimed: the track would be 200px for five orders of
 * magnitude. The slider moves on a ladder of round values (see spendScale) and
 * the two inputs take any figure, typed as "10000", "10 k" or "2,5 M".
 *
 * Nothing reaches the URL until Apply: dragging a thumb would otherwise refetch
 * the table on every pixel. The live count under the slider is what tells the
 * user where they are before they commit.
 */
export function AmountRangeFilter({ value, onApply, maxima, previewCount, className }: {
    value: SpendRange;
    onApply: (next: SpendRange) => void;
    /** The largest amount per period, which sets the top of the track. */
    maxima: AccountSpendMax | null;
    /** How many accounts a draft would keep, with every other filter applied. */
    previewCount?: (draft: SpendRange) => Promise<number | null>;
    className?: string;
}) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<SpendRange>(value);
    const [minText, setMinText] = useState('');
    const [maxText, setMaxText] = useState('');
    const [preview, setPreview] = useState<{ key: string; n: number | null }>({ key: '', n: null });
    const containerRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    const today = maxima?.today ?? null;
    const active = isSpendFilterActive(value);

    const period = spendPeriod(draft.period);
    const scale = useMemo(() => spendScale(maxima?.[period.maxKey] ?? null), [maxima, period.maxKey]);
    const top = scaleTop(scale);
    const ticks = useMemo(() => scaleTicks(scale), [scale]);

    const syncTexts = useCallback((r: SpendRange) => {
        setMinText(r.min !== null && r.min > 0 ? formatInputAmount(r.min) : '');
        setMaxText(r.max !== null ? formatInputAmount(r.max) : '');
    }, []);

    /** Opening starts from what is applied, so Cancel always means "as it was". */
    const openPanel = () => {
        setDraft(value);
        syncTexts(value);
        // The last count was taken with the other filters as they were then; a
        // filter changed since would leave it on screen, unmarked, until the new
        // count lands.
        setPreview({ key: '', n: null });
        setOpen(true);
    };
    const close = useCallback(() => setOpen(false), []);

    // The panel is wider than its trigger. Measured before paint: when it would
    // run off the right, it hangs from the trigger's right edge like the
    // dropdowns do; and whatever happens it stays 8px clear of both edges,
    // because on a 390px phone hanging it from the trigger alone still ran 16px
    // off the left.
    useLayoutEffect(() => {
        const panel = panelRef.current;
        const anchor = containerRef.current;
        if (!open || !panel || !anchor) return;
        const vw = document.documentElement.clientWidth;
        const r = panel.getBoundingClientRect();
        let shift = 0;
        if (r.right > vw - 8) shift = anchor.getBoundingClientRect().width - r.width;
        if (r.right + shift > vw - 8) shift = vw - 8 - r.right;
        if (r.left + shift < 8) shift = 8 - r.left;
        panel.style.marginLeft = shift ? `${shift}px` : '';
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) close();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open, close]);

    // The count follows the draft, debounced. The answer remembers which draft
    // it was for: any other draft reads as "still counting", and a slower answer
    // to an older draft is dropped rather than shown over the newer one.
    const draftKey = `${draft.min}|${draft.max}|${draft.period}`;
    const previewSeq = useRef(0);
    useEffect(() => {
        if (!open || !previewCount) return;
        const seq = ++previewSeq.current;
        const t = setTimeout(async () => {
            const n = await previewCount(draft);
            if (seq === previewSeq.current) setPreview({ key: draftKey, n });
        }, PREVIEW_DEBOUNCE_MS);
        return () => clearTimeout(t);
    }, [open, draft, draftKey, previewCount]);
    const previewLoading = preview.key !== draftKey;

    const invalid = draft.min !== null && draft.max !== null && draft.min > draft.max;

    const apply = () => {
        if (invalid) return;
        // A minimum of zero is no minimum: the bottom of the track is "anything".
        onApply({ ...draft, min: draft.min && draft.min > 0 ? draft.min : null });
        close();
    };

    const reset = () => {
        const cleared: SpendRange = { min: null, max: null, period: draft.period };
        setDraft(cleared);
        syncTexts(cleared);
    };

    // ─── Slider ──────────────────────────────────────────────────────────────
    const minPos = draft.min && draft.min > 0 ? valueToPosition(draft.min, scale) : 0;
    const maxPos = draft.max === null ? SLIDER_STEPS : valueToPosition(draft.max, scale);

    // Both handlers work on amounts, not only positions: positions round to
    // round amounts, and two thumbs that meet must never leave min > max. A move
    // that rounds back to where the thumb was (an arrow key near a round value)
    // steps to the next round amount instead, so the keyboard never gets stuck.
    const onMinSlide = (raw: number) => {
        const cur = draft.min ?? 0;
        let v = raw <= 0 ? 0 : positionToValue(raw, scale);
        if (raw > minPos && v <= cur) v = nextRoundAmount(cur, 1);
        if (raw < minPos && v >= cur) v = nextRoundAmount(cur, -1);
        if (draft.max !== null) v = Math.min(v, draft.max);
        const min = v > 0 ? v : null;
        setDraft({ ...draft, min });
        setMinText(min !== null ? formatInputAmount(min) : '');
    };
    const onMaxSlide = (raw: number) => {
        // The end of the track is "no maximum", not the largest amount on file:
        // an account that grows past it next month must not drop out of a saved
        // link. So is any amount that rounds to the top.
        const cur = draft.max ?? top;
        let v = raw >= SLIDER_STEPS ? top : positionToValue(raw, scale);
        if (raw < maxPos && v >= cur) v = nextRoundAmount(cur, -1);
        if (raw > maxPos && v <= cur) v = nextRoundAmount(cur, 1);
        let max: number | null = v >= top ? null : v;
        if (max !== null && draft.min !== null) max = Math.max(max, draft.min);
        setDraft({ ...draft, max });
        setMaxText(max !== null ? formatInputAmount(max) : '');
    };

    // ─── Inputs ──────────────────────────────────────────────────────────────
    const commitMin = () => {
        const v = parseAmount(minText);
        const min = v !== null && v > 0 ? v : null;
        setDraft(d => ({ ...d, min }));
        setMinText(min !== null ? formatInputAmount(min) : '');
    };
    const commitMax = () => {
        const v = parseAmount(maxText);
        setDraft(d => ({ ...d, max: v }));
        setMaxText(v !== null ? formatInputAmount(v) : '');
    };
    /** Enter commits the field and applies, with the field's value read directly. */
    const onInputKey = (which: 'min' | 'max') => (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const v = parseAmount(which === 'min' ? minText : maxText);
        const next: SpendRange = which === 'min'
            ? { ...draft, min: v !== null && v > 0 ? v : null }
            : { ...draft, max: v };
        if (next.min !== null && next.max !== null && next.min > next.max) {
            setDraft(next);
            syncTexts(next);
            return;
        }
        onApply(next);
        close();
    };

    const setPeriod = (key: SpendPeriodKey) => setDraft(d => ({ ...d, period: key }));
    const setPreset = (min: number) => {
        const next = { ...draft, min, max: null };
        setDraft(next);
        syncTexts(next);
    };

    // ─── Trigger label ───────────────────────────────────────────────────────
    const triggerLabel = active ? describeSpendRange(value) : 'Tous les montants';
    const triggerPeriod = active && value.period !== 'tout' ? spendPeriodShort(value.period, today) : null;

    const leftPct = (minPos / SLIDER_STEPS) * 100;
    const rightPct = (maxPos / SLIDER_STEPS) * 100;

    return (
        <div ref={containerRef} className={cn('relative max-w-full', className)}>
            <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => (open ? close() : openPanel())}
                className={cn(
                    'flex items-center gap-2 w-full pl-3 pr-2.5 py-2 rounded-md text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-primary/25 select-none',
                    'bg-sand text-ink-secondary hover:bg-stone',
                    open && 'bg-stone ring-2 ring-hairline-strong',
                )}
            >
                <span className="flex-1 text-left truncate" translate="no">
                    {triggerLabel}
                    {triggerPeriod && <span className="text-ink-mute font-normal"> · {triggerPeriod}</span>}
                </span>
                <ChevronDown className={cn('w-3.5 h-3.5 shrink-0 text-ink-mute transition-transform duration-150', open && 'rotate-180')} />
            </button>

            {open && (
                <div
                    ref={panelRef}
                    role="dialog"
                    aria-label="Filtrer par montant facturé"
                    className="absolute z-50 top-full mt-1.5 left-0 w-[28rem] max-w-[calc(100vw-1rem)]
                               bg-white rounded-lg border border-hairline shadow-xl menu-in"
                >
                    <div className="px-5 pt-4 pb-3 border-b border-hairline">
                        <p className="text-sm font-semibold text-ink">Montant facturé</p>
                        <p className="text-xs text-ink-mute mt-0.5">
                            Factures moins avoirs, sur la période choisie.
                        </p>
                    </div>

                    <div className="px-5 py-4 space-y-5">
                        {/* Period */}
                        <div>
                            <p className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow mb-2">Période</p>
                            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Période">
                                {SPEND_PERIODS.map(p => {
                                    const on = draft.period === p.key;
                                    return (
                                        <button
                                            key={p.key}
                                            type="button"
                                            role="radio"
                                            aria-checked={on}
                                            onClick={() => setPeriod(p.key)}
                                            className={cn(
                                                'px-2.5 py-1 rounded-full text-xs font-semibold transition-colors border',
                                                on
                                                    ? 'bg-ink text-white border-ink'
                                                    : 'bg-white text-ink-secondary border-hairline-strong hover:border-ink/40 hover:bg-sand',
                                            )}
                                        >
                                            {spendPeriodLabel(p.key, today)}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Slider */}
                        <div>
                            <div className="relative h-5">
                                {/* Inset by half a thumb: a thumb's centre travels from
                                    0.625rem to the width minus 0.625rem, and the fill
                                    and the ticks have to line up with it. */}
                                <div className="absolute inset-y-0 left-2.5 right-2.5" aria-hidden="true">
                                    <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-stone" />
                                    <div
                                        className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-ink"
                                        style={{ left: `${leftPct}%`, right: `${100 - rightPct}%` }}
                                    />
                                </div>
                                <input
                                    type="range" min={0} max={SLIDER_STEPS} step={1}
                                    value={minPos}
                                    onChange={e => onMinSlide(Number(e.target.value))}
                                    aria-label="Montant minimum"
                                    aria-valuetext={draft.min ? formatInputAmount(draft.min) : 'Aucun minimum'}
                                    className="range-dual"
                                    // Two thumbs parked together at the top end: the
                                    // minimum has to be the one on top, or it can
                                    // never be dragged back down.
                                    style={{ zIndex: minPos > SLIDER_STEPS - 20 ? 4 : 3 }}
                                />
                                <input
                                    type="range" min={0} max={SLIDER_STEPS} step={1}
                                    value={maxPos}
                                    onChange={e => onMaxSlide(Number(e.target.value))}
                                    aria-label="Montant maximum"
                                    aria-valuetext={draft.max !== null ? formatInputAmount(draft.max) : 'Aucun maximum'}
                                    className="range-dual"
                                    style={{ zIndex: 3 }}
                                />
                            </div>
                            <div className="relative h-4 mt-1.5 mx-2.5" aria-hidden="true">
                                {ticks.map(t => (
                                    <span
                                        key={t.value}
                                        // The end labels align to the ends of the track
                                        // rather than centre on them and overhang.
                                        className={cn(
                                            'absolute text-2xs text-ink-faint tabular-nums whitespace-nowrap',
                                            t.pos === 0 ? '' : t.pos === SLIDER_STEPS ? '-translate-x-full' : '-translate-x-1/2',
                                        )}
                                        style={{ left: `${(t.pos / SLIDER_STEPS) * 100}%` }}
                                    >
                                        {t.value === top ? `${formatCompactAmount(t.value)}+` : formatCompactAmount(t.value)}
                                    </span>
                                ))}
                            </div>
                        </div>

                        {/* Inputs */}
                        <div className="flex items-end gap-2">
                            <label className="flex-1 min-w-0">
                                <span className="block text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow mb-1">Minimum</span>
                                <input
                                    value={minText}
                                    onChange={e => setMinText(e.target.value)}
                                    onBlur={commitMin}
                                    onKeyDown={onInputKey('min')}
                                    inputMode="decimal"
                                    placeholder="Aucun minimum"
                                    aria-invalid={invalid || undefined}
                                    className="form-input h-9 tabular-nums"
                                />
                            </label>
                            <span className="pb-2 text-ink-faint">–</span>
                            <label className="flex-1 min-w-0">
                                <span className="block text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow mb-1">Maximum</span>
                                <input
                                    value={maxText}
                                    onChange={e => setMaxText(e.target.value)}
                                    onBlur={commitMax}
                                    onKeyDown={onInputKey('max')}
                                    inputMode="decimal"
                                    placeholder="Aucun maximum"
                                    aria-invalid={invalid || undefined}
                                    className="form-input h-9 tabular-nums"
                                />
                            </label>
                        </div>
                        {invalid && (
                            <p className="-mt-3 text-xs text-tone-critical-ink">Le minimum dépasse le maximum.</p>
                        )}

                        {/* Shortcuts */}
                        <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow mr-1">Raccourcis</span>
                            {PRESETS.map(p => {
                                const on = draft.min === p && draft.max === null;
                                return (
                                    <button
                                        key={p}
                                        type="button"
                                        onClick={() => setPreset(p)}
                                        className={cn(
                                            'px-2 py-0.5 rounded-full text-xs font-semibold tabular-nums transition-colors border',
                                            on
                                                ? 'bg-ink text-white border-ink'
                                                : 'bg-sand text-ink-secondary border-transparent hover:bg-stone',
                                        )}
                                    >
                                        ≥ {formatCompactAmount(p)}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 py-3 border-t border-hairline bg-sand/50 rounded-b-lg">
                        <span className="leading-tight tabular-nums whitespace-nowrap" translate="no" aria-live="polite">
                            {previewCount && (previewLoading
                                ? <span className="inline-flex items-center gap-1.5 text-xs text-ink-mute"><Loader2 className="w-3 h-3 animate-spin" />Calcul…</span>
                                : preview.n !== null && (
                                    <>
                                        <span className="block text-sm font-bold text-ink">
                                            {preview.n.toLocaleString('fr-CA')} compte{preview.n > 1 ? 's' : ''}
                                        </span>
                                        <span className="block text-2xs text-ink-mute">avec les autres filtres</span>
                                    </>
                                ))}
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                            <button type="button" onClick={reset} className="btn btn-xs btn-ghost">Réinitialiser</button>
                            <button type="button" onClick={close} className="btn btn-xs btn-ghost">Annuler</button>
                            <button type="button" onClick={apply} disabled={invalid} className="btn btn-xs btn-dark">Appliquer</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
