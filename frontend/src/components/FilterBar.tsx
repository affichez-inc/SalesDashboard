import {
    Children, isValidElement, useEffect, useRef, useState,
    type ReactElement, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, X } from 'lucide-react';
import { ClearFiltersButton } from './ClearFiltersButton';
import { FilterPanelContext } from './FilterPanelContext';
import { MultiSelect, type MultiSelectProps } from './MultiSelect';
import { Select, type SelectProps } from './Select';

/** Up to this many filters stay on the bar: a button hiding one dropdown saves nothing. */
const INLINE_MAX = 4;

/** An active filter, as its chip on the bar. */
export interface FilterChip {
    text: string;
    icon?: ReactNode;
    onClear: () => void;
}

interface FilterGroupProps {
    label: string;
    children: ReactNode;
    /** Stays on the bar when the others move behind the Filtres button: search and period. */
    pinned?: boolean;
    /** A single-choice filter's "no filter" value, which is what its chip's cross goes back to. */
    resetTo?: string;
    /** The chip of a control that is neither a Select nor a MultiSelect; null when inactive. */
    chip?: FilterChip | null;
}

export function FilterGroup({ label, children }: FilterGroupProps) {
    return (
        <div className="flex flex-col gap-0.5 md:gap-1 min-w-0">
            <label className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow px-0.5">
                {label}
            </label>
            {children}
        </div>
    );
}

/** Read off the control's own props, so a filter cannot say one thing and its chip another. */
function chipOf({ children: control, chip, resetTo }: FilterGroupProps): FilterChip | null {
    if (chip !== undefined) return chip;
    if (!isValidElement(control)) return null;
    if (control.type === MultiSelect) {
        const { values, options, onChange } = control.props as MultiSelectProps;
        if (values.length === 0) return null;
        const first = options.find(o => o.value === values[0]);
        return {
            text: (first?.label ?? values[0]) + (values.length > 1 ? ` +${values.length - 1}` : ''),
            icon: first?.icon,
            onClear: () => onChange([]),
        };
    }
    if (control.type === Select && resetTo !== undefined) {
        const { value, options, onChange } = control.props as SelectProps;
        if (value === resetTo) return null;
        const picked = options.find(o => o.value === value);
        return { text: picked?.label ?? value, icon: picked?.icon, onClear: () => onChange(resetTo) };
    }
    return null;
}

interface FilterBarProps {
    children: ReactNode;
}

/**
 * The filters of a page.
 *
 * Up to INLINE_MAX they sit on the bar. Beyond that the bar keeps the `pinned` ones
 * and a Filtres button opening a drawer with the rest, each active one shown as a
 * chip under the bar, because a filter out of sight that empties the page is
 * otherwise invisible.
 *
 * Filters apply as they are picked, as on the bar: every screen answers well under
 * a second, so an Apply button would only add a click. The drawer has no backdrop
 * and leaves the page visible beside it for the same reason: the figures move as
 * you choose.
 */
