import { useEffect, useState, useCallback, useMemo } from 'react';
import { useUrlState, useUrlList } from '../hooks/useUrlState';
import { cachedRpc } from '../lib/rpcCache';
import {
    Loader2, AlertTriangle, TriangleAlert, Settings2, Info,
} from 'lucide-react';
import type {
    AdPerformanceRow, AdMonthlyRow, AdCampaignRow, AdSpendStatusRow, AdChannel, AdFilterOptions,
    AdAccountOption,
} from '../types/database';
import { MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { MultiSelect } from '../components/MultiSelect';
import { useRepFilter, REP_ALL_LABEL } from '../hooks/useRepFilter';
import { InfoHint } from '../components/InfoHint';
import { ClearFiltersButton } from '../components/ClearFiltersButton';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { ChannelCard } from '../components/advertising/ChannelCard';
import { SpendVsRevenueChart } from '../components/advertising/SpendVsRevenueChart';
import { CampaignTable } from '../components/advertising/CampaignTable';
import {
    CHANNEL_LABEL, CHANNELS, AD_VIEWS, AD_VIEW_PARAM, DEFAULT_AD_VIEW,
    AD_BASIS_LABEL, AD_BASIS_PARAM, BASIS_WORDS,
    channelLabel, isCohortOpen, parseAdView, viewHasSpend, formatAdDay,
    adAccountLabel, inAdAccountSelection, narrowingAdAccounts,
} from '../components/advertising/channel';
import type { AdBasis, AdView } from '../components/advertising/channel';
import { ChannelLogo, ChannelLogoTile } from '../components/advertising/ChannelLogo';
import { AdvertisingIcon } from '../components/advertising/AdvertisingIcon';

/**
 * Publicité: Google and Meta, in three views.
 *
 *   payant    — ad spend compared with the revenue of the accounts tagged
 *               Google Ads / Meta Ads (the channel cards, the comparison, the
 *               monthly chart and the campaign table).
 *   organique — the accounts that came through the same platforms without an
 *               ad ("Google Organique", "Meta Organique"): accounts and
 *               revenue only, no spend, no return, no campaigns.
 *   inconnu   — Google only: the "Google Organique" accounts created before
 *               that source was reserved for organic arrivals. They mix paid
 *               and organic, so they are shown apart and counted in neither.
 *
 * Two screens in the nav choose what the accounts "bought": Factures
 * (/publicite, their invoices, net of credit notes) or Devis (/publicite/devis,
 * their won quotes, dated by acceptance). The page is the same on both; only
 * the documents summed change (p_basis).
 *
 * Attribution is by channel and by month of account creation. Revenue for a
 * period keeps accruing until its attribution window closes, so figures from an
 * open window are marked as provisional (see isCohortOpen).
 *
 * The account filters (rep, source, service, domain, region) narrow the
 * accounts and their revenue. Spend is reported per campaign and cannot be
 * narrowed by rep, service, domain or region, so with one of those set the RPCs
 * return no cost and no return, and the page says so. A source filter selects
 * whole channels and keeps every ratio.
 *
 * The ad-account filter works the other way round: it narrows the spend and
 * leaves the accounts whole, because the CRM does not record which ad account a
 * client came from. It is offered for a platform synced from several ad
 * accounts, in the paid view only, and the ratios stay: they compare the
 * channel's accounts with the spend of the ad accounts selected.
 *
 * Organic is the default view while the Google Ads cohort is young;
 * DEFAULT_AD_VIEW is the one line to flip when the paid figures carry enough
 * months.
 */

const DEFAULT_EXCLUDED_RATINGS = ['Compte interne : Ne pas reprendre', 'Fournisseur'];

const WINDOW_OPTIONS = [
    { value: '3',     label: '3 mois après' },
    { value: '6',     label: '6 mois après' },
    { value: '12',    label: '12 mois après' },
    { value: '24',    label: '24 mois après' },
    { value: 'Toute', label: 'Tout l’historique' },
];

const CURRENT_YEAR = new Date().getFullYear();

/** The "every account" choice of a two-account platform. Never sent: it is the empty selection. */
const ALL_AD_ACCOUNTS = 'Tous';

/** What the filters offer when their list could not be read: nothing, but loaded. */
const NO_OPTIONS: AdFilterOptions = {
    sources: [], services: [], reps: [], domaines: [], regions: [], ad_accounts: [],
};

const YEAR_OPTIONS = [
    { value: 'Toutes', label: 'Toutes les années' },
    ...Array.from({ length: CURRENT_YEAR - 2020 }, (_, i) => CURRENT_YEAR - i)
        .map(y => ({ value: String(y), label: String(y) })),
];

const SUBTITLE: Record<AdBasis, Record<AdView, string>> = {
    factures: {
        organique: 'Les comptes venus de Google ou de Facebook sans publicité, et ce qu’ils ont facturé',
        payant: 'Ce que la publicité coûte, et ce que les comptes qu’elle a ramenés ont facturé',
        inconnu: 'Les comptes Google d’avant la séparation entre organique et payant, et ce qu’ils ont facturé',
    },
    devis: {
        organique: 'Les comptes venus de Google ou de Facebook sans publicité, et les devis qu’ils ont acceptés',
        payant: 'Ce que la publicité coûte, et les devis acceptés par les comptes qu’elle a ramenés',
        inconnu: 'Les comptes Google d’avant la séparation entre organique et payant, et les devis qu’ils ont acceptés',
    },
};

export default function Advertising({ basis }: { basis: AdBasis }) {
    const [viewParam, setViewParam] = useUrlState('vue', DEFAULT_AD_VIEW);
    const view = parseAdView(viewParam);
    const hasSpend = viewHasSpend(view);
    const viewArg = AD_VIEW_PARAM[view];

    const basisArg = AD_BASIS_PARAM[basis];

    const [yearParam, setYearParam] = useUrlState('year', String(CURRENT_YEAR));
    const year: number | 'Toutes' = yearParam === 'Toutes' ? 'Toutes' : Number(yearParam);

    const [monthParam, setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = monthParam === 'Toutes' ? 'Toutes' : Number(monthParam);

    const [windowParam, setWindowParam] = useUrlState('fenetre', '12');
    const [ratingScope, setRatingScope] = useUrlState('statut', 'Clients');
    const [campaignPlatform, setCampaignPlatform] = useUrlState('plateforme', 'Toutes');
    const [campaignStatuses, setCampaignStatuses] = useUrlList('campagnes');

    // Account filters. Each takes several values; an empty list is "no filter".
    const [selectedReps, setSelectedReps] = useUrlList('rep');
    const [selectedSources, setSelectedSources] = useUrlList('source');
    const [selectedServices, setSelectedServices] = useUrlList('service');
    const [selectedDomaines, setSelectedDomaines] = useUrlList('domaine');
    const [selectedRegions, setSelectedRegions] = useUrlList('region');
    // Spend filter: the ad accounts whose spend is counted. Empty is all of them.
    const [selectedAdAccounts, setSelectedAdAccounts] = useUrlList('compte');

    const [options, setOptions] = useState<AdFilterOptions | null>(null);
    const [loading, setLoading] = useState(true);
    const [perf, setPerf] = useState<AdPerformanceRow[]>([]);
    const [monthly, setMonthly] = useState<AdMonthlyRow[]>([]);
    const [campaigns, setCampaigns] = useState<AdCampaignRow[]>([]);
    const [status, setStatus] = useState<AdSpendStatusRow[]>([]);

    const yearValue = year === 'Toutes' ? null : year;
    // A month only applies within a year.
    const monthValue = selectedMonth === 'Toutes' || yearValue === null ? null : selectedMonth;
    const windowMonths = windowParam === 'Toute' ? null : Number(windowParam);
    const excludeRatings = ratingScope === 'Tous' ? null : DEFAULT_EXCLUDED_RATINGS;

    // Interne and/or reps by name. See hooks/useRepFilter.
    const repFilter = useRepFilter(selectedReps, options?.reps ?? []);
    // These RPCs take a list only: one rep is a list of one.
    const repsParam = useMemo(
        () => (repFilter.rep ? [repFilter.rep] : repFilter.reps),
        [repFilter.rep, repFilter.reps],
    );
    // A source belongs to one view. One carried over in the URL from another
    // view would match no channel and empty the page, so only the sources this
    // view offers are sent.
    const sourcesParam = useMemo(() => {
        const known = selectedSources.filter(s => options?.sources.includes(s));
        return known.length > 0 ? known : null;
    }, [selectedSources, options]);
    const servicesParam = selectedServices.length > 0 ? selectedServices : null;
    const domainesParam = selectedDomaines.length > 0 ? selectedDomaines : null;
    const regionsParam = selectedRegions.length > 0 ? selectedRegions : null;

    // Only a platform synced from several ad accounts has anything to choose
    // between; with one account each, the filter is not shown at all.
    const adAccountChoices = useMemo<AdAccountOption[]>(() => {
        const all = options?.ad_accounts ?? [];
        return all.filter(a => all.filter(b => b.platform === a.platform).length > 1);
    }, [options]);
    /** The accounts the spend is limited to, or null for all of them. */
    const pickedAdAccounts = useMemo<AdAccountOption[] | null>(() => {
        if (!hasSpend) return null;
        const picked = narrowingAdAccounts(adAccountChoices, selectedAdAccounts);
        return picked.length > 0 ? picked : null;
    }, [hasSpend, adAccountChoices, selectedAdAccounts]);
    const adAccountsParam = useMemo(
        () => (pickedAdAccounts ? pickedAdAccounts.map(a => a.id) : null),
        [pickedAdAccounts],
    );

    /** The accounts are a subset the spend cannot be matched to. */
    const narrowed = repsParam !== null || servicesParam !== null
        || domainesParam !== null || regionsParam !== null;

    // The view is a mode, not a filter: it is neither counted nor cleared.
    const activeFilterCount = [
        yearParam !== String(CURRENT_YEAR),
        monthParam !== 'Toutes',
        windowParam !== '12',
        ratingScope !== 'Clients',
        !repFilter.isAll,
        selectedSources.length > 0,
        selectedServices.length > 0,
        selectedDomaines.length > 0,
        selectedRegions.length > 0,
        // One per platform: each has a dropdown of its own.
        ...CHANNELS.map(c => (pickedAdAccounts ?? []).some(acc => acc.platform === c)),
        campaignPlatform !== 'Toutes',
        campaignStatuses.length > 0,
    ].filter(Boolean).length;

    const clearFilters = () => {
        setYearParam(String(CURRENT_YEAR), {
            month: null, fenetre: null, statut: null, plateforme: null, campagnes: null,
            rep: null, source: null, service: null, domaine: null, region: null, compte: null,
        });
    };

    const fetchOptions = useCallback(async () => {
        const { data } = await cachedRpc<AdFilterOptions>('get_ad_filter_options', {
            p_year: yearValue, p_exclude_ratings: excludeRatings, p_view: viewArg,
        }, { single: true });
        // `null` means "still loading" and nothing else: fetchData waits on it.
        setOptions(data ?? NO_OPTIONS);
    }, [yearValue, excludeRatings, viewArg]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchOptions(); }, [fetchOptions]);

    // A source or an ad account in the URL can only be checked against what the
    // options offer, so the first read waits for them rather than running
    // unfiltered.
    const waitingForOptions = options === null
        && (selectedSources.length > 0 || (hasSpend && selectedAdAccounts.length > 0));

    const fetchData = useCallback(async () => {
        if (waitingForOptions) return;
        setLoading(true);
        const shared = {
            p_window_months: windowMonths, p_exclude_ratings: excludeRatings, p_view: viewArg,
            p_reps: repsParam, p_sources: sourcesParam, p_services: servicesParam,
            p_domaines: domainesParam, p_regions: regionsParam,
            // Sent only when set, so the page still reads a database that does
            // not have the parameter yet.
            ...(adAccountsParam ? { p_ad_accounts: adAccountsParam } : {}),
            // Invoices are the default: only the Devis screen names its basis.
            ...(basisArg === 'quotes' ? { p_basis: basisArg } : {}),
        };

        const [
            { data: perfData },
            { data: monthlyData },
            { data: campaignData },
            { data: statusData },
        ] = await Promise.all([
            cachedRpc('get_ad_performance', { ...shared, p_year: yearValue, p_month: monthValue }),
            // The monthly series is the month axis, so it ignores the month
            // filter and is skipped when no year is selected.
            yearValue === null
                ? Promise.resolve({ data: [] })
                : cachedRpc('get_ad_monthly', { ...shared, p_year: yearValue }),
            // Spend-side data is only shown in the paid view.
            hasSpend
                ? cachedRpc('get_ad_campaigns', { p_year: yearValue, p_month: monthValue, p_platform: null })
                : Promise.resolve({ data: [] }),
            hasSpend
                ? cachedRpc('get_ad_spend_status')
                : Promise.resolve({ data: [] }),
        ]);

        setPerf((perfData as AdPerformanceRow[]) ?? []);
        setMonthly((monthlyData as AdMonthlyRow[]) ?? []);
        setCampaigns((campaignData as AdCampaignRow[]) ?? []);
        setStatus((statusData as AdSpendStatusRow[]) ?? []);
        setLoading(false);
    }, [yearValue, monthValue, windowMonths, excludeRatings, viewArg, basisArg, hasSpend, waitingForOptions,
        repsParam, sourcesParam, servicesParam, domainesParam, regionsParam, adAccountsParam]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchData(); }, [fetchData]);

    const monthOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Année complète' },
               ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))],
        [],
    );

    const optionList = (values: string[] | undefined) => (values ?? []).map(v => ({ value: v, label: v }));

    // One dropdown per platform. A single list of every account read as if
    // ticking a Google account left Meta out, when a platform that is not named
    // is counted whole; a filter of its own for each platform says that by itself.
    const adAccountFilters = useMemo(
        () => CHANNELS
            .map(channel => ({
                channel,
                options: adAccountChoices.filter(a => a.platform === channel).map(a => ({
                    value: a.id,
                    label: adAccountLabel(a),
                    icon: <ChannelLogo channel={channel} size="xs" />,
                })),
            }))
            .filter(f => f.options.length > 0),
        [adAccountChoices],
    );
    /** The selection with one platform's part replaced; the other platforms keep theirs. */
    const setAdAccountsOf = (channel: AdChannel, ids: string[]) => {
        const others = (pickedAdAccounts ?? []).filter(a => a.platform !== channel).map(a => a.id);
        setSelectedAdAccounts(narrowingAdAccounts(adAccountChoices, [...others, ...ids]).map(a => a.id));
    };
    // The campaign rows carry their ad account, so the same selection is applied here.
    const visibleCampaigns = useMemo(
        () => campaigns.filter(c => inAdAccountSelection(c.platform, c.ad_account_id, pickedAdAccounts)),
        [campaigns, pickedAdAccounts],
    );

    /** The date that separates "Google inconnu" from "Google Organique", from the data. */
    const splitDate = perf.find(p => p.cohort_from || p.cohort_before);
    const splitDay = formatAdDay(splitDate?.cohort_from ?? splitDate?.cohort_before ?? null);

    const windowLabel = windowParam === 'Toute'
        ? 'tout l’historique'
        : `${windowParam} mois suivant la création du compte`;

    /** No spend imported yet: credentials missing or back-fill never run. */
    const noSpendData = status.every(s => s.days === 0);

    /** Spend in a currency other than CAD makes every ratio wrong. */
    const foreignCurrency = useMemo(
        () => [...new Set(status.flatMap(s => s.currencies))].filter(c => c && c !== 'CAD'),
        [status],
    );

    /** Accounts for a channel but no spend in the period. */
    const partial = perf.filter(p => p.accounts_created > 0 && p.spend === 0);

    const openCohort = perf.some(p => isCohortOpen(p.window_ends_on));

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
                <div className="flex items-center gap-3 md:gap-4 min-w-0 flex-1">
                    <span className="shrink-0 inline-flex h-11 w-11 md:h-12 md:w-12 items-center justify-center rounded-lg bg-white shadow-card text-ink">
                        <AdvertisingIcon className="h-6 w-6" />
                    </span>
                    <div className="min-w-0">
                        <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">
                            Publicité · {AD_BASIS_LABEL[basis]}
                        </h1>
                        <p className="text-xs md:text-sm text-ink-mute mt-0.5">{SUBTITLE[basis][view]}</p>
                    </div>
                </div>

                <div className="flex flex-wrap gap-2 self-start md:self-auto">
                    <div className="flex gap-1 bg-stone p-0.5 rounded-md" role="tablist" aria-label="Vue">
                        {AD_VIEWS.map(v => (
                            <button
                                key={v.value}
                                role="tab"
                                aria-selected={view === v.value}
                                // The sources differ from one view to the next, so the
                                // source selection does not follow.
                                onClick={() => { setOptions(null); setViewParam(v.value, { source: null }); }}
                                className={cn(
                                    'px-4 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap transition-all',
                                    view === v.value ? 'bg-white text-ink shadow-card' : 'text-ink-mute hover:text-ink-secondary',
                                )}
                            >
                                {v.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={yearParam}
                            onChange={v => setYearParam(v, v === 'Toutes' ? { month: null } : undefined)}
                            options={YEAR_OPTIONS} variant="accent" className="w-40" />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select value={yearValue === null ? 'Toutes' : monthParam} onChange={setMonthParam}
                            options={monthOptions} className="w-40" disabled={yearValue === null} />
                </FilterGroup>
                <FilterGroup label="Fenêtre de revenus">
                    <Select value={windowParam} onChange={setWindowParam}
                            options={WINDOW_OPTIONS} variant="accent" className="w-44" />
                </FilterGroup>
                <FilterGroup label="Représentant">
                    <MultiSelect values={repFilter.selected} onChange={setSelectedReps} options={repFilter.options}
                                 allLabel={REP_ALL_LABEL} allIcon={repFilter.allIcon} className="w-48" />
                </FilterGroup>
                <FilterGroup label="Source">
                    <MultiSelect values={sourcesParam ?? []} onChange={setSelectedSources}
                                 options={optionList(options?.sources)} allLabel="Toutes les sources" className="w-48" />
                </FilterGroup>
                <FilterGroup label="Service">
                    <MultiSelect values={selectedServices} onChange={setSelectedServices}
                                 options={optionList(options?.services)} allLabel="Tous les services" className="w-48" />
                </FilterGroup>
                <FilterGroup label="Domaine">
                    <MultiSelect values={selectedDomaines} onChange={setSelectedDomaines}
                                 options={optionList(options?.domaines)} allLabel="Tous les domaines" className="w-48" />
                </FilterGroup>
                <FilterGroup label="Région">
                    <MultiSelect values={selectedRegions} onChange={setSelectedRegions}
                                 options={optionList(options?.regions)} allLabel="Toutes les régions" className="w-44" />
                </FilterGroup>
                {hasSpend && adAccountFilters.map(f => {
                    const picked = (pickedAdAccounts ?? []).filter(a => a.platform === f.channel).map(a => a.id);
                    const logo = <ChannelLogo channel={f.channel} size="xs" />;
                    return (
                        <FilterGroup key={f.channel} label={`Compte ${CHANNEL_LABEL[f.channel]}`}>
                            {f.options.length === 2 ? (
                                // Two accounts leave three choices: all, one, or the other.
                                // A list to tick would let both be ticked, which is "all"
                                // again and reads as the selection being thrown away.
                                <Select
                                    value={picked[0] ?? ALL_AD_ACCOUNTS}
                                    onChange={v => setAdAccountsOf(f.channel, v === ALL_AD_ACCOUNTS ? [] : [v])}
                                    options={[
                                        { value: ALL_AD_ACCOUNTS, label: 'Tous les comptes', icon: logo },
                                        ...f.options,
                                    ]}
                                    searchable={false}
                                    className="w-56" />
                            ) : (
                                // From three accounts on, a subset means something. Every
                                // account ticked is not a narrowing, so it is stored as none.
                                <MultiSelect
                                    values={picked}
                                    onChange={ids => setAdAccountsOf(f.channel, ids)}
                                    options={f.options}
                                    allLabel="Tous les comptes"
                                    allIcon={logo}
                                    className="w-56" />
                            )}
                        </FilterGroup>
                    );
                })}
                <FilterGroup label="Statut">
                    <Select value={ratingScope} onChange={setRatingScope} className="w-52"
                            options={[
                                { value: 'Clients', label: 'Clients seulement' },
                                { value: 'Tous',    label: 'Inclure comptes internes' },
                            ]} />
                </FilterGroup>
                <ClearFiltersButton activeCount={activeFilterCount} onClear={clearFilters} />
            </FilterBar>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-press" />
                    <p className="text-sm text-ink-mute font-medium">Chargement des données publicitaires...</p>
                </div>
            ) : (
                <>
                    {view === 'inconnu' && splitDay && <UnknownNotice day={splitDay} />}
                    {view === 'organique' && splitDay && <OrganicSinceNotice day={splitDay} />}

                    {/* Spend notices only make sense where spend is shown. */}
                    {hasSpend && (
                        <>
                            {noSpendData && <NoDataNotice />}
                            {foreignCurrency.length > 0 && <CurrencyNotice currencies={foreignCurrency} />}
                            {!noSpendData && partial.length > 0 && (
                                <PartialNotice channels={partial.map(p => p.channel)} />
                            )}
                            {!noSpendData && narrowed && <NarrowedNotice />}
                            {!noSpendData && pickedAdAccounts && <AdAccountNotice accounts={pickedAdAccounts} />}
                        </>
                    )}

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6" translate="no">
                        {perf.map(row => (
                            <ChannelCard key={row.channel} row={row} windowLabel={windowLabel}
                                         view={view} basis={basis} narrowed={narrowed} />
                        ))}
                    </div>

                    {/* One channel has nothing to be compared with. */}
                    {perf.length > 1 && (
                        <ComparisonTable rows={perf} windowLabel={windowLabel} openCohort={openCohort}
                                         view={view} basis={basis} />
                    )}

                    {year !== 'Toutes' && (
                        <SpendVsRevenueChart rows={monthly} year={year} windowLabel={windowLabel}
                                             view={view} basis={basis} />
                    )}

                    {hasSpend && (
                        <CampaignTable
                            rows={visibleCampaigns}
                            platform={campaignPlatform}
                            onPlatformChange={setCampaignPlatform}
                            statuses={campaignStatuses}
                            onStatusesChange={setCampaignStatuses}
                        />
                    )}
                </>
            )}
        </div>
    );
}

