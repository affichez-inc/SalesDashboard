import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlStateNumber, useUrlList } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import { Loader2, TrendingUp, Users, Target, Briefcase, Trophy, User, FileText, X, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SommaireRow } from '../types/database';
import { SommaireTable } from '../components/dashboard/SommaireTable';
import { DEPARTMENTS, MONTHS, OFFICES, SALE_STATUSES } from '../lib/constants';
import { useRepTeam, mergeInternalRows, INTERNAL_LABEL } from '../lib/repTeam';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { MultiSelect } from '../components/MultiSelect';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { ExportButton } from '../components/ExportButton';
import type { CsvColumn } from '../lib/csv';
import { useRepFilter, REP_ALL_LABEL } from '../hooks/useRepFilter';
import { sumDepartments } from '../lib/sommaire';
import { RepAvatar, RepName } from '../components/RepAvatar';

interface DashboardKPIs {
    ytd_total: number;
    ytd_count: number;
    avg_deal_size: number;
    annual_target: number;
    pct_of_target: number;
    invoiced_total: number;
    accepted_total: number;
}

interface TopClient {
    client_name: string;
    total_amount: number;
    deal_count: number;
    office: string;
}

interface LeaderboardEntry {
    rep_name: string;
    office: string;
    total_amount: number;
    deal_count: number;
    avg_deal: number;
    rank: number;
}

// "Je veux tout le temps qu'on puisse telecharger les rapports partout"
// (2026-09-04). Both exports carry the full list, not the five rows on screen.
const CLIENT_CSV: CsvColumn<TopClient>[] = [
    { header: 'Client',  value: c => c.client_name },
    { header: 'Bureau',  value: c => c.office },
    { header: 'Devis',   value: c => c.deal_count },
    { header: 'Montant', value: c => c.total_amount },
];

const LEADERBOARD_CSV: CsvColumn<LeaderboardEntry>[] = [
    { header: 'Rang',            value: r => r.rank },
    { header: 'Representant',    value: r => r.rep_name },
    { header: 'Bureau',          value: r => r.office },
    { header: 'Devis',           value: r => r.deal_count },
    { header: 'Montant',         value: r => r.total_amount },
    { header: 'Devis moyen',     value: r => r.avg_deal },
];

