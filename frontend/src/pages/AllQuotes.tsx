import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2, Search } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useUrlList, useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { useRepFilter, REP_ALL_LABEL, REP_INTERNAL } from '../hooks/useRepFilter';
import { useRepTeam } from '../lib/repTeam';
import { DEPARTMENTS, MONTHS } from '../lib/constants';
import { formatCurrencyCAD, formatShortDate, cn } from '../lib/utils';
import type { CsvColumn } from '../lib/csv';
import type { AllQuoteRow } from '../types/database';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { MultiSelect } from '../components/MultiSelect';
import { ExportButton } from '../components/ExportButton';
import { SortIcon } from '../components/SortIcon';
import { RepName } from '../components/RepAvatar';
import { DEPT_COLORS } from '../components/weekly/deptColors';

const PAGE_SIZE = 100;
/** The API's row cap per request; the export reads in slices of this size. */
const EXPORT_PAGE = 1000;
const NO_REPS: string[] = [];

const COLUMNS = 'zoho_id, quote_number, client_name, rep_name, department, zoho_department_label, ' +
    'office, status, amount, quote_date, sale_date';

const STATUSES = [
    { value: 'draft', label: 'Brouillon' },
    { value: 'sent', label: 'Envoyé' },
    { value: 'accepted', label: 'Accepté' },
    { value: 'invoiced', label: 'Facturé' },
    { value: 'declined', label: 'Refusé' },
    { value: 'expired', label: 'Expiré' },
];
const STATUS_LABEL: Record<string, string> = Object.fromEntries(STATUSES.map(s => [s.value, s.label]));
const STATUS_STYLE: Record<string, string> = {
    draft: 'bg-stone text-ink-secondary border-hairline-strong',
    sent: 'bg-stone text-ink-secondary border-hairline-strong',
    accepted: 'bg-tone-warn-soft text-tone-warn-ink border-tone-warn/30',
    invoiced: 'bg-tone-good-soft text-tone-good-ink border-tone-good/30',
    declined: 'bg-tone-critical-soft text-tone-critical-ink border-tone-critical/30',
    expired: 'bg-stone text-ink-faint border-hairline-strong',
};

type SortKey = 'date' | 'quote_number' | 'client_name' | 'rep_name' | 'department' | 'office' | 'status' | 'amount';
type SortOrder = 'asc' | 'desc';

const FIRST_YEAR = 2021;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * PostgREST's `or` filter is comma-separated and paren-grouped, so those
 * characters in a search term would corrupt the query rather than match text.
 * `%` and `_` are ilike wildcards and are escaped so they match literally.
 */
function sanitizeSearch(raw: string): string {
    return raw.replace(/[,()]/g, ' ').replace(/[%_\\]/g, '\\$&').trim();
}