// ─── Notices ──────────────────────────────────────────────────────────────────

function UnknownNotice({ day }: { day: string }) {
    return (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-tone-neutral-soft border border-hairline">
            <Info className="w-4 h-4 text-tone-neutral-ink shrink-0 mt-0.5" />
            <div className="text-xs text-tone-neutral-ink leading-relaxed">
                <strong className="font-semibold">
                    Comptes « Google Organique » créés avant le {day}.
                </strong>{' '}
                Jusqu&rsquo;à cette date, cette origine regroupait la recherche Google et les clics sur
                une publicité Google, sans moyen de les distinguer. Ces comptes ne sont donc comptés
                ni dans <strong>Organique</strong> ni dans <strong>Payant</strong>, et aucune dépense
                ne leur est comparée.
            </div>
        </div>
    );
}

function OrganicSinceNotice({ day }: { day: string }) {
    return (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-tone-neutral-soft border border-hairline">
            <Info className="w-4 h-4 text-tone-neutral-ink shrink-0 mt-0.5" />
            <div className="text-xs text-tone-neutral-ink leading-relaxed">
                <strong className="font-semibold">
                    Google Organique compte les comptes créés depuis le {day}.
                </strong>{' '}
                Les comptes plus anciens portant cette origine mélangent recherche et publicité :
                ils sont dans l&rsquo;onglet <strong>Google inconnu</strong>.
            </div>
        </div>
    );
}