export default function Dashboard() {
    const { isAdmin, repName: authRepName } = useAuth();

    const [year, setYear] = useUrlStateNumber('year', 2026);
    const [selectedOffice, setSelectedOffice] = useUrlState('office', 'Toutes');
    const [selectedStatus, setSelectedStatus] = useUrlState('status', 'Toutes');
    const [selectedDepts, setSelectedDepts] = useUrlList('dept');
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const setSelectedMonth = (v: number | 'Toutes') => _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v));
    // Admin only; a rep is pinned to their own name below, whatever the URL says.
    const [selectedReps, setSelectedReps] = useUrlList('rep');

    const [loading, setLoading] = useState(true);
    const [showLeaderboard, setShowLeaderboard] = useState(false);
    const [showClients, setShowClients] = useState(false);
    const [grandTotalData, setGrandTotalData] = useState<SommaireRow[]>([]);
    const [deptData, setDeptData] = useState<SommaireRow[]>([]);
    const [prevGrandTotalData, setPrevGrandTotalData] = useState<SommaireRow[]>([]);
    const [prevDeptData, setPrevDeptData] = useState<SommaireRow[]>([]);
    const [kpis, setKpis] = useState<DashboardKPIs | null>(null);
    const [topClients, setTopClients] = useState<TopClient[]>([]);
    const [rawLeaderboard, setRawLeaderboard] = useState<LeaderboardEntry[]>([]);
    const repTeam = useRepTeam();
    /**
     * Internal reps are one line, named Interne.
     *
     * Membership is "not on the current sales team", the same rule the rep
     * filter uses, so the leaderboard and the filter can never disagree. It is
     * recomputed here rather than when the rows are fetched because the team
     * list arrives on its own schedule.
     */
    const leaderboard = useMemo(() => mergeInternalRows(
        rawLeaderboard, repTeam, r => r.rep_name,
        r => ({ ...r, rep_name: INTERNAL_LABEL, office: '—' }),
        (acc, r) => ({
            ...acc,
            total_amount: Number(acc.total_amount) + Number(r.total_amount),
            deal_count: Number(acc.deal_count) + Number(r.deal_count),
        }),
    )
        .map(r => ({ ...r, avg_deal: Number(r.deal_count) > 0 ? Number(r.total_amount) / Number(r.deal_count) : 0 }))
        .sort((a, b) => Number(b.total_amount) - Number(a.total_amount))
        .map((r, i) => ({ ...r, rank: i + 1 })), [rawLeaderboard, repTeam]);
    /**
     * Every rep who quoted anything this year, read WITHOUT a rep filter.
     *
     * It used to be scraped out of the leaderboard this page had just loaded.
     * That was harmless only while the leaderboard ignored the rep filter; now
     * that it honours it, the scrape would feed the filter its own output -
     * pick "Interne", the leaderboard comes back holding only internal names,
     * allReps then equals the internal group, and the next render computes
     * allReps-minus-team = the same set for a different reason. One unfiltered
     * read per year keeps the two apart.
     */
    const [allReps, setAllReps] = useState<string[]>([]);

    /**
     * The rep filter. See useRepFilter - the dropdown lists the current sales
     * team by name, and everyone else (former staff, internal billing) sits
     * behind "Interne" instead of adding 20 rows nobody scrolls. Several can be
     * ticked at once.
     *
     * Three parameters, because they do different jobs:
     *   p_rep          one rep: filters rows AND selects that rep's own objective;
     *   p_reps         a list: filters rows only;
     *   p_target_reps  a list made of team members only: the objective is the
     *                  sum of theirs. Left null when "Interne" is in the
     *                  selection, which has no objective to be measured against.
     */
    const repFilter = useRepFilter(selectedReps, allReps);
    const repParam = isAdmin ? repFilter.rep : (authRepName ?? null);
    // Only an admin gets the lists; a rep is pinned to their own name, where
    // p_rep already does the right thing.
    const repsParam = isAdmin ? repFilter.reps : null;
    const targetRepsParam = isAdmin ? repFilter.targetReps : null;

    useEffect(() => {
        if (!isAdmin) return;
        let cancelled = false;
        (async () => {
            const { data } = await cachedRpc('get_rep_leaderboard', { p_year: year });
            if (cancelled || !data) return;
            const names = (data as LeaderboardEntry[]).map(r => r.rep_name).filter(Boolean);
            // 'Vente interne' is dropped by excluded_reps, so it never comes back
            // here - but it is a real biller and belongs in the Interne group.
            setAllReps([...new Set([...names, 'Vente interne'])].sort());
        })();
        return () => { cancelled = true; };
    }, [year, isAdmin]);

    const fetchData = useCallback(async () => {
        setLoading(true);
        const officeParam = selectedOffice === 'Toutes' ? null : selectedOffice;
        const statusParam = selectedStatus === 'Toutes' ? null : selectedStatus;
        const deptsParam = selectedDepts.length > 0 ? selectedDepts : null;
        const monthParam = selectedMonth === 'Toutes' ? null : selectedMonth;

        const [
            { data: grandData },
            { data: dData },
            { data: prevGrandData },
            { data: prevDData },
            { data: kpiData },
            { data: clientData },
            { data: leaderData }
        ] = await Promise.all([
            cachedRpc('get_sommaire_grand_total', { p_year: year, p_office: officeParam, p_status: statusParam, p_rep: repParam, p_reps: repsParam, p_target_reps: targetRepsParam }),
            cachedRpc('get_sommaire', { p_year: year, p_office: officeParam, p_status: statusParam, p_rep: repParam, p_reps: repsParam }),
            cachedRpc('get_sommaire_grand_total', { p_year: year - 1, p_office: officeParam, p_status: statusParam, p_rep: repParam, p_reps: repsParam, p_target_reps: targetRepsParam }),
            cachedRpc('get_sommaire', { p_year: year - 1, p_office: officeParam, p_status: statusParam, p_rep: repParam, p_reps: repsParam }),
            cachedRpc('get_dashboard_kpis', { p_year: year, p_office: officeParam, p_status: statusParam, p_month: monthParam, p_depts: deptsParam, p_rep: repParam, p_reps: repsParam, p_target_reps: targetRepsParam }),
            cachedRpc('get_top_clients', { p_year: year, p_office: officeParam, p_status: statusParam, p_limit: 200, p_month: monthParam, p_depts: deptsParam, p_rep: repParam, p_reps: repsParam }),
            cachedRpc('get_rep_leaderboard', { p_year: year, p_office: officeParam, p_status: statusParam, p_month: monthParam, p_depts: deptsParam, p_rep: repParam, p_reps: repsParam })
        ]);

        setGrandTotalData(grandData || []);
        setDeptData(dData || []);
        setPrevGrandTotalData(prevGrandData || []);
        setPrevDeptData(prevDData || []);
        setKpis(kpiData?.[0] || null);
        setTopClients(clientData || []);

        setRawLeaderboard((leaderData as LeaderboardEntry[]) || []);
        setLoading(false);
    }, [year, selectedOffice, selectedStatus, selectedDepts, selectedMonth, repParam, repsParam, targetRepsParam]);

    // Always keep a current reference so the Realtime callback never goes stale
    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);

    // Re-fetch whenever filters change
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchData(); }, [fetchData]);

    // Realtime subscription - set up once, always calls the latest fetchData via ref
    useEffect(() => {
        const sub = supabase
            .channel('db-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => { invalidateRpcCache(); fetchDataRef.current(); })
            .subscribe();
        return () => { supabase.removeChannel(sub); };
    }, []);

    const officeOptions = useMemo(() => [{ value: 'Toutes', label: 'Tout le réseau' }, ...OFFICES], []);
    const statusOptions = useMemo(() => [{ value: 'Toutes', label: 'Tous les devis' }, ...SALE_STATUSES], []);
    const deptOptions = useMemo(() => DEPARTMENTS.map(d => ({ value: d as string, label: d as string })), []);
    const monthOptions = useMemo(() => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))], []);

    // objectives is keyed (year, month, department) with no office dimension, so
    // an office-filtered view has no target to be measured against and the RPC
    // returns 0. Show "—", not 0 % — see STATS-INTEGRITY.md.
    const hasTarget = Number(kpis?.annual_target ?? 0) > 0;
    const repOptions = repFilter.options;
    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    return (
        <>
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            {/* Header */}
            <div>
                <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">
                    Tableau de Bord
                    {!isAdmin && authRepName && <span className="ml-2 text-base font-normal text-ink-mute">({authRepName})</span>}
                </h1>
                <p className="text-xs md:text-sm text-ink-mute mt-0.5">Performance et indicateurs clés de vente</p>
            </div>

            {/* Combined Filter Bar */}
            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={(val) => setYear(Number(val))} options={yearOptions} variant="accent" className="w-28" />
                </FilterGroup>
                <FilterGroup label="Siège">
                    <Select value={selectedOffice} onChange={setSelectedOffice} options={officeOptions} className="w-44" />
                </FilterGroup>
                <FilterGroup label="Statut">
                    <Select value={selectedStatus} onChange={setSelectedStatus} options={statusOptions} className="w-40" />
                </FilterGroup>
                <FilterGroup label="Département">
                    <MultiSelect values={selectedDepts} onChange={setSelectedDepts} options={deptOptions}
                                 allLabel="Tous services" className="w-48" />
                </FilterGroup>
                <FilterGroup label="Mois">
                    <Select value={String(selectedMonth)} onChange={(val) => setSelectedMonth(val === 'Toutes' ? 'Toutes' : Number(val))} options={monthOptions} className="w-40" />
                </FilterGroup>
                {isAdmin && (
                    <FilterGroup label="Représentant">
                        <MultiSelect values={repFilter.selected} onChange={setSelectedReps} options={repOptions}
                                     allLabel={REP_ALL_LABEL} allIcon={repFilter.allIcon} className="w-48" />
                    </FilterGroup>
                )}
            </FilterBar>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-press" />
                    <p className="text-sm text-ink-mute font-medium">Analyse des données en cours...</p>
                </div>
            ) : (
                <>
                    {/* KPI Grid */}
                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 md:gap-4">
                        {/* trend only when a target exists for this scope: 0 % would read
                            as zero attainment rather than "rien à comparer". */}
                        <KPICard
                            title="Total Devis YTD"
                            value={formatCurrencyCAD(kpis?.ytd_total || 0)}
                            subText="Revenus cumulés"
                            icon={TrendingUp}
                            trend={hasTarget ? kpis?.pct_of_target : undefined}
                        />
                        <KPICard
                            title="Total Devis"
                            value={String(kpis?.ytd_count || 0)}
                            subText="Devis conclus (filtres)"
                            icon={FileText}
                        />
                        <KPICard
                            title="Vente moyenne"
                            value={formatCurrencyCAD(kpis?.avg_deal_size || 0)}
                            subText="Par transaction"
                            icon={Briefcase}
                        />
                        <KPICard
                            title="Objectif Annuel"
                            value={hasTarget ? formatCurrencyCAD(kpis!.annual_target) : '—'}
                            subText={hasTarget ? "Planifié pour l'année" : 'Aucun objectif pour ce filtre'}
                            icon={Target}
                        />
                        <KPICard
                            title="Répartition Statut"
                            value={formatCurrencyCAD(kpis?.invoiced_total || 0)}
                            subValue={formatCurrencyCAD(kpis?.accepted_total || 0)}
                            subText="Facturé vs Accepté"
                            icon={Users}
                            dual
                        />
                    </div>

                    {/* Detailed Insights Section */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
                        {/* Leaderboard */}
                        <div className="bg-white rounded-xl shadow-card overflow-hidden">
                            <div className="px-5 py-4 border-b border-hairline flex items-center justify-between">
                                <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                                    <Trophy className="w-4 h-4 text-ink-mute" /> Leaderboard Reps
                                </h3>
                                <div className="flex items-center gap-2">
                                    <ExportButton rows={leaderboard} columns={LEADERBOARD_CSV}
                                                  filename="leaderboard_reps_devis" disabled={leaderboard.length === 0} label="CSV" />
                                    {leaderboard.length > 5 && (
                                        <button onClick={() => setShowLeaderboard(true)} className="flex items-center gap-1 text-2xs font-bold text-primary-press hover:text-primary-deep transition-colors">
                                            Voir tout ({leaderboard.length}) <ChevronRight className="w-3 h-3" />
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div className="divide-y divide-hairline">
                                {leaderboard.slice(0, 5).map((rep, idx) => (
                                    <div key={rep.rep_name} className="px-5 py-3 flex items-center justify-between hover:bg-sand transition-colors">
                                        <div className="flex items-center gap-3">
                                            <span className={cn(
                                                "w-6 h-6 rounded-full flex items-center justify-center text-2xs font-bold",
                                                idx === 0 ? "bg-ink text-white" : "bg-stone text-ink-secondary"
                                            )}>
                                                {idx + 1}
                                            </span>
                                            <RepAvatar name={rep.rep_name} size="md" />
                                            <div className="min-w-0">
                                                <p className="text-sm font-semibold text-ink-secondary truncate">{rep.rep_name}</p>
                                                <p className="text-2xs text-ink-mute uppercase font-semibold">{rep.office}</p>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-bold text-ink">{formatCurrencyCAD(rep.total_amount)}</p>
                                            <p className="text-sm font-bold text-ink-mute tabular-nums">{rep.deal_count} <span className="text-2xs font-normal text-ink-mute">devis</span></p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Top Clients */}
                        <div className="bg-white rounded-xl shadow-card overflow-hidden">
                            <div className="px-5 py-4 border-b border-hairline flex items-center justify-between">
                                <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                                    <User className="w-4 h-4 text-ink-mute" /> Top 5 Clients
                                </h3>
                                <div className="flex items-center gap-2">
                                    <ExportButton rows={topClients} columns={CLIENT_CSV}
                                                  filename="top_clients_devis" disabled={topClients.length === 0} label="CSV" />
                                    {topClients.length > 5 && (
                                        <button onClick={() => setShowClients(true)} className="flex items-center gap-1 text-2xs font-bold text-primary-press hover:text-primary-deep transition-colors">
                                            Voir tout ({topClients.length}) <ChevronRight className="w-3 h-3" />
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div className="divide-y divide-hairline">
                                {topClients.slice(0, 5).map((c) => (
                                    <div key={c.client_name} className="px-5 py-3 flex items-center justify-between hover:bg-sand transition-colors">
                                        <div className="max-w-[200px]">
                                            <p className="text-sm font-semibold text-ink-secondary truncate" title={c.client_name}>{c.client_name}</p>
                                            <p className="text-2xs text-ink-mute uppercase font-semibold">{c.office}</p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-bold text-ink">{formatCurrencyCAD(c.total_amount)}</p>
                                            <p className="text-sm font-bold text-ink-mute tabular-nums">{c.deal_count} <span className="text-2xs font-normal text-ink-mute">devis</span></p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Main Performance Table */}
                    <div className="space-y-6">
                        <SommaireTable
                            title={selectedDepts.length === 0 ? "Performance Globale" : `Performance · ${selectedDepts.join(', ')}`}
                            data={selectedDepts.length === 0 ? grandTotalData : sumDepartments(deptData, selectedDepts)}
                            prevYearData={selectedDepts.length === 0 ? prevGrandTotalData : sumDepartments(prevDeptData, selectedDepts)}
                            year={year}
                            selectedMonth={selectedMonth}
                        />
                    </div>
                </>
            )}
        </div>

        {/* Leaderboard Modal */}
        {showLeaderboard && (
            <Modal title="Leaderboard Reps" onClose={() => setShowLeaderboard(false)}>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hairline bg-sand/50">
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">#</th>
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Représentant</th>
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Siège</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Total</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Devis</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Moy./devis</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {leaderboard.map((rep, idx) => (
                            <tr key={rep.rep_name} className="hover:bg-sand/60 transition-colors">
                                <td className="px-4 py-2.5">
                                    <span className={cn(
                                        "w-6 h-6 rounded-full flex items-center justify-center text-2xs font-bold",
                                        idx === 0 ? "bg-ink text-white" : idx === 1 ? "bg-stone text-ink-secondary" : idx === 2 ? "bg-sand text-ink-mute" : "bg-sand text-ink-faint"
                                    )}>{idx + 1}</span>
                                </td>
                                <td className="px-4 py-2.5 font-semibold text-ink-secondary">
                                    <RepName name={rep.rep_name} size="sm" />
                                </td>
                                <td className="px-4 py-2.5 text-2xs font-semibold text-ink-mute uppercase">{rep.office}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums">{formatCurrencyCAD(rep.total_amount)}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-ink-mute tabular-nums">{rep.deal_count}</td>
                                <td className="px-4 py-2.5 text-right text-ink-mute tabular-nums text-xs">{formatCurrencyCAD(rep.avg_deal)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </Modal>
        )}

        {/* Top Clients Modal */}
        {showClients && (
            <Modal title="Tous les clients" onClose={() => setShowClients(false)}>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hairline bg-sand/50">
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">#</th>
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Client</th>
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Siège</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Total</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Devis</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {topClients.map((c, idx) => (
                            <tr key={c.client_name} className="hover:bg-sand/60 transition-colors">
                                <td className="px-4 py-2.5 text-xs font-bold text-ink-mute tabular-nums">{idx + 1}</td>
                                <td className="px-4 py-2.5 font-semibold text-ink-secondary max-w-[240px] truncate" title={c.client_name}>{c.client_name}</td>
                                <td className="px-4 py-2.5 text-2xs font-semibold text-ink-mute uppercase">{c.office}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums">{formatCurrencyCAD(c.total_amount)}</td>
                                <td className="px-4 py-2.5 text-right font-bold text-ink-mute tabular-nums">{c.deal_count}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </Modal>
        )}
        </>
    );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
            <div className="absolute inset-0 bg-ink/40 backdrop-blur-xs" />
            <div
                className="relative bg-white rounded-xl shadow-2xl w-full max-w-[calc(100vw-2rem)] md:max-w-4xl max-h-[80vh] flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                <div className="px-5 py-4 border-b border-hairline flex items-center justify-between shrink-0">
                    <h3 className="text-sm font-semibold text-ink">{title}</h3>
                    <button onClick={onClose} className="p-1.5 rounded-md text-ink-mute hover:text-ink-secondary hover:bg-stone transition-all">
                        <X className="w-4 h-4" />
                    </button>
                </div>
                <div className="overflow-y-auto overflow-x-auto">
                    {children}
                </div>
            </div>
        </div>
    );
}

interface KPICardProps {
    title: string;
    value: string;
    /** The second figure of a `dual` card. */
    subValue?: string;
    subText: string;
    icon: LucideIcon;
    /** Percent of target, shown as a badge. */
    trend?: number;
    dual?: boolean;
}

function KPICard({ title, value, subValue, subText, icon: Icon, trend, dual }: KPICardProps) {
    return (
        <div className="bg-white p-3 md:p-5 rounded-xl shadow-card flex flex-col justify-between hover:shadow-elevated transition-all group">
            <div className="flex items-start justify-between mb-2 md:mb-4">
                <div className="p-2 md:p-2.5 bg-sand rounded-md text-ink-mute group-hover:text-primary-press group-hover:bg-primary-wash transition-colors">
                    <Icon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                {trend !== undefined && (
                    <div className={cn(
                        "text-2xs font-bold px-1.5 md:px-2 py-0.5 rounded-full",
                        trend >= 100 ? "bg-tone-good-soft text-tone-good-ink" : "bg-tone-warn-soft text-tone-warn-ink"
                    )}>
                        {trend}%
                    </div>
                )}
            </div>
            <div>
                <p className="text-2xs md:text-xs font-semibold text-ink-mute uppercase tracking-eyebrow leading-tight">{title}</p>
                <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-base md:text-2xl font-bold text-ink tabular-nums">{value}</span>
                </div>
                {dual && subValue && (
                    <div className="mt-0.5 flex flex-col md:flex-row items-start md:items-center gap-0.5 md:gap-2 text-2xs font-bold">
                        <span className="text-tone-good">I : {value}</span>
                        <span className="hidden md:inline text-ink-faint">|</span>
                        <span className="text-ink-secondary">A : {subValue}</span>
                    </div>
                )}
                <p className="text-2xs text-ink-mute mt-0.5 md:mt-1 font-medium italic">{subText}</p>
            </div>
        </div>
    );
}