/** A value inside a PostgREST `in.(...)` list: quoted, so commas and parens in a name are safe. */
const quoteIn = (v: string) => '"' + v.replace(/["\\]/g, '\\$&') + '"';

/** [start, end) of the chosen period as ISO dates, or null for "all". */
function periodBounds(year: string, month: string): [string, string] | null {
    if (year === 'Toutes') return null;
    const y = Number(year);
    if (month === 'Toutes') return [`${y}-01-01`, `${y + 1}-01-01`];
    const m = Number(month);
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
    return [`${y}-${pad(m)}-01`, next];
}

export default function AllQuotes() {
    const thisYear = new Date().getFullYear();
    const [year, setYear] = useUrlState('year', String(thisYear));
    const [month, setMonth] = useUrlState('month', 'Toutes');
    const [statuses, setStatuses] = useUrlList('statut');
    const [selectedReps, setSelectedReps] = useUrlList('rep');
    const [depts, setDepts] = useUrlList('dept');
    const [office, setOffice] = useUrlState('bureau', 'Tous');
    const [q, setQ] = useUrlState('q', '');
    const [sortKey, setSortKey] = useUrlState('tri', 'date');
    const [sortOrder, setSortOrder] = useUrlState('ordre', 'desc');
    const [page, setPage] = useUrlStateNumber('page', 1);

    const repTeam = useRepTeam();
    // allReps is empty on purpose: the query below builds "Interne" as
    // "not in the team" itself, so it never needs the list of internal names.
    const repFilter = useRepFilter(selectedReps, NO_REPS);

    const [search, setSearch] = useState(q);
    const [rows, setRows] = useState<AllQuoteRow[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [firstYear, setFirstYear] = useState(FIRST_YEAR);
    const requestId = useRef(0);

    // Debounced: the URL (and the query) follow the box 300 ms after the last key.
    useEffect(() => {
        if (search === q) return;
        const t = setTimeout(() => setQ(search, { page: null }), 300);
        return () => clearTimeout(t);
    }, [search, q, setQ]);

    // Earliest year present, so the dropdown does not offer empty years.
    useEffect(() => {
        void (async () => {
            const { data } = await supabase.from('sales').select('sale_date')
                .not('sale_date', 'is', null).order('sale_date', { ascending: true }).limit(1);
            const d = (data as { sale_date: string }[] | null)?.[0]?.sale_date;
            if (d) setFirstYear(Math.min(thisYear, Number(d.slice(0, 4))));
        })();
    }, [thisYear]);

    const yearOptions = useMemo(() => {
        const ys = [];
        for (let y = thisYear; y >= firstYear; y--) ys.push({ value: String(y), label: String(y) });
        return [{ value: 'Toutes', label: 'Toutes les années' }, ...ys];
    }, [thisYear, firstYear]);
    const monthOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))],
        [],
    );
    const deptOptions = useMemo(() => DEPARTMENTS.map(d => ({ value: d, label: d })), []);

    const sortOrderT: SortOrder = sortOrder === 'asc' ? 'asc' : 'desc';

    const buildQuery = useCallback(() => {
        let query = supabase.from('sales').select(COLUMNS, { count: 'exact' });

        // The period is when the quote was ISSUED (quote_date). Older won rows were
        // synced before quote_date existed and carry NULL there, so for those the
        // sale_date is the best date we have.
        const bounds = periodBounds(year, month);
        if (bounds) {
            const [a, b] = bounds;
            query = query.or(
                `and(quote_date.gte.${a},quote_date.lt.${b}),` +
                `and(quote_date.is.null,sale_date.gte.${a},sale_date.lt.${b})`,
            );
        }
        if (statuses.length > 0) query = query.in('status', statuses);
        if (depts.length > 0) query = query.in('department', depts);
        if (office !== 'Tous') query = query.eq('office', office);

        // Reps: named reps are an `in`; "Interne" is everyone NOT on the team
        // (former staff, billing entities), so it is `not.in(team)`. Both ticked
        // is the OR of the two. A NULL rep_name is not on the team either, hence
        // the explicit is.null in the Interne branch. While the team is still
        // loading Interne narrows nothing, as useRepFilter does.
        const wantsInternal = repFilter.selected.includes(REP_INTERNAL) && repFilter.team.length > 0;
        const names = repFilter.selected.filter(n => n !== REP_INTERNAL);
        const parts: string[] = [];
        if (names.length > 0) parts.push(`rep_name.in.(${names.map(quoteIn).join(',')})`);
        if (wantsInternal) {
            parts.push(`rep_name.not.in.(${repFilter.team.map(quoteIn).join(',')})`, 'rep_name.is.null');
        }
        if (parts.length > 0) query = query.or(parts.join(','));

        const term = sanitizeSearch(q);
        if (term) {
            const like = `%${term}%`;
            query = query.or(`client_name.ilike.${like},quote_number.ilike.${like}`);
        }

        const asc = sortOrderT === 'asc';
        if (sortKey === 'date') {
            query = query.order('quote_date', { ascending: asc, nullsFirst: false })
                .order('sale_date', { ascending: asc, nullsFirst: false });
        } else {
            query = query.order(sortKey, { ascending: asc });
        }
        // The id breaks ties so paging never skips or repeats a row.
        return query.order('zoho_id', { ascending: true });
    }, [year, month, statuses, depts, office, repFilter, q, sortKey, sortOrderT]);

    useEffect(() => {
        const id = ++requestId.current;
        void (async () => {
            setLoading(true);
            const from = (page - 1) * PAGE_SIZE;
            const { data, count, error: err } = await buildQuery().range(from, from + PAGE_SIZE - 1);
            if (id !== requestId.current) return;
            setError(!!err);
            setRows(err ? [] : (data as unknown as AllQuoteRow[]) ?? []);
            setTotal(err ? 0 : count ?? 0);
            setLoading(false);
        })();
    }, [buildQuery, page]);

    const fetchAll = useCallback(async (): Promise<AllQuoteRow[]> => {
        const out: AllQuoteRow[] = [];
        for (let from = 0; ; from += EXPORT_PAGE) {
            const { data, error: err } = await buildQuery().range(from, from + EXPORT_PAGE - 1);
            if (err) throw err;
            const chunk = (data as unknown as AllQuoteRow[]) ?? [];
            if (chunk.length === 0) break; // an EMPTY page ends it, so a lower row cap cannot truncate
            out.push(...chunk);
        }
        return out;
    }, [buildQuery]);

    const csv = useMemo<CsvColumn<AllQuoteRow>[]>(() => [
        { header: 'Date',           value: r => r.quote_date ?? r.sale_date },
        { header: 'Numero',         value: r => r.quote_number },
        { header: 'Client',         value: r => r.client_name },
        { header: 'Representant',   value: r => repTeam.display(r.rep_name) },
        { header: 'Departement',    value: r => r.department },
        { header: 'Etiquette Zoho', value: r => r.zoho_department_label },
        { header: 'Bureau',         value: r => r.office },
        { header: 'Statut',         value: r => (r.status ? STATUS_LABEL[r.status] ?? r.status : '') },
        { header: 'Montant',        value: r => Number(r.amount) },
    ], [repTeam]);

    const sortBy = (key: SortKey) => {
        if (key === sortKey) setSortOrder(sortOrderT === 'asc' ? 'desc' : 'asc', { page: null });
        else setSortKey(key, { page: null, ordre: key === 'date' || key === 'amount' ? 'desc' : 'asc' });
    };
    /** Any filter change returns to page 1: page 7 of a 3-page result is empty. */
    const reset = { page: null };

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const rangeEnd = Math.min(page * PAGE_SIZE, total);
    const pageTotal = rows.reduce((s, r) => s + Number(r.amount), 0);

    const th = 'px-3 md:px-5 py-2.5 md:py-3 text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap';
    const head = (key: SortKey, label: string, align: 'left' | 'right' = 'left') => (
        <th className={cn(th, 'cursor-pointer hover:bg-stone transition-colors', align === 'right' ? 'text-right' : 'text-left')}
            onClick={() => sortBy(key)} aria-sort={sortKey === key ? (sortOrderT === 'asc' ? 'ascending' : 'descending') : 'none'}>
            <div className={cn('flex items-center gap-2', align === 'right' && 'justify-end')}>
                {label} <SortIcon order={sortKey === key ? sortOrderT : null} />
            </div>
        </th>
    );

    const go = (p: number) => setPage(Math.min(totalPages, Math.max(1, p)));
    const btn = 'p-1.5 rounded-md text-ink-mute hover:bg-stone disabled:opacity-30 disabled:hover:bg-transparent';
    const pager = (
        <div className="flex items-center gap-1">
            <button onClick={() => go(1)} disabled={page <= 1} aria-label="Première page" className={btn}><ChevronsLeft className="w-4 h-4" /></button>
            <button onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Page précédente" className={btn}><ChevronLeft className="w-4 h-4" /></button>
            <span className="text-xs font-semibold text-ink-mute px-2 tabular-nums" translate="no">{page} / {totalPages}</span>
            <button onClick={() => go(page + 1)} disabled={page >= totalPages} aria-label="Page suivante" className={btn}><ChevronRight className="w-4 h-4" /></button>
            <button onClick={() => go(totalPages)} disabled={page >= totalPages} aria-label="Dernière page" className={btn}><ChevronsRight className="w-4 h-4" /></button>
        </div>
    );

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6">
            <div>
                <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">Tous les devis</h1>
                <p className="text-xs md:text-sm text-ink-mute mt-0.5">Devis · tous les statuts</p>
            </div>

            <FilterBar>
                <FilterGroup label="Recherche">
                    <div className="relative">
                        <Search className="w-4 h-4 text-ink-faint absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                            type="search" value={search} onChange={e => setSearch(e.target.value)}
                            placeholder="Client ou numéro de devis" className="form-input pl-9 w-56"
                        />
                    </div>
                </FilterGroup>
                <FilterGroup label="Année">
                    <Select value={year} onChange={v => setYear(v, reset)} options={yearOptions} className="w-40" />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select value={month} onChange={v => setMonth(v, reset)} options={monthOptions}
                        disabled={year === 'Toutes'} className="w-36" />
                </FilterGroup>
                <FilterGroup label="Statut">
                    <MultiSelect values={statuses} onChange={v => setStatuses(v, reset)} options={STATUSES}
                        allLabel="Tous les statuts" className="w-44" />
                </FilterGroup>
                <FilterGroup label="Représentant">
                    <MultiSelect values={repFilter.selected} onChange={v => setSelectedReps(v, reset)}
                        options={repFilter.options} allLabel={REP_ALL_LABEL} allIcon={repFilter.allIcon} className="w-52" />
                </FilterGroup>
                <FilterGroup label="Département">
                    <MultiSelect values={depts} onChange={v => setDepts(v, reset)} options={deptOptions}
                        allLabel="Tous les départements" className="w-56" />
                </FilterGroup>
                <FilterGroup label="Bureau">
                    <Select value={office} onChange={v => setOffice(v, reset)} className="w-36"
                        options={[{ value: 'Tous', label: 'Tous' }, { value: 'QC', label: 'Québec' }, { value: 'MTL', label: 'Montréal' }]} />
                </FilterGroup>
            </FilterBar>

            <div className="bg-white rounded-xl shadow-card overflow-hidden">
                <div className="px-5 py-3.5 border-b border-hairline flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <h2 className="text-sm font-semibold text-ink-secondary uppercase tracking-label">Liste des devis</h2>
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-2xs font-semibold bg-stone text-ink-secondary uppercase tracking-label"
                              translate="no">
                            {total.toLocaleString('fr-CA')} devis
                        </span>
                        {loading && <Loader2 className="w-4 h-4 animate-spin text-ink-faint" />}
                    </div>
                    <div className="flex items-center gap-3">
                        <p className="text-xs font-medium text-ink-mute" translate="no">
                            {total === 0 ? 'Aucun devis' : `${rangeStart}–${rangeEnd} sur ${total.toLocaleString('fr-CA')}`}
                        </p>
                        <ExportButton rows={fetchAll} columns={csv} filename="tous_les_devis" label="CSV" disabled={total === 0} />
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-hairline bg-sand/50">
                                {head('date', 'Date')}
                                {head('quote_number', '# Devis')}
                                {head('client_name', 'Client')}
                                {head('rep_name', 'Représentant')}
                                {head('department', 'Département')}
                                {head('office', 'Bureau')}
                                {head('status', 'Statut')}
                                {head('amount', 'Montant', 'right')}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-hairline">
                            {rows.length === 0 ? (
                                <tr>
                                    <td colSpan={8} className="px-5 py-20 text-center text-sm text-ink-mute font-medium">
                                        {loading ? 'Chargement…' : error ? 'Impossible de charger les devis.' : 'Aucun devis trouvé pour ces critères.'}
                                    </td>
                                </tr>
                            ) : rows.map(r => (
                                <tr key={r.zoho_id} className="hover:bg-sand/60 transition-colors">
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 text-ink-mute whitespace-nowrap text-2xs font-medium">
                                        {formatShortDate(r.quote_date ?? r.sale_date ?? '')}
                                    </td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 font-mono text-2xs text-ink-mute whitespace-nowrap">{r.quote_number}</td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 font-bold text-ink max-w-[140px] md:max-w-[240px] truncate" title={r.client_name}>
                                        {r.client_name}
                                    </td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 text-ink-secondary whitespace-nowrap font-medium">
                                        <RepName name={r.rep_name} size="sm" />
                                    </td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5">
                                        <span className={cn(
                                            'inline-flex items-center px-2 py-0.5 rounded-md text-2xs font-bold whitespace-nowrap border',
                                            DEPT_COLORS[r.department] ?? 'bg-stone text-ink-secondary border-hairline-strong/50',
                                        )}>
                                            {r.department}
                                        </span>
                                    </td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 text-ink-mute whitespace-nowrap text-xs">{r.office}</td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5">
                                        <span className={cn(
                                            'inline-flex items-center px-2 py-0.5 rounded-xs text-2xs font-semibold uppercase tracking-tighter border',
                                            STATUS_STYLE[r.status ?? ''] ?? 'bg-stone text-ink-secondary border-hairline-strong',
                                        )}>
                                            {r.status ? STATUS_LABEL[r.status] ?? r.status : '—'}
                                        </span>
                                    </td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 text-right font-bold tabular-nums whitespace-nowrap text-ink">
                                        {formatCurrencyCAD(r.amount)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        {rows.length > 0 && (
                            <tfoot>
                                <tr className="bg-ink text-white font-bold">
                                    <td colSpan={7} className="px-3 md:px-5 py-3 md:py-4 text-2xs uppercase tracking-eyebrow">Total de la page</td>
                                    <td className="px-3 md:px-5 py-3 md:py-4 text-right tabular-nums whitespace-nowrap">{formatCurrencyCAD(pageTotal)}</td>
                                </tr>
                            </tfoot>
                        )}
                    </table>
                </div>
                <div className="flex justify-end px-5 py-3 border-t border-hairline bg-sand/40">{pager}</div>
            </div>
        </div>
    );
}
