import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * The pager of a server-paginated table, rendered above and below it.
 *
 * First and last buttons matter here in a way they do not on a short list: 20,645
 * accounts is 188 pages, and stepping to the end one arrow at a time is not a
 * navigation option.
 */
export function Pager({ page, totalPages, total, rangeStart, rangeEnd, onChange, position, noun, emptyLabel, note }: {
    page: number;
    totalPages: number;
    total: number;
    rangeStart: number;
    rangeEnd: number;
    onChange: (p: number) => void;
    position: 'top' | 'bottom';
    /** What is counted, plural: "comptes", "factures". */
    noun: string;
    /** Said instead of the count when there is nothing: "Aucun compte". */
    emptyLabel: string;
    /** Said after the count, e.g. how the rows are ordered when it is not the default. */
    note?: string;
}) {
    const go = (p: number) => onChange(Math.min(totalPages, Math.max(1, p)));
    const btn = 'p-1.5 rounded-md text-ink-mute hover:bg-stone disabled:opacity-30 disabled:hover:bg-transparent';
    return (
        <div className={cn(
            'flex flex-wrap items-center justify-between gap-3 px-5 py-3',
            position === 'top' ? 'border-b border-hairline' : 'border-t border-hairline bg-sand/40',
        )}>
            <p className="text-xs font-medium text-ink-mute" translate="no">
                {total === 0
                    ? emptyLabel
                    : rangeStart + '–' + rangeEnd + ' sur ' + total.toLocaleString('fr-CA') + ' ' + noun}
                {note && total > 0 && <span className="text-ink-faint">{' · ' + note}</span>}
            </p>
            <div className="flex items-center gap-1">
                <button onClick={() => go(1)} disabled={page <= 1} aria-label="Première page" className={btn}>
                    <ChevronsLeft className="w-4 h-4" />
                </button>
                <button onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Page précédente" className={btn}>
                    <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs font-semibold text-ink-mute px-2 tabular-nums" translate="no">
                    {page} / {totalPages}
                </span>
                <button onClick={() => go(page + 1)} disabled={page >= totalPages} aria-label="Page suivante" className={btn}>
                    <ChevronRight className="w-4 h-4" />
                </button>
                <button onClick={() => go(totalPages)} disabled={page >= totalPages} aria-label="Dernière page" className={btn}>
                    <ChevronsRight className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}
