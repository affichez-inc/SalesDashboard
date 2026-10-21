import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ChevronDown, Check, Search } from 'lucide-react';
import { cn, foldForSearch } from '../lib/utils';

/**
 * From this many options the dropdown grows a search box. Some of these lists are
 * long - 25 sources, 55 industries, 30 reps - and scrolling a 55-item list to
 * find "Dentiste" is not a way to use a filter.
 */
const SEARCHABLE_FROM = 4;

export interface SelectOption {
    value: string;
    label: string;
    /**
     * Drawn to the left of the label, in the list and on the trigger.
     *
     * A node rather than an icon name so the caller decides what it is - every
     * rep filter passes a <RepAvatar>. It is decorative: the label still
     * carries the meaning, and nothing here depends on the icon rendering.
     */
    icon?: React.ReactNode;
    /** Shown on hover over the option in MultiSelect, for a label that is a shortened form. */
    hint?: string;
}

interface SelectProps {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    variant?: 'default' | 'accent';
    disabled?: boolean;
    placeholder?: string;
    className?: string;
    /** Force the search box on or off. Defaults to on above SEARCHABLE_FROM options. */
    searchable?: boolean;
}

export function Select({
    value,
    onChange,
    options,
    variant = 'default',
    disabled = false,
    className,
    searchable,
}: SelectProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    const selected = options.find(o => o.value === value);
    const showSearch = searchable ?? options.length >= SEARCHABLE_FROM;

    const filtered = useMemo(() => {
        const q = foldForSearch(query.trim());
        if (!q) return options;
        return options.filter(o => foldForSearch(o.label).includes(q));
    }, [options, query]);

    // The query is per-opening, not sticky: reopening a dropdown that still had
    // "dent" in it would look like half the options had vanished.
    const close = useCallback(() => { setOpen(false); setQuery(''); }, []);

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

    const handleSelect = (val: string) => {
        onChange(val);
        close();
    };

    // Focus the search box on open so the list is type-to-filter, not
    // click-then-type. Deferred a frame because the input does not exist until
    // this render commits.
    useEffect(() => {
        if (open && showSearch) {
            const id = requestAnimationFrame(() => searchRef.current?.focus());
            return () => cancelAnimationFrame(id);
        }
    }, [open, showSearch]);

    const isAccent = variant === 'accent';

    return (
        <div ref={containerRef} className={cn("relative max-w-full", className)}>
            {/* Trigger */}
            <button
                type="button"
                disabled={disabled}
                onClick={() => !disabled && setOpen(o => !o)}
                className={cn(
                    "flex items-center gap-2 w-full pl-3 pr-2.5 py-2 rounded-md text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-primary/25 select-none",
                    disabled && "opacity-40 cursor-not-allowed",
                    isAccent
                        ? "bg-primary-wash text-primary-press hover:bg-primary-subdued"
                        : "bg-sand text-ink-secondary hover:bg-stone",
                    open && (isAccent ? "bg-primary-subdued ring-2 ring-primary/25" : "bg-stone ring-2 ring-hairline-strong")
                )}
            >
                {selected?.icon}
                <span className="flex-1 text-left truncate">{selected?.label ?? '—'}</span>
                <ChevronDown className={cn(
                    "w-3.5 h-3.5 shrink-0 transition-transform duration-150",
                    isAccent ? "text-primary-press" : "text-ink-mute",
                    open && "rotate-180"
                )} />
            </button>

            {/* Dropdown */}
            {open && (
                <div className={cn(
                    "absolute z-50 top-full mt-1.5 left-0 min-w-full bg-white rounded-lg border border-hairline shadow-xl overflow-hidden",
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
                                // Enter picks the only remaining match, which is what
                                // typing three letters is usually aiming at.
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && filtered.length === 1) {
                                        e.preventDefault();
                                        handleSelect(filtered[0].value);
                                    }
                                }}
                                className="w-full pl-7 pr-2 py-1.5 rounded-md bg-sand text-sm
                                           placeholder:text-ink-faint focus:outline-none
                                           focus:ring-2 focus:ring-primary/25"
                            />
                        </div>
                    )}
                    <div className="py-1 max-h-64 overflow-y-auto">
                        {filtered.length === 0 && (
                            <p className="px-3 py-4 text-center text-xs text-ink-mute">Aucun résultat</p>
                        )}
                        {filtered.map(opt => {
                            const isSelected = opt.value === value;
                            return (
                                <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => handleSelect(opt.value)}
                                    className={cn(
                                        "w-full flex items-center justify-between gap-3 px-3 py-2 text-sm transition-colors text-left",
                                        isSelected
                                            ? "bg-primary/5 text-primary-press font-semibold"
                                            : "text-ink-secondary hover:bg-sand font-medium"
                                    )}
                                >
                                    <span className="flex items-center gap-2 min-w-0">
                                        {opt.icon}
                                        <span className="truncate" translate="no">{opt.label}</span>
                                    </span>
                                    {isSelected && <Check className="w-3.5 h-3.5 shrink-0 text-primary-press" />}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
