import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlList } from '../hooks/useUrlState';
import { MultiSelect } from '../components/MultiSelect';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import { Loader2, TrendingUp, Users, Percent, DollarSign } from 'lucide-react';
import type {
    ZohoLeadKPIs, ZohoLeadBreakdownRow, ZohoLeadFilterOptions,
} from '../types/database';
import { MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { InfoHint } from '../components/InfoHint';
import { formatCurrencyCAD, cn } from '../lib/utils';

/**
 * Leads dashboard, over Zoho's Leads module.
 *
 * Reads zoho_leads (stage = 'lead'), not the legacy hand-entered `leads` table
 * this page used to query - that held 192 rows, all dated 2026-01-01, and had not
 * been updated since May. Contacts are deliberately out of scope: most were
 * created directly in Zoho as clients and were never leads, so including them put
 * conversion at ~99% and inflated revenue several-fold.
 */
export default function LeadsDashboard() {
    const [yearParam, _setYearParam] = useUrlState('year', '2026');
    const year: number | 'Toutes' = yearParam === 'Toutes' ? 'Toutes' : Number(yearParam);
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const setSelectedMonth = (v: number | 'Toutes') => _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v));
    const setYear = (v: number | 'Toutes') => _setYearParam(v === 'Toutes' ? 'Toutes' : String(v));
    // Several values each; an empty list is "no filter".
    const [selectedReps, setSelectedReps] = useUrlList('rep');
    const [selectedSources, setSelectedSources] = useUrlList('source');
    const [selectedServices, setSelectedServices] = useUrlList('service');

    const [loading, setLoading] = useState(true);
    const [kpis, setKpis] = useState<ZohoLeadKPIs | null>(null);
    const [byRep, setByRep] = useState<ZohoLeadBreakdownRow[]>([]);
    const [bySource, setBySource] = useState<ZohoLeadBreakdownRow[]>([]);
    const [byService, setByService] = useState<ZohoLeadBreakdownRow[]>([]);

    // Filter values come from the data, not a hardcoded list. The old constants
    // were the legacy table's six sources, of which only "Meta Ads" exists in
    // Zoho - the real top source, "Publicité/Recherche Google", was not offered.
    const [options, setOptions] = useState<ZohoLeadFilterOptions | null>(null);

    const yearParamValue = year === 'Toutes' ? null : year;

    const fetchData = useCallback(async () => {
        setLoading(true);
        const monthParam = selectedMonth === 'Toutes' ? null : selectedMonth;
        const repsParam = selectedReps.length > 0 ? selectedReps : null;
        const sourcesParam = selectedSources.length > 0 ? selectedSources : null;
        const servicesParam = selectedServices.length > 0 ? selectedServices : null;

        const [
            { data: kpiData },
            { data: repData },
            { data: srcData },
            { data: svcData },
        ] = await Promise.all([
            cachedRpc('get_zoho_lead_kpis', {
                p_year: yearParamValue, p_month: monthParam, p_reps: repsParam,
                p_sources: sourcesParam, p_services: servicesParam,
            }),
            cachedRpc('get_zoho_leads_by_rep', {
                p_year: yearParamValue, p_month: monthParam,
                p_sources: sourcesParam, p_services: servicesParam,
            }),
            cachedRpc('get_zoho_leads_by_source', {
                p_year: yearParamValue, p_month: monthParam,
                p_reps: repsParam, p_services: servicesParam,
            }),
            cachedRpc('get_zoho_leads_by_service', {
                p_year: yearParamValue, p_month: monthParam,
                p_reps: repsParam, p_sources: sourcesParam,
            }),
        ]);

        setKpis((kpiData as ZohoLeadKPIs[])?.[0] ?? null);
        setByRep((repData as ZohoLeadBreakdownRow[]) ?? []);
        setBySource((srcData as ZohoLeadBreakdownRow[]) ?? []);
        setByService((svcData as ZohoLeadBreakdownRow[]) ?? []);
        setLoading(false);
    }, [yearParamValue, selectedMonth, selectedReps, selectedSources, selectedServices]);

    const fetchOptions = useCallback(async () => {
        const { data } = await cachedRpc<ZohoLeadFilterOptions>(
            // p_stage: 'lead' because every figure on this page counts leads only.
            // Without it the dropdowns were built from leads AND contacts, so a rep
            // or source carried solely by contacts could be picked and returned an
            // all-zero dashboard - which reads as broken data, not an empty filter.
            'get_zoho_lead_filter_options', { p_year: yearParamValue, p_stage: 'lead' }, { single: true });
        if (data) setOptions(data);
    }, [yearParamValue]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchData(); }, [fetchData]);
    // Options load once per year change. The rule fires on any setState
    // reachable from an effect; the write happens in the awaited
    // continuation, not synchronously, so there is no cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchOptions(); }, [fetchOptions]);

    // Coalesced: a full sync rewrites ~29k rows, and one refetch per change event
    // would fire thousands of queries at the browser.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const sub = supabase
            .channel('leads-dashboard-changes')
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

    const yearOptions = [
        { value: 'Toutes', label: 'Toutes les années' },
        ...[2027, 2026, 2025, 2024, 2023, 2022].map(y => ({ value: String(y), label: String(y) })),
    ];
    const monthOptions = useMemo(
        () => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))],
        [],
    );
    const repOptions = useMemo(
        () => (options?.reps ?? []).map(r => ({ value: r, label: r })),
        [options],
    );
    const sourceOptions = useMemo(
        () => (options?.sources ?? []).map(s => ({ value: s, label: s })),
        [options],
    );
    const serviceOptions = useMemo(
        () => (options?.services ?? []).map(s => ({ value: s, label: s })),
        [options],
    );

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div>
                <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">Leads · Tableau de bord</h1>
                <p className="text-xs md:text-sm text-ink-mute mt-0.5">
                    Leads entrants du module Leads de Zoho CRM, et ce qu&rsquo;ils ont rapporté
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
                <FilterGroup label="Représentant">
                    <MultiSelect values={selectedReps} onChange={setSelectedReps} options={repOptions}
                                 allLabel="Tous les reps" className="w-48" />
                </FilterGroup>
                <FilterGroup label="Source">
                    <MultiSelect values={selectedSources} onChange={setSelectedSources} options={sourceOptions}
                                 allLabel="Toutes les sources" className="w-52" />
                </FilterGroup>
                <FilterGroup label="Service">
                    <MultiSelect values={selectedServices} onChange={setSelectedServices} options={serviceOptions}
                                 allLabel="Tous les services" className="w-48" />
                </FilterGroup>
            </FilterBar>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-press" />
                    <p className="text-sm text-ink-mute font-medium">Chargement des données leads...</p>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        <KPICard
                            title="Leads reçus"
                            value={(kpis?.leads_received ?? 0).toLocaleString('fr-CA')}
                            subText="Module Leads de Zoho"
                            icon={Users}
                            hint="Nombre de leads créés dans Zoho CRM sur la période. Les contacts ne sont pas comptés : la plupart ont été créés directement comme clients et n'ont jamais été des leads."
                        />
                        <KPICard
                            title="Convertis"
                            value={(kpis?.leads_converted ?? 0).toLocaleString('fr-CA')}
                            subText={`${(kpis?.conversion_rate ?? 0).toFixed(1)} % des leads`}
                            icon={TrendingUp}
                            hint="Leads que Zoho a marqués comme convertis en contact/compte. Presque tous les leads finissent par l'être, donc ce taux bouge peu : regardez plutôt « Leads facturés »."
                        />
                        <KPICard
                            title="Leads facturés"
                            value={(kpis?.leads_invoiced ?? 0).toLocaleString('fr-CA')}
                            subText={`${(kpis?.invoiced_rate ?? 0).toFixed(1)} % des leads`}
                            icon={Percent}
                            highlight={(kpis?.invoiced_rate ?? 0) >= 20}
                            hint="Leads dont le compte a réellement été facturé après l'arrivée du lead. C'est la conversion qui compte : elle mesure de l'argent, pas une case cochée dans Zoho."
                        />
                        <KPICard
                            title="Revenus générés"
                            value={formatCurrencyCAD(kpis?.revenue_attributed ?? 0)}
                            subText={`Valeur client totale ${formatCurrencyCAD(kpis?.revenue_lifetime ?? 0)}`}
                            icon={DollarSign}
                            hint="Factures datées à partir de l'arrivée du lead : un lead ne peut pas avoir généré des revenus antérieurs à lui. La « valeur client totale » ajoute tout l'historique de facturation du compte, y compris avant le lead. Les deux sont comptés une seule fois par compte."
                        />
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 md:gap-6">
                        <LeadsBreakdownTable title="Par représentant" rows={byRep} />
                        <LeadsBreakdownTable title="Par source" rows={bySource} />
                        <LeadsBreakdownTable
                            title="Par service"
                            rows={byService}
                            note="Un lead peut cocher plusieurs services : le total des lignes dépasse le nombre de leads."
                        />
                    </div>
                </>
            )}
        </div>
    );
}

