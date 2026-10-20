import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import {
    Loader2, ExternalLink, Search, RefreshCw, ChevronLeft, ChevronRight,
    ChevronsLeft, ChevronsRight, X,
} from 'lucide-react';
import type {
    ZohoAccountRow, ZohoAccountFilterOptions, LeadInvoiceRow, LeadInvoiceTotals,
    AccountDeptRevenueRow, AccountContactRow, AccountSpendMax,
} from '../types/database';
import { MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { ExportButton } from '../components/ExportButton';
import { ExportMenu } from '../components/ExportMenu';
import { ClearFiltersButton } from '../components/ClearFiltersButton';
import { TagCell } from '../components/TagCell';
import { useRepFilter, REP_ALL_LABEL } from '../hooks/useRepFilter';
import { useUrlList } from '../hooks/useUrlState';
import { MultiSelect } from '../components/MultiSelect';
import { downloadCsv, type CsvColumn } from '../lib/csv';
import { RepName } from '../components/RepAvatar';
import { useRepTeam } from '../lib/repTeam';
import { useAuth } from '../contexts/AuthContext';
import { AmountRangeFilter } from '../components/accounts/AmountRangeFilter';
import { MetaAudienceModal } from '../components/accounts/MetaAudienceModal';
import { ChannelLogo } from '../components/advertising/ChannelLogo';
import { ratingLabel, ratingOptions, ratingsInScope } from '../lib/accountRating';
import { fetchAccountContacts, groupedLines, accountContactColumns } from '../components/accounts/accountContacts';
import {
    DEFAULT_SPEND_PERIOD, spendPeriod, spendPeriodShort, isSpendFilterActive,
    type SpendRange, type SpendPeriodKey,
} from '../components/accounts/spendRange';
import {
    formatShortDate, formatCurrencyCAD, formatPhone, phoneSearchPattern, cn,
} from '../lib/utils';

/**
 * Comptes - détail.
 *
 * The searchable client directory Dominic asked for on 2026-09-04: "avoir comme
 * une search feature que tu peux aller chercher ton client, puis tu cliques puis
 * ça show les stats". Clicking a row opens the account's full billing history -
 * per department, per year - which is the "data client" half of that ask.
 *
 * Filtering, sorting, counting and paging all happen in Postgres. The page shows
 * 100 of 20,645 rows, so a filter applied in the browser would search 100
 * records and leave the count and the pager wrong.
 */

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

const PAGE_SIZE = 100;
/** Exports are capped: 20,645 rows is a fine CSV, but an unbounded range on a
 *  view with a LEFT JOIN aggregate is not something to hand a browser blindly. */
const EXPORT_MAX = 25000;
/** The API's row cap per request; the export reads in slices of this size. */
const EXPORT_PAGE = 1000;

const NO_REPS: string[] = [];

/** Zoho writes "-None-" into a picklist that was never set. */
const isBlankPick = (v: string | null): boolean => !v || v === '-None-';

/**
 * PostgREST's `or` filter is comma-separated and paren-grouped, so those
 * characters in a search term would corrupt the query rather than match text.
 * `%` and `_` are ilike wildcards and are escaped so they match literally.
 */
function sanitizeSearch(raw: string): string {
    return raw.replace(/[,()]/g, ' ').replace(/[%_\\]/g, '\\$&').trim();
}

export default function AccountsDetail() {
    const [yearParam, _setYearParam] = useUrlState('year', 'Toutes');
    const year: number | 'Toutes' = yearParam === 'Toutes' ? 'Toutes' : Number(yearParam);
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    // Each of these takes several values; an empty list is "no filter".
    const [selectedReps, _setSelectedReps] = useUrlList('rep');
    const [selectedSources, _setSelectedSources] = useUrlList('source');
    const [selectedServices, _setSelectedServices] = useUrlList('service');
    const [selectedDomaines, _setSelectedDomaines] = useUrlList('domaine');
    const [selectedRegions, _setSelectedRegions] = useUrlList('region');
    const [selectedInvoiced, _setSelectedInvoiced] = useUrlState('factures', 'Tous');
    const [ratingScope, _setRatingScope] = useUrlState('statut', 'Clients');
    // Zoho's Rating ("Évaluation"), by stored value. ANDs with Statut above.
    const [selectedRatings, _setSelectedRatings] = useUrlList('evaluation');
    const ratings = useMemo(
        () => ratingsInScope(selectedRatings, ratingScope === 'Tous'),
        [selectedRatings, ratingScope],
    );
    // "Montant facturé": both bounds optional, and the period they apply to.
    const [amountMinParam, _setAmountMin] = useUrlState('montant_min', '');
    const [amountMaxParam] = useUrlState('montant_max', '');
    const [amountPeriodParam] = useUrlState('montant_periode', DEFAULT_SPEND_PERIOD);
    const [page, setPage] = useUrlStateNumber('page', 1);

    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [options, setOptions] = useState<ZohoAccountFilterOptions | null>(null);

    const [rows, setRows] = useState<ZohoAccountRow[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [invoiceTotals, setInvoiceTotals] = useState<Record<string, LeadInvoiceTotals>>({});
    const [detailAccount, setDetailAccount] = useState<ZohoAccountRow | null>(null);

    // Interne and/or reps by name. See hooks/useRepFilter. NO_REPS rather than a
    // fresh [] while the options load: a new array each render rebuilt the query
    // and refetched on every render, forever if the options call failed.
    const repFilter = useRepFilter(selectedReps, options?.reps ?? NO_REPS);

    // A filter change invalidates the page number - page 7 of a 3-page result is
    // an empty table, which reads as "no data" rather than "wrong page".
    //
    // Both params MUST move in one navigation. Calling the filter setter and then
    // setPage(1) looks equivalent and is not: react-router hands each setter the
    // search params from the render that created it, so the page reset starts
    // from a snapshot taken before the filter change and its navigate()
    // overwrites it. The filter then appears to do nothing at all - the dropdown
    // snaps back and the table never changes. LeadsDetail hit this exact bug and
    // UrlStateCompanions in hooks/useUrlState exists to solve it.
    const toPage1 = { page: null };
    const setYear = (v: number | 'Toutes') =>
        _setYearParam(v === 'Toutes' ? 'Toutes' : String(v), toPage1);
    const setSelectedMonth = (v: number | 'Toutes') =>
        _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v), toPage1);
    const setSelectedReps = (v: string[]) => _setSelectedReps(v, toPage1);
    const setSelectedSources = (v: string[]) => _setSelectedSources(v, toPage1);
    const setSelectedServices = (v: string[]) => _setSelectedServices(v, toPage1);
    const setSelectedDomaines = (v: string[]) => _setSelectedDomaines(v, toPage1);
    const setSelectedRegions = (v: string[]) => _setSelectedRegions(v, toPage1);
    const setSelectedInvoiced = (v: string) => _setSelectedInvoiced(v, toPage1);
    const setRatingScope = (v: string) => _setRatingScope(v, toPage1);
    const setSelectedRatings = (v: string[]) => _setSelectedRatings(v, toPage1);

    const amountRange = useMemo<SpendRange>(() => {
        const num = (s: string) => (s !== '' && Number.isFinite(Number(s)) ? Number(s) : null);
        return {
            min: num(amountMinParam),
            max: num(amountMaxParam),
            period: spendPeriod(amountPeriodParam).key as SpendPeriodKey,
        };
    }, [amountMinParam, amountMaxParam, amountPeriodParam]);
    const amountActive = isSpendFilterActive(amountRange);
    /** The view column the amount filter compares, when it is on. */
    const amountColumn = amountActive ? spendPeriod(amountRange.period).column : null;

    // The three params move in one navigation, with the page reset, for the
    // reason given at toPage1. A period with no amount is not a filter, so it
    // is not kept either: it would sit in the link and in an audience's record.
    const setAmountRange = (r: SpendRange) => {
        const on = isSpendFilterActive(r);
        _setAmountMin(on && r.min !== null && r.min > 0 ? String(r.min) : '', {
            montant_max: on && r.max !== null ? String(r.max) : null,
            montant_periode: on && r.period !== DEFAULT_SPEND_PERIOD ? r.period : null,
            page: null,
        });
    };

    /**
     * Debounced search, with the page reset skipped on the first run.
     *
     * The effect fires once on mount, and resetting the page there silently threw
     * away `?page=3` from a shared link, a bookmark or a browser Back - the table
     * jumped to page 1 about a third of a second after loading, with no
     * indication why.
     */
    const searchSettled = useRef(false);
    /**
     * Every filter back to its default in ONE navigation.
     *
     * `year` is set to its own default value, which makes useUrlState drop the
     * param; the other eight ride along as companions. Nine separate setter calls
     * would leave eight of the params behind, for the same reason a filter change
     * cannot reset the page on its own - see toPage1 above.
     *
     * `search` is component state rather than a URL param, so it is cleared
     * separately and costs no navigation.
     */
    const clearFilters = () => {
        setSearch('');
        _setYearParam('Toutes', {
            month: null, rep: null, source: null, service: null,
            domaine: null, region: null, factures: null, statut: null, evaluation: null, page: null,
            montant_min: null, montant_max: null, montant_periode: null,
        });
    };

    // Counted from `search`, not `debouncedSearch`, so the badge reacts as you
    // type rather than a third of a second later.
    const activeFilterCount = [
        search.trim() !== '',
        year !== 'Toutes',
        selectedMonth !== 'Toutes',
        !repFilter.isAll,
        selectedSources.length > 0,
        selectedServices.length > 0,
        selectedDomaines.length > 0,
        selectedRegions.length > 0,
        selectedInvoiced !== 'Tous',
        ratingScope !== 'Clients',
        ratings.length > 0,
        amountActive,
    ].filter(Boolean).length;

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

    const [serviceVariants, setServiceVariants] = useState<Record<string, string[]>>({});

    /**
     * Bounds for the year/month filter, as an ISO half-open range on
     * created_time. Built in Montreal time so an account created 31 December at
     * 20:00 EST counts in December and not in January - the same rule the RPCs
     * apply with AT TIME ZONE.
     */
    const dateBounds = useMemo(() => {
        if (year === 'Toutes') return null;
        const m = selectedMonth === 'Toutes' ? null : selectedMonth;
        const pad = (n: number) => String(n).padStart(2, '0');
        // -05:00/-04:00 is handled by Postgres; sending a plain local timestamp
        // with an explicit Montreal offset keeps the boundary honest either way.
        const from = m ? `${year}-${pad(m)}-01T00:00:00-05:00` : `${year}-01-01T00:00:00-05:00`;
        const toY = m ? (m === 12 ? year + 1 : year) : year + 1;
        const toM = m ? (m === 12 ? 1 : m + 1) : 1;
        const to = `${toY}-${pad(toM)}-01T00:00:00-05:00`;
        return { from, to };
    }, [year, selectedMonth]);

    /**
     * One query builder for the table, the export, the Meta audience and the
     * amount filter's live count, so none of them can describe a different set
     * of accounts from the one on screen.
     *
     * `amount` is passed in rather than read from the URL so the amount popover
     * can count a draft before it is applied.
     */
    const buildQuery = useCallback((mode: 'page' | 'export' | 'count', amount: SpendRange) => {
        let query = supabase
            .from('zoho_accounts_enriched')
            .select('*', mode === 'count'
                ? { count: 'exact', head: true }
                : { count: mode === 'page' ? 'exact' : undefined });

        // The amount billed over the chosen period. Zero at the bottom of the
        // range is "no minimum": it keeps the accounts that bought nothing.
        const spendCol = isSpendFilterActive(amount) ? spendPeriod(amount.period).column : null;
        if (spendCol) {
            if (amount.min !== null && amount.min > 0) query = query.gte(spendCol, amount.min);
            if (amount.max !== null) query = query.lte(spendCol, amount.max);
        }

        if (dateBounds) query = query.gte('created_time', dateBounds.from).lt('created_time', dateBounds.to);
        // A group becomes an `in` list; a single rep stays an equality. Both go
        // through repFilter so the dropdown and the query can never disagree.
        if (repFilter.rep) query = query.eq('rep_name', repFilter.rep);
        else if (repFilter.reps) query = query.in('rep_name', repFilter.reps);
        if (selectedSources.length > 0) query = query.in('origine_du_client', selectedSources);
        if (selectedDomaines.length > 0) query = query.in('domaine_activite', selectedDomaines);
        if (selectedRegions.length > 0) query = query.in('region_administrative', selectedRegions);
        if (selectedInvoiced !== 'Tous') query = query.eq('has_invoices', selectedInvoiced === 'avec');
        // A precomputed boolean, not `rating not.in (...)`: PostgREST turns that
        // into NOT (rating IN ...), which is NULL - and therefore false - for the
        // 977 accounts with no rating, silently hiding them.
        if (ratingScope !== 'Tous') query = query.eq('is_internal', false);
        if (ratings.length > 0) query = query.in('rating', ratings);
        if (selectedServices.length > 0) {
            // overlaps, not contains: match every spelling of every selected service.
            query = query.overlaps('service_interest',
                selectedServices.flatMap(s => serviceVariants[s] ?? [s]));
        }

        const term = sanitizeSearch(debouncedSearch);
        if (term) {
            const like = `%${term}%`;
            query = query.or(
                `account_name.ilike.${like},billing_city.ilike.${like},` +
                `website.ilike.${like},phone.ilike.${phoneSearchPattern(term)}`,
            );
        }

        if (mode !== 'count') {
            // Filtered by amount, the list reads largest first - the question
            // was "who bought the most". Otherwise newest first, as it always was.
            if (spendCol) query = query.order(spendCol, { ascending: false });
            // The id breaks ties, so paging through the export in slices of a
            // thousand never skips or repeats an account created the same second.
            query = query
                .order('created_time', { ascending: false, nullsFirst: false })
                .order('zoho_account_id', { ascending: true });
        }
        return query;
    }, [dateBounds, repFilter, selectedSources, selectedServices, selectedDomaines,
        selectedRegions, selectedInvoiced, ratingScope, ratings, debouncedSearch, serviceVariants]);

    /** How many accounts a draft amount range keeps, with every other filter on. */
    const countForAmount = useCallback(async (draft: SpendRange): Promise<number | null> => {
        const { count, error } = await buildQuery('count', draft);
        return error ? null : count ?? 0;
    }, [buildQuery]);

    /**
     * Monotonic request id. Nine filters over 20,645 rows means a broad query and
     * a narrow one are regularly in flight together, and they do not come back in
     * the order they were sent - so without this guard an older, wider response
     * lands last and overwrites the filtered result. On screen that looks exactly
     * like the filter having been ignored: the dropdown says "Meta Ads" and the
     * table shows every account.
     */
    const requestId = useRef(0);

    /** `id` is the request that asked for these rows; if a newer page has since
     *  loaded, its invoice totals must not be replaced by this one's. */
    const fetchInvoiceTotals = useCallback(async (pageRows: ZohoAccountRow[], id: number) => {
        const ids = pageRows.map(r => r.zoho_account_id).filter(Boolean);
        if (ids.length === 0) { setInvoiceTotals({}); return; }
        const { data } = await cachedRpc('get_account_invoice_totals', { p_account_ids: ids });
        if (!data || id !== requestId.current) return;
        const byAccount: Record<string, LeadInvoiceTotals> = {};
        for (const row of data as LeadInvoiceTotals[]) byAccount[row.account_id] = row;
        setInvoiceTotals(byAccount);
    }, []);

    const fetchData = useCallback(async () => {
        const id = ++requestId.current;
        setLoading(true);
        const from = (page - 1) * PAGE_SIZE;
        const { data, count } = await buildQuery('page', amountRange).range(from, from + PAGE_SIZE - 1);
        if (id !== requestId.current) return; // a newer query has already answered
        const pageRows = (data as ZohoAccountRow[]) ?? [];
        setRows(pageRows);
        setTotal(count ?? 0);
        setLoading(false);

        // A page number can outlive the result it belonged to: a shared
        // ?page=7 link, a filter carried in from the URL, or the Back button
        // after narrowing the list. The table then renders empty and says
        // "aucun compte ne correspond à ces filtres", which is a lie - the
        // filters match plenty, you are simply past the end.
        //
        // Clamping cannot loop: the value written always satisfies
        // page <= lastPage, so the refetch it triggers takes the else branch.
        const lastPage = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
        if (page > lastPage) {
            setPage(lastPage);
            return;
        }

        // Deliberately after setLoading: the table is useful without the
        // Factures column, so it renders on the first result rather than
        // waiting on a second round trip.
        fetchInvoiceTotals(pageRows, id);
    }, [buildQuery, amountRange, page, fetchInvoiceTotals, setPage]);

    const fetchOptions = useCallback(async () => {
        const { data } = await cachedRpc<ZohoAccountFilterOptions>('get_zoho_account_filter_options', {
                p_year: year === 'Toutes' ? null : year,
                // null = every rating, so the dropdowns still offer a source or a
                // rep carried only by internal accounts when that filter is on.
                p_exclude_ratings: null,
            }, { single: true });
        if (data) { setOptions(data); setServiceVariants(data.service_variants ?? {}); }
    }, [year]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    useEffect(() => { fetchData(); }, [fetchData]);
    useEffect(() => { fetchOptions(); }, [fetchOptions]);

    // The top of the amount slider, per period. Until it loads - or on a
    // database that does not have the function yet - the amount filter is not
    // offered, rather than offered against columns that do not exist.
    const [spendMax, setSpendMax] = useState<AccountSpendMax | null>(null);
    useEffect(() => {
        cachedRpc<AccountSpendMax>('get_account_spend_max', {}, { single: true })
            .then(({ data }) => { if (data) setSpendMax(data); });
    }, []);

    const repTeam = useRepTeam();
    const { sections } = useAuth();
    /** Creating an audience needs the client list and the ad accounts both. */
    const canPushAudience = sections.comptes && sections.publicite;
    const [audienceOpen, setAudienceOpen] = useState(false);

    /**
     * The whole filtered set, in pages of a thousand: the API returns at most
     * that many rows per request whatever range is asked for, so one large
     * range would quietly stop at the first thousand.
     */
    const fetchAllFiltered = useCallback(async (): Promise<ZohoAccountRow[]> => {
        const out: ZohoAccountRow[] = [];
        for (let from = 0; from < EXPORT_MAX; from += EXPORT_PAGE) {
            const { data, error } = await buildQuery('export', amountRange).range(from, from + EXPORT_PAGE - 1);
            // A plain object from postgrest-js, not an Error: wrapped for the message.
            if (error) throw new Error(error.message);
            const pageRows = (data as ZohoAccountRow[]) ?? [];
            out.push(...pageRows);
            // An empty page ends it, not a short one: see accountContacts.
            if (pageRows.length === 0) break;
        }
        return out;
    }, [buildQuery, amountRange]);

    /** The period amount, as a column, when the amount filter is on a period. */
    const periodAmount = useMemo(() => {
        if (!amountColumn || amountRange.period === 'tout') return undefined;
        const col = amountColumn;
        return {
            header: `Facturé (${spendPeriodShort(amountRange.period, spendMax?.today ?? null)})`,
            value: (a: ZohoAccountRow) => a[col],
        };
    }, [amountColumn, amountRange.period, spendMax]);

    /** The export says what the screen says: a rep off the sales team is Interne there too. */
    const exportAccounts = useCallback(async () => {
        const accounts = (await fetchAllFiltered())
            .map(a => ({ ...a, rep_name: repTeam.display(a.rep_name) }));
        const cols: CsvColumn<ZohoAccountRow>[] = periodAmount
            ? [...ACCOUNT_CSV.slice(0, ACCOUNT_CSV_AMOUNT_AT), periodAmount, ...ACCOUNT_CSV.slice(ACCOUNT_CSV_AMOUNT_AT)]
            : ACCOUNT_CSV;
        downloadCsv(accounts, cols, 'comptes');
    }, [fetchAllFiltered, repTeam, periodAmount]);

    /** Each account followed by its contacts, in one file. */
    const exportAccountsWithContacts = useCallback(async () => {
        const accounts = await fetchAllFiltered();
        const contacts = await fetchAccountContacts(accounts.map(a => a.zoho_account_id));
        const cols = accountContactColumns({ displayRep: repTeam.display, periodAmount });
        downloadCsv(groupedLines(accounts, contacts), cols, 'comptes_contacts');
    }, [fetchAllFiltered, repTeam, periodAmount]);

    /**
     * The filters behind an audience, kept with it in meta_audience_log: every
     * URL parameter but the page number, plus the search box, which filters the
     * list but lives outside the URL. A parameter left out was at its default.
     */
    const [searchParams] = useSearchParams();
    const audienceFilters = useMemo(() => {
        const out: Record<string, string[]> = {};
        for (const [key, value] of searchParams) {
            if (key === 'page') continue;
            (out[key] ??= []).push(value);
        }
        const term = debouncedSearch.trim();
        if (term) out.recherche = [term];
        return out;
    }, [searchParams, debouncedSearch]);

    const audienceName = useMemo(() => {
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        return `Comptes Affichez ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }, []);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const rangeEnd = Math.min(page * PAGE_SIZE, total);

    const optionList = (values: string[] | undefined) => (values ?? []).map(v => ({ value: v, label: v }));
    const yearOptions = useMemo(() => [
        { value: 'Toutes', label: 'Toutes les années' },
        ...(options?.years ?? []).map(y => ({ value: String(y), label: String(y) })),
    ], [options]);
    const monthOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))],
        [],
    );

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                {/* flex-1: the description wraps before the three buttons are
                    pushed onto a line of their own. */}
                <div className="flex-1 min-w-[16rem]">
                    <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">Comptes · Détail</h1>
                    <p className="text-xs md:text-sm text-ink-mute mt-0.5">
                        Répertoire des comptes clients. Cliquez sur un compte pour voir sa facturation par
                        département et par année.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <ExportMenu
                        disabled={total === 0}
                        label={total > 0 ? `Exporter ${total.toLocaleString('fr-CA')} comptes` : 'Exporter CSV'}
                        // The contacts export and the audience need this release's
                        // migration; spendMax answering is the sign it is there.
                        choices={[
                            {
                                key: 'comptes',
                                label: 'Comptes seulement',
                                hint: 'Une ligne par compte, comme le tableau.',
                                run: exportAccounts,
                            },
                            ...(spendMax ? [{
                                key: 'contacts',
                                label: 'Comptes et contacts',
                                hint: "Chaque compte suivi de ses contacts : nom, courriel, téléphones, adresse d'envoi.",
                                run: exportAccountsWithContacts,
                            }] : []),
                        ]}
                    />
                    {canPushAudience && spendMax && (
                        <button
                            type="button"
                            onClick={() => setAudienceOpen(true)}
                            disabled={total === 0}
                            title="Créer une audience personnalisée Meta avec les contacts de ces comptes"
                            className="btn btn-xs btn-quiet"
                        >
                            <ChannelLogo channel="meta" size="xs" />
                            Audience Meta
                        </button>
                    )}
                    <button
                        // The whole point of this button is to bypass the
                        // cache; without the drop it would replay the same
                        // answer and look broken.
                        onClick={() => { invalidateRpcCache(); fetchDataRef.current(); }}
                        className="btn btn-xs btn-quiet"
                    >
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
                            placeholder="Nom, téléphone, ville…"
                            aria-label="Rechercher un compte"
                            // h-9 is the same 36px step the Selects beside it sit
                            // on; padding alone left it 2px proud of the row.
                            className="w-64 h-9 pl-9 pr-3 rounded-md border border-hairline-strong bg-white text-sm
                                       placeholder:text-ink-faint focus:outline-none focus:ring-2
                                       focus:ring-ring focus:border-primary"
                        />
                    </div>
                </FilterGroup>
                <FilterGroup label="Année">
                    <Select
                        value={year === 'Toutes' ? 'Toutes' : String(year)}
                        onChange={v => setYear(v === 'Toutes' ? 'Toutes' : Number(v))}
                        options={yearOptions} variant="accent" className="w-40"
                    />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select
                        value={String(selectedMonth)}
                        onChange={v => setSelectedMonth(v === 'Toutes' ? 'Toutes' : Number(v))}
                        options={monthOptions} className="w-40"
                    />
                </FilterGroup>
                <FilterGroup label="Représentant">
                    <MultiSelect values={repFilter.selected} onChange={setSelectedReps} options={repFilter.options}
                                 allLabel={REP_ALL_LABEL} allIcon={repFilter.allIcon} className="w-48" />
                </FilterGroup>
                <FilterGroup label="Source">
                    <MultiSelect values={selectedSources} onChange={setSelectedSources} options={optionList(options?.sources)} allLabel="Toutes les sources" className="w-52" />
                </FilterGroup>
                <FilterGroup label="Service">
                    <MultiSelect values={selectedServices} onChange={setSelectedServices} options={optionList(options?.services)} allLabel="Tous les services" className="w-48" />
                </FilterGroup>
                <FilterGroup label="Domaine">
                    <MultiSelect values={selectedDomaines} onChange={setSelectedDomaines} options={optionList(options?.domaines)} allLabel="Tous les domaines" className="w-48" />
                </FilterGroup>
                <FilterGroup label="Région">
                    <MultiSelect values={selectedRegions} onChange={setSelectedRegions} options={optionList(options?.regions)} allLabel="Toutes les régions" className="w-44" />
                </FilterGroup>
                <FilterGroup label="Factures">
                    <Select
                        value={selectedInvoiced} onChange={setSelectedInvoiced} className="w-44"
                        options={[
                            { value: 'Tous',  label: 'Tous les comptes' },
                            { value: 'avec',  label: 'Avec factures' },
                            { value: 'sans',  label: 'Sans facture' },
                        ]}
                    />
                </FilterGroup>
                {spendMax && (
                    <FilterGroup label="Montant facturé">
                        <AmountRangeFilter
                            value={amountRange} onApply={setAmountRange}
                            maxima={spendMax} previewCount={countForAmount}
                            className="w-56"
                        />
                    </FilterGroup>
                )}
                <FilterGroup label="Statut">
                    <Select
                        value={ratingScope} onChange={setRatingScope} className="w-52"
                        options={[
                            { value: 'Clients', label: 'Clients seulement' },
                            { value: 'Tous',    label: 'Inclure comptes internes' },
                        ]}
                    />
                </FilterGroup>
                <FilterGroup label="Évaluation">
                    <MultiSelect values={ratings} onChange={setSelectedRatings}
                                 options={ratingOptions(options?.ratings, ratingScope === 'Tous')}
                                 allLabel="Toutes les évaluations" className="w-52" />
                </FilterGroup>
                <ClearFiltersButton activeCount={activeFilterCount} onClear={clearFilters} />
            </FilterBar>

            <div className="bg-white rounded-xl shadow-card overflow-hidden">
                <Pager
                    page={page} totalPages={totalPages} total={total}
                    rangeStart={rangeStart} rangeEnd={rangeEnd}
                    onChange={setPage} position="top"
                    note={amountActive ? 'triés par montant facturé' : undefined}
                />

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-6 h-6 animate-spin text-primary-press" />
                    </div>
                ) : rows.length === 0 ? (
                    <p className="py-20 text-center text-sm text-ink-mute">Aucun compte ne correspond à ces filtres.</p>
                ) : (
                    <div className="overflow-x-auto">
                        {/* translate="no" on the whole table: none of this is prose -
                            it is company names, phone numbers, amounts and dates.
                            Translating it is never wanted, and Chrome freezing a
                            translated cell makes the table silently show stale data
                            after a filter change. */}
                        <table className="w-full" translate="no">
                            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_theme(colors.slate.200)]">
                                <tr>
                                    <th className="th">Compte</th>
                                    <th className="th">Téléphone</th>
                                    <th className="th">Ville</th>
                                    <th className="th">Propriétaire</th>
                                    <th className="th">Évaluation</th>
                                    <th className="th">Source</th>
                                    <th className="th">Domaine</th>
                                    <th className="th">Service</th>
                                    {periodAmount && (
                                        <th className="th text-right">{periodAmount.header}</th>
                                    )}
                                    <th className="th text-right">Factures</th>
                                    <th className="th">Créé le</th>
                                    <th className="th">CRM</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hairline">
                                {rows.map(a => {
                                    const totals = invoiceTotals[a.zoho_account_id];
                                    return (
                                        // The whole row opens the account, not just
                                        // the name: the name is a small target in a
                                        // ten-column table, and every other cell
                                        // looked clickable but was not.
                                        <tr
                                            key={a.zoho_account_id}
                                            onClick={() => setDetailAccount(a)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    setDetailAccount(a);
                                                }
                                            }}
                                            tabIndex={0}
                                            role="button"
                                            aria-label={`Voir la facturation de ${a.account_name ?? 'ce compte'}`}
                                            className="cursor-pointer transition-colors hover:bg-sand/70
                                                       focus:bg-sand focus:outline-none
                                                       focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
                                        >
                                            <td className="td">
                                                <span className="font-semibold text-ink">
                                                    {a.account_name ?? '—'}
                                                </span>
                                                {a.parent_account_name && (
                                                    <p className="text-2xs text-ink-mute mt-0.5">
                                                        Sous-compte de {a.parent_account_name}
                                                    </p>
                                                )}
                                            </td>
                                            <td className="td whitespace-nowrap text-ink-mute">{formatPhone(a.phone) ?? '—'}</td>
                                            <td className="td text-ink-mute">{a.billing_city ?? '—'}</td>
                                            <td className="td text-ink-mute"><span className="inline-flex items-center gap-2">{a.rep_name ? <RepName name={a.rep_name} size="sm" /> : '—'}</span></td>
                                            <td className="td text-ink-mute" title={a.rating ? ratingLabel(a.rating).full : undefined}>
                                                {a.rating ? ratingLabel(a.rating).short : '—'}
                                            </td>
                                            <td className="td">
                                                <span className="inline-flex items-center gap-1.5">
                                                    {a.is_bulk_import && (
                                                        <span
                                                            className="w-1.5 h-1.5 rounded-full bg-tone-warn shrink-0"
                                                            title="Liste de clients rachetée, pas une campagne"
                                                        />
                                                    )}
                                                    <TagCell values={isBlankPick(a.origine_du_client) ? [] : [a.origine_du_client!]} />
                                                </span>
                                            </td>
                                            <td className="td text-ink-mute">{isBlankPick(a.domaine_activite) ? '—' : a.domaine_activite}</td>
                                            {/* service_resolved, not service_interest:
                                                59% of accounts never had the CRM field
                                                filled in, and Shop Santé showed an empty
                                                Service column while its invoices clearly
                                                named two departments. Borrowed values are
                                                greyed and marked, so an invoice department
                                                is never passed off as a CRM answer. */}
                                            <td className="td">
                                                <span className="inline-flex items-center gap-1">
                                                    <TagCell
                                                        values={a.service_resolved ?? []}
                                                        muted={a.service_origin === 'invoice'}
                                                    />
                                                    {a.service_origin === 'invoice' && (
                                                        <span
                                                            className="text-ink-faint"
                                                            title="Service déduit des départements facturés : le CRM n'en indique aucun"
                                                        >*</span>
                                                    )}
                                                </span>
                                            </td>
                                            {periodAmount && (
                                                <td className="td text-right whitespace-nowrap font-semibold text-ink tabular-nums" translate="no">
                                                    {formatCurrencyCAD(periodAmount.value(a))}
                                                </td>
                                            )}
                                            <td className="td text-right">
                                                {totals ? (
                                                    // Amount on top, the document count under it: the
                                                    // amount is what the column is for, and "$3,400"
                                                    // over one invoice is a different client from
                                                    // "$3,400" over forty.
                                                    <span
                                                        className="inline-flex flex-col items-end leading-tight"
                                                        title={`${totals.invoice_count} facture${totals.invoice_count > 1 ? 's' : ''}`
                                                            + (totals.credit_count > 0
                                                                ? `, ${totals.credit_count} avoir${totals.credit_count > 1 ? 's' : ''}`
                                                                : '')}
                                                    >
                                                        <span className="font-semibold text-ink tabular-nums">
                                                            {formatCurrencyCAD(totals.total_amount)}
                                                        </span>
                                                        <span className="text-2xs text-ink-mute tabular-nums" translate="no">
                                                            {totals.invoice_count} facture{totals.invoice_count > 1 ? 's' : ''}
                                                            {totals.credit_count > 0 && (
                                                                <span className="text-tone-critical">
                                                                    {' '}· {totals.credit_count} avoir{totals.credit_count > 1 ? 's' : ''}
                                                                </span>
                                                            )}
                                                        </span>
                                                    </span>
                                                ) : (
                                                    <span className="text-ink-faint">—</span>
                                                )}
                                            </td>
                                            <td className="td whitespace-nowrap text-ink-mute text-xs">
                                                {a.created_time ? formatShortDate(new Date(a.created_time)) : '—'}
                                            </td>
                                            <td className="td">
                                                {a.zoho_crm_url && (
                                                    <a
                                                        href={a.zoho_crm_url} target="_blank" rel="noopener noreferrer"
                                                        onClick={e => e.stopPropagation()}
                                                        aria-label={`Ouvrir ${a.account_name ?? 'le compte'} dans Zoho CRM`}
                                                        className="text-ink-faint hover:text-primary-press transition-colors inline-block"
                                                    >
                                                        <ExternalLink className="w-3.5 h-3.5" />
                                                    </a>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}

                {/* Repeated at the foot of the table: with 100 rows on screen the
                    top control has scrolled well out of view by the time somebody
                    has finished reading and wants the next page. */}
                {!loading && rows.length > 0 && (
                    <Pager
                        page={page} totalPages={totalPages} total={total}
                        rangeStart={rangeStart} rangeEnd={rangeEnd}
                        onChange={setPage} position="bottom"
                    />
                )}
            </div>

            {detailAccount && (
                <AccountDetailModal account={detailAccount} onClose={() => setDetailAccount(null)} />
            )}

            {audienceOpen && (
                <MetaAudienceModal
                    loadAccounts={fetchAllFiltered}
                    filters={audienceFilters}
                    defaultName={audienceName}
                    onClose={() => setAudienceOpen(false)}
                />
            )}
        </div>
    );
}

/**
 * The pager, rendered above and below the table.
 *
 * First and last buttons matter here in a way they do not on a short list: 20,645
 * accounts is 188 pages, and stepping to the end one arrow at a time is not a
 * navigation option.
 */
function Pager({ page, totalPages, total, rangeStart, rangeEnd, onChange, position, note }: {
    page: number;
    totalPages: number;
    total: number;
    rangeStart: number;
    rangeEnd: number;
    onChange: (p: number) => void;
    position: 'top' | 'bottom';
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
                    ? 'Aucun compte'
                    : rangeStart + '–' + rangeEnd + ' sur ' + total.toLocaleString('fr-CA') + ' comptes'}
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

const ACCOUNT_CSV: CsvColumn<ZohoAccountRow>[] = [
    { header: 'Compte',             value: a => a.account_name },
    { header: 'Téléphone',          value: a => a.phone },
    { header: 'Site web',           value: a => a.website },
    { header: 'Adresse',            value: a => a.billing_street },
    { header: 'Ville',              value: a => a.billing_city },
    { header: 'Province',           value: a => a.billing_state },
    { header: 'Code postal',        value: a => a.billing_code },
    { header: 'Région',             value: a => a.region_administrative },
    { header: 'Propriétaire',       value: a => a.rep_name },
    { header: 'Source',             value: a => a.origine_du_client },
    { header: 'Liste rachetée',     value: a => a.is_bulk_import },
    { header: 'Domaine',            value: a => a.domaine_activite },
    { header: 'Services',           value: a => (a.service_interest ?? []).join(' | ') },
    { header: 'Évaluation',         value: a => (a.rating ? ratingLabel(a.rating).full : null) },
    { header: 'Compte interne',     value: a => a.is_internal },
    { header: 'Compte parent',      value: a => a.parent_account_name },
    { header: 'Créé le',            value: a => a.created_date },
    { header: 'Dernière activité',  value: a => a.last_activity_time?.slice(0, 10) ?? null },
    { header: 'Nb factures',        value: a => a.invoice_count },
    { header: 'Nb avoirs',          value: a => a.credit_count },
    { header: 'Revenus (net)',      value: a => a.revenue_lifetime },
    { header: '1re facture',        value: a => a.first_invoice_date },
    { header: 'Dernière facture',   value: a => a.last_invoice_date },
    { header: 'Ventes Royer/VotreLogo', value: a => a.ventes_totales },
    { header: 'Nb tâches',          value: a => a.nombre_taches },
    { header: 'Lien CRM',           value: a => a.zoho_crm_url },
];

/** Where the period amount goes when the amount filter adds it: after the lifetime one. */
const ACCOUNT_CSV_AMOUNT_AT = ACCOUNT_CSV.findIndex(c => c.header === 'Revenus (net)') + 1;

const INVOICE_CSV: CsvColumn<LeadInvoiceRow>[] = [
    { header: 'Numéro',        value: i => i.invoice_number },
    { header: 'Date',          value: i => i.invoice_date },
    { header: 'Département',   value: i => i.department },
    { header: 'Bureau',        value: i => i.office },
    { header: 'Représentant',  value: i => i.rep_name },
    { header: 'Statut',        value: i => INVOICE_STATUS_LABELS[i.is_avoir ? 'avoir' : i.status] ?? i.status },
    { header: 'Montant',       value: i => i.amount },
];

/**
 * One account's billing history: a department × year pivot on top, the invoice
 * line items underneath.
 *
 * The pivot is the answer to "il a acheté combien par département par année,
 * puis voir la progression" - reading a year-over-year trend off a flat list of
 * invoices is exactly the work this page exists to remove.
 */
function AccountDetailModal({ account, onClose }: { account: ZohoAccountRow; onClose: () => void }) {
    const repTeam = useRepTeam();
    const [invoices, setInvoices] = useState<LeadInvoiceRow[]>([]);
    const [deptRows, setDeptRows] = useState<AccountDeptRevenueRow[]>([]);
    const [contacts, setContacts] = useState<AccountContactRow[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            const [{ data: inv }, { data: dept }, { data: cts }] = await Promise.all([
                cachedRpc('get_account_invoices', { p_account_id: account.zoho_account_id }),
                cachedRpc('get_account_revenue_by_department', { p_account_id: account.zoho_account_id }),
                cachedRpc('get_account_contacts', { p_account_id: account.zoho_account_id }),
            ]);
            if (cancelled) return;
            setInvoices((inv as LeadInvoiceRow[]) ?? []);
            setDeptRows((dept as AccountDeptRevenueRow[]) ?? []);
            setContacts((cts as AccountContactRow[]) ?? []);
            setLoading(false);
        })();
        return () => { cancelled = true; };
    }, [account.zoho_account_id]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    /** Departments as rows, years as columns - the shape people read a trend in. */
    const pivot = useMemo(() => {
        const years = [...new Set(deptRows.map(r => r.year))].sort((a, b) => a - b);
        const depts = [...new Set(deptRows.map(r => r.department))].sort();
        const cell = new Map<string, number>();
        for (const r of deptRows) cell.set(`${r.department}|${r.year}`, Number(r.total_amount));
        const byYear = new Map<number, number>();
        for (const r of deptRows) byYear.set(r.year, (byYear.get(r.year) ?? 0) + Number(r.total_amount));
        return { years, depts, cell, byYear };
    }, [deptRows]);

    const net = invoices.reduce((s, r) => s + Number(r.amount), 0);
    const invoiceCount = invoices.filter(r => !r.is_avoir).length;
    const creditCount = invoices.length - invoiceCount;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
            onClick={onClose}
            role="presentation"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={`Facturation de ${account.account_name ?? 'ce compte'}`}
                onClick={e => e.stopPropagation()}
                className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            >
                <div className="flex items-start justify-between gap-4 border-b border-hairline px-6 py-4">
                    <div className="min-w-0">
                        <h2 className="text-lg font-semibold text-ink truncate">
                            {account.account_name ?? 'Compte'}
                        </h2>
                        <p className="mt-0.5 text-sm text-ink-mute truncate">
                            {[
                                formatPhone(account.phone),
                                account.billing_city,
                                isBlankPick(account.domaine_activite) ? null : account.domaine_activite,
                                isBlankPick(account.origine_du_client) ? null : account.origine_du_client,
                                account.rep_name,
                            ].filter(Boolean).join(' · ') || '—'}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {account.zoho_crm_url && (
                            <a
                                href={account.zoho_crm_url} target="_blank" rel="noopener noreferrer"
                                className="rounded-md p-1.5 text-ink-mute hover:bg-stone hover:text-primary-press transition-colors"
                                aria-label="Ouvrir dans Zoho CRM"
                            >
                                <ExternalLink className="h-4 w-4" />
                            </a>
                        )}
                        <button
                            onClick={onClose}
                            aria-label="Fermer"
                            className="rounded-md p-1.5 text-ink-mute transition-colors hover:bg-stone hover:text-ink-secondary"
                        >
                            <X className="h-5 w-5" />
                        </button>
                    </div>
                </div>

                {!loading && contacts.length > 0 && (
                    <div className="px-6 py-3 border-b border-hairline flex flex-wrap gap-x-5 gap-y-1.5">
                        <span className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow self-center">
                            Contacts
                        </span>
                        {contacts.slice(0, 8).map(c => (
                            <span key={c.zoho_record_id} className="text-xs text-ink-mute">
                                <span className="font-semibold text-ink-secondary">{c.full_name ?? '—'}</span>
                                {c.phone && <span className="text-ink-mute"> · {formatPhone(c.phone)}</span>}
                                {c.email && <span className="text-ink-faint"> · {c.email}</span>}
                                {c.stage === 'lead' && (
                                    <span className="ml-1 badge bg-data-2 text-data-2-ink">Lead</span>
                                )}
                            </span>
                        ))}
                        {contacts.length > 8 && (
                            <span className="text-xs text-ink-faint self-center">
                                +{contacts.length - 8} autres
                            </span>
                        )}
                    </div>
                )}

                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="h-6 w-6 animate-spin text-primary-press" />
                    </div>
                ) : invoices.length === 0 ? (
                    <div className="px-6 py-16 text-center text-sm text-ink-mute">
                        Aucune facture pour ce compte.
                        {(account.ventes_totales ?? 0) > 0 && (
                            <p className="mt-3 text-xs text-ink-mute max-w-lg mx-auto leading-relaxed">
                                Ce compte porte {formatCurrencyCAD(account.ventes_totales ?? 0)} de ventes
                                Royer&nbsp;&amp;&nbsp;Fils / VotreLogo.ca dans le CRM. Cette facturation se fait
                                en dehors des organisations Zoho Books lues par l&rsquo;application, donc aucune
                                facture n&rsquo;est disponible ici.
                            </p>
                        )}
                    </div>
                ) : (
                    <div className="overflow-auto">
                        {pivot.years.length > 0 && (
                            <div className="px-6 pt-5 pb-4 border-b border-hairline bg-sand/40">
                                <h3 className="text-xs font-semibold text-ink-mute uppercase tracking-eyebrow mb-3">
                                    Par département et par année
                                </h3>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b border-hairline-strong">
                                                <th className="py-2 pr-4 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Département</th>
                                                {pivot.years.map(y => (
                                                    <th key={y} className="py-2 px-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow tabular-nums">{y}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-hairline">
                                            {pivot.depts.map(d => (
                                                <tr key={d}>
                                                    <td className="py-2 pr-4 font-semibold text-ink-secondary text-xs">{d}</td>
                                                    {pivot.years.map(y => {
                                                        const v = pivot.cell.get(`${d}|${y}`);
                                                        return (
                                                            <td key={y} className={cn(
                                                                'py-2 px-3 text-right tabular-nums text-xs',
                                                                v === undefined ? 'text-ink-faint' : 'text-ink-secondary font-medium',
                                                            )}>
                                                                {v === undefined ? '—' : formatCurrencyCAD(v)}
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            ))}
                                            <tr className="border-t-2 border-hairline-strong">
                                                <td className="py-2 pr-4 font-bold text-ink-secondary text-xs">Total</td>
                                                {pivot.years.map(y => (
                                                    <td key={y} className="py-2 px-3 text-right font-bold text-ink tabular-nums text-xs">
                                                        {formatCurrencyCAD(pivot.byYear.get(y) ?? 0)}
                                                    </td>
                                                ))}
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        <table className="w-full">
                            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_theme(colors.slate.200)]">
                                <tr>
                                    <th className="th">Numéro</th>
                                    <th className="th">Date</th>
                                    <th className="th">Département</th>
                                    <th className="th">Bureau</th>
                                    <th className="th">Représentant</th>
                                    <th className="th">Statut</th>
                                    <th className="th text-right">Montant</th>
                                </tr>
                            </thead>
                            <tbody>
                                {invoices.map(inv => {
                                    const key = inv.is_avoir ? 'avoir' : inv.status;
                                    return (
                                        <tr key={inv.zoho_id} className={cn('transition-colors hover:bg-sand/70', inv.is_avoir && 'bg-tone-critical-soft/30')}>
                                            <td className="td font-medium text-ink">{inv.invoice_number ?? '—'}</td>
                                            <td className="td whitespace-nowrap text-ink-mute">
                                                {inv.invoice_date ? formatShortDate(new Date(inv.invoice_date)) : '—'}
                                            </td>
                                            <td className="td text-ink-mute">{inv.department ?? '—'}</td>
                                            <td className="td text-ink-mute">{inv.office ?? '—'}</td>
                                            <td className="td text-ink-mute"><span className="inline-flex items-center gap-2">{inv.rep_name ? <RepName name={inv.rep_name} size="sm" /> : '—'}</span></td>
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

                {/*
                  * The figures are held back until the fetch lands, and carry
                  * translate="no".
                  *
                  * Both are needed for the same reason. Chrome Translate is on
                  * for these users; it replaces a text node with its own and
                  * then stops tracking it, so a node that rendered "0,00 $"
                  * during the load kept showing "$0.00" after the real total
                  * arrived - reopening the modal looked like it "fixed" the
                  * number because that built a fresh node. Not rendering a
                  * placeholder number means there is nothing wrong to freeze;
                  * translate="no" means it is never swapped in the first place.
                  */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline bg-sand/60 px-6 py-3">
                    <span className="text-sm text-ink-mute" translate="no">
                        {loading ? '' : (
                            <>
                                {`${invoiceCount} facture${invoiceCount > 1 ? 's' : ''}`}
                                {creditCount > 0 && ` · ${creditCount} avoir${creditCount > 1 ? 's' : ''}`}
                            </>
                        )}
                    </span>
                    <div className="flex items-center gap-4">
                        <ExportButton
                            // Interne in the file, as on screen.
                            rows={invoices.map(i => ({ ...i, rep_name: repTeam.display(i.rep_name) }))}
                            columns={INVOICE_CSV}
                            filename={`factures_${(account.account_name ?? 'compte').replace(/[^\w-]+/g, '_').slice(0, 40)}`}
                            disabled={invoices.length === 0}
                        />
                        {/* Label small and muted, amount large and dark - at the
                          * same weight and size the two ran together. */}
                        <span className="flex items-baseline gap-2" translate="no">
                            <span className="text-2xs font-semibold uppercase tracking-eyebrow text-ink-mute">
                                Total net
                            </span>
                            <span className={cn('text-lg font-bold tabular-nums',
                                net < 0 ? 'text-tone-critical-ink' : 'text-ink')}>
                                {loading ? '—' : formatCurrencyCAD(net)}
                            </span>
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