export function FilterBar({ children }: FilterBarProps) {
    const items = Children.toArray(children).filter(isValidElement);
    const groups = items.filter(c => c.type === FilterGroup) as ReactElement<FilterGroupProps>[];
    const clear = items.find(c => c.type === ClearFiltersButton);

    const [open, setOpen] = useState(false);
    const barRef = useRef<HTMLDivElement>(null);
    const drawerRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        drawerRef.current?.focus();
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node;
            if (!drawerRef.current?.contains(t) && !barRef.current?.contains(t)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            setOpen(false);
            buttonRef.current?.focus();
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    if (groups.length <= INLINE_MAX) {
        return (
            <div className="bg-white rounded-xl shadow-card px-4 md:px-5 py-3 md:py-3.5 grid grid-cols-2 md:flex md:flex-wrap items-end gap-3 md:gap-x-6 md:gap-y-3">
                {children}
            </div>
        );
    }

    const hidden = groups.filter(g => !g.props.pinned);
    const chips = hidden.flatMap(g => {
        const chip = chipOf(g.props);
        return chip ? [{ key: g.key, label: g.props.label, ...chip }] : [];
    });
    const closeAndRefocus = () => {
        setOpen(false);
        buttonRef.current?.focus();
    };

    return (
        <div ref={barRef} className="bg-white rounded-xl shadow-card px-4 md:px-5 py-3 md:py-3.5">
            <div className="flex flex-wrap items-end gap-3 md:gap-x-6 md:gap-y-3">
                {groups.filter(g => g.props.pinned)}
                <div className="flex items-center gap-2">
                    <button
                        ref={buttonRef}
                        type="button"
                        aria-haspopup="dialog"
                        aria-expanded={open}
                        onClick={() => setOpen(o => !o)}
                        className="btn btn-sm btn-secondary gap-2"
                    >
                        <SlidersHorizontal className="w-4 h-4" />
                        Filtres
                        {chips.length > 0 && (
                            <span
                                translate="no"
                                className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1
                                           rounded-full bg-ink text-white text-2xs font-bold tabular-nums"
                            >
                                {chips.length}
                            </span>
                        )}
                    </button>
                    {clear}
                </div>
            </div>

            {chips.length > 0 && (
                <div className="mt-3 pt-3 border-t border-hairline flex flex-wrap items-center gap-1.5">
                    {chips.map(c => (
                        <span key={c.key} className="inline-flex items-center max-w-full rounded-full bg-sand text-xs font-medium text-ink-secondary">
                            <button
                                type="button"
                                onClick={() => setOpen(true)}
                                title={`Modifier : ${c.label}`}
                                className="flex items-center gap-1.5 min-w-0 pl-3 pr-1 py-1 rounded-l-full hover:text-ink"
                            >
                                <span className="text-ink-mute shrink-0">{c.label} :</span>
                                {c.icon && <span className="-my-0.5 inline-flex shrink-0">{c.icon}</span>}
                                <span className="truncate" translate="no">{c.text}</span>
                            </button>
                            <button
                                type="button"
                                onClick={c.onClear}
                                aria-label={`Retirer le filtre ${c.label}`}
                                className="shrink-0 p-1 mr-1 rounded-full text-ink-mute hover:bg-stone hover:text-ink"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    ))}
                </div>
            )}

            {open && createPortal(
                <div
                    ref={drawerRef}
                    role="dialog"
                    aria-label="Filtres"
                    tabIndex={-1}
                    className="drawer-in fixed inset-y-0 right-0 z-50 flex w-full sm:w-[25rem] flex-col bg-white shadow-2xl focus:outline-none"
                >
                    <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-4">
                        <h2 className="text-md font-semibold text-ink">Filtres</h2>
                        <button
                            type="button"
                            onClick={closeAndRefocus}
                            aria-label="Fermer les filtres"
                            className="rounded-md p-1.5 text-ink-mute transition-colors hover:bg-stone hover:text-ink-secondary"
                        >
                            <X className="h-5 w-5" />
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                        <FilterPanelContext.Provider value={true}>
                            {hidden.map(g => {
                                const chip = chipOf(g.props);
                                return (
                                    <div key={g.key} className="space-y-1">
                                        <div className="flex items-baseline justify-between gap-3 px-0.5">
                                            <span className={`text-2xs font-semibold uppercase tracking-eyebrow ${chip ? 'text-ink' : 'text-ink-mute'}`}>
                                                {g.props.label}
                                            </span>
                                            {chip && (
                                                <button type="button" onClick={chip.onClear} className="text-xs font-medium text-ink-mute hover:text-ink">
                                                    Effacer
                                                </button>
                                            )}
                                        </div>
                                        {g.props.children}
                                    </div>
                                );
                            })}
                        </FilterPanelContext.Provider>
                    </div>
                    <div className="flex items-center justify-between gap-3 border-t border-hairline bg-sand/50 px-5 py-3">
                        {clear ?? <span />}
                        <button type="button" onClick={closeAndRefocus} className="btn btn-sm btn-dark">
                            Voir les résultats
                        </button>
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
}