function NarrowedNotice() {
    return (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-tone-neutral-soft border border-hairline">
            <Info className="w-4 h-4 text-tone-neutral-ink shrink-0 mt-0.5" />
            <div className="text-xs text-tone-neutral-ink leading-relaxed">
                <strong className="font-semibold">
                    Coût par compte et rendement non calculés avec ces filtres.
                </strong>{' '}
                Les comptes et leurs revenus suivent les filtres représentant, service, domaine et
                région. La dépense, elle, est rapportée par campagne et ne peut pas être répartie
                ainsi : la diviser par une partie seulement des comptes donnerait un coût trop élevé.
            </div>
        </div>
    );
}

function AdAccountNotice({ accounts }: { accounts: AdAccountOption[] }) {
    // One clause per platform, since each is narrowed on its own.
    const byPlatform = CHANNELS
        .map(c => ({ channel: c, names: accounts.filter(a => a.platform === c).map(adAccountLabel) }))
        .filter(g => g.names.length > 0);
    return (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-tone-neutral-soft border border-hairline">
            <Info className="w-4 h-4 text-tone-neutral-ink shrink-0 mt-0.5" />
            <div className="text-xs text-tone-neutral-ink leading-relaxed">
                <strong className="font-semibold">
                    Dépense limitée à{' '}
                    <span translate="no">
                        {byPlatform.map(g => `${CHANNEL_LABEL[g.channel]} : ${g.names.join(' et ')}`).join(' ; ')}
                    </span>.
                </strong>{' '}
                Les comptes créés et leurs revenus restent ceux de tout le canal : le CRM
                n&rsquo;indique pas de quel compte publicitaire vient un client. Le coût par compte et
                le rendement comparent donc tous les comptes du canal à la dépense des comptes
                publicitaires choisis.
            </div>
        </div>
    );
}

