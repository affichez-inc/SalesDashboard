import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlList } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import { Loader2, Building2, Percent, DollarSign, Timer } from 'lucide-react';
import type {
    ZohoAccountKPIs, ZohoAccountBreakdownRow, ZohoAccountFilterOptions,
    ZohoAccountMonthlyRow,
} from '../types/database';
import { MonthlyEvolution } from '../components/accounts/MonthlyEvolution';
import { MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { MultiSelect } from '../components/MultiSelect';
import { InfoHint } from '../components/InfoHint';
import { ExportButton } from '../components/ExportButton';
import { ClearFiltersButton } from '../components/ClearFiltersButton';
import { useRepFilter, REP_ALL_LABEL } from '../hooks/useRepFilter';
import { formatCurrencyCAD, cn } from '../lib/utils';
import type { CsvColumn } from '../lib/csv';
import { RepAvatar } from '../components/RepAvatar';
import { useRepTeam, mergeInternalRows, INTERNAL_LABEL } from '../lib/repTeam';
import { INTERNAL_RATINGS, ratingOptions, ratingsInScope } from '../lib/accountRating';

/**
 * Comptes - tableau de bord.
 *
 * Reads Zoho CRM's Accounts module, which is the grain Dominic actually works
 * in: "c'est des comptes, les contacts je m'en fous, tout est basé sur le
 * compte" (2026-09-04). A company with three contacts is ONE account, so its
 * revenue is counted once with no dedupe layer - that was the hardest part of
 * the leads dashboard and it simply does not arise here.
 *
 * Two things on this page do not exist on the leads one, and both come straight
 * out of that meeting:
 *
 *   1. THE ATTRIBUTION WINDOW. "Les leads qu'on a eus en juillet, ils ont acheté
 *      combien dans les 12 mois après?" Revenue is capped at N months from the
 *      account's creation. Without the cap a 2021 account outperforms a 2026 one
 *      purely by having had five more years to buy, and every month-over-month
 *      source comparison is a lie.
 *
 *   2. REVENUE PER ACCOUNT. The quality measure. Divided by accounts created,
 *      not by accounts invoiced, because the accounts that bought nothing are
 *      exactly what makes a bad source bad.
 */

/** Excluded by default. Both are Affichez's own entities, not clients: LUMEN
 *  (Hydro-Québec) alone carries six figures on an internal rating and would
 *  otherwise sit at the top of every list. The Statut filter switches them back
 *  on - the data layer keeps every account. */
const DEFAULT_EXCLUDED_RATINGS = INTERNAL_RATINGS;

const WINDOW_OPTIONS = [
    { value: '3',      label: '3 mois après' },
    { value: '6',      label: '6 mois après' },
    { value: '12',     label: '12 mois après' },
    { value: '24',     label: '24 mois après' },
    { value: 'Toute',  label: 'Tout l’historique' },
];

export default function AccountsDashboard() {
    const [yearParam, _setYearParam] = useUrlState('year', '2026');
    const year: number | 'Toutes' = yearParam === 'Toutes' ? 'Toutes' : Number(yearParam);
    const setYear = (v: number | 'Toutes') => _setYearParam(v === 'Toutes' ? 'Toutes' : String(v));

    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const setSelectedMonth = (v: number | 'Toutes') => _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v));

    // Each of these takes several values; an empty list is "no filter".
    const [selectedReps, setSelectedReps] = useUrlList('rep');
    const [selectedSources, setSelectedSources] = useUrlList('source');
    const [selectedServices, setSelectedServices] = useUrlList('service');
    const [selectedDomaines, setSelectedDomaines] = useUrlList('domaine');
    const [selectedRegions, setSelectedRegions] = useUrlList('region');
    const [windowParam, setWindowParam] = useUrlState('fenetre', '12');
    // 'Tous' means show the internal and supplier accounts too.
    const [ratingScope, setRatingScope] = useUrlState('statut', 'Clients');
    // Zoho's Rating ("Évaluation"), by stored value. ANDs with Statut above.
    const [selectedRatings, setSelectedRatings] = useUrlList('evaluation');
    const ratings = useMemo(
        () => ratingsInScope(selectedRatings, ratingScope === 'Tous'),
        [selectedRatings, ratingScope],
    );

    const [loading, setLoading] = useState(true);
    const [kpis, setKpis] = useState<ZohoAccountKPIs | null>(null);
    const [rawByRep, setRawByRep] = useState<ZohoAccountBreakdownRow[]>([]);
    const [bySource, setBySource] = useState<ZohoAccountBreakdownRow[]>([]);
    const [byService, setByService] = useState<ZohoAccountBreakdownRow[]>([]);
    const [byDomaine, setByDomaine] = useState<ZohoAccountBreakdownRow[]>([]);
    const [monthly, setMonthly] = useState<ZohoAccountMonthlyRow[]>([]);
    const [monthlyPrev, setMonthlyPrev] = useState<ZohoAccountMonthlyRow[]>([]);
    const [options, setOptions] = useState<ZohoAccountFilterOptions | null>(null);

    // Interne and/or reps by name. See hooks/useRepFilter.
    const repFilter = useRepFilter(selectedReps, options?.reps ?? []);

    const yearParamValue = year === 'Toutes' ? null : year;
    // null is the RPC's "no cap", not a missing argument.
    const windowMonths = windowParam === 'Toute' ? null : Number(windowParam);
    const excludeRatings = ratingScope === 'Tous' ? null : DEFAULT_EXCLUDED_RATINGS;

    /**
     * Back to the default view in one navigation: 2026, twelve-month window,
     * clients only, no other filter. Setting `year` to its default drops the
     * param and the rest ride along as companions - nine separate calls would
     * leave eight params behind.
     *
     * The year and the window are reset too, deliberately: they are part of what
     * the page shows by default, and a "réinitialiser" that left the window on 3
     * months would be the more surprising behaviour.
     */
    const clearFilters = () => {
        _setYearParam('2026', {
            month: null, rep: null, source: null, service: null,
            domaine: null, region: null, fenetre: null, statut: null, evaluation: null,
        });
    };

    const activeFilterCount = [
        yearParam !== '2026',
        selectedMonth !== 'Toutes',
        !repFilter.isAll,
        selectedSources.length > 0,
        selectedServices.length > 0,
        selectedDomaines.length > 0,
        selectedRegions.length > 0,
        windowParam !== '12',
        ratingScope !== 'Clients',
        ratings.length > 0,
    ].filter(Boolean).length;

    const fetchData = useCallback(async () => {
        setLoading(true);
        const shared = {
            p_year: yearParamValue,
            p_month: selectedMonth === 'Toutes' ? null : selectedMonth,
            p_window_months: windowMonths,
            p_exclude_ratings: excludeRatings,
            p_regions: selectedRegions.length > 0 ? selectedRegions : null,
            // Sent only when set, so every call without it is one a database
            // that predates the parameter still answers.
            ...(ratings.length > 0 ? { p_ratings: ratings } : {}),
        };
        const rep = repFilter.rep;
        const reps = repFilter.reps;
        const sources = selectedSources.length > 0 ? selectedSources : null;
        const services = selectedServices.length > 0 ? selectedServices : null;
        const domaines = selectedDomaines.length > 0 ? selectedDomaines : null;

        // Each breakdown drops its own dimension from the filter set, so choosing
        // "Meta Ads" does not reduce the source chart to a single bar.
        // The monthly series ignores the month filter on purpose - it IS the
        // month axis, and scoping it to one month would collapse it to a single
        // point. The previous year is fetched alongside so a month can be read
        // against the same month last year rather than only against its
        // neighbours.
        const monthlyArgs = {
            p_rep: rep, p_reps: reps, p_sources: sources, p_services: services,
            p_domaines: domaines, p_regions: shared.p_regions,
            p_window_months: shared.p_window_months, p_exclude_ratings: shared.p_exclude_ratings,
            ...(ratings.length > 0 ? { p_ratings: ratings } : {}),
        };

        const [
            { data: kpiData },
            { data: repData },
            { data: srcData },
            { data: svcData },
            { data: domData },
            { data: monData },
            { data: monPrevData },
        ] = await Promise.all([
            cachedRpc('get_zoho_account_kpis',       { ...shared, p_rep: rep, p_reps: reps, p_sources: sources, p_services: services, p_domaines: domaines }),
            // by_rep keeps p_reps (so a group narrows the list to its members)
            // but never p_rep - picking one rep must not reduce their own
            // breakdown to a single bar with nothing to compare it against.
            cachedRpc('get_zoho_accounts_by_rep',    { ...shared, p_reps: reps, p_sources: sources, p_services: services, p_domaines: domaines }),
            cachedRpc('get_zoho_accounts_by_source', { ...shared, p_rep: rep, p_reps: reps, p_services: services, p_domaines: domaines }),
            cachedRpc('get_zoho_accounts_by_service',{ ...shared, p_rep: rep, p_reps: reps, p_sources: sources, p_domaines: domaines }),
            cachedRpc('get_zoho_accounts_by_domaine',{ ...shared, p_rep: rep, p_reps: reps, p_sources: sources, p_services: services }),
            cachedRpc('get_zoho_accounts_monthly_summary', { ...monthlyArgs, p_year: yearParamValue }),
            cachedRpc('get_zoho_accounts_monthly_summary', {
                ...monthlyArgs,
                p_year: yearParamValue === null ? null : yearParamValue - 1,
            }),
        ]);

        setKpis((kpiData as ZohoAccountKPIs[])?.[0] ?? null);
        setRawByRep((repData as ZohoAccountBreakdownRow[]) ?? []);
        setBySource((srcData as ZohoAccountBreakdownRow[]) ?? []);
        setByService((svcData as ZohoAccountBreakdownRow[]) ?? []);
        setByDomaine((domData as ZohoAccountBreakdownRow[]) ?? []);
        setMonthly((monData as ZohoAccountMonthlyRow[]) ?? []);
        setMonthlyPrev((monPrevData as ZohoAccountMonthlyRow[]) ?? []);
        setLoading(false);
    }, [yearParamValue, selectedMonth, repFilter, selectedSources, selectedServices,
        selectedDomaines, selectedRegions, windowMonths, excludeRatings, ratings]);

    const fetchOptions = useCallback(async () => {
        const { data } = await cachedRpc<ZohoAccountFilterOptions>('get_zoho_account_filter_options', {
                p_year: yearParamValue,
                p_exclude_ratings: excludeRatings,
            }, { single: true });
        if (data) setOptions(data);
    }, [yearParamValue, excludeRatings]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    // Both effects set state: fetchData flips `loading` before awaiting, and
    // fetchOptions writes in the awaited continuation. Neither cascades - the
    // write happens after a round trip, not during the render pass - and this is
    // the same shape every other dashboard in the app uses.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchData(); }, [fetchData]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchOptions(); }, [fetchOptions]);

    // Coalesced: a full account sync rewrites all 20,645 rows, and one refetch
    // per change event would fire thousands of queries at the browser.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const sub = supabase
            .channel('accounts-dashboard-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'zoho_accounts' }, () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => { invalidateRpcCache(); fetchDataRef.current(); }, 1500);
            })
            .subscribe();
        return () => {
            if (timer) clearTimeout(timer);
            supabase.removeChannel(sub);
        };
    }, []);

    const repTeam = useRepTeam();

    /**
     * Everyone off the sales team is one Interne line, the same membership the
     * rep filter uses. revenue_per_account is recomputed rather than averaged:
     * it is revenue divided by accounts CREATED, so summing the two components
     * is the only way to keep that meaning.
     */
    const byRep = useMemo(() => mergeInternalRows(
        rawByRep, repTeam, r => r.label,
        r => ({ ...r, label: INTERNAL_LABEL, is_bulk_import: false }),
        (acc, r) => ({
            ...acc,
            nb_accounts: acc.nb_accounts + r.nb_accounts,
            nb_invoiced: acc.nb_invoiced + r.nb_invoiced,
            total_amount: acc.total_amount + r.total_amount,
        }),
    )
        .map(r => ({ ...r, revenue_per_account: r.nb_accounts > 0 ? Math.round((r.total_amount / r.nb_accounts) * 100) / 100 : 0 }))
        // The RPC orders by revenue then account count; keep that after merging.
        .sort((a, b) => b.total_amount - a.total_amount || b.nb_accounts - a.nb_accounts),
        [rawByRep, repTeam]);

    const yearOptions = useMemo(() => [
        { value: 'Toutes', label: 'Toutes les années' },
        ...(options?.years ?? []).map(y => ({ value: String(y), label: String(y) })),
    ], [options]);
    const monthOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))],
        [],
    );
    const optionList = (values: string[] | undefined) => (values ?? []).map(v => ({ value: v, label: v }));

    const windowLabel = windowParam === 'Toute'
        ? 'tout l’historique'
        : `${windowParam} mois suivant la création du compte`;

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div>
                <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">Comptes · Tableau de bord</h1>
                <p className="text-xs md:text-sm text-ink-mute mt-0.5">
                    Comptes clients du CRM, et ce qu&rsquo;ils ont facturé après leur arrivée
                </p>
            </div>

            <FilterBar>
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
                <FilterGroup label="Fenêtre de revenus">
                    <Select value={windowParam} onChange={setWindowParam} options={WINDOW_OPTIONS} variant="accent" className="w-44" />
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

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-press" />
                    <p className="text-sm text-ink-mute font-medium">Chargement des comptes...</p>
                </div>
            ) : (
                <>
                    {/* translate="no": these are live figures; a translated text
                        node is replaced once and then keeps its stale value when
                        React re-renders. Labels stay translatable, values do not. */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4" translate="no">
                        <KPICard
                            title="Comptes créés"
                            value={(kpis?.accounts_created ?? 0).toLocaleString('fr-CA')}
                            subText="Nouveaux comptes sur la période"
                            icon={Building2}
                            hint="Comptes créés dans Zoho CRM sur la période choisie, comptés sur le calendrier de Montréal. Un compte = une entreprise, peu importe le nombre de contacts qu'il porte. Par défaut les comptes internes d'Affichez et les fournisseurs sont exclus : changez « Statut » pour les inclure."
                        />
                        <KPICard
                            title="Comptes facturés"
                            value={(kpis?.accounts_invoiced ?? 0).toLocaleString('fr-CA')}
                            subText={`${(kpis?.invoiced_rate ?? 0).toFixed(1)} % des comptes créés`}
                            icon={Percent}
                            highlight={(kpis?.invoiced_rate ?? 0) >= 20}
                            hint={`Comptes ayant reçu au moins une facture dans les ${windowLabel}. C'est la seule conversion qui mesure de l'argent plutôt qu'une case cochée dans Zoho.`}
                        />
                        <KPICard
                            title="Revenus attribués"
                            value={formatCurrencyCAD(kpis?.revenue_attributed ?? 0)}
                            subText={windowParam === 'Toute'
                                ? 'Tout l\u2019historique de facturation'
                                : `Factur\u00e9 dans les ${windowParam} mois suivant la cr\u00e9ation`}
                            icon={DollarSign}
                            hint={`Factures datées entre la création du compte et ${windowLabel}. La fenêtre est ce qui rend deux mois comparables : sans elle, un compte de 2021 bat toujours un compte de 2026 simplement parce qu'il a eu cinq ans de plus pour acheter. « Historique complet » ignore la fenêtre.`}
                        />
                        <KPICard
                            title="Revenu par compte"
                            value={formatCurrencyCAD(kpis?.revenue_per_account ?? 0)}
                            subText={kpis?.avg_days_to_first_invoice != null
                                ? `1re facture après ${Math.round(kpis.avg_days_to_first_invoice)} jours en moyenne`
                                : 'Aucune facture sur la période'}
                            icon={Timer}
                            hint="Revenus attribués ÷ comptes créés. Divisé par tous les comptes, pas seulement les comptes facturés : les comptes qui n'ont rien acheté sont précisément ce qui rend une source mauvaise, les retirer du calcul cacherait le problème. C'est le chiffre à comparer d'un mois à l'autre et d'une source à l'autre."
                        />
                    </div>

                    {/* The Royer & Fils / VotreLogo.ca note that used to sit here was
                        removed on 2026-09-08: it was four lines of explanation on
                        every load, for a figure most readers never needed. The
                        caveat itself has not gone away - that business is invoiced
                        outside the two Books organisations this app reads, so those
                        2,028 accounts show almost no revenue here. It is documented
                        in docs/COMPTES.md §8a, and the source table still marks the
                        cohort with a dot and explains it on hover. */}

                    <MonthlyEvolution
                        current={monthly} previous={monthlyPrev}
                        year={year}
                        previousYear={yearParamValue === null ? null : yearParamValue - 1}
                        windowLabel={windowLabel}
                    />

                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 md:gap-6">
                        <BreakdownTable
                            title="Par source" rows={bySource} filename="comptes_par_source"
                            note="Les sources marquées d'un point sont des listes de clients rachetées (Royer & Fils, PLOGG/BUCCO), pas des campagnes : leur volume ne se compare pas à celui de Meta Ads ou de Google. Attention en particulier à Royer & Fils / VotreLogo.ca : cette entreprise est facturée en dehors des deux organisations Zoho Books que l'application lit, donc ses revenus n'apparaissent presque pas ici : un taux de facturation très bas sur cette ligne ne veut PAS dire que ces clients n'achètent rien."
                        />
                        <BreakdownTable
                            title="Par représentant" rows={byRep} filename="comptes_par_rep" people
                        />
                        <BreakdownTable
                            title="Par domaine d'activité" rows={byDomaine} filename="comptes_par_domaine"
                            note="Le secteur du client selon le CRM. Renseigné sur environ deux comptes sur trois."
                        />
                        <BreakdownTable
                            title="Par service" rows={byService} filename="comptes_par_service"
                            note="Un compte peut cocher plusieurs services : le total des lignes dépasse le nombre de comptes."
                        />
                    </div>
                </>
            )}
        </div>
    );
}

