import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { ChevronDown, Check, Search } from 'lucide-react';
import { cn, foldForSearch } from '../lib/utils';
import type { SelectOption } from './Select';

/** Same threshold as Select: from this many options the list grows a search box. */
const SEARCHABLE_FROM = 4;

interface MultiSelectProps {
    /** The selected values. An empty list means "no filter", shown as `allLabel`. */
    values: string[];
    onChange: (values: string[]) => void;
    /** The real values only. "All" is not an option here, it is the empty list. */
    options: SelectOption[];
    /** What the trigger and the first row read when nothing is selected. */
    allLabel: string;
    /** Drawn beside `allLabel`, where the options carry an icon of their own. */
    allIcon?: React.ReactNode;
    disabled?: boolean;
    className?: string;
    /** Force the search box on or off. Defaults to on above SEARCHABLE_FROM options. */
    searchable?: boolean;
}

/**
 * A filter dropdown that takes several values at once.
 *
 * It looks and opens like Select, with two differences: picking a value does
 * not close the list, and the first row clears the selection. Nothing selected
 * and everything selected are not the same thing - the first is "no filter" and
 * includes rows that carry no value at all - so the empty list is the only way
 * to say "all", and it has a row of its own rather than a "select all" toggle.
 *
 * Values are kept in the order of `options`, whatever order they were clicked
 * in, so the same selection always produces the same URL and the same cache key.
 */