function NoDataNotice() {
    return (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-tone-warn-soft border border-tone-warn/30">
            <Settings2 className="w-4 h-4 text-tone-warn-ink shrink-0 mt-0.5" />
            <div className="text-xs text-tone-warn-ink leading-relaxed">
                <strong className="font-semibold">Aucune dépense publicitaire n&rsquo;a encore été importée.</strong>
                {' '}Les comptes et les revenus ci-dessous sont réels ; le coût par compte et le
                rendement resteront vides tant que les accès Google Ads et Meta ne sont pas configurés
                et synchronisés (<strong>Paramètres → Synchronisation</strong>).
            </div>
        </div>
    );
}

function CurrencyNotice({ currencies }: { currencies: string[] }) {
    return (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-tone-critical-soft border border-tone-critical/30">
            <AlertTriangle className="w-4 h-4 text-tone-critical-ink shrink-0 mt-0.5" />
            <div className="text-xs text-tone-critical-ink leading-relaxed">
                <strong className="font-semibold">
                    Dépenses en {currencies.join(', ')}, revenus en CAD.
                </strong>{' '}
                Les ratios (coût par compte, rendement) comparent deux devises différentes et sont
                faux. Aucune conversion de devise n&rsquo;est appliquée.
            </div>
        </div>
    );
}