function LeadsBreakdownTable({ title, rows, note }: {
    title: string;
    rows: ZohoLeadBreakdownRow[];
    note?: string;
}) {
    const totalLeads = rows.reduce((s, r) => s + r.nb_leads, 0);
    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-hairline flex items-center gap-2">
                <h3 className="text-sm font-semibold text-ink">{title}</h3>
                {note && <InfoHint text={note} />}
            </div>
            {rows.length === 0 ? (
                <p className="px-5 py-8 text-sm text-ink-mute text-center">Aucun lead</p>
            ) : (
                <div className="max-h-[420px] overflow-y-auto">
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-sand/95 backdrop-blur">
                            <tr className="border-b border-hairline">
                                <th className="px-4 py-2.5 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Nom</th>
                                <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Leads</th>
                                <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Facturés</th>
                                <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Revenus</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-hairline">
                            {rows.map(r => {
                                const pct = totalLeads > 0 ? Math.round((r.nb_leads / totalLeads) * 100) : 0;
                                const rate = r.nb_leads > 0 ? ((r.nb_invoiced / r.nb_leads) * 100).toFixed(0) : '0';
                                return (
                                    <tr key={r.label} className="hover:bg-sand/60 transition-colors">
                                        <td className="px-4 py-2.5">
                                            <p className="font-semibold text-ink-secondary text-xs truncate max-w-[150px]" title={r.label}>
                                                {r.label}
                                            </p>
                                            <div className="mt-1 h-1 rounded-full bg-stone w-full max-w-[100px]">
                                                <div className="h-1 rounded-full bg-primary" style={{ width: `${pct}%` }} />
                                            </div>
                                        </td>
                                        <td className="px-4 py-2.5 text-right font-bold text-ink-secondary tabular-nums">{r.nb_leads}</td>
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
