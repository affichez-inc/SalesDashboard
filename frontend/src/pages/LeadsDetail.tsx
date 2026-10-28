import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlStateNumber, useUrlList } from '../hooks/useUrlState';
import { MultiSelect } from '../components/MultiSelect';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import { Loader2, ExternalLink, Search, RefreshCw, ChevronLeft, ChevronRight, FileText, X } from 'lucide-react';
import type {
    ZohoLeadRow, ZohoLeadFilterOptions, LeadInvoiceRow, LeadInvoiceTotals,
    AttributionOrigin,
} from '../types/database';
import { MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { RepName } from '../components/RepAvatar';
import {
    formatShortDate, formatCurrencyCAD, formatPhone, phoneSearchPattern, clipServices, cn,
} from '../lib/utils';

const STAGE_LABELS: Record<string, string> = {
    lead: 'Lead',
    contact: 'Contact',
};

const STAGE_COLORS: Record<string, string> = {
    lead: 'bg-data-2 text-data-2-ink',
    contact: 'bg-data-1 text-data-1-ink',
};

const INVOICE_STATUS_LABELS: Record<string, string> = {
    paid: 'Payé', partial: 'Partiel', sent: 'Envoyé',
    viewed: 'Envoyé', overdue: 'En retard', avoir: 'Avoir', void: 'Annulé',
};

const INVOICE_STATUS_COLORS: Record<string, string> = {
    paid: 'bg-tone-good-soft text-tone-good-ink',
    partial: 'bg-tone-warn-soft text-tone-warn-ink',
    sent: 'bg-stone text-ink-secondary',
    viewed: 'bg-stone text-ink-secondary',
    overdue: 'bg-tone-critical-soft text-tone-critical-ink',
    avoir: 'bg-tone-critical-soft text-tone-critical-ink',
    void: 'bg-stone text-ink-secondary',
};

/** Zoho writes "-None-" into a picklist that was never set. */
const isBlankPick = (v: string | null): boolean => !v || v === '-None-';

/** Zoho timestamps carry an offset (…-04:00); show date + time, they matter here. */
function formatDateTime(value: string | null): string {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return `${formatShortDate(d)} ${d.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })}`;
}

const PAGE_SIZE = 100;

/**
 * PostgREST's `or` filter is comma-separated and paren-grouped, so those
 * characters in a search term would corrupt the query rather than match text.
 * `%` and `_` are ilike wildcards and are escaped so they match literally.
 */
function sanitizeSearch(raw: string): string {
    return raw.replace(/[,()]/g, ' ').replace(/[%_\\]/g, '\\$&').trim();
}

export default function LeadsDetail({ propRepName }: { propRepName?: string }) {
    // 'Toutes' spans every year. Records go back well before 2023, so a mandatory
    // single-year filter hid most of the data with no way to widen it.
    const [yearParam, _setYearParam] = useUrlState('year', '2026');
    const year: number | 'Toutes' = yearParam === 'Toutes' ? 'Toutes' : Number(yearParam);
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    // Several values each; an empty list is "no filter".
    const [selectedReps, _setSelectedReps] = useUrlList('rep');
    const [selectedSources, _setSelectedSources] = useUrlList('source');
    const [selectedServices, _setSelectedServices] = useUrlList('service');
    const [selectedStage, _setSelectedStage] = useUrlState('stage', 'Tous');
    // Composes with the Type filter above rather than replacing it: "leads with
    // invoices", "contacts with invoices" and "both" are Type x Factures, so the
    // two stay separate dropdowns instead of one combined list of six.
    const [selectedInvoiced, _setSelectedInvoiced] = useUrlState('factures', 'Tous');
    const [page, setPage] = useUrlStateNumber('page', 1);

    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');

    // Changing any filter must return to page 1 - otherwise a narrower result set
    // leaves you stranded on a page that no longer exists, showing nothing.
    //
    // Both params move in ONE navigation. Calling the two setters in sequence
    // looked equivalent but silently broke every filter on this page: react-router
    // hands each setter the search params from the render it was created in, so
    // the `page` reset started from a snapshot that predated the filter change and
    // its navigate() overwrote it. See UrlStateCompanions in hooks/useUrlState.
    const toPage1 = { page: null };
    const setYear = (v: number | 'Toutes') =>
        _setYearParam(v === 'Toutes' ? 'Toutes' : String(v), toPage1);
    const setSelectedMonth = (v: number | 'Toutes') =>
        _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v), toPage1);
    const setSelectedReps = (v: string[]) => _setSelectedReps(v, toPage1);
    const setSelectedSources = (v: string[]) => _setSelectedSources(v, toPage1);
    const setSelectedServices = (v: string[]) => _setSelectedServices(v, toPage1);
    const setSelectedStage = (v: string) => _setSelectedStage(v, toPage1);
    const setSelectedInvoiced = (v: string) => _setSelectedInvoiced(v, toPage1);

    const [rows, setRows] = useState<ZohoLeadRow[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);

    // Invoice rollups for the accounts on the current page only - one RPC per
    // page rather than per row. Keyed by CRM account id, so two contacts at the
    // same company share an entry, which is also how Zoho owns the invoices.
    const [invoiceTotals, setInvoiceTotals] = useState<Record<string, LeadInvoiceTotals>>({});
    const [invoiceModal, setInvoiceModal] = useState<ZohoLeadRow | null>(null);
    // Paging faster than the rollup returns would let an earlier response land
    // last and blank the column for leads that do have invoices. Only the newest
    // request may write.
    const totalsRequestRef = useRef(0);

    // Dropdown options come from the data rather than a hardcoded list: Zoho's
    // Lead Source picklist has 34 values, most unused, and the service field is a
    // multi-select. Deriving them keeps the filters honest as the CRM changes.
    const [allSources, setAllSources] = useState<string[]>([]);
    const [allServices, setAllServices] = useState<string[]>([]);
    const [allReps, setAllReps] = useState<string[]>([]);
    // Every raw spelling behind each service label. Zoho stores the same service
    // under variants that differ in case or spacing, so matching the label alone
    // silently dropped rows - "Distribution Publicitaire" returned 166 of 2,209.
    const [serviceVariants, setServiceVariants] = useState<Record<string, string[]>>({});

    const effectiveRepName = propRepName ?? null;

    /** null = no date filter at all (every year). */
    const yearBounds = useMemo(() => {
        if (year === 'Toutes') return null;
        if (selectedMonth === 'Toutes') {
            return { from: `${year}-01-01T00:00:00Z`, to: `${year + 1}-01-01T00:00:00Z` };
        }
        const m = Number(selectedMonth);
        const nextYear = m === 12 ? year + 1 : year;
        const nextMonth = m === 12 ? 1 : m + 1;
        return {
            from: `${year}-${String(m).padStart(2, '0')}-01T00:00:00Z`,
            to: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00Z`,
        };
    }, [year, selectedMonth]);

    /**
     * Totals for every account represented on this page. Runs after the rows
     * land rather than as part of the same query: the aggregate is over invoices,
     * a different table with its own grain, and joining it into the paged lead
     * query would multiply rows before the LIMIT could be applied.
     */
    const fetchInvoiceTotals = useCallback(async (pageRows: ZohoLeadRow[]) => {
        const seq = ++totalsRequestRef.current;
        const isStale = () => seq !== totalsRequestRef.current;

        const ids = [...new Set(pageRows.map(r => r.account_id).filter((id): id is string => !!id))];
        if (ids.length === 0) { setInvoiceTotals({}); return; }
        const { data, error } = await cachedRpc('get_lead_invoice_totals', { p_account_ids: ids });
        if (isStale()) return;
        if (error || !data) { setInvoiceTotals({}); return; }
        const byAccount: Record<string, LeadInvoiceTotals> = {};
        for (const row of data as LeadInvoiceTotals[]) byAccount[row.account_id] = row;
        setInvoiceTotals(byAccount);
    }, []);

    const fetchData = useCallback(async () => {
        setLoading(true);

        // zoho_leads_unique drops a converted lead when its contact is also synced,
        // so the same person is not counted twice.
        // `count: 'exact'` gives the total across all pages, not just this slice.
        const from = (page - 1) * PAGE_SIZE;
        let query = supabase
            .from('zoho_leads_unique')
            .select('*', { count: 'exact' })
            .order('created_time', { ascending: false })
            .range(from, from + PAGE_SIZE - 1);

        if (yearBounds) {
            query = query.gte('created_time', yearBounds.from).lt('created_time', yearBounds.to);
        }

        if (effectiveRepName) query = query.eq('rep_name', effectiveRepName);
        else if (selectedReps.length > 0) query = query.in('rep_name', selectedReps);

        // source_resolved / service_resolved, not the raw Zoho columns: those are
        // empty for most contacts, so filtering on them would return nothing for
        // exactly the rows the dropdown was populated from.
        if (selectedSources.length > 0) query = query.in('source_resolved', selectedSources);
        if (selectedServices.length > 0) {
            // overlaps, not contains: match any spelling of any selected label.
            query = query.overlaps('service_resolved',
                selectedServices.flatMap(s => serviceVariants[s] ?? [s]));
        }
        if (selectedStage !== 'Tous') query = query.eq('stage', selectedStage);
        // Server-side, on the view's computed flag: the page is cut by
        // LIMIT/OFFSET in Postgres, so filtering on the invoice rollup here would
        // search 100 rows out of ~29k and leave the count and pager wrong.
        if (selectedInvoiced !== 'Tous') {
            query = query.eq('has_invoices', selectedInvoiced === 'avec');
        }

        // Searching server-side, not over the loaded page: with 100 rows per page a
        // client-side filter would quietly search 100 of several thousand records.
        const term = sanitizeSearch(debouncedSearch);
        if (term) {
            const like = `%${term}%`;
            query = query.or(
                `full_name.ilike.${like},company.ilike.${like},` +
                `email.ilike.${like},phone.ilike.${phoneSearchPattern(term)}`,
            );
        }

        const { data, count } = await query;
        const pageRows = (data as ZohoLeadRow[]) ?? [];
        setRows(pageRows);
        setTotal(count ?? 0);
        setLoading(false);
        // Deliberately after setLoading: the table is useful without the invoice
        // column, so it renders on the first result rather than waiting on a
        // second round trip.
        fetchInvoiceTotals(pageRows);
    }, [yearBounds, selectedReps, selectedSources, selectedServices, selectedStage,
        selectedInvoiced, effectiveRepName, page, debouncedSearch, fetchInvoiceTotals,
        serviceVariants]);

    /**
     * Options are scoped to the year only, so choosing one filter never empties
     * the others. The DISTINCT runs in Postgres - pulling rows to the browser and
     * de-duplicating here would have needed all ~29k of them.
     */
    const fetchOptions = useCallback(async () => {
        const { data, error } = await cachedRpc<ZohoLeadFilterOptions>(
            // p_stage stays null here, unlike the dashboard: this table really does
            // list both modules, so its dropdowns should cover both.
            'get_zoho_lead_filter_options', { p_year: year === 'Toutes' ? null : year, p_stage: null }, { single: true });
        if (error || !data) return;
        setAllSources(data.sources ?? []);
        setAllServices(data.services ?? []);
        setAllReps(data.reps ?? []);
        setServiceVariants(data.service_variants ?? {});
    }, [year]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchData(); }, [fetchData]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchOptions(); }, [fetchOptions]);

    // Coalesced: a full sync upserts ~29k rows, and refetching once per change
    // event would fire thousands of queries at the browser. One refresh 1.5s after
    // the last change keeps live updates without the stampede.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const sub = supabase
            .channel('zoho-leads-detail-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'zoho_leads' }, () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => { invalidateRpcCache(); fetchDataRef.current(); }, 1500);
            })
            .subscribe();
        return () => {
            if (timer) clearTimeout(timer);
            supabase.removeChannel(sub);
        };
    }, []);

    // One request per pause in typing rather than per keystroke.
    useEffect(() => {
        const id = setTimeout(() => {
            setDebouncedSearch(prev => (prev === search ? prev : search));
        }, 350);
        return () => clearTimeout(id);
    }, [search]);

    // A new search term changes the result set, so any page beyond the first is
    // meaningless. Kept separate from the setter wrappers because `search` is
    // typed, not selected.
    const lastSearchRef = useRef(debouncedSearch);
    useEffect(() => {
        if (lastSearchRef.current !== debouncedSearch) {
            lastSearchRef.current = debouncedSearch;
            setPage(1);
        }
    }, [debouncedSearch, setPage]);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const rangeEnd = Math.min(page * PAGE_SIZE, total);

    /** Page numbers around the current one, with ellipses. 293 pages can't all be buttons. */
    const pageNumbers = useMemo<(number | 'gap')[]>(() => {
        if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
        const out: (number | 'gap')[] = [1];
        const lo = Math.max(2, page - 1);
        const hi = Math.min(totalPages - 1, page + 1);
        if (lo > 2) out.push('gap');
        for (let i = lo; i <= hi; i++) out.push(i);
        if (hi < totalPages - 1) out.push('gap');
        out.push(totalPages);
        return out;
    }, [page, totalPages]);

    // Counts describe the current page - `total` is the figure for everything.
    const counts = useMemo(() => ({
        leads: rows.filter(r => r.stage === 'lead').length,
        contacts: rows.filter(r => r.stage === 'contact').length,
    }), [rows]);

    const yearOptions = [
        { value: 'Toutes', label: 'Toutes les années' },
        ...[2027, 2026, 2025, 2024, 2023, 2022].map(y => ({ value: String(y), label: String(y) })),
    ];
    const monthOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))],
        [],
    );
    const repOptions = useMemo(
        () => allReps.map(r => ({ value: r, label: r })),
        [allReps],
    );
    const sourceOptions = useMemo(
        () => allSources.map(s => ({ value: s, label: s })),
        [allSources],
    );
    const serviceOptions = useMemo(
        () => allServices.map(s => ({ value: s, label: s })),
        [allServices],
    );
    const stageOptions = [
        { value: 'Tous', label: 'Leads et contacts' },
        { value: 'lead', label: 'Leads seulement' },
        { value: 'contact', label: 'Contacts seulement' },
    ];
    // "Sans factures" also catches records with no CRM account at all - from the
    // table's side those are indistinguishable from an account that was never
    // billed, and both show an em dash in the Factures column.
    const invoicedOptions = [
        { value: 'Tous', label: 'Avec et sans factures' },
        { value: 'avec', label: 'Avec factures' },
        { value: 'sans', label: 'Sans factures' },
    ];

    const pageBtn = 'min-w-[2rem] rounded-md px-2 py-1.5 text-sm font-medium transition-colors';

    const renderPagination = (position: 'top' | 'bottom') => (
        <div
            className={cn(
                'flex flex-wrap items-center justify-between gap-3 px-6 py-3',
                position === 'top' ? 'border-b border-hairline' : 'border-t border-hairline',
            )}
        >
            <span className="text-sm text-ink-mute" translate="no">
                {`${rangeStart}–${rangeEnd} / ${total.toLocaleString('fr-CA')}`}
            </span>
            <div className="flex items-center gap-1">
                <button
                    onClick={() => setPage(Math.max(1, page - 1))}
                    disabled={page === 1}
                    aria-label="Page précédente"
                    className={cn(pageBtn, 'text-ink-secondary hover:bg-stone disabled:pointer-events-none disabled:opacity-40')}
                >
                    <ChevronLeft className="h-4 w-4" />
                </button>

                {pageNumbers.map((p, i) =>
                    p === 'gap' ? (
                        <span key={`gap-${i}`} className="px-1 text-sm text-ink-faint">…</span>
                    ) : (
                        <button
                            key={p}
                            onClick={() => setPage(p)}
                            aria-current={p === page ? 'page' : undefined}
                            className={cn(
                                pageBtn,
                                p === page
                                    ? 'bg-primary text-white'
                                    : 'text-ink-secondary hover:bg-stone',
                            )}
                        >
                            {p}
                        </button>
                    ),
                )}

                <button
                    onClick={() => setPage(Math.min(totalPages, page + 1))}
                    disabled={page >= totalPages}
                    aria-label="Page suivante"
                    className={cn(pageBtn, 'text-ink-secondary hover:bg-stone disabled:pointer-events-none disabled:opacity-40')}
                >
                    <ChevronRight className="h-4 w-4" />
                </button>
            </div>
        </div>
    );

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold text-ink">Leads · Détail</h1>
                    <p className="mt-1 text-sm text-ink-mute">
                        Leads et contacts synchronisés depuis Zoho CRM
                    </p>
                </div>
                <button
                    onClick={() => { invalidateRpcCache(); fetchData(); fetchOptions(); }}
                    className="btn btn-sm btn-secondary"
                >
                    <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                    Actualiser
                </button>
            </div>

            <FilterBar>
                <FilterGroup label="Année">
                    <Select
                        value={year === 'Toutes' ? 'Toutes' : String(year)}
                        onChange={v => setYear(v === 'Toutes' ? 'Toutes' : Number(v))}
                        options={yearOptions}
                        variant="accent"
                    />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select
                        value={selectedMonth === 'Toutes' ? 'Toutes' : String(selectedMonth)}
                        onChange={v => setSelectedMonth(v === 'Toutes' ? 'Toutes' : Number(v))}
                        options={monthOptions}
                    />
                </FilterGroup>
                {!effectiveRepName && (
                    <FilterGroup label="Propriétaire">
                        <MultiSelect values={selectedReps} onChange={setSelectedReps} options={repOptions}
                                     allLabel="Tous les reps" className="w-48" />
                    </FilterGroup>
                )}
                <FilterGroup label="Source">
                    <MultiSelect values={selectedSources} onChange={setSelectedSources} options={sourceOptions}
                                 allLabel="Toutes les sources" className="w-52" />
                </FilterGroup>
                <FilterGroup label="Service">
                    <MultiSelect values={selectedServices} onChange={setSelectedServices} options={serviceOptions}
                                 allLabel="Tous les services" className="w-48" />
                </FilterGroup>
                <FilterGroup label="Type">
                    <Select value={selectedStage} onChange={setSelectedStage} options={stageOptions} />
                </FilterGroup>
                <FilterGroup label="Factures">
                    <Select value={selectedInvoiced} onChange={setSelectedInvoiced} options={invoicedOptions} />
                </FilterGroup>
            </FilterBar>

            <div className="card">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-hairline px-6 py-4">
                    <div className="flex items-baseline gap-3">
                        <span className="text-lg font-semibold text-ink" translate="no">
                            {`${total.toLocaleString('fr-CA')} ${total === 1 ? 'enregistrement' : 'enregistrements'}`}
                        </span>
                        <span className="text-sm text-ink-mute" translate="no">
                            {total > 0
                                ? `${rangeStart}–${rangeEnd} affichés · ${counts.leads} leads · ${counts.contacts} contacts`
                                : ''}
                        </span>
                    </div>
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" />
                        <input
                            type="search"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Nom, entreprise, courriel, téléphone…"
                            className="w-72 rounded-md border border-hairline-strong py-2 pl-9 pr-3 text-sm
                                       placeholder:text-ink-mute focus:border-primary
                                       focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                    </div>
                </div>

                {totalPages > 1 && renderPagination('top')}

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="h-6 w-6 animate-spin text-primary-press" />
                    </div>
                ) : rows.length === 0 ? (
                    <div className="px-6 py-20 text-center text-sm text-ink-mute">
                        Aucun enregistrement pour ces filtres.
                    </div>
                ) : (
                    <div className="max-h-[65vh] overflow-auto">
                        <table className="w-full">
                            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_theme(colors.slate.200)]">
                                <tr>
                                    <th className="th">Nom</th>
                                    <th className="th">Entreprise</th>
                                    <th className="th">Téléphone</th>
                                    <th className="th">Courriel</th>
                                    <th className="th">Propriétaire</th>
                                    <th className="th">Source</th>
                                    <th className="th">Service</th>
                                    <th className="th">Factures</th>
                                    <th className="th">Type</th>
                                    <th className="th">Créé le</th>
                                    <th className="th">Modifié le</th>
                                    <th className="th">CRM</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(r => (
                                    <tr key={r.zoho_record_id} className="transition-colors hover:bg-sand/70">
                                        <td className="td font-medium text-ink">{r.full_name ?? '—'}</td>
                                        <td className="td">{r.company ?? '—'}</td>
                                        <td className="td whitespace-nowrap tabular-nums">{formatPhone(r.phone) ?? '—'}</td>
                                        <td className="td">
                                            {r.email
                                                ? <a href={`mailto:${r.email}`} className="text-primary-press hover:underline">{r.email}</a>
                                                : '—'}
                                        </td>
                                        <td className="td">
                                            {(r.rep_name ?? r.owner_name)
                                                ? <RepName name={r.rep_name ?? r.owner_name} size="sm" />
                                                : '—'}
                                        </td>
                                        <td className="td"><SourceCell row={r} /></td>
                                        <td className="td"><ServiceCell row={r} /></td>
                                        <td className="td">
                                            <InvoiceCell
                                                row={r}
                                                totals={r.account_id ? invoiceTotals[r.account_id] : undefined}
                                                onOpen={() => setInvoiceModal(r)}
                                            />
                                        </td>
                                        <td className="td">
                                            <span className={cn('badge', STAGE_COLORS[r.stage])}>
                                                {STAGE_LABELS[r.stage]}
                                            </span>
                                        </td>
                                        <td className="td whitespace-nowrap text-ink-mute">{formatDateTime(r.created_time)}</td>
                                        <td className="td whitespace-nowrap text-ink-mute">{formatDateTime(r.modified_time)}</td>
                                        <td className="td">
                                            {r.zoho_crm_url && (
                                                <a
                                                    href={r.zoho_crm_url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-ink-mute transition-colors hover:text-primary-press"
                                                    title="Ouvrir dans Zoho CRM"
                                                >
                                                    <ExternalLink className="h-4 w-4" />
                                                </a>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {totalPages > 1 && renderPagination('bottom')}
            </div>

            {invoiceModal && (
                <InvoiceModal lead={invoiceModal} onClose={() => setInvoiceModal(null)} />
            )}
        </div>
    );
}

/**
 * The Factures cell. Four states worth telling apart, because "no invoices" and
 * "we cannot know yet" would otherwise look identical:
 *   no account      - nothing to look up (an unconverted lead, or a contact with
 *                     no company in the CRM)
 *   account, none   - the account is known and simply has no invoices
 *   rollup pending  - the row says there are invoices, the amounts are still in
 *                     flight. Shown as a placeholder rather than an em dash, so
 *                     the column cannot briefly contradict the Factures filter
 *                     or a failed rollup call.
 *   account + row   - count and net total, click for the lines
 */
function InvoiceCell({ row, totals, onOpen }: {
    row: ZohoLeadRow;
    totals?: LeadInvoiceTotals;
    onOpen: () => void;
}) {
    if (!row.account_id) {
        return <span className="text-ink-faint" title="Aucun compte Zoho associe">&mdash;</span>;
    }
    // `=== false`, not `!`: the flag comes from the view, so a frontend shipped
    // ahead of its migration would otherwise read undefined and blank the whole
    // column. Missing falls through to the rollup, which is the previous behaviour.
    if (row.has_invoices === false) {
        return <span className="text-ink-faint" title="Aucune facture pour ce compte">&mdash;</span>;
    }
    if (row.has_invoices === undefined && !totals) {
        return <span className="text-ink-faint" title="Aucune facture pour ce compte">&mdash;</span>;
    }
    if (!totals || (totals.invoice_count === 0 && totals.credit_count === 0)) {
        return <span className="text-ink-faint" title="Chargement des montants">&hellip;</span>;
    }
    const count = totals.invoice_count + totals.credit_count;
    return (
        <button
            onClick={onOpen}
            title={`Voir les ${count} facture${count > 1 ? 's' : ''}`}
            className="inline-flex items-center gap-2 rounded-md border border-hairline-strong px-2 py-1
                       text-xs font-semibold text-ink-secondary transition-colors
                       hover:border-primary hover:bg-primary-wash hover:text-primary-press"
        >
            <FileText className="h-3.5 w-3.5" />
            <span className="tabular-nums">{count}</span>
            <span className="text-ink-faint">|</span>
            <span className={cn('tabular-nums', totals.total_amount < 0 && 'text-tone-critical-ink')}>
                {formatCurrencyCAD(totals.total_amount)}
            </span>
        </button>
    );
}

/** Every invoice on the lead's account, fetched on open. */
/**
 * Why a value is showing when the record itself does not carry it. Zoho's
 * Contacts module has no source and no service field at all, so for a contact
 * every one of these except 'own' is the normal case rather than an exception.
 */
const ORIGIN_HINTS: Record<AttributionOrigin, string> = {
    own:     'Renseigné sur la fiche',
    lead:    'Hérité du lead d’origine',
    account: 'Provenant du compte client',
    invoice: 'Départements réellement facturés',
};

/** Borrowed from somewhere else, so the cell earns the asterisk. */
function isBorrowed(origin: AttributionOrigin | null | undefined): boolean {
    return origin === 'lead' || origin === 'account' || origin === 'invoice';
}

function SourceCell({ row }: { row: ZohoLeadRow }) {
    // ?? the raw column, not ||: a frontend shipped ahead of its migration reads
    // undefined here and would otherwise blank a source it already knows.
    const source = row.source_resolved ?? row.lead_source;
    const origin = row.source_origin
        ?? (row.attribution_inherited ? 'lead' : 'own') as AttributionOrigin;

    if (isBlankPick(source)) return <span className="text-ink-faint">&mdash;</span>;
    return (
        <span title={ORIGIN_HINTS[origin]}>
            {source}
            {isBorrowed(origin) && <span className="ml-1 text-ink-mute">*</span>}
        </span>
    );
}

function ServiceCell({ row }: { row: ZohoLeadRow }) {
    const services = row.service_resolved ?? row.service_interest;
    if (!services?.length) return <span className="text-ink-faint">&mdash;</span>;

    const origin = row.service_origin
        ?? (row.attribution_inherited ? 'lead' : 'own') as AttributionOrigin;
    const { text, hiddenCount, truncated } = clipServices(services);

    // Anything the cell cannot show has to be in the tooltip, and there are two
    // ways to lose a value here, not one: a second service, or a single name too
    // long for the column. Keying this off hiddenCount alone left
    // "Développement d'application W…" with no way to read the rest.
    const elided = hiddenCount > 0 || truncated;
    const full = hiddenCount > 0
        ? `${services.length} services : ${services.join(', ')}`
        : services[0];
    const title = [elided ? full : null, ORIGIN_HINTS[origin]]
        .filter(Boolean).join(' — ');

    return (
        <span
            className={cn('inline-flex items-baseline gap-1', elided && 'cursor-help')}
            title={title}
        >
            <span className="whitespace-nowrap">
                {text}
                {/* One ellipsis, never two: `text` already ends in one when the
                    name itself was cut. */}
                {hiddenCount > 0 && !truncated && <span className="text-ink-mute">&hellip;</span>}
            </span>
            {isBorrowed(origin) && <span className="text-ink-mute">*</span>}
        </span>
    );
}

function InvoiceModal({ lead, onClose }: { lead: ZohoLeadRow; onClose: () => void }) {
    const [rows, setRows] = useState<LeadInvoiceRow[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            const { data } = await cachedRpc('get_lead_invoices', { p_account_id: lead.account_id });
            if (cancelled) return;
            setRows((data as LeadInvoiceRow[]) ?? []);
            setLoading(false);
        })();
        return () => { cancelled = true; };
    }, [lead.account_id]);

    // Escape closes, matching the backdrop click. Bound to the document because
    // focus may be anywhere inside the dialog.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const net = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const invoiceCount = rows.filter(r => !r.is_avoir).length;
    const creditCount = rows.length - invoiceCount;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
            onClick={onClose}
            role="presentation"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={`Factures de ${lead.company ?? lead.full_name ?? 'ce compte'}`}
                onClick={e => e.stopPropagation()}
                className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl
                           bg-white shadow-2xl"
            >
                <div className="flex items-start justify-between gap-4 border-b border-hairline px-6 py-4">
                    <div>
                        <h2 className="text-lg font-semibold text-ink">
                            {lead.company ?? lead.full_name ?? 'Compte'}
                        </h2>
                        <p className="mt-0.5 text-sm text-ink-mute">
                            {lead.full_name ?? '\u2014'}
                            {lead.email && <span className="text-ink-faint"> &middot; {lead.email}</span>}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label="Fermer"
                        className="rounded-md p-1.5 text-ink-mute transition-colors hover:bg-stone hover:text-ink-secondary"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="h-6 w-6 animate-spin text-primary-press" />
                    </div>
                ) : rows.length === 0 ? (
                    <div className="px-6 py-16 text-center text-sm text-ink-mute">
                        Aucune facture pour ce compte.
                    </div>
                ) : (
                    <div className="overflow-auto">
                        <table className="w-full">
                            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_theme(colors.slate.200)]">
                                <tr>
                                    <th className="th">Num&eacute;ro</th>
                                    <th className="th">Date</th>
                                    <th className="th">D&eacute;partement</th>
                                    <th className="th">Bureau</th>
                                    <th className="th">Repr&eacute;sentant</th>
                                    <th className="th">Statut</th>
                                    <th className="th text-right">Montant</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(inv => {
                                    const key = inv.is_avoir ? 'avoir' : inv.status;
                                    return (
                                        <tr
                                            key={inv.zoho_id}
                                            className={cn('transition-colors hover:bg-sand/70',
                                                          inv.is_avoir && 'bg-tone-critical-soft/30')}
                                        >
                                            <td className="td font-medium text-ink">{inv.invoice_number ?? '\u2014'}</td>
                                            <td className="td whitespace-nowrap text-ink-mute">
                                                {inv.invoice_date ? formatShortDate(new Date(inv.invoice_date)) : '\u2014'}
                                            </td>
                                            <td className="td text-ink-mute">{inv.department ?? '\u2014'}</td>
                                            <td className="td text-ink-mute">{inv.office ?? '\u2014'}</td>
                                            <td className="td text-ink-mute">{inv.rep_name ?? '\u2014'}</td>
                                            <td className="td">
                                                <span className={cn('badge', INVOICE_STATUS_COLORS[key])}>
                                                    {INVOICE_STATUS_LABELS[key] ?? key}
                                                </span>
                                            </td>
                                            <td className={cn('td text-right font-semibold tabular-nums',
                                                              inv.is_avoir ? 'text-tone-critical-ink' : 'text-ink')}>
                                                {formatCurrencyCAD(inv.amount)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline
                                bg-sand/60 px-6 py-3">
                    <span className="text-sm text-ink-mute" translate="no">
                        {`${invoiceCount} facture${invoiceCount > 1 ? 's' : ''}`}
                        {creditCount > 0 && ` \u00b7 ${creditCount} avoir${creditCount > 1 ? 's' : ''}`}
                    </span>
                    <span className="text-sm font-semibold text-ink">
                        Total net{' '}
                        <span className="tabular-nums text-base">{formatCurrencyCAD(net)}</span>
                    </span>
                </div>
            </div>
        </div>
    );
}