function PartialNotice({ channels }: { channels: AdChannel[] }) {
    return (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-tone-warn-soft border border-tone-warn/30">
            <TriangleAlert className="w-4 h-4 text-tone-warn-ink shrink-0 mt-0.5" />
            <div className="text-xs text-tone-warn-ink leading-relaxed">
                <strong className="font-semibold inline-flex flex-wrap items-center gap-x-1.5">
                    {channels.map((c, i) => (
                        <span key={c} className="inline-flex items-center gap-1">
                            {i > 0 && <span className="font-normal">et</span>}
                            <ChannelLogo channel={c} size="xs" />
                            {CHANNEL_LABEL[c]}
                        </span>
                    ))}
                    <span>: des comptes, mais aucune dépense sur la période.</span>
                </strong>{' '}
                Soit l&rsquo;import ne couvre pas encore ces dates, soit les accès de cette plateforme ne
                sont pas configurés. Le coût par compte et le rendement sont laissés vides plutôt
                qu&rsquo;affichés à zéro.
            </div>
        </div>
    );
}

// ─── Side-by-side comparison ──────────────────────────────────────────────────

/** Both channels side by side. */
function ComparisonTable({ rows, windowLabel, openCohort, view, basis }: {
    rows: AdPerformanceRow[];
    windowLabel: string;
    openCohort: boolean;
    view: AdView;
    basis: AdBasis;
}) {
    const words = BASIS_WORDS[basis];
    const organic = !viewHasSpend(view);
    const best = useMemo(() => {
        if (organic) return null;
        const scored = rows.filter(r => r.roas !== null);
        if (scored.length < 2) return null;
        return scored.reduce((a, b) => (a.roas ?? 0) >= (b.roas ?? 0) ? a : b).channel;
    }, [rows, organic]);

    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-hairline flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-ink">
                    {organic ? 'Comparaison des deux sources organiques' : 'Comparaison des deux canaux'}
                </h3>
                <InfoHint text={organic
                    ? `Comptes créés dans la période choisie avec cette origine, et ${words.what} dans les ${windowLabel}. Le revenu par compte divise par tous les comptes créés, y compris ceux qui n'ont rien acheté.`
                    : `Dépenses de la période choisie, comparées aux comptes créés dans cette même période et à ${words.what} dans les ${windowLabel}. Le coût par compte divise la dépense par tous les comptes créés, y compris ceux qui n'ont rien acheté.`} />
                {openCohort && (
                    <span className="text-2xs font-semibold px-2 py-0.5 rounded-full bg-tone-warn-soft text-tone-warn-ink">
                        Cohorte en cours
                    </span>
                )}
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-sm" translate="no">
                    <thead className="bg-sand/95">
                        <tr className="border-b border-hairline">
                            <Th align="left">{organic ? 'Source' : 'Canal'}</Th>
                            {!organic && <Th>Dépense</Th>}
                            <Th>Comptes</Th>
                            {!organic && <Th>Coût / compte</Th>}
                            <Th>{words.counted}</Th>
                            {organic && <Th>% {words.counted.toLowerCase()}</Th>}
                            {!organic && <Th>Coût / client</Th>}
                            <Th>Revenus</Th>
                            <Th>Revenu / compte</Th>
                            {!organic && <Th>Rendement</Th>}
                            {!organic && <Th>Net</Th>}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {rows.map(r => {
                            const open = isCohortOpen(r.window_ends_on);
                            const share = r.accounts_created > 0
                                ? `${Math.round((r.accounts_invoiced / r.accounts_created) * 100)} %`
                                : '—';
                            return (
                            <tr key={r.channel} className="hover:bg-sand/60 transition-colors">
                                <td className="px-4 py-3">
                                    <div className="flex items-center gap-3">
                                        <ChannelLogoTile channel={r.channel} size="sm" />
                                        <div className="min-w-0">
                                            <p className="font-semibold text-ink text-xs">{channelLabel(r.channel, view)}</p>
                                            <p className="text-2xs text-ink-mute mt-0.5 truncate max-w-[200px]"
                                               title={r.sources.join(', ')}>
                                                {r.sources.join(', ')}
                                            </p>
                                        </div>
                                    </div>
                                </td>
                                {!organic && <Td value={r.spend > 0 ? formatCurrencyCAD(r.spend) : '—'} />}
                                <Td value={r.accounts_created.toLocaleString('fr-CA')} strong={organic} />
                                {!organic && <Td value={r.cost_per_account !== null ? formatCurrencyCAD(r.cost_per_account) : '—'} strong />}
                                <Td value={r.accounts_invoiced.toLocaleString('fr-CA')} />
                                {organic && <Td value={share} />}
                                {!organic && <Td value={r.cost_per_client !== null ? formatCurrencyCAD(r.cost_per_client) : '—'} />}
                                <Td value={formatCurrencyCAD(r.revenue_attributed)} strong={organic} />
                                <Td value={r.revenue_per_account !== null ? formatCurrencyCAD(r.revenue_per_account) : '—'} />
                                {!organic && (
                                    <td className="px-4 py-3 text-right tabular-nums">
                                        {r.roas === null ? (
                                            <span className="text-ink-faint text-xs">—</span>
                                        ) : (
                                            <span className={cn(
                                                'text-xs font-bold',
                                                open ? 'text-ink-mute'
                                                    : r.roas >= 1 ? 'text-tone-good' : 'text-tone-critical',
                                            )}>
                                                {r.roas.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ×
                                                {best === r.channel && rows.length > 1 && (
                                                    <span className="ml-1.5 text-2xs font-bold px-1.5 py-0.5 rounded-full bg-tone-good-soft text-tone-good-ink">
                                                        Meilleur
                                                    </span>
                                                )}
                                            </span>
                                        )}
                                    </td>
                                )}
                                {!organic && (
                                    <td className="px-4 py-3 text-right tabular-nums">
                                        <span className={cn('text-xs font-bold',
                                            r.spend === 0 || r.net === null ? 'text-ink-faint'
                                                : open ? 'text-ink-mute'
                                                    : r.net >= 0 ? 'text-tone-good' : 'text-tone-critical')}>
                                            {r.spend === 0 || r.net === null ? '—' : formatCurrencyCAD(r.net)}
                                        </span>
                                    </td>
                                )}
                            </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <p className="px-5 py-3 text-2xs text-ink-mute border-t border-hairline leading-relaxed">
                {organic ? (
                    <>« Revenu / compte » = {words.legend.toLowerCase()} par les comptes créés sur la période ÷ tous
                    ces comptes, même ceux qui n&rsquo;ont rien acheté. En gris : fenêtre de revenus pas
                    encore terminée.</>
                ) : (
                    <>« Coût / compte » est l&rsquo;équivalent du coût par lead. « Rendement » = {words.legend.toLowerCase()}
                    {' '}par les comptes créés sur la période ÷ dépense publicitaire de la période.
                    1,00 × signifie que la publicité s&rsquo;est payée elle-même, sans compter les coûts de
                    production ni les commissions. En gris : fenêtre de revenus pas encore terminée.</>
                )}
            </p>
        </div>
    );
}

function Th({ children, align = 'right' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
    return (
        <th className={cn(
            'px-4 py-2.5 text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap',
            align === 'left' ? 'text-left' : 'text-right',
        )}>
            {children}
        </th>
    );
}

function Td({ value, strong }: { value: string; strong?: boolean }) {
    return (
        <td className={cn('px-4 py-3 text-right tabular-nums text-xs',
            strong ? 'font-bold text-ink' : 'font-semibold text-ink-secondary')}>
            {value}
        </td>
    );
}
