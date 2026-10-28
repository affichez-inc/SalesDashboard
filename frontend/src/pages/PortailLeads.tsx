import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlStateNumber, useUrlList } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import { Loader2, TrendingUp, Users, Percent, DollarSign } from 'lucide-react';
import type { ZohoLeadKPIs, ZohoLeadsMonthlyRow, ZohoLeadFilterOptions } from '../types/database';
import { MONTHS } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { MultiSelect } from '../components/MultiSelect';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { InfoHint } from '../components/InfoHint';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import LeadsDetail from './LeadsDetail';
import { ExportButton } from '../components/ExportButton';
import type { CsvColumn } from '../lib/csv';
import { RepAvatar } from '../components/RepAvatar';

interface Props { propRepName?: string; }

export default function PortailLeads({ propRepName }: Props) {
    const { repName: authRepName } = useAuth();
    const { viewAsRep } = useAdminView();
    const repName = propRepName ?? viewAsRep ?? authRepName ?? '';

    const [tab, setTab] = useUrlState('tab', 'apercu') as ['apercu' | 'detail', (v: 'apercu' | 'detail') => void];
    const [year, setYear] = useUrlStateNumber('year', 2026);
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const setSelectedMonth = (v: number | 'Toutes') => _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v));
    // Several values each; an empty list is "no filter". The Détail tab reads the
    // same two URL keys, so a selection follows from one tab to the other.
    const [selectedSources, setSelectedSources] = useUrlList('source');
    const [selectedServices, setSelectedServices] = useUrlList('service');

    const [loading, setLoading] = useState(true);
    const [kpis, setKpis] = useState<ZohoLeadKPIs | null>(null);
    const [monthly, setMonthly] = useState<ZohoLeadsMonthlyRow[]>([]);
    // Sources and services come from the data. The hardcoded lists were the
    // legacy table's, and only one of their six values exists in Zoho.
    const [options, setOptions] = useState<ZohoLeadFilterOptions | null>(null);

    const repParam = repName || null;

    const fetchData = useCallback(async () => {
        if (!repParam) return;
        setLoading(true);
        const monthParam = selectedMonth === 'Toutes' ? null : selectedMonth;
        const sourcesParam = selectedSources.length > 0 ? selectedSources : null;
        const servicesParam = selectedServices.length > 0 ? selectedServices : null;

        const [
            { data: kpiData },
            { data: monthData },
        ] = await Promise.all([
            cachedRpc('get_zoho_lead_kpis', { p_year: year, p_month: monthParam, p_rep: repParam, p_sources: sourcesParam, p_services: servicesParam }),
            cachedRpc('get_zoho_leads_monthly_summary', { p_year: year, p_rep: repParam, p_sources: sourcesParam, p_services: servicesParam }),
        ]);

        setKpis((kpiData as ZohoLeadKPIs[])?.[0] ?? null);
        setMonthly((monthData as ZohoLeadsMonthlyRow[]) ?? []);
        setLoading(false);
    }, [year, selectedMonth, selectedSources, selectedServices, repParam]);

    const fetchOptions = useCallback(async () => {
        const { data } = await cachedRpc<ZohoLeadFilterOptions>(
            // Lead-only, to match get_zoho_lead_kpis and the monthly summary above -
            // a source that only contacts carry would otherwise be offered here and
            // empty the whole portal.
            'get_zoho_lead_filter_options', { p_year: year, p_stage: 'lead' }, { single: true });
        if (data) setOptions(data);
    }, [year]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchData(); }, [fetchData]);
    // Options load once per year change. The rule fires on any setState
    // reachable from an effect; the write happens in the awaited
    // continuation, not synchronously, so there is no cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchOptions(); }, [fetchOptions]);

    // Coalesced: a full sync rewrites ~29k rows, so one refetch per change event
    // would stampede the browser.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const sub = supabase
            .channel(`portail-leads-${repName}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'zoho_leads' }, () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => { invalidateRpcCache(); fetchDataRef.current(); }, 1500);
            })
            .subscribe();
        return () => {
            if (timer) clearTimeout(timer);
            supabase.removeChannel(sub);
        };
    }, [repName]);

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));
    const monthOptions = useMemo(() => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))], []);
    const sourceOptions = useMemo(
        () => (options?.sources ?? []).map(s => ({ value: s, label: s })),
        [options],
    );
    const serviceOptions = useMemo(
        () => (options?.services ?? []).map(s => ({ value: s, label: s })),
        [options],
    );

    const monthLabel = (m: number) => MONTHS.find(mo => mo.value === m)?.label ?? String(m);

    if (!repName) {
        return (
            <div className="p-8 text-center text-ink-mute text-sm">
                Aucun représentant sélectionné.
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">Mes Leads</h1>
                    <p className="text-xs md:text-sm text-ink-mute mt-0.5 inline-flex items-center gap-2"><RepAvatar name={repName} size="sm" literal />{repName}</p>
                </div>
                {/* Tab switcher */}
                <div className="flex items-center gap-1 bg-stone rounded-md p-1">
                    <TabBtn active={tab === 'apercu'} onClick={() => setTab('apercu')}>Aperçu</TabBtn>
                    <TabBtn active={tab === 'detail'} onClick={() => setTab('detail')}>Détail</TabBtn>
                </div>
            </div>

            {tab === 'apercu' && (
                <>
                    <FilterBar>
                        <FilterGroup label="Année">
                            <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                        </FilterGroup>
                        <FilterGroup label="Mois">
                            <Select value={String(selectedMonth)} onChange={v => setSelectedMonth(v === 'Toutes' ? 'Toutes' : Number(v))} options={monthOptions} className="w-40" />
                        </FilterGroup>
                        <FilterGroup label="Source">
                            <MultiSelect values={selectedSources} onChange={setSelectedSources} options={sourceOptions}
                                         allLabel="Toutes sources" className="w-52" />
                        </FilterGroup>
                        <FilterGroup label="Service">
                            <MultiSelect values={selectedServices} onChange={setSelectedServices} options={serviceOptions}
                                         allLabel="Tous services" className="w-48" />
                        </FilterGroup>
                    </FilterBar>

                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-20 gap-3">
                            <Loader2 className="w-8 h-8 animate-spin text-primary-press" />
                            <p className="text-sm text-ink-mute font-medium">Chargement de vos leads...</p>
                        </div>
                    ) : (
                        <>
                            {/* KPI Cards */}
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                                <KPICard
                                    title="Leads reçus"
                                    value={(kpis?.leads_received ?? 0).toLocaleString('fr-CA')}
                                    subText="Module Leads de Zoho"
                                    icon={Users}
                                    hint="Vos leads créés dans Zoho CRM sur la période. Les contacts ne sont pas comptés : la plupart ont été créés directement comme clients."
                                />
                                <KPICard
                                    title="Convertis"
                                    value={(kpis?.leads_converted ?? 0).toLocaleString('fr-CA')}
                                    subText={`${(kpis?.conversion_rate ?? 0).toFixed(1)} % des leads`}
                                    icon={TrendingUp}
                                    hint="Leads que Zoho a marqués comme convertis en contact/compte. Presque tous finissent par l’être, donc ce taux bouge peu."
                                />
                                <KPICard
                                    title="Leads facturés"
                                    value={(kpis?.leads_invoiced ?? 0).toLocaleString('fr-CA')}
                                    subText={`${(kpis?.invoiced_rate ?? 0).toFixed(1)} % des leads`}
                                    icon={Percent}
                                    highlight={(kpis?.invoiced_rate ?? 0) >= 20}
                                    hint="Leads dont le compte a réellement été facturé après l’arrivée du lead. C’est la conversion qui compte."
                                />
                                <KPICard
                                    title="Revenus générés"
                                    value={formatCurrencyCAD(kpis?.revenue_attributed ?? 0)}
                                    subText={`Valeur client totale ${formatCurrencyCAD(kpis?.revenue_lifetime ?? 0)}`}
                                    icon={DollarSign}
                                    hint="Factures datées à partir de l’arrivée du lead : un lead ne peut pas avoir généré des revenus antérieurs à lui. La valeur client totale ajoute tout l’historique du compte. Compté une seule fois par compte."
                                />
                            </div>

                            {/* Monthly summary table */}
                            <div className="bg-white rounded-xl shadow-card overflow-hidden">
                                <div className="px-5 py-4 border-b border-hairline">
                                    <h3 className="text-sm font-semibold text-ink">Résumé mensuel</h3>
                                    <ExportButton
                                        rows={monthly}
                                        columns={[
                                            { header: 'Mois',      value: r => r.month },
                                            { header: 'Leads',     value: r => r.nb_leads },
                                            { header: 'Convertis', value: r => r.nb_converted },
                                            { header: 'Factures',  value: r => r.nb_invoiced },
                                            { header: 'Montant',   value: r => r.total_amount },
                                        ] as CsvColumn<typeof monthly[number]>[]}
                                        filename="mes_leads_par_mois" label="CSV"
                                        disabled={monthly.length === 0}
                                    />
                                </div>
                                {monthly.length === 0 ? (
                                    <p className="px-5 py-8 text-sm text-ink-mute text-center">Aucune donnée</p>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="border-b border-hairline bg-sand/60">
                                                    <th className="th text-left">Mois</th>
                                                    <th className="th text-right">Leads</th>
                                                    <th className="th text-right">Facturés</th>
                                                    <th className="th text-right">Taux</th>
                                                    <th className="th text-right">Revenus</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-hairline">
                                                {monthly.map(row => {
                                                    const rate = row.nb_leads > 0 ? ((row.nb_invoiced / row.nb_leads) * 100).toFixed(0) : '0';
                                                    return (
                                                        <tr key={row.month} className="hover:bg-sand/60 transition-colors">
                                                            <td className="td font-semibold text-ink-secondary">{monthLabel(row.month)}</td>
                                                            <td className="td text-right tabular-nums font-bold text-ink-secondary">{row.nb_leads}</td>
                                                            <td className="td text-right tabular-nums font-bold text-ink-secondary">{row.nb_invoiced}</td>
                                                            <td className="td text-right tabular-nums">
                                                                <span className={cn("text-xs font-bold", Number(rate) >= 20 ? "text-tone-good" : "text-ink-mute")}>
                                                                    {rate}%
                                                                </span>
                                                            </td>
                                                            <td className="td text-right tabular-nums font-bold text-ink text-xs">
                                                                {row.total_amount > 0 ? formatCurrencyCAD(row.total_amount) : <span className="text-ink-faint">—</span>}
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                            <tfoot>
                                                <tr className="border-t border-hairline-strong bg-sand/60">
                                                    <td className="td font-bold text-ink">Total</td>
                                                    <td className="td text-right tabular-nums font-bold text-ink">{kpis?.leads_received ?? 0}</td>
                                                    <td className="td text-right tabular-nums font-bold text-ink">{kpis?.leads_invoiced ?? 0}</td>
                                                    <td className="td text-right tabular-nums">
                                                        <span className={cn("text-xs font-bold", (kpis?.invoiced_rate ?? 0) >= 20 ? "text-tone-good" : "text-ink-mute")}>
                                                            {(kpis?.invoiced_rate ?? 0).toFixed(1)}%
                                                        </span>
                                                    </td>
                                                    <td className="td text-right tabular-nums font-bold text-ink text-xs">{formatCurrencyCAD(kpis?.revenue_attributed ?? 0)}</td>
                                                </tr>
                                            </tfoot>
                                        </table>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </>
            )}

            {tab === 'detail' && (
                <LeadsDetail propRepName={repName} />
            )}
        </div>
    );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "px-3 py-1.5 rounded-md text-xs font-bold transition-all",
                active ? "bg-white text-ink shadow-xs" : "text-ink-mute hover:text-ink-secondary"
            )}
        >
            {children}
        </button>
    );
}

function KPICard({ title, value, subText, icon: Icon, highlight, hint }: { title: string; value: string; subText: string; icon: React.ElementType; highlight?: boolean; hint?: string }) {
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
