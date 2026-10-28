import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, Search } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import { useUrlList, useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { useRepFilter, REP_ALL_LABEL } from '../hooks/useRepFilter';
import { useRepTeam } from '../lib/repTeam';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { MultiSelect } from '../components/MultiSelect';
import { ClearFiltersButton } from '../components/ClearFiltersButton';
import { ExportButton } from '../components/ExportButton';
import { Pager } from '../components/Pager';
import { SortIcon } from '../components/SortIcon';
import { RepName } from '../components/RepAvatar';
import { ShippingNote } from '../components/ShippingNote';
import { DeptBadge, InvoiceStatusBadge, QuoteStatusBadge } from '../components/documents/DocumentBadges';
import {
    INVOICE_STATUS_OPTIONS, QUOTE_STATUS_OPTIONS, invoiceStatusLabel, quoteStatusLabel,
} from '../components/documents/documentStatus';
import {
    DOCUMENT_LIST_RPC, DOCUMENT_OPTIONS_KIND, DOCUMENT_PAGE_SIZE, documentListArgs,
    type DocumentKind, type DocumentListQuery,
} from '../components/documents/documentLists';
import type { CsvColumn } from '../lib/csv';
import type { DocumentListOptions, DocumentListPage, InvoiceListRow, QuoteListRow } from '../types/database';
import { cn, formatCurrencyCAD, formatShortDate } from '../lib/utils';

/**
 * Toutes les factures / Tous les devis.
 *
 * Every document Zoho Books holds, with the columns of the weekly detail table
 * and no week to pick. Search, filters, sort, count, total and paging all run
 * in Postgres (get_invoice_list / get_quote_list): the page holds 100 of tens of
 * thousands of rows, so anything done in the browser would act on those 100.
 */

/** One table row, from either list. */
interface DocRow {
    id: string;
    number: string | null;
    date: string | null;
    client: string;
    amount: number;
    shipping: number | null;
    rep: string | null;
    department: string | null;
    deptLabel: string | null;
    office: string | null;
    isAvoir: boolean;
    status: string | null;
    zohoStatus: string | null;
}

function toRows(kind: DocumentKind, rows: Array<InvoiceListRow | QuoteListRow>): DocRow[] {
    if (kind === 'factures') {
        return (rows as InvoiceListRow[]).map(r => ({
            id: r.zoho_id, number: r.invoice_number, date: r.invoice_date, client: r.client_name,
            amount: Number(r.amount), shipping: r.shipping_charge, rep: r.rep_name,
            department: r.department, deptLabel: r.zoho_department_label, office: r.office,
            isAvoir: r.is_avoir, status: r.status, zohoStatus: null,
        }));
    }
    return (rows as QuoteListRow[]).map(r => ({
        id: r.zoho_id, number: r.quote_number, date: r.quote_date, client: r.client_name,
        amount: Number(r.amount), shipping: null, rep: r.rep_name,
        department: r.department, deptLabel: r.zoho_department_label, office: r.office,
        isAvoir: false, status: r.status, zohoStatus: r.zoho_status,
    }));
}

const COPY = {
    factures: {
        title: 'Factures · Toutes les factures',
        subtitle: 'Toutes les factures et tous les avoirs de Zoho Books, QC et MTL.',
        tableTitle: 'Liste détaillée des factures',
        noun: 'factures',
        emptyLabel: 'Aucune facture',
        emptyMessage: 'Aucune facture ne correspond à ces critères.',
        numberHeader: '# Facture',
        statusOptions: INVOICE_STATUS_OPTIONS,
        table: 'invoices',
        exportName: 'factures',
    },
    devis: {
        title: 'Devis · Tous les devis',
        subtitle: 'Tous les devis de Zoho Books, QC et MTL, quel que soit leur statut. Datés à leur émission.',
        tableTitle: 'Liste détaillée des devis',
        noun: 'devis',
        emptyLabel: 'Aucun devis',
        emptyMessage: 'Aucun devis ne correspond à ces critères.',
        numberHeader: '# Devis',
        statusOptions: QUOTE_STATUS_OPTIONS,
        table: 'sales',
        exportName: 'devis',
    },
} as const;

function statusLabel(kind: DocumentKind, r: DocRow): string {
    return kind === 'factures'
        ? invoiceStatusLabel(r.status ?? '', r.isAvoir)
        : quoteStatusLabel(r.status, r.zohoStatus);
}

function zohoUrl(kind: DocumentKind, r: DocRow): string {
    const org = r.office === 'MTL' ? '815683274' : '48244978';
    const path = kind === 'devis' ? 'quotes' : r.isAvoir ? 'creditnotes' : 'invoices';
    return `https://books.zoho.com/app/${org}#/${path}/${r.id}`;
}

/** The RPC caps a page at this many rows; the export reads in slices of it. */
const EXPORT_PAGE = 1000;
const EXPORT_MAX = 100_000;

const NO_REPS: string[] = [];

export default function DocumentList({ kind }: { kind: DocumentKind }) {
    const copy = COPY[kind];
    const [yearParam, _setYear] = useUrlState('year', 'Toutes');
    const [selectedStatuses, _setStatuses] = useUrlList('statut');
    const [selectedReps, _setReps] = useUrlList('rep');
    const [sortParam, _setSort] = useUrlState('tri', 'date');
    const [orderParam] = useUrlState('ordre', 'desc');
    const [page, setPage] = useUrlStateNumber('page', 1);

    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [options, setOptions] = useState<DocumentListOptions | null>(null);
    const [result, setResult] = useState<DocumentListPage<InvoiceListRow | QuoteListRow> | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);

    const repTeam = useRepTeam();
    // NO_REPS rather than a fresh [] while the options load, so the query is not
    // rebuilt on every render.
    const repFilter = useRepFilter(selectedReps, options?.reps ?? NO_REPS);

    const year = yearParam === 'Toutes' ? null : (Number(yearParam) || null);
    const sort: 'date' | 'amount' = sortParam === 'montant' ? 'amount' : 'date';
    const desc = orderParam !== 'asc';
    // Known values only, in option order: one selection, one cache key.
    const statuses = useMemo(
        () => copy.statusOptions.map(o => o.value).filter(v => selectedStatuses.includes(v)),
        [copy, selectedStatuses],
    );

    // A filter and the page reset move in ONE navigation; see UrlStateCompanions.
    const toPage1 = { page: null };
    const setYear = (v: string) => _setYear(v, toPage1);
    const setStatuses = (v: string[]) => _setStatuses(v, toPage1);
    const setReps = (v: string[]) => _setReps(v, toPage1);
    /** A second click on the sorted column flips it; a new column starts descending. */
    const sortBy = (key: 'date' | 'amount') => {
        const nextDesc = key === sort ? !desc : true;
        _setSort(key === 'amount' ? 'montant' : 'date', { ordre: nextDesc ? null : 'asc', page: null });
    };

    // Debounced, with the page reset skipped on the first run so a shared
    // ?page=3 survives the mount.
    const searchSettled = useRef(false);
    useEffect(() => {
        const t = setTimeout(() => {
            setDebouncedSearch(search);
            if (searchSettled.current) setPage(1);
            searchSettled.current = true;
        }, 300);
        return () => clearTimeout(t);
        // setPage is stable; search is the only real trigger.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [search]);

    const query = useMemo<DocumentListQuery>(() => ({
        search: debouncedSearch,
        statuses,
        reps: repFilter.rep ? [repFilter.rep] : repFilter.reps,
        year,
        sort,
        desc,
    }), [debouncedSearch, statuses, repFilter.rep, repFilter.reps, year, sort, desc]);

    // Responses do not come back in the order they were sent; only the latest
    // request may write the table.
    const requestId = useRef(0);
    const fetchPage = useCallback(async () => {
        const id = ++requestId.current;
        setLoading(true);
        const { data, error } = await cachedRpc<DocumentListPage<InvoiceListRow | QuoteListRow>>(
            DOCUMENT_LIST_RPC[kind],
            documentListArgs(query, DOCUMENT_PAGE_SIZE, (page - 1) * DOCUMENT_PAGE_SIZE),
        );
        if (id !== requestId.current) return;
        setLoading(false);
        if (error || !data) { setFailed(true); return; }
        setFailed(false);
        setResult(data);
        // A page number can outlive its result (a shared link, Back after
        // narrowing). Clamping cannot loop: the value written is always valid.
        const lastPage = Math.max(1, Math.ceil(data.total_count / DOCUMENT_PAGE_SIZE));
        if (page > lastPage) setPage(lastPage);
    }, [kind, query, page, setPage]);

    const fetchRef = useRef(fetchPage);
    useEffect(() => { fetchRef.current = fetchPage; }, [fetchPage]);
    useEffect(() => { fetchPage(); }, [fetchPage]);

    useEffect(() => {
        cachedRpc<DocumentListOptions>('get_document_list_options', { p_kind: DOCUMENT_OPTIONS_KIND[kind] })
            .then(({ data }) => { if (data) setOptions(data); });
    }, [kind]);

    // A sync, and above all a back-fill, writes rows in bursts: one refetch per
    // pause rather than one per row.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const channel = supabase.channel(`document-list-${kind}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: copy.table }, () => {
                clearTimeout(timer);
                timer = setTimeout(() => { invalidateRpcCache(); fetchRef.current(); }, 2000);
            }).subscribe();
        return () => { clearTimeout(timer); supabase.removeChannel(channel); };
    }, [kind, copy.table]);

    const rows = useMemo(() => (result ? toRows(kind, result.rows) : []), [kind, result]);
    const total = result?.total_count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / DOCUMENT_PAGE_SIZE));
    const rangeStart = total === 0 ? 0 : (page - 1) * DOCUMENT_PAGE_SIZE + 1;
    const rangeEnd = Math.min(page * DOCUMENT_PAGE_SIZE, total);

    /** Every row of the filtered set, not the visible page. Rep names say what the screen says. */
    const exportRows = useCallback(async (): Promise<DocRow[]> => {
        const out: DocRow[] = [];
        for (let offset = 0; offset < EXPORT_MAX; offset += EXPORT_PAGE) {
            const { data, error } = await supabase.rpc(DOCUMENT_LIST_RPC[kind], documentListArgs(query, EXPORT_PAGE, offset));
            // A plain object from postgrest-js, not an Error: wrapped for the message.
            if (error) throw new Error(error.message);
            const pageRows = toRows(kind, (data as DocumentListPage<InvoiceListRow | QuoteListRow>).rows);
            // An empty page ends it, not a short one.
            if (pageRows.length === 0) break;
            out.push(...pageRows);
        }
        return out.map(r => ({ ...r, rep: r.rep ? repTeam.display(r.rep) : null }));
    }, [kind, query, repTeam]);

    const csvColumns = useMemo<CsvColumn<DocRow>[]>(() => [
        { header: 'Date',         value: r => r.date },
        { header: 'Numéro',       value: r => r.number },
        { header: 'Client',       value: r => r.client },
        { header: 'Représentant', value: r => r.rep },
        { header: 'Département',  value: r => r.department ?? r.deptLabel },
        { header: 'Bureau',       value: r => r.office },
        { header: 'Statut',       value: r => statusLabel(kind, r) },
        { header: 'Montant',      value: r => r.amount },
        ...(kind === 'factures' ? [{ header: 'Dont livraison', value: (r: DocRow) => r.shipping }] : []),
    ], [kind]);

    const yearOptions = useMemo(() => [
        { value: 'Toutes', label: 'Toutes les années' },
        ...(options?.years ?? []).map(y => ({ value: String(y), label: String(y) })),
    ], [options]);

    // Counted from `search`, not the debounced value, so the badge reacts as you type.
    const activeFilterCount = [
        search.trim() !== '', year !== null, statuses.length > 0, !repFilter.isAll,
    ].filter(Boolean).length;
    const clearFilters = () => {
        setSearch('');
        _setYear('Toutes', { statut: null, rep: null, page: null });
    };

    const refresh = () => { invalidateRpcCache(); fetchRef.current(); };

    const thSort = (key: 'date' | 'amount', label: string, align: 'left' | 'right') => (
        <th
            className={cn(
                "px-3 2xl:px-5 py-2.5 md:py-3 text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap cursor-pointer hover:bg-stone transition-colors group",
                align === 'right' ? 'text-right' : 'text-left',
                sort === key && 'bg-stone/60',
            )}
            onClick={() => sortBy(key)}
            aria-sort={sort === key ? (desc ? 'descending' : 'ascending') : 'none'}
        >
            <div className={cn("flex items-center gap-2", align === 'right' && 'justify-end')}>
                {label} <SortIcon order={sort === key ? (desc ? 'desc' : 'asc') : null} />
            </div>
        </th>
    );
    const th = "px-3 2xl:px-5 py-2.5 md:py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap";
    const td = "px-3 2xl:px-5 py-2.5 md:py-3.5";

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex-1 min-w-[16rem]">
                    <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">{copy.title}</h1>
                    <p className="text-xs md:text-sm text-ink-mute mt-0.5">{copy.subtitle}</p>
                </div>
                <button onClick={refresh} className="btn btn-xs btn-quiet">
                    <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
                    Actualiser
                </button>
            </div>

            <FilterBar>
                <FilterGroup label="Recherche">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-mute" />
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Client, numéro, représentant…"
                            aria-label={`Rechercher dans les ${copy.noun}`}
                            className="w-full md:w-64 h-9 pl-9 pr-3 rounded-md border border-hairline-strong bg-white text-sm
                                       placeholder:text-ink-faint focus:outline-none focus:ring-2
                                       focus:ring-ring focus:border-primary"
                        />
                    </div>
                </FilterGroup>
                <FilterGroup label="Statut">
                    <MultiSelect values={statuses} onChange={setStatuses} options={[...copy.statusOptions]}
                                 allLabel="Tous les statuts" className="w-44" />
                </FilterGroup>
                <FilterGroup label="Représentant">
                    <MultiSelect values={repFilter.selected} onChange={setReps} options={repFilter.options}
                                 allLabel={REP_ALL_LABEL} allIcon={repFilter.allIcon} className="w-52" />
                </FilterGroup>
                <FilterGroup label="Année">
                    <Select value={year === null ? 'Toutes' : String(year)} onChange={setYear}
                            options={yearOptions} className="w-40" />
                </FilterGroup>
                <ClearFiltersButton activeCount={activeFilterCount} onClear={clearFilters} />
            </FilterBar>

            <div className="bg-white rounded-xl shadow-card overflow-hidden">
                <div className="px-5 py-3.5 border-b border-hairline flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold text-ink-secondary uppercase tracking-label">{copy.tableTitle}</h2>
                    <div className="flex items-center gap-2">
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-2xs font-semibold bg-stone text-ink-secondary uppercase tracking-label"
                              translate="no">
                            {total.toLocaleString('fr-CA')} {copy.noun}
                        </span>
                        <ExportButton rows={exportRows} columns={csvColumns} filename={copy.exportName}
                                      label="CSV" disabled={total === 0} />
                    </div>
                </div>

                <Pager
                    page={page} totalPages={totalPages} total={total}
                    rangeStart={rangeStart} rangeEnd={rangeEnd}
                    onChange={setPage} position="top"
                    noun={copy.noun} emptyLabel={copy.emptyLabel}
                />

                {!result && loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-6 h-6 animate-spin text-primary-press" />
                    </div>
                ) : failed && !result ? (
                    <p className="py-20 text-center text-sm text-ink-mute">
                        La liste n'a pas pu être chargée. Réessayez avec « Actualiser ».
                    </p>
                ) : rows.length === 0 ? (
                    <p className="py-20 text-center text-sm text-ink-mute">{copy.emptyMessage}</p>
                ) : (
                    // Scrolls in a box no taller than the window, so the sticky
                    // header has something to stick to. A refetch dims the rows it
                    // is about to replace instead of swapping them for a spinner.
                    <div className={cn('max-h-[calc(100dvh-8rem)] overflow-auto transition-opacity', loading && 'opacity-60')}>
                        {/* translate="no": names, numbers and amounts, never prose. */}
                        <table className="w-full text-sm" translate="no">
                            <thead className="sticky top-0 z-10 bg-white">
                                <tr className="border-b border-hairline bg-sand/50">
                                    {thSort('date', 'Date', 'left')}
                                    <th className={th}>Statut</th>
                                    <th className={th}>Client</th>
                                    {thSort('amount', 'Montant', 'right')}
                                    <th className={th}>{copy.numberHeader}</th>
                                    <th className={th}>Représentant</th>
                                    <th className={th}>Département</th>
                                    <th className={cn(th, 'text-center')}>Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hairline">
                                {rows.map(r => (
                                    <tr key={r.id} className={cn("hover:bg-sand/60 transition-colors group", r.isAvoir && "bg-tone-critical-soft/30")}>
                                        <td className={cn(td, "text-ink-mute whitespace-nowrap text-2xs font-medium")}>
                                            {r.date ? formatShortDate(r.date) : '—'}
                                        </td>
                                        <td className={td}>
                                            {kind === 'factures'
                                                ? <InvoiceStatusBadge status={r.status ?? ''} isAvoir={r.isAvoir} />
                                                : <QuoteStatusBadge status={r.status} zohoStatus={r.zohoStatus} />}
                                        </td>
                                        <td className={cn(td, "font-bold text-ink max-w-[160px] md:max-w-[200px] 2xl:max-w-[320px] truncate")} title={r.client}>
                                            {r.client}
                                        </td>
                                        <td className={cn(td, "text-right font-bold tabular-nums whitespace-nowrap transition-colors",
                                                          r.isAvoir ? "text-tone-critical-ink" : "text-ink group-hover:text-primary-press")}>
                                            {formatCurrencyCAD(r.amount)}
                                            {kind === 'factures' && <ShippingNote amount={r.shipping} className="mt-0.5" />}
                                        </td>
                                        <td className={cn(td, "font-mono text-2xs text-ink-mute whitespace-nowrap")}>{r.number ?? '—'}</td>
                                        <td className={cn(td, "text-ink-secondary font-medium")}>
                                            <RepName name={r.rep} size="sm" />
                                        </td>
                                        <td className={td}>
                                            <DeptBadge department={r.department} rawLabel={r.deptLabel} />
                                        </td>
                                        <td className={cn(td, "text-center")}>
                                            <a
                                                href={zohoUrl(kind, r)}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center justify-center p-1.5 rounded-md text-ink-faint hover:text-primary-press hover:bg-primary-wash transition-all"
                                                title="Voir dans Zoho Books"
                                                aria-label={`Ouvrir ${r.number ?? 'ce document'} dans Zoho Books`}
                                            >
                                                <ExternalLink className="w-4 h-4" />
                                            </a>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="bg-ink text-white font-bold">
                                    <td colSpan={3} className="px-3 2xl:px-5 py-3 md:py-4 text-2xs uppercase tracking-eyebrow">
                                        Total · {total.toLocaleString('fr-CA')} {copy.noun}
                                    </td>
                                    <td className="px-3 2xl:px-5 py-3 md:py-4 text-right font-bold tabular-nums whitespace-nowrap">
                                        {formatCurrencyCAD(result?.total_amount ?? 0)}
                                    </td>
                                    <td colSpan={4} className="px-3 2xl:px-5 py-3 md:py-4"></td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                )}

                {rows.length > 0 && (
                    <Pager
                        page={page} totalPages={totalPages} total={total}
                        rangeStart={rangeStart} rangeEnd={rangeEnd}
                        onChange={setPage} position="bottom"
                        noun={copy.noun} emptyLabel={copy.emptyLabel}
                    />
                )}
            </div>
        </div>
    );
}