export function MultiSelect({
    values,
    onChange,
    options,
    allLabel,
    allIcon,
    disabled = false,
    className,
    searchable,
}: MultiSelectProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    const selected = useMemo(() => new Set(values), [values]);
    const showSearch = searchable ?? options.length >= SEARCHABLE_FROM;

    const filtered = useMemo(() => {
        const q = foldForSearch(query.trim());
        if (!q) return options;
        return options.filter(o => foldForSearch(o.label).includes(q));
    }, [options, query]);

    const close = useCallback(() => { setOpen(false); setQuery(''); }, []);

    // The menu is as wide as its longest label, which can be wider than the
    // trigger. In the right-hand column of a narrow screen that would run past
    // the edge and scroll the page sideways, so it hangs from the trigger's
    // right edge instead. Measured before paint, on the element itself: the
    // menu is unmounted on close, so the next opening starts from the left again.
    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (!open || !menu) return;
        if (menu.getBoundingClientRect().right > document.documentElement.clientWidth - 8) {
            menu.style.left = 'auto';
            menu.style.right = '0';
        }
    }, [open]);

    // Close on outside click
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                close();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open, close]);

    // Keyboard: Escape to close
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [open, close]);

    useEffect(() => {
        if (open && showSearch) {
            const id = requestAnimationFrame(() => searchRef.current?.focus());
            return () => cancelAnimationFrame(id);
        }
    }, [open, showSearch]);

    const toggle = (value: string) => {
        const next = new Set(selected);
        if (next.has(value)) next.delete(value); else next.add(value);
        // A value that is no longer offered (the year changed and it has no row
        // any more) stays selected until it is cleared, after the known ones.
        const known = options.filter(o => next.has(o.value)).map(o => o.value);
        const unknown = values.filter(v => next.has(v) && !options.some(o => o.value === v));
        onChange([...known, ...unknown]);
    };

    const first = options.find(o => o.value === values[0]);
    const extra = values.length - 1;
    const active = values.length > 0;

    return (
        <div ref={containerRef} className={cn("relative max-w-full", className)}>
            {/* Trigger */}
            <button
                type="button"
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => !disabled && setOpen(o => !o)}
                className={cn(
                    "flex items-center gap-2 w-full pl-3 pr-2.5 py-2 rounded-md text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-primary/25 select-none",
                    "bg-sand text-ink-secondary hover:bg-stone",
                    disabled && "opacity-40 cursor-not-allowed",
                    open && "bg-stone ring-2 ring-hairline-strong"
                )}
            >
                {/* An avatar is taller than a line of text; the negative margin
                    keeps this trigger the same height as the ones beside it. */}
                {(active ? first?.icon : allIcon) && (
                    <span className="-my-0.5 inline-flex shrink-0">{active ? first?.icon : allIcon}</span>
                )}
                <span className="flex-1 text-left truncate" translate={active ? 'no' : undefined}>
                    {active ? (first?.label ?? values[0]) : allLabel}
                </span>
                {extra > 0 && (
                    <span
                        translate="no"
                        title={values.map(v => options.find(o => o.value === v)?.label ?? v).join(', ')}
                        className="shrink-0 inline-flex items-center justify-center min-w-[20px] h-[18px] px-1
                                   rounded-full bg-ink text-white text-2xs font-bold tabular-nums"
                    >
                        +{extra}
                    </span>
                )}
                <ChevronDown className={cn(
                    "w-3.5 h-3.5 shrink-0 text-ink-mute transition-transform duration-150",
                    open && "rotate-180"
                )} />
            </button>

            {/* Dropdown */}
            {open && (
                <div ref={menuRef} className={cn(
                    "absolute z-50 top-full mt-1.5 left-0 min-w-full max-w-[calc(100vw-1rem)] bg-white rounded-lg border border-hairline shadow-xl overflow-hidden",
                    "menu-in"
                )}>
                    {showSearch && (
                        <div className="relative border-b border-hairline p-2">
                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-faint" />
                            <input
                                ref={searchRef}
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder="Rechercher…"
                                aria-label="Filtrer les options"
                                // Enter ticks the only remaining match and keeps the
                                // list open for the next one.
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && filtered.length === 1) {
                                        e.preventDefault();
                                        toggle(filtered[0].value);
                                        setQuery('');
                                    }
                                }}
                                className="w-full pl-7 pr-2 py-1.5 rounded-md bg-sand text-sm
                                           placeholder:text-ink-faint focus:outline-none
                                           focus:ring-2 focus:ring-primary/25"
                            />
                        </div>
                    )}
                    <div className="py-1 max-h-64 overflow-y-auto" role="listbox" aria-multiselectable="true">
                        {/* Hidden while searching: it is not a value to be found. */}
                        {!query.trim() && (
                            <button
                                type="button"
                                role="option"
                                aria-selected={!active}
                                onClick={() => { onChange([]); close(); }}
                                className={cn(
                                    "w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors text-left border-b border-hairline",
                                    !active
                                        ? "bg-primary/5 text-primary-press font-semibold"
                                        : "text-ink-secondary hover:bg-sand font-medium"
                                )}
                            >
                                <Tick on={!active} round />
                                <span className="flex items-center gap-2 min-w-0">
                                    {allIcon}
                                    <span className="truncate">{allLabel}</span>
                                </span>
                            </button>
                        )}
                        {filtered.length === 0 && (
                            <p className="px-3 py-4 text-center text-xs text-ink-mute">Aucun résultat</p>
                        )}
                        {filtered.map(opt => {
                            const isSelected = selected.has(opt.value);
                            return (
                                <button
                                    key={opt.value}
                                    type="button"
                                    role="option"
                                    aria-selected={isSelected}
                                    title={opt.hint}
                                    onClick={() => toggle(opt.value)}
                                    className={cn(
                                        "w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors text-left",
                                        isSelected
                                            ? "bg-primary/5 text-primary-press font-semibold"
                                            : "text-ink-secondary hover:bg-sand font-medium"
                                    )}
                                >
                                    <Tick on={isSelected} />
                                    <span className="flex items-center gap-2 min-w-0">
                                        {opt.icon}
                                        <span className="truncate" translate="no">{opt.label}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

/** The box in front of a row: square for a value, round for "all" (it is exclusive). */
function Tick({ on, round }: { on: boolean; round?: boolean }) {
    return (
        <span className={cn(
            "shrink-0 inline-flex items-center justify-center w-4 h-4 border transition-colors",
            round ? "rounded-full" : "rounded-xs",
            on ? "bg-primary border-primary text-white" : "bg-white border-hairline-strong"
        )}>
            {on && <Check className="w-3 h-3" strokeWidth={3} />}
        </span>
    );
}
