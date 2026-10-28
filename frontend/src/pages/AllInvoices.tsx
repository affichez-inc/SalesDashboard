import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUrlList, useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import {
    Loader2, Search, RefreshCw, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
} from 'lucide-react';
import type { InvDetailRow } from '../types/database';
import { DEPARTMENTS, INVOICE_STATUSES, MONTHS, OFFICES } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { MultiSelect } from '../components/MultiSelect';
import { ExportButton } from '../components/ExportButton';
import { ClearFiltersButton } from '../components/ClearFiltersButton';
import { SortIcon } from '../components/SortIcon';
import { ShippingNote } from '../components/ShippingNote';
import { DEPT_COLORS } from '../components/weekly/deptColors';
import { RepName } from '../components/RepAvatar';
import { useRepFilter, REP_ALL_LABEL, REP_INTERNAL } from '../hooks/useRepFilter';
import { useRepTeam } from '../lib/repTeam';
import type { CsvColumn } from '../lib/csv';
import { formatCurrencyCAD, formatShortDate, cn } from '../lib/utils';

/**
 * Toutes les factures - every invoice and credit note, searchable.
 *
 * Same columns as the weekly detail list (Factures > Détail hebdo), but over the
 * whole table instead of one week. The table holds tens of thousands of rows, so
 * filtering, sorting, counting and paging all happen in Postgres: a filter
 * applied to the 100 rows on screen would leave the count and the pager wrong.
 *
 * Rows are deliberately not clickable and carry no Zoho link yet.
 */

const PAGE_SIZE = 100;
/** The API's row cap per request; the export reads in slices of this size. */
const EXPORT_PAGE = 1000;
/** Safety stop for the export loop, far above the real table size. */
const EXPORT_MAX = 200000;
const FIRST_YEAR = 2021;

const NO_REPS: string[] = [];

const COLUMNS = 'zoho_id, invoice_number, invoice_date, client_name, rep_name, department, ' +
    'zoho_department_label, office, status, is_avoir, amount, shipping_charge';

/** Sortable columns -> the database column they sort on. */
const SORT_COLUMNS = {
    invoice_date: 'invoice_date',
    invoice_number: 'invoice_number',
    client_name: 'client_name',
    rep_name: 'rep_name',
    department: 'department',
    office: 'office',
    status: 'status',
    amount: 'amount',
} as const;
type SortKey = keyof typeof SORT_COLUMNS;
const isSortKey = (k: string): k is SortKey => k in SORT_COLUMNS;

const INV_STATUS_STYLES: Record<string, string> = {
    paid:    'bg-tone-good-soft text-tone-good-ink border-tone-good/30',
    partial: 'bg-tone-warn-soft text-tone-warn-ink border-tone-warn/30',
    sent:    'bg-tone-warn-soft text-tone-warn-ink border-tone-warn/30',
    viewed:  'bg-tone-warn-soft text-tone-warn-ink border-tone-warn/30',
    overdue: 'bg-tone-critical-soft text-tone-critical-ink border-tone-critical/30',
    avoir:   'bg-tone-critical-soft text-tone-critical-ink border-tone-critical/30',
};
const INV_STATUS_LABELS: Record<string, string> = {
    paid: 'Payé', partial: 'Partiel', sent: 'Envoyé',
    viewed: 'Envoyé', overdue: 'En retard', avoir: 'Avoir',
};

function InvStatusBadge({ status, isAvoir }: { status: string; isAvoir: boolean }) {
    const key = isAvoir ? 'avoir' : status;
    return (
        <span className={cn(
            'inline-flex items-center px-2 py-0.5 rounded-xs text-2xs font-semibold uppercase tracking-tighter border',
            INV_STATUS_STYLES[key] ?? 'bg-stone text-ink-secondary border-hairline-strong',
        )}>
            {INV_STATUS_LABELS[key] ?? key}
        </span>
    );
}

/**
 * PostgREST's `or` filter is comma-separated and paren-grouped, so those
 * characters in a search term would corrupt the query rather than match text.
 * `%` and `_` are ilike wildcards and are escaped so they match literally.
 */
function sanitizeSearch(raw: string): string {
    return raw.replace(/[,()]/g, ' ').replace(/[%_\\]/g, '\\$&').trim();
}

/** A value inside a PostgREST `in.(...)` list: quoted, with `"` and `\` escaped. */
const quoteListValue = (v: string): string => `"${v.replace(/[\\"]/g, '\\$&')}"`;

const pad = (n: number) => String(n).padStart(2, '0');

