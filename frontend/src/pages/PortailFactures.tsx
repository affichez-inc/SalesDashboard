import { useEffect, useState, useCallback, useRef } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import {
    Loader2, TrendingUp, Target, Briefcase, FileText,
    User, X, ChevronRight,
} from 'lucide-react';
import type { SommaireRow } from '../types/database';
import { SommaireTable } from '../components/dashboard/SommaireTable';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { MonthlyDetail } from '../components/monthly/MonthlyDetail';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { fetchCommRate } from '../utils/commRates';

interface InvKPIs {
    ytd_total: number;
    ytd_count: number;
    avg_deal_size: number;
    annual_target: number;
    pct_of_target: number;
    paid_total: number;
    partial_total: number;
    avoir_total: number;
}
interface TopClient { client_name: string; total_amount: number; deal_count: number; office: string; }

interface Props { propRepName?: string; }

export default function PortailFactures({ propRepName }: Props) {
    const { repName: authRepName, isAdmin } = useAuth();
    const { viewAsRep } = useAdminView();
    const repName = propRepName ?? viewAsRep ?? authRepName ?? '';

    const [tab, setTab] = useUrlState('tab', 'apercu') as ['apercu' | 'mensuel', (v: 'apercu' | 'mensuel') => void];
    const [year, setYear] = useUrlStateNumber('year', 2026);
    const [commRate, setCommRate] = useState(0.05);

    const [loading, setLoading] = useState(true);
    const [kpis, setKpis] = useState<InvKPIs | null>(null);
    const [grandTotal, setGrandTotal] = useState<SommaireRow[]>([]);
    const [prevGrandTotal, setPrevGrandTotal] = useState<SommaireRow[]>([]);
    const [topClients, setTopClients] = useState<TopClient[]>([]);
    const [showClients, setShowClients] = useState(false);

    const repParam = repName || null;

    useEffect(() => {
        if (!repName) return;
        fetchCommRate(repName).then(setCommRate);
    }, [repName]);

    const fetchData = useCallback(async () => {
        if (!repParam && !isAdmin) return;
        setLoading(true);
        const [
            { data: grandData },
            { data: prevGrandData },
            { data: kpiData },
            { data: clientData },
        ] = await Promise.all([
            cachedRpc('get_inv_sommaire_grand_total', { p_year: year, p_office: null, p_status: null, p_rep: repParam }),
            cachedRpc('get_inv_sommaire_grand_total', { p_year: year - 1, p_office: null, p_status: null, p_rep: repParam }),
            cachedRpc('get_inv_dashboard_kpis', { p_year: year, p_office: null, p_status: null, p_month: null, p_dept: null, p_rep: repParam }),
            cachedRpc('get_inv_top_clients', { p_year: year, p_office: null, p_status: null, p_limit: 20, p_month: null, p_dept: null, p_rep: repParam }),
        ]);
        setGrandTotal(grandData || []);
        setPrevGrandTotal(prevGrandData || []);
        setKpis(kpiData?.[0] || null);
        setTopClients(clientData || []);
        setLoading(false);
    }, [year, repParam, isAdmin]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchData(); }, [fetchData]);
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>;
        const sub = supabase.channel(`portail-factures-${repName}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, () => {
                clearTimeout(timer);
                timer = setTimeout(() => { invalidateRpcCache(); fetchDataRef.current(); }, 2000);
            }).subscribe();
        return () => { clearTimeout(timer); supabase.removeChannel(sub); };
    }, [repName]);

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    if (!repName && !isAdmin) {
        return (
            <div className="p-4 md:p-8 max-w-screen-2xl mx-auto flex items-center justify-center min-h-[60vh]">
                <div className="text-center space-y-3">
                    <div className="w-14 h-14 rounded-xl bg-stone flex items-center justify-center mx-auto">
                        <User className="w-7 h-7 text-ink-faint" />
                    </div>
                    <h2 className="text-base font-semibold text-ink-secondary">Portail non configuré</h2>
                    <p className="text-sm text-ink-mute max-w-xs">Votre compte n'est pas encore associé à un représentant. Contactez un administrateur pour configurer votre accès.</p>
                </div>
            </div>
        );
    }

    return (
        <>
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-5 md:space-y-6">

            {/* Header */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h2 className="text-xl font-semibold text-ink tracking-tight flex items-center gap-2">
                        <FileText className="w-5 h-5 text-data-3-ink" />
                        Mes Factures
                    </h2>
                    <p className="text-sm text-ink-mute mt-0.5">Facturation et revenus · {repName || 'Représentant'}</p>
                </div>

                {/* Tab switcher */}
                <div className="flex gap-1 bg-stone p-1 rounded-md">
                    <button
                        onClick={() => setTab('apercu')}
                        className={cn(
                            "px-4 py-1.5 rounded-md text-sm font-semibold transition-all",
                            tab === 'apercu'
                                ? "bg-white shadow-xs text-ink"
                                : "text-ink-secondary hover:text-ink"
                        )}
                    >
                        Aperçu
                    </button>
                    <button
                        onClick={() => setTab('mensuel')}
                        className={cn(
                            "px-4 py-1.5 rounded-md text-sm font-semibold transition-all",
                            tab === 'mensuel'
                                ? "bg-white shadow-xs text-ink"
                                : "text-ink-secondary hover:text-ink"
                        )}
                    >
                        Mensuel
                    </button>
                </div>
            </div>

            {/* ── Aperçu tab ─────────────────────────────────────────────────────── */}
            {tab === 'apercu' && (
                <>
                <FilterBar>
                    <FilterGroup label="Année">
                        <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                    </FilterGroup>
                </FilterBar>

                {loading ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-3">
                        <Loader2 className="w-8 h-8 animate-spin text-primary-press" />
                        <p className="text-sm text-ink-mute">Chargement des factures...</p>
                    </div>
                ) : (
                    <>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <KPICard
                            title="Facturé YTD"
                            value={new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(kpis?.ytd_total ?? 0).replace(/\s*CA$/, '').trim()}
                            sub="Net après avoirs"
                            icon={TrendingUp}
                            trend={kpis?.pct_of_target}
                            accent
                        />
                        <KPICard
                            title="Nb Factures"
                            value={String(kpis?.ytd_count ?? 0)}
                            sub="Factures émises"
                            icon={FileText}
                        />
                        <KPICard
                            title="Montant Moyen"
                            value={formatCurrencyCAD(kpis?.avg_deal_size ?? 0)}
                            sub="Par facture"
                            icon={Briefcase}
                        />
                        <KPICard
                            title="Objectif Annuel"
                            value={formatCurrencyCAD(kpis?.annual_target ?? 0)}
                            sub={(kpis?.avoir_total ?? 0) < 0 ? `Avoirs: ${formatCurrencyCAD(kpis?.avoir_total ?? 0)}` : 'Aucun avoir'}
                            icon={Target}
                        />
                    </div>


                    <div className="bg-white rounded-xl shadow-card overflow-hidden">
                        <div className="px-5 py-4 border-b border-hairline flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                                <User className="w-4 h-4 text-ink-mute" /> Mes Clients
                            </h3>
                            {topClients.length > 5 && (
                                <button onClick={() => setShowClients(true)} className="flex items-center gap-1 text-2xs font-bold text-primary-press hover:text-primary-deep transition-colors">
                                    Voir tout ({topClients.length}) <ChevronRight className="w-3 h-3" />
                                </button>
                            )}
                        </div>
                        <div className="divide-y divide-hairline">
                            {topClients.length === 0 ? (
                                <p className="px-5 py-8 text-sm text-ink-mute text-center">Aucun client pour cette période</p>
                            ) : topClients.slice(0, 5).map((c, idx) => (
                                <div key={c.client_name} className="px-5 py-3 flex items-center justify-between hover:bg-sand transition-colors">
                                    <div className="flex items-center gap-3">
                                        <span className="w-5 h-5 text-2xs font-bold text-ink-mute tabular-nums flex items-center justify-center shrink-0">{idx + 1}</span>
                                        <p className="text-sm font-semibold text-ink-secondary truncate max-w-[240px]" title={c.client_name}>{c.client_name}</p>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <p className="text-sm font-bold text-ink">{formatCurrencyCAD(c.total_amount)}</p>
                                        <p className="text-2xs text-ink-mute">{c.deal_count} factures</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <SommaireTable
                        title={`Performance mensuelle · ${repName}`}
                        data={grandTotal}
                        prevYearData={prevGrandTotal}
                        year={year}
                        selectedMonth="Toutes"
                        dealLabel="factures"
                    />
                    </>
                )}
                </>
            )}

            {/* ── Mensuel tab ────────────────────────────────────────────────────── */}
            {tab === 'mensuel' && (
                <MonthlyDetail
                    module="factures"
                    repName={repName || null}
                    commRate={commRate}
                />
            )}
        </div>

        {showClients && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setShowClients(false)}>
                <div className="absolute inset-0 bg-ink/40 backdrop-blur-xs" />
                <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                    <div className="px-5 py-4 border-b border-hairline flex items-center justify-between shrink-0">
                        <h3 className="text-sm font-semibold text-ink">Tous mes clients · Factures</h3>
                        <button onClick={() => setShowClients(false)} className="p-1.5 rounded-md text-ink-mute hover:bg-stone transition-all"><X className="w-4 h-4" /></button>
                    </div>
                    <div className="overflow-y-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-hairline bg-sand/50">
                                    <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">#</th>
                                    <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Client</th>
                                    <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Total</th>
                                    <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Factures</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hairline">
                                {topClients.map((c, idx) => (
                                    <tr key={c.client_name} className="hover:bg-sand/60">
                                        <td className="px-4 py-2.5 text-xs font-bold text-ink-mute tabular-nums">{idx + 1}</td>
                                        <td className="px-4 py-2.5 font-semibold text-ink-secondary max-w-[220px] truncate">{c.client_name}</td>
                                        <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums">{formatCurrencyCAD(c.total_amount)}</td>
                                        <td className="px-4 py-2.5 text-right font-bold text-ink-mute tabular-nums">{c.deal_count}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        )}
        </>
    );
}

function KPICard({ title, value, sub, icon: Icon, trend, accent = false }: {
    title: string; value: string; sub: string;
    icon: React.ElementType; trend?: number; accent?: boolean;
}) {
    return (
        <div className={cn(
            "p-3 md:p-5 rounded-xl border flex flex-col justify-between hover:shadow-elevated transition-all group",
            accent ? "bg-primary/5 border-primary/20" : "bg-white border-hairline shadow-card"
        )}>
            <div className="flex items-start justify-between mb-2 md:mb-4">
                <div className={cn("p-2 md:p-2.5 rounded-md transition-colors",
                    accent ? "bg-primary-wash text-primary-press" : "bg-sand text-ink-mute group-hover:text-primary-press group-hover:bg-primary-wash")}>
                    <Icon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                {trend !== undefined && (
                    <span className={cn("text-2xs font-bold px-1.5 md:px-2 py-0.5 rounded-full",
                        trend >= 100 ? "bg-tone-good-soft text-tone-good-ink" : "bg-tone-warn-soft text-tone-warn-ink")}>
                        {trend}% obj.
                    </span>
                )}
            </div>
            <div>
                <p className="text-2xs md:text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">{title}</p>
                <p className={cn("text-lg md:text-2xl font-bold mt-1 tabular-nums", accent ? "text-primary-press" : "text-ink")}>{value}</p>
                <p className="text-2xs text-ink-mute mt-0.5 md:mt-1 italic">{sub}</p>
            </div>
        </div>
    );
}