const BREAKDOWN_CSV: CsvColumn<ZohoAccountBreakdownRow>[] = [
    { header: 'Nom',                value: r => r.label },
    { header: 'Comptes',            value: r => r.nb_accounts },
    { header: 'Comptes facturés',   value: r => r.nb_invoiced },
    { header: 'Taux facturé (%)',   value: r => r.nb_accounts > 0 ? Math.round((r.nb_invoiced / r.nb_accounts) * 1000) / 10 : 0 },
    { header: 'Revenus',            value: r => r.total_amount },
    { header: 'Revenu par compte',  value: r => r.revenue_per_account },
    { header: 'Liste rachetée',     value: r => r.is_bulk_import },
];

function BreakdownTable({ title, rows, note, filename, people }: {
    title: string;
    rows: ZohoAccountBreakdownRow[];
    note?: string;
    filename: string;
    /** The labels are rep names, so each one gets its face. This table is also
     *  used for sources, services and industries, where an avatar would be
     *  meaningless. */
    people?: boolean;
}) {
    const totalAccounts = rows.reduce((s, r) => s + r.nb_accounts, 0);
    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-hairline flex items-center gap-2">
                <h3 className="text-sm font-semibold text-ink">{title}</h3>
                {note && <InfoHint text={note} />}
                <div className="ml-auto">
                    <ExportButton rows={rows} columns={BREAKDOWN_CSV} filename={filename} disabled={rows.length === 0} />
                </div>
            </div>
            {rows.length === 0 ? (
                <p className="px-5 py-8 text-sm text-ink-mute text-center">Aucun compte</p>
            ) : (
                <div className="max-h-[420px] overflow-y-auto">
                    <table className="w-full text-sm" translate="no">
                        <thead className="sticky top-0 bg-sand/95 backdrop-blur">
                            <tr className="border-b border-hairline">
                                <th className="px-4 py-2.5 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Nom</th>
                                <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Comptes</th>
                                <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Facturés</th>
                                <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Revenus</th>
                                <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">/ compte</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-hairline">
                            {rows.map(r => {
                                const pct = totalAccounts > 0 ? Math.round((r.nb_accounts / totalAccounts) * 100) : 0;
                                const rate = r.nb_accounts > 0 ? ((r.nb_invoiced / r.nb_accounts) * 100).toFixed(0) : '0';
                                return (
                                    <tr key={r.label} className="hover:bg-sand/60 transition-colors">
                                        <td className="px-4 py-2.5">
                                            <p className="font-semibold text-ink-secondary text-xs truncate max-w-[170px] flex items-center gap-1.5" title={r.label}>
                                                {r.is_bulk_import && (
                                                    <span
                                                        className="w-1.5 h-1.5 rounded-full bg-tone-warn shrink-0"
                                                        title={"Liste de clients rachetée, pas une campagne : le volume ne se compare pas à celui d'une campagne publicitaire."
                                                            + (r.label.includes('Royer')
                                                                ? " Cette entreprise est aussi facturée hors des organisations Zoho Books lues par l'application : ses revenus réels n'apparaissent pas dans cette ligne."
                                                                : '')}
                                                    />
                                                )}
                                                {people && <RepAvatar name={r.label} size="xs" />}
                                                {r.label}
                                            </p>
                                            <div className="mt-1 h-1 rounded-full bg-stone w-full max-w-[100px]">
                                                <div className="h-1 rounded-full bg-primary" style={{ width: `${pct}%` }} />
                                            </div>
                                        </td>
                                        <td className="px-4 py-2.5 text-right font-bold text-ink-secondary tabular-nums">{r.nb_accounts}</td>
                                        <td className="px-4 py-2.5 text-right tabular-nums">
                                            <span className="font-bold text-ink-secondary">{r.nb_invoiced}</span>
                                            <span className={cn('ml-1 text-2xs font-bold',
                                                Number(rate) >= 20 ? 'text-tone-good' : 'text-ink-mute')}>
                                                ({rate}%)
                                            </span>
                                        </td>
                                        <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums text-xs">
                                            {formatCurrencyCAD(r.total_amount)}
                                        </td>
                                        <td className="px-4 py-2.5 text-right font-semibold text-ink-mute tabular-nums text-xs">
                                            {formatCurrencyCAD(r.revenue_per_account)}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function KPICard({ title, value, subText, icon: Icon, highlight, hint }: {
    title: string;
    value: string;
    subText: string;
    icon: React.ElementType;
    highlight?: boolean;
    hint?: string;
}) {
    return (
        <div className="bg-white p-3 md:p-5 rounded-xl shadow-card flex flex-col justify-between hover:shadow-elevated transition-all group">
            <div className="flex items-start justify-between mb-2 md:mb-4">
                <div className="p-2 md:p-2.5 bg-sand rounded-md text-ink-mute group-hover:text-primary-press group-hover:bg-primary-wash transition-colors">
                    <Icon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                <div className="flex items-center gap-1.5">
                    {highlight && (
                        <span className="text-2xs font-bold px-2 py-0.5 rounded-full bg-tone-good-soft text-tone-good-ink">Bon</span>
                    )}
                    {hint && <InfoHint text={hint} />}
                </div>
            </div>
            <div>
                <p className="text-2xs md:text-xs font-semibold text-ink-mute uppercase tracking-eyebrow leading-tight">{title}</p>
                <p className="mt-1 text-base md:text-2xl font-bold text-ink tabular-nums">{value}</p>
                <p className="text-2xs text-ink-mute mt-0.5 md:mt-1 font-medium italic">{subText}</p>
            </div>
        </div>
    );
}