export default function AllInvoices() {
    const currentYear = new Date().getFullYear();
    const [yearParam, _setYear] = useUrlState('year', String(currentYear));
    const [monthParam, _setMonth] = useUrlState('month', 'Toutes');
    const [selectedStatuses, _setStatuses] = useUrlList('statut');
    const [selectedReps, _setReps] = useUrlList('rep');
    const [selectedDepts, _setDepts] = useUrlList('dept');
    const [office, _setOffice] = useUrlState('bureau', 'Tous');
    const [shippingOnly, _setShippingOnly] = useUrlState('livraison', '');
    const [q, setQ] = useUrlState('q', '');
    const [sortParam, setSortParam] = useUrlState('sort', 'invoice_date');
    const [dirParam] = useUrlState('dir', 'desc');
    const [page, setPage] = useUrlStateNumber('page', 1);

    const sortKey: SortKey = isSortKey(sortParam) ? sortParam : 'invoice_date';
    const ascending = dirParam === 'asc';

    const year: number | 'Toutes' = yearParam === 'Toutes' ? 'Toutes' : Number(yearParam) || currentYear;
    const month: number | 'Toutes' = year === 'Toutes' || monthParam === 'Toutes' ? 'Toutes' : Number(monthParam) || 'Toutes';

    const [rows, setRows] = useState<InvDetailRow[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const repTeam = useRepTeam();
    // Used for the dropdown (options, recognised selection) only: the server-side
    // rep filter is built below from the team, because this page does not load the
    // list of every name in the data that `repFilter.reps` would need for Interne.
    const repFilter = useRepFilter(selectedReps, NO_REPS);

    // A filter change invalidates the page number. Both params must move in ONE
    // navigation (see UrlStateCompanions in hooks/useUrlState).
    const toPage1 = { page: null };
    const setYear = (v: string) => _setYear(v, { ...toPage1, ...(v === 'Toutes' ? { month: null } : {}) });
    const setMonth = (v: string) => _setMonth(v, toPage1);
    const setStatuses = (v: string[]) => _setStatuses(v, toPage1);
    const setReps = (v: string[]) => _setReps(v, toPage1);
    const setDepts = (v: string[]) => _setDepts(v, toPage1);
    const setOffice = (v: string) => _setOffice(v, toPage1);
    const setShippingOnly = (v: string) => _setShippingOnly(v, toPage1);

    // Search box: local text, written to the URL 300 ms after typing stops.
    const [search, setSearch] = useState(q);
    const qRef = useRef(q);
    const setQRef = useRef(setQ);
    useEffect(() => { qRef.current = q; setQRef.current = setQ; });
    useEffect(() => {
        const t = setTimeout(() => {
            if (search !== qRef.current) setQRef.current(search, { page: null });
        }, 300);
        return () => clearTimeout(t);
    }, [search]);
    // Back/forward or "Réinitialiser" changed the URL: follow it.
    useEffect(() => { setSearch(q); }, [q]);

    const clearFilters = () => {
        setSearch('');
        _setYear(String(currentYear), {
            month: null, statut: null, rep: null, dept: null, bureau: null,
            livraison: null, q: null, page: null,
        });
    };

    const activeFilterCount = [
        search.trim() !== '',
        year !== currentYear,
        month !== 'Toutes',
        selectedStatuses.length > 0,
        !repFilter.isAll,
        selectedDepts.length > 0,
        office !== 'Tous',
        shippingOnly === '1',
    ].filter(Boolean).length;

    /** Half-open date range on invoice_date: a range, never EXTRACT, so the index serves it. */
    const dateBounds = useMemo(() => {
        if (year === 'Toutes') return null;
        if (month === 'Toutes') return { from: `${year}-01-01`, to: `${year + 1}-01-01` };
        const toY = month === 12 ? year + 1 : year;
        const toM = month === 12 ? 1 : month + 1;
        return { from: `${year}-${pad(month)}-01`, to: `${toY}-${pad(toM)}-01` };
    }, [year, month]);

    const debouncedTerm = sanitizeSearch(q);

    /**
     * One query builder for the table and the export, so they can never describe
     * different sets of invoices.
     */
    const buildQuery = useCallback((mode: 'page' | 'export') => {
        let query = supabase
            .from('invoices')
            .select(COLUMNS, mode === 'page' ? { count: 'exact' } : undefined);

        if (dateBounds) query = query.gte('invoice_date', dateBounds.from).lt('invoice_date', dateBounds.to);

        if (selectedStatuses.length === 0) {
            // Same default as get_inv_weekly_detail: everything but voided.
            query = query.neq('status', 'void');
        } else {
            // 'avoir' is a credit note (is_avoir), the others are the status
            // column; "Envoyé" also covers 'viewed', as the badge does.
            const statuses = selectedStatuses
                .filter(s => s !== 'avoir')
                .flatMap(s => (s === 'sent' ? ['sent', 'viewed'] : [s]));
            const parts: string[] = [];
            if (statuses.length > 0) parts.push(`status.in.(${statuses.map(quoteListValue).join(',')})`);
            if (selectedStatuses.includes('avoir')) parts.push('status.eq.avoir', 'is_avoir.is.true');
            query = query.or(parts.join(','));
        }

        // Reps: named team members, and/or "Interne" = every name off the team.
        // The names come from the dropdown's own recognised selection, and Interne
        // narrows nothing until the team has loaded (an empty team would make
        // everybody look internal).
        const names = repFilter.selected.filter(n => n !== REP_INTERNAL);
        const wantsInternal = repFilter.selected.includes(REP_INTERNAL) && repTeam.team.length > 0;
        const inList = names.length > 0 ? `rep_name.in.(${names.map(quoteListValue).join(',')})` : null;
        // NOT IN is NULL, not TRUE, on a row without a rep, so Interne names the
        // NULLs explicitly or they vanish from both choices.
        const offTeam = wantsInternal
            ? `rep_name.not.in.(${repTeam.team.map(quoteListValue).join(',')}),rep_name.is.null`
            : null;
        if (inList && offTeam) query = query.or(`${inList},${offTeam}`);
        else if (inList) query = query.in('rep_name', names);
        else if (offTeam) query = query.or(offTeam);

        if (selectedDepts.length > 0) query = query.in('department', selectedDepts);
        if (office !== 'Tous') query = query.eq('office', office);
        if (shippingOnly === '1') query = query.neq('shipping_charge', 0);

        if (debouncedTerm) {
            const like = `%${debouncedTerm}%`;
            query = query.or(`client_name.ilike.${like},invoice_number.ilike.${like}`);
        }

        // The id breaks ties so paging through the export never skips or repeats
        // an invoice that shares a date.
        query = query.order(SORT_COLUMNS[sortKey], { ascending, nullsFirst: false });
        if (sortKey !== 'invoice_date') query = query.order('invoice_date', { ascending: false });
        return query.order('zoho_id', { ascending: true });
    }, [dateBounds, selectedStatuses, repFilter.selected, repTeam.team, selectedDepts, office,
        shippingOnly, debouncedTerm, sortKey, ascending]);

    /** Responses do not come back in the order they were sent; only the latest may land. */
    const requestId = useRef(0);

    const fetchData = useCallback(async () => {
        const id = ++requestId.current;
        setLoading(true);
        const from = (page - 1) * PAGE_SIZE;
        const { data, count, error: err } = await buildQuery('page').range(from, from + PAGE_SIZE - 1);
        if (id !== requestId.current) return;
        if (err) {
            setError(err.message);
            setRows([]);
            setTotal(0);
            setLoading(false);
            return;
        }
        setError(null);
        setRows((data as unknown as InvDetailRow[]) ?? []);
        setTotal(count ?? 0);
        setLoading(false);

        // A page number can outlive its result (shared link, Back button).
        const lastPage = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
        if (page > lastPage) setPage(lastPage);
    }, [buildQuery, page, setPage]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    useEffect(() => { fetchData(); }, [fetchData]);

    /** The whole filtered set in slices of a thousand, stopping on an EMPTY page. */
    const fetchAllFiltered = useCallback(async (): Promise<InvDetailRow[]> => {
        const out: InvDetailRow[] = [];
        for (let from = 0; from < EXPORT_MAX; from += EXPORT_PAGE) {
            const { data, error: err } = await buildQuery('export').range(from, from + EXPORT_PAGE - 1);
            if (err) throw new Error(err.message);
            const pageRows = (data as unknown as InvDetailRow[]) ?? [];
            out.push(...pageRows);
            if (pageRows.length === 0) break;
        }
        return out;
    }, [buildQuery]);

    const exportRows = useCallback(
        async () => (await fetchAllFiltered()).map(r => ({ ...r, rep_name: repTeam.display(r.rep_name) })),
        [fetchAllFiltered, repTeam],
    );

    const handleSort = (key: SortKey) => {
        const nextDir = key === sortKey ? (ascending ? 'desc' : 'asc') : (key === 'invoice_date' || key === 'amount' ? 'desc' : 'asc');
        setSortParam(key, { page: null, dir: nextDir === 'desc' ? null : nextDir });
    };

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const rangeEnd = Math.min(page * PAGE_SIZE, total);

    const yearOptions = useMemo(() => {
        const years: { value: string; label: string }[] = [{ value: 'Toutes', label: 'Toutes les années' }];
        for (let y = currentYear; y >= FIRST_YEAR; y--) years.push({ value: String(y), label: String(y) });
        return years;
    }, [currentYear]);
    const monthOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))],
        [],
    );

    const th = 'px-3 md:px-5 py-2.5 md:py-3 text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap';
    const sortableTh = (key: SortKey, label: string, align: 'left' | 'right' = 'left') => (
        <th
            className={cn(th, align === 'right' ? 'text-right' : 'text-left', 'cursor-pointer hover:bg-stone transition-colors group')}
            onClick={() => handleSort(key)}
            aria-sort={sortKey === key ? (ascending ? 'ascending' : 'descending') : 'none'}
        >
            <div className={cn('flex items-center gap-2', align === 'right' && 'justify-end')}>
                {label} <SortIcon order={sortKey === key ? (ascending ? 'asc' : 'desc') : null} />
            </div>
        </th>
    );

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">Toutes les factures</h1>
                    <p className="text-xs md:text-sm text-ink-mute mt-0.5">Factures et avoirs</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <ExportButton
                        rows={exportRows} columns={INVOICE_CSV} filename="factures"
                        label={total > 0 ? `Exporter ${total.toLocaleString('fr-CA')} factures` : 'Exporter CSV'}
                        disabled={total === 0}
                    />
                    <button onClick={() => fetchDataRef.current()} className="btn btn-xs btn-quiet">
                        <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
                        Actualiser
                    </button>
                </div>
            </div>

            <FilterBar>
                <FilterGroup label="Recherche">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-mute" />
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Client ou numéro…"
                            aria-label="Rechercher une facture"
                            className="w-64 h-9 pl-9 pr-3 rounded-md border border-hairline-strong bg-white text-sm
                                       placeholder:text-ink-faint focus:outline-none focus:ring-2
                                       focus:ring-ring focus:border-primary"
                        />
                    </div>
                </FilterGroup>
                <FilterGroup label="Année">
                    <Select value={yearParam} onChange={setYear} options={yearOptions} variant="accent" className="w-40" />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select
                        value={String(month)} onChange={setMonth} options={monthOptions}
                        disabled={year === 'Toutes'} className="w-40"
                    />
                </FilterGroup>
                <FilterGroup label="Statut">
                    <MultiSelect
                        values={selectedStatuses} onChange={setStatuses}
                        options={INVOICE_STATUSES.map(s => ({ value: s.value, label: s.label }))}
                        allLabel="Tous les statuts" className="w-48"
                    />
                </FilterGroup>
                <FilterGroup label="Représentant">
                    <MultiSelect
                        values={repFilter.selected} onChange={setReps} options={repFilter.options}
                        allLabel={REP_ALL_LABEL} allIcon={repFilter.allIcon} className="w-48"
                    />
                </FilterGroup>
                <FilterGroup label="Département">
                    <MultiSelect
                        values={selectedDepts} onChange={setDepts}
                        options={DEPARTMENTS.map(d => ({ value: d, label: d }))}
                        allLabel="Tous les départements" className="w-52"
                    />
                </FilterGroup>
                <FilterGroup label="Bureau">
                    <Select
                        value={office} onChange={setOffice} className="w-40"
                        options={[{ value: 'Tous', label: 'Tous les bureaux' }, ...OFFICES.map(o => ({ value: o.value, label: o.label }))]}
                    />
                </FilterGroup>
                <FilterGroup label="Livraison">
                    <Select
                        value={shippingOnly} onChange={setShippingOnly} className="w-44"
                        options={[
                            { value: '', label: 'Toutes les factures' },
                            { value: '1', label: 'Avec livraison' },
                        ]}
                    />
                </FilterGroup>
                <ClearFiltersButton activeCount={activeFilterCount} onClear={clearFilters} />
            </FilterBar>

            <div className="bg-white rounded-xl shadow-card overflow-hidden">
                <Pager
                    page={page} totalPages={totalPages} total={total}
                    rangeStart={rangeStart} rangeEnd={rangeEnd}
                    onChange={setPage} position="top"
                />

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-6 h-6 animate-spin text-primary-press" />
                    </div>
                ) : error ? (
                    <p className="py-20 text-center text-sm text-tone-critical-ink">Erreur de chargement : {error}</p>
                ) : rows.length === 0 ? (
                    <p className="py-20 text-center text-sm text-ink-mute">Aucune facture ne correspond à ces filtres.</p>
                ) : (
                    <div className="max-h-[calc(100dvh-8rem)] overflow-auto">
                        <table className="w-full text-sm" translate="no">
                            <thead className="sticky top-0 z-10 bg-white">
                                <tr className="border-b border-hairline bg-sand/50">
                                    {sortableTh('invoice_date', 'Date')}
                                    {sortableTh('invoice_number', '# Facture')}
                                    {sortableTh('client_name', 'Client')}
                                    {sortableTh('rep_name', 'Représentant')}
                                    {sortableTh('department', 'Département')}
                                    {sortableTh('office', 'Bureau')}
                                    {sortableTh('status', 'Statut')}
                                    {sortableTh('amount', 'Montant', 'right')}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hairline">
                                {rows.map(item => (
                                    <tr
                                        key={item.zoho_id}
                                        className={cn('hover:bg-sand/60 transition-colors', item.is_avoir && 'bg-tone-critical-soft/30')}
                                    >
                                        <td className="px-3 md:px-5 py-2.5 md:py-3.5 text-ink-mute whitespace-nowrap text-2xs font-medium">
                                            {formatShortDate(item.invoice_date)}
                                        </td>
                                        <td className="px-3 md:px-5 py-2.5 md:py-3.5 font-mono text-2xs text-ink-mute whitespace-nowrap">
                                            {item.invoice_number}
                                        </td>
                                        <td className="px-3 md:px-5 py-2.5 md:py-3.5 font-bold text-ink max-w-[200px] md:max-w-[280px] truncate" title={item.client_name}>
                                            {item.client_name}
                                        </td>
                                        <td className="px-3 md:px-5 py-2.5 md:py-3.5 text-ink-secondary whitespace-nowrap font-medium">
                                            <RepName name={item.rep_name} size="sm" />
                                        </td>
                                        <td className="px-3 md:px-5 py-2.5 md:py-3.5">
                                            {item.department && (
                                                <span className={cn(
                                                    'inline-flex items-center px-2 py-0.5 rounded-md text-2xs font-bold whitespace-nowrap border',
                                                    DEPT_COLORS[item.department] ?? 'bg-stone text-ink-secondary border-hairline-strong/50',
                                                )}>
                                                    {item.department}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-3 md:px-5 py-2.5 md:py-3.5 text-ink-secondary whitespace-nowrap text-2xs font-semibold">
                                            {item.office}
                                        </td>
                                        <td className="px-3 md:px-5 py-2.5 md:py-3.5">
                                            <InvStatusBadge status={item.status} isAvoir={item.is_avoir} />
                                        </td>
                                        <td className={cn(
                                            'px-3 md:px-5 py-2.5 md:py-3.5 text-right font-bold tabular-nums whitespace-nowrap',
                                            item.is_avoir ? 'text-tone-critical-ink' : 'text-ink',
                                        )}>
                                            {formatCurrencyCAD(item.amount)}
                                            <ShippingNote amount={item.shipping_charge} className="mt-0.5" />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {!loading && rows.length > 0 && (
                    <Pager
                        page={page} totalPages={totalPages} total={total}
                        rangeStart={rangeStart} rangeEnd={rangeEnd}
                        onChange={setPage} position="bottom"
                    />
                )}
            </div>
        </div>
    );
}

/** Same columns as the weekly list's invoice export, "Dont livraison" included. */
const INVOICE_CSV: CsvColumn<InvDetailRow>[] = [
    { header: 'Date',           value: r => r.invoice_date },
    { header: 'Numero',         value: r => r.invoice_number },
    { header: 'Client',         value: r => r.client_name },
    { header: 'Representant',   value: r => r.rep_name },
    { header: 'Departement',    value: r => r.department },
    { header: 'Bureau',         value: r => r.office },
    { header: 'Statut',         value: r => String(r.status ?? '') },
    { header: 'Montant',        value: r => Number(r.amount) },
    { header: 'Dont livraison', value: r => (r.shipping_charge != null ? Number(r.shipping_charge) : null) },
];

function Pager({ page, totalPages, total, rangeStart, rangeEnd, onChange, position }: {
    page: number;
    totalPages: number;
    total: number;
    rangeStart: number;
    rangeEnd: number;
    onChange: (p: number) => void;
    position: 'top' | 'bottom';
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
                    ? 'Aucune facture'
                    : rangeStart + '–' + rangeEnd + ' sur ' + total.toLocaleString('fr-CA') + ' factures'}
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
