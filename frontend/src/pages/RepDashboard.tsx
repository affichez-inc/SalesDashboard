import { useEffect, useState, useCallback, useRef } from 'react';
import { cachedRpc } from '../lib/rpcCache';
import {
    Loader2, TrendingUp, Target, Briefcase, FileText,
    ClipboardList, User, ChevronDown, X,
    BarChart2, Trophy, ChevronRight,
} from 'lucide-react';
import type { SommaireRow } from '../types/database';
import { SommaireTable } from '../components/dashboard/SommaireTable';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { MONTHS } from '../lib/constants';
import { useRepTeam } from '../lib/repTeam';
import { RepAvatar } from '../components/RepAvatar';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DevisKPIs {
    ytd_total: number;
    ytd_count: number;
    avg_deal_size: number;
    annual_target: number;
    pct_of_target: number;
    invoiced_total: number;
    accepted_total: number;
}

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

interface LeaderboardEntry {
    rep_name: string;
    office: string;
    total_amount: number;
    deal_count: number;
    avg_deal: number;
    rank: number;
}

// ─── Rep Picker ───────────────────────────────────────────────────────────────

function RepPicker({ reps, selected, onChange }: {
    reps: string[];
    selected: string;
    onChange: (rep: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        window.addEventListener('click', close);
        return () => window.removeEventListener('click', close);
    }, [open]);

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen(v => !v)}
                className="flex items-center gap-2 px-4 py-2.5 bg-white border border-hairline-strong rounded-md text-sm font-semibold text-ink-secondary hover:border-primary hover:text-primary-press transition-all shadow-xs"
            >
                {selected
                    ? <RepAvatar name={selected} size="md" literal />
                    : <div className="w-8 h-8 rounded-full bg-primary-wash text-primary-press flex items-center justify-center shrink-0">
                          <User className="w-3.5 h-3.5" />
                      </div>}
                {selected || 'Choisir un représentant'}
                <ChevronDown className={cn("w-4 h-4 text-ink-mute transition-transform ml-1", open && "rotate-180")} />
            </button>

            {open && (
                <div className="absolute top-full left-0 mt-2 w-64 bg-white rounded-lg border border-hairline-strong shadow-xl overflow-hidden z-30">
                    <div className="px-3 py-2 border-b border-hairline">
                        <p className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Représentants</p>
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                        {reps.length === 0 ? (
                            <p className="px-4 py-3 text-sm text-ink-mute">Aucun représentant</p>
                        ) : (
                            reps.map(rep => (
                                <button
                                    key={rep}
                                    onClick={() => { onChange(rep); setOpen(false); }}
                                    className={cn(
                                        "w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors text-left",
                                        rep === selected
                                            ? "bg-primary/5 text-primary-press font-semibold"
                                            : "text-ink-secondary hover:bg-sand font-medium"
                                    )}
                                >
                                    <RepAvatar name={rep} size="md" literal />
                                    {rep}
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KPICard({ title, value, subText, icon: Icon, trend, trendLabel, accent = false }: {
    title: string;
    value: string;
    subText: string;
    icon: React.ElementType;
    trend?: number;
    trendLabel?: string;
    accent?: boolean;
}) {
    return (
        <div className={cn(
            "p-3 md:p-5 rounded-xl border flex flex-col justify-between hover:shadow-elevated transition-all group",
            accent
                ? "bg-primary/5 border-primary/20 shadow-xs"
                : "bg-white border-hairline shadow-card"
        )}>
            <div className="flex items-start justify-between mb-2 md:mb-4">
                <div className={cn(
                    "p-2 md:p-2.5 rounded-md transition-colors",
                    accent
                        ? "bg-primary-wash text-primary-press"
                        : "bg-sand text-ink-mute group-hover:text-primary-press group-hover:bg-primary-wash"
                )}>
                    <Icon className="w-5 h-5" />
                </div>
                {trend !== undefined && (
                    <div className={cn("text-2xs font-bold px-2 py-0.5 rounded-full", trend >= 100 ? "bg-tone-good-soft text-tone-good-ink" : "bg-tone-warn-soft text-tone-warn-ink")}>
                        {trend}% {trendLabel}
                    </div>
                )}
            </div>
            <div>
                <p className="text-2xs md:text-xs font-semibold text-ink-mute uppercase tracking-eyebrow leading-tight">{title}</p>
                <p className={cn("text-base md:text-2xl font-bold mt-0.5 md:mt-1 tabular-nums", accent ? "text-primary-press" : "text-ink")}>{value}</p>
                <p className="text-2xs text-ink-mute mt-0.5 md:mt-1 font-medium italic">{subText}</p>
            </div>
        </div>
    );
}

// ─── Section Header ───────────────────────────────────────────────────────────

function SectionHeader({ icon: Icon, label, color }: { icon: React.ElementType; label: string; color: string }) {
    return (
        <div className="flex items-center gap-3">
            <div className={cn("w-8 h-8 rounded-md flex items-center justify-center", color)}>
                <Icon className="w-4 h-4" />
            </div>
            <h2 className="text-sm font-semibold text-ink-mute uppercase tracking-eyebrow">{label}</h2>
            <div className="flex-1 h-px bg-stone" />
        </div>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function RepDashboard() {
    const { isAdmin } = useAuth();

    // Filters
    const [year, setYear] = useState(2026);
    const [selectedMonth, setSelectedMonth] = useState<number | 'Toutes'>('Toutes');
    const [selectedRep, setSelectedRep] = useState<string>('');

    // Rep list
    const [allReps, setAllReps] = useState<string[]>([]);
    const repsLoadedRef = useRef(false);

    // Devis state
    const [devisLoading, setDevisLoading] = useState(false);
    const [devisKpis, setDevisKpis] = useState<DevisKPIs | null>(null);
    const [devisGrandTotal, setDevisGrandTotal] = useState<SommaireRow[]>([]);
    const [devisPrevGrandTotal, setDevisPrevGrandTotal] = useState<SommaireRow[]>([]);

    // Factures state
    const [invLoading, setInvLoading] = useState(false);
    const [invKpis, setInvKpis] = useState<InvKPIs | null>(null);
    const [invGrandTotal, setInvGrandTotal] = useState<SommaireRow[]>([]);
    const [invPrevGrandTotal, setInvPrevGrandTotal] = useState<SommaireRow[]>([]);

    // Top clients for the rep
    interface TopClient { client_name: string; total_amount: number; deal_count: number; }
    const [topClients, setTopClients] = useState<TopClient[]>([]);
    const [showClients, setShowClients] = useState(false);

    const monthParam = selectedMonth === 'Toutes' ? null : selectedMonth;
    const repParam = selectedRep || null;

    const repTeam = useRepTeam();

    // Load rep list once. It waits for the team list: before that arrives every
    // name looks off-team, and the picker would offer billing entities.
    const loadReps = useCallback(async () => {
        if (repsLoadedRef.current || !repTeam.loaded) return;
        const { data } = await cachedRpc('get_inv_rep_leaderboard', {
            p_year: 2026, p_office: null, p_status: null,
            p_month: null, p_dept: null, p_rep: null,
        });
        if (data && data.length > 0) {
            const names = (data as LeaderboardEntry[])
                .map(r => r.rep_name)
                .filter(n => !repTeam.isInternal(n))
                .sort();
            setAllReps(names);
            if (!selectedRep) setSelectedRep(names[0] ?? '');
            repsLoadedRef.current = true;
        }
    }, [selectedRep, repTeam]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { loadReps(); }, [loadReps]);

    // Fetch devis data for rep
    const fetchDevis = useCallback(async () => {
        if (!repParam) return;
        setDevisLoading(true);
        const [
            { data: grandData },
            { data: prevGrandData },
            { data: kpiData },
        ] = await Promise.all([
            cachedRpc('get_sommaire_grand_total', { p_year: year, p_office: null, p_status: null, p_rep: repParam }),
            cachedRpc('get_sommaire_grand_total', { p_year: year - 1, p_office: null, p_status: null, p_rep: repParam }),
            cachedRpc('get_dashboard_kpis', { p_year: year, p_office: null, p_status: null, p_month: monthParam, p_dept: null, p_rep: repParam }),
        ]);
        setDevisGrandTotal(grandData || []);
        setDevisPrevGrandTotal(prevGrandData || []);
        setDevisKpis(kpiData?.[0] || null);
        setDevisLoading(false);
    }, [year, repParam, monthParam]);

    // Fetch factures data for rep
    const fetchInvoices = useCallback(async () => {
        if (!repParam) return;
        setInvLoading(true);
        const [
            { data: grandData },
            { data: prevGrandData },
            { data: kpiData },
            { data: clientData },
        ] = await Promise.all([
            cachedRpc('get_inv_sommaire_grand_total', { p_year: year, p_office: null, p_status: null, p_rep: repParam }),
            cachedRpc('get_inv_sommaire_grand_total', { p_year: year - 1, p_office: null, p_status: null, p_rep: repParam }),
            cachedRpc('get_inv_dashboard_kpis', { p_year: year, p_office: null, p_status: null, p_month: monthParam, p_dept: null, p_rep: repParam }),
            cachedRpc('get_inv_top_clients', { p_year: year, p_office: null, p_status: null, p_limit: 20, p_month: monthParam, p_dept: null, p_rep: repParam }),
        ]);
        setInvGrandTotal(grandData || []);
        setInvPrevGrandTotal(prevGrandData || []);
        setInvKpis(kpiData?.[0] || null);
        setTopClients(clientData || []);
        setInvLoading(false);
    }, [year, repParam, monthParam]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchDevis(); }, [fetchDevis]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));
    const monthOptions = [
        { value: 'Toutes', label: 'Année complète' },
        ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))
    ];

    if (!isAdmin) {
        return (
            <div className="flex items-center justify-center h-64">
                <p className="text-ink-mute text-sm">Accès réservé aux administrateurs.</p>
            </div>
        );
    }

    return (
        <>
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">

            {/* ─── Header ─── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                    {/* Rep avatar */}
                    <RepAvatar name={selectedRep} size="lg" square literal />
                    <div>
                        <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">
                            {selectedRep || 'Choisir un représentant'}
                        </h1>
                        <p className="text-xs md:text-sm text-ink-mute mt-0.5">Fiche représentant · Performance individuelle</p>
                    </div>
                </div>
                <RepPicker reps={allReps} selected={selectedRep} onChange={setSelectedRep} />
            </div>

            {/* ─── Filters ─── */}
            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select
                        value={String(selectedMonth)}
                        onChange={v => setSelectedMonth(v === 'Toutes' ? 'Toutes' : Number(v))}
                        options={monthOptions}
                        className="w-44"
                    />
                </FilterGroup>
            </FilterBar>

            {!selectedRep ? (
                <div className="flex flex-col items-center justify-center py-24 gap-3">
                    <div className="w-16 h-16 rounded-xl bg-stone flex items-center justify-center">
                        <User className="w-8 h-8 text-ink-faint" />
                    </div>
                    <p className="text-ink-mute font-medium">Sélectionnez un représentant pour voir sa fiche</p>
                </div>
            ) : (
                <>
                {/* ─── DEVIS section ─── */}
                <div className="space-y-5">
                    <SectionHeader icon={ClipboardList} label="Devis" color="bg-data-2 text-data-2-ink" />

                    {devisLoading ? (
                        <div className="flex items-center justify-center py-12 gap-2">
                            <Loader2 className="w-5 h-5 animate-spin text-ink-mute" />
                            <span className="text-sm text-ink-mute">Chargement des devis...</span>
                        </div>
                    ) : (
                        <>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <KPICard
                                title="Devis YTD"
                                value={formatCurrencyCAD(devisKpis?.ytd_total ?? 0)}
                                subText="Total cumulé (accepté + facturé)"
                                icon={TrendingUp}
                                trend={devisKpis?.pct_of_target}
                                trendLabel="de l'objectif"
                                accent
                            />
                            <KPICard
                                title="Nb Devis"
                                value={String(devisKpis?.ytd_count ?? 0)}
                                subText="Devis traités"
                                icon={ClipboardList}
                            />
                            <KPICard
                                title="Montant Moyen"
                                value={formatCurrencyCAD(devisKpis?.avg_deal_size ?? 0)}
                                subText="Par devis"
                                icon={Briefcase}
                            />
                            <KPICard
                                title="Objectif Annuel"
                                value={formatCurrencyCAD(devisKpis?.annual_target ?? 0)}
                                subText={`Facturé: ${formatCurrencyCAD(devisKpis?.invoiced_total ?? 0)} · Accepté: ${formatCurrencyCAD(devisKpis?.accepted_total ?? 0)}`}
                                icon={Target}
                            />
                        </div>

                        <SommaireTable
                            title={`Performance Devis · ${selectedRep}`}
                            data={devisGrandTotal}
                            prevYearData={devisPrevGrandTotal}
                            year={year}
                            selectedMonth={selectedMonth}
                            dealLabel="devis"
                        />
                        </>
                    )}
                </div>

                {/* ─── FACTURES section ─── */}
                <div className="space-y-5">
                    <SectionHeader icon={FileText} label="Factures" color="bg-data-3 text-data-3-ink" />

                    {invLoading ? (
                        <div className="flex items-center justify-center py-12 gap-2">
                            <Loader2 className="w-5 h-5 animate-spin text-ink-mute" />
                            <span className="text-sm text-ink-mute">Chargement des factures...</span>
                        </div>
                    ) : (
                        <>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                            <KPICard
                                title="Facturé YTD"
                                value={formatCurrencyCAD(invKpis?.ytd_total ?? 0)}
                                subText="Net après avoirs"
                                icon={TrendingUp}
                                trend={invKpis?.pct_of_target}
                                trendLabel="de l'objectif"
                                accent
                            />
                            <KPICard
                                title="Nb Factures"
                                value={String(invKpis?.ytd_count ?? 0)}
                                subText="Factures émises"
                                icon={FileText}
                            />
                            <KPICard
                                title="Montant Moyen"
                                value={formatCurrencyCAD(invKpis?.avg_deal_size ?? 0)}
                                subText="Par facture"
                                icon={Briefcase}
                            />
                        </div>

                        {/* Top clients for this rep */}
                        <div className="bg-white rounded-xl shadow-card overflow-hidden">
                            <div className="px-5 py-4 border-b border-hairline flex items-center justify-between">
                                <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                                    <Trophy className="w-4 h-4 text-ink-mute" />
                                    Top clients · {selectedRep}
                                </h3>
                                {topClients.length > 5 && (
                                    <button
                                        onClick={() => setShowClients(true)}
                                        className="flex items-center gap-1 text-2xs font-bold text-primary-press hover:text-primary-deep transition-colors"
                                    >
                                        Voir tout ({topClients.length}) <ChevronRight className="w-3 h-3" />
                                    </button>
                                )}
                            </div>
                            <div className="divide-y divide-hairline">
                                {topClients.length === 0 ? (
                                    <p className="px-5 py-4 text-sm text-ink-mute text-center">Aucun client pour ce représentant</p>
                                ) : (
                                    topClients.slice(0, 5).map((c, idx) => (
                                        <div key={c.client_name} className="px-5 py-3 flex items-center justify-between hover:bg-sand transition-colors">
                                            <div className="flex items-center gap-3">
                                                <span className="w-5 h-5 text-2xs font-bold text-ink-mute tabular-nums flex items-center justify-center shrink-0">{idx + 1}</span>
                                                <p className="text-sm font-semibold text-ink-secondary max-w-[240px] truncate" title={c.client_name}>{c.client_name}</p>
                                            </div>
                                            <div className="text-right shrink-0">
                                                <p className="text-sm font-bold text-ink">{formatCurrencyCAD(c.total_amount)}</p>
                                                <p className="text-2xs text-ink-mute">{c.deal_count} factures</p>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>

                        <SommaireTable
                            title={`Performance Factures · ${selectedRep}`}
                            data={invGrandTotal}
                            prevYearData={invPrevGrandTotal}
                            year={year}
                            selectedMonth={selectedMonth}
                            dealLabel="factures"
                        />
                        </>
                    )}
                </div>
                </>
            )}
        </div>

        {/* ─── Top clients modal ─── */}
        {showClients && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setShowClients(false)}>
                <div className="absolute inset-0 bg-ink/40 backdrop-blur-xs" />
                <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                    <div className="px-5 py-4 border-b border-hairline flex items-center justify-between shrink-0">
                        <h3 className="text-sm font-semibold text-ink">Tous les clients · {selectedRep}</h3>
                        <button onClick={() => setShowClients(false)} className="p-1.5 rounded-md text-ink-mute hover:text-ink-secondary hover:bg-stone transition-all">
                            <X className="w-4 h-4" />
                        </button>
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
                                    <tr key={c.client_name} className="hover:bg-sand/60 transition-colors">
                                        <td className="px-4 py-2.5 text-xs font-bold text-ink-mute tabular-nums">{idx + 1}</td>
                                        <td className="px-4 py-2.5 font-semibold text-ink-secondary max-w-[260px] truncate" title={c.client_name}>{c.client_name}</td>
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

// Placeholder for quarterly view - shows the BarChart2 icon nicely
export function RepPlaceholderCard({ label }: { label: string }) {
    return (
        <div className="bg-white rounded-xl shadow-card p-10 flex flex-col items-center gap-3 text-center">
            <div className="w-12 h-12 rounded-xl bg-stone flex items-center justify-center">
                <BarChart2 className="w-6 h-6 text-ink-faint" />
            </div>
            <p className="text-sm font-semibold text-ink-mute">{label}</p>
            <p className="text-xs text-ink-faint">Disponible prochainement</p>
        </div>
    );
}
