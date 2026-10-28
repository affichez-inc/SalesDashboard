import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlStateNumber, useUrlList } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import { Loader2, TrendingUp, Target, Briefcase, Trophy, User, FileText, X, ChevronRight, Unlink } from 'lucide-react';
import type { SommaireRow, InvoiceUnassignedSummary, UnassignedInvoiceRow } from '../types/database';
import { SommaireTable } from '../components/dashboard/SommaireTable';
import { DEPARTMENTS, MONTHS, OFFICES, INVOICE_STATUSES } from '../lib/constants';
import { useRepTeam, mergeInternalRows, INTERNAL_LABEL } from '../lib/repTeam';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { MultiSelect } from '../components/MultiSelect';
import { formatCurrencyCAD, formatShortDate, cn } from '../lib/utils';
import { InfoHint } from '../components/InfoHint';
import { useRepFilter, REP_ALL_LABEL } from '../hooks/useRepFilter';
import { sumDepartments } from '../lib/sommaire';
import { ExportButton } from '../components/ExportButton';
import type { CsvColumn } from '../lib/csv';
import { useAuth } from '../contexts/AuthContext';
import { RepAvatar, RepName } from '../components/RepAvatar';

interface InvDashboardKPIs {
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

// Asked for directly in the 2026-09-04 meeting: "je veux tout le temps qu'on
// puisse telecharger les rapports partout". The export always carries the FULL
// list behind each card, not the five rows the card shows.
const CLIENT_CSV: CsvColumn<TopClient>[] = [
    { header: 'Client',   value: c => c.client_name },
    { header: 'Bureau',   value: c => c.office },
    { header: 'Factures', value: c => c.deal_count },
    { header: 'Montant',  value: c => c.total_amount },
];
interface LeaderboardEntry { rep_name: string; office: string; total_amount: number; deal_count: number; avg_deal: number; rank: number; }

const LEADERBOARD_CSV: CsvColumn<LeaderboardEntry>[] = [
    { header: 'Rang',              value: r => r.rank },
    { header: 'Representant',      value: r => r.rep_name },
    { header: 'Bureau',            value: r => r.office },
    { header: 'Factures',          value: r => r.deal_count },
    { header: 'Montant',           value: r => r.total_amount },
    { header: 'Facture moyenne',   value: r => r.avg_deal },
];

export default function FDashboard() {
    const { isAdmin, repName: authRepName } = useAuth();

    const [year, setYear] = useUrlStateNumber('year', 2026);
    const [selectedOffice, setSelectedOffice] = useUrlState('office', 'Toutes');
    const [selectedStatuses, setSelectedStatuses] = useUrlList('status');
    const [selectedDepts, setSelectedDepts] = useUrlList('dept');
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const setSelectedMonth = (v: number | 'Toutes') => _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v));
    // Admin can switch reps; members are locked to their own rep, whatever the URL says.
    const [selectedReps, setSelectedReps] = useUrlList('rep');

    const [loading, setLoading] = useState(true);
    const [showLeaderboard, setShowLeaderboard] = useState(false);
    const [showClients, setShowClients] = useState(false);
    const [grandTotalData, setGrandTotalData] = useState<SommaireRow[]>([]);
    // The selected departments as one row per month. Empty while none is selected.
    const [deptData, setDeptData] = useState<SommaireRow[]>([]);
    const [prevGrandTotalData, setPrevGrandTotalData] = useState<SommaireRow[]>([]);
    const [prevDeptData, setPrevDeptData] = useState<SommaireRow[]>([]);
    const [kpis, setKpis] = useState<InvDashboardKPIs | null>(null);
    // Billing the app cannot tie to a CRM account, so it never reaches a lead.
    const [unassigned, setUnassigned] = useState<InvoiceUnassignedSummary | null>(null);
    const [showUnassigned, setShowUnassigned] = useState(false);
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
     * Every rep who billed anything this year, fetched WITHOUT a rep filter.
     *
     * It used to be scraped out of the leaderboard the page had just loaded,
     * which fed the filter its own output: choosing "Équipe entière" narrowed the
     * leaderboard to the team, allReps then held only the team, "Interne"
     * computed allReps-minus-team = nothing, and an empty group falls back to no
     * filter - so Interne silently showed EVERYONE, with a higher total than the
     * team it was supposed to be a subset of.
     *
     * One unfiltered read per year breaks the loop.
     */
    const [allReps, setAllReps] = useState<string[]>([]);

    /**
     * The rep filter. The dropdown lists the sales team by name plus "Interne"
     * (everybody else), and several can be ticked at once.
     *
     * Three parameters, because they do different jobs on these functions:
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
            const { data } = await cachedRpc('get_inv_rep_leaderboard', { p_year: year });
            if (cancelled || !data) return;
            const names = (data as LeaderboardEntry[])
                .map(r => r.rep_name).filter(Boolean);
            // 'Vente interne' is dropped from the RPC by excluded_reps, so it
            // would never appear here - but it is a real biller and belongs in
            // the Interne group, so it is added back by name.
            const withInternal = [...new Set([...names, 'Vente interne'])].sort();
            setAllReps(withInternal);
        })();
        return () => { cancelled = true; };
    }, [year, isAdmin]);

    const fetchData = useCallback(async () => {
        setLoading(true);
        const officeParam = selectedOffice === 'Toutes' ? null : selectedOffice;
        const statusesParam = selectedStatuses.length > 0 ? selectedStatuses : null;
        const deptsParam = selectedDepts.length > 0 ? selectedDepts : null;
        const monthParam = selectedMonth === 'Toutes' ? null : selectedMonth;

        const { data: excludedClientData } = await supabase.from('excluded_clients').select('client_name');
        const excludedClients = (excludedClientData ?? []).map((r: { client_name: string }) => r.client_name);

        const [
            { data: grandData },
            { data: dData },
            { data: prevGrandData },
            { data: prevDData },
            { data: kpiData },
            { data: clientData },
            { data: leaderData },
            { data: unassignedData }
        ] = await Promise.all([
            cachedRpc('get_inv_sommaire_grand_total', { p_year: year, p_office: officeParam, p_statuses: statusesParam, p_rep: repParam, p_reps: repsParam, p_target_reps: targetRepsParam }),
            cachedRpc('get_inv_sommaire', { p_year: year, p_office: officeParam, p_statuses: statusesParam, p_rep: repParam, p_reps: repsParam }),
            cachedRpc('get_inv_sommaire_grand_total', { p_year: year - 1, p_office: officeParam, p_statuses: statusesParam, p_rep: repParam, p_reps: repsParam, p_target_reps: targetRepsParam }),
            cachedRpc('get_inv_sommaire', { p_year: year - 1, p_office: officeParam, p_statuses: statusesParam, p_rep: repParam, p_reps: repsParam }),
            cachedRpc('get_inv_dashboard_kpis', { p_year: year, p_office: officeParam, p_statuses: statusesParam, p_month: monthParam, p_depts: deptsParam, p_rep: repParam, p_reps: repsParam, p_target_reps: targetRepsParam }),
            cachedRpc('get_inv_top_clients', { p_year: year, p_office: officeParam, p_statuses: statusesParam, p_limit: 200, p_month: monthParam, p_depts: deptsParam, p_rep: repParam, p_reps: repsParam }),
            cachedRpc('get_inv_rep_leaderboard', { p_year: year, p_office: officeParam, p_statuses: statusesParam, p_month: monthParam, p_depts: deptsParam, p_rep: repParam, p_reps: repsParam }),
            // No status filter: an invoice is unattributed regardless of whether it is paid.
            cachedRpc('get_invoice_unassigned_summary', { p_year: year, p_office: officeParam, p_month: monthParam, p_depts: deptsParam, p_rep: repParam, p_reps: repsParam })
        ]);

        setUnassigned((unassignedData as InvoiceUnassignedSummary[])?.[0] ?? null);

        setTopClients(clientData || []);

        // Kept for the unfiltered view only. With a group or a single rep the
        // RPCs now reach every name themselves - p_reps stands the excluded_reps
        // guard down - so running this as well would double-count Vente interne.
        if (repParam === null && repsParam === null) {
            // Supplementary query ONLY for 'Vente interne' - the one rep actually excluded from RPC results
            // (Simon, Magasin, Charles, Pier-Alexandre are already in the RPC numbers; fetching them again would double-count)
            const buildIntQuery = (y: number) => {
                let q = supabase
                    .from('invoices')
                    .select('invoice_date, amount, is_avoir')
                    .eq('rep_name', 'Vente interne')
                    .gte('invoice_date', `${y}-01-01`)
                    .lt('invoice_date', `${y + 1}-01-01`);
                excludedClients.forEach((c: string) => { q = q.neq('client_name', c); });
                if (officeParam) q = q.eq('office', officeParam);
                if (statusesParam) q = q.in('status', statusesParam);
                if (deptsParam)    q = q.in('department', deptsParam);
                if (monthParam) {
                    const nm = monthParam === 12 ? 1 : monthParam + 1;
                    const ny2 = monthParam === 12 ? y + 1 : y;
                    const ms = String(monthParam).padStart(2, '0');
                    const me = `${ny2}-${String(nm).padStart(2, '0')}-01`;
                    q = q.gte('invoice_date', `${y}-${ms}-01`).lt('invoice_date', me);
                }
                return q;
            };

            const [{ data: intData }, { data: intPrevData }] = await Promise.all([
                buildIntQuery(year),
                buildIntQuery(year - 1),
            ]);

            // Aggregate invoice rows into a month → {amount, count} map
            const aggByMonth = (rows: { invoice_date: string; amount: number; is_avoir: boolean }[]): Map<number, { amount: number; count: number }> => {
                const map = new Map<number, { amount: number; count: number }>();
                for (const r of (rows || [])) {
                    const m = parseInt(r.invoice_date.split('-')[1], 10);
                    const cur = map.get(m) || { amount: 0, count: 0 };
                    cur.amount += Number(r.amount);
                    if (!r.is_avoir) cur.count++;
                    map.set(m, cur);
                }
                return map;
            };

            const intMonthly     = aggByMonth(intData     || []);
            const intPrevMonthly = aggByMonth(intPrevData || []);

            // Merge a month-map into an array of SommaireRows (adds amounts + deal counts)
            const mergeInto = (base: SommaireRow[], extra: Map<number, { amount: number; count: number }>): SommaireRow[] => {
                const result: SommaireRow[] = (base || []).map(r => {
                    const ex = extra.get(r.month);
                    if (!ex) return r;
                    const newAmt = r.actual_amount + ex.amount;
                    return {
                        ...r,
                        actual_amount: newAmt,
                        deal_count: r.deal_count + ex.count,
                        pct_atteint: r.objectif > 0 ? (newAmt / r.objectif) * 100 : 0,
                    };
                });
                // Months present in extra but not in base
                for (const [m, ex] of extra) {
                    if (!result.find(r => r.month === m)) {
                        result.push({ month: m, objectif: 0, actual_amount: ex.amount, pct_atteint: 0, deal_count: ex.count });
                    }
                }
                return result;
            };

            setGrandTotalData(mergeInto(grandData || [], intMonthly));
            setPrevGrandTotalData(mergeInto(prevGrandData || [], intPrevMonthly));

            // The selected departments, one row per month. intMonthly was read with
            // the same department filter, so it merges in by month alone.
            if (deptsParam) {
                setDeptData(mergeInto(sumDepartments(dData || [], deptsParam), intMonthly));
                setPrevDeptData(mergeInto(sumDepartments(prevDData || [], deptsParam), intPrevMonthly));
            } else {
                setDeptData([]);
                setPrevDeptData([]);
            }

            // KPI adjustment
            const intYtdTotal = [...intMonthly.values()].reduce((s, v) => s + v.amount, 0);
            const intYtdCount = [...intMonthly.values()].reduce((s, v) => s + v.count, 0);
            const baseKpi = kpiData?.[0] ?? null;
            if (baseKpi) {
                const newTotal = baseKpi.ytd_total + intYtdTotal;
                const newCount = baseKpi.ytd_count + intYtdCount;
                setKpis({
                    ...baseKpi,
                    ytd_total: newTotal,
                    ytd_count: newCount,
                    avg_deal_size: newCount > 0 ? newTotal / newCount : 0,
                    pct_of_target: baseKpi.annual_target > 0 ? Math.round((newTotal / baseKpi.annual_target) * 100) : 0,
                });
            } else {
                setKpis(null);
            }

            // 'Vente interne' is the one name excluded at DB level, so it is
            // added back as its own row and folded into Interne with the rest.
            const suppTotal = [...intMonthly.values()].reduce((s, v) => s + v.amount, 0);
            const suppCount = [...intMonthly.values()].reduce((s, v) => s + v.count, 0);
            setRawLeaderboard((suppTotal !== 0 || suppCount !== 0)
                ? [...((leaderData as LeaderboardEntry[]) || []), { rep_name: 'Vente interne', office: '—', total_amount: suppTotal, deal_count: suppCount, avg_deal: suppCount > 0 ? suppTotal / suppCount : 0, rank: 0 }]
                : ((leaderData as LeaderboardEntry[]) || []));
        } else {
            setGrandTotalData(grandData || []);
            setDeptData(deptsParam ? sumDepartments(dData || [], deptsParam) : []);
            setPrevGrandTotalData(prevGrandData || []);
            setPrevDeptData(deptsParam ? sumDepartments(prevDData || [], deptsParam) : []);
            setKpis(kpiData?.[0] || null);
            setRawLeaderboard((leaderData as LeaderboardEntry[]) || []);
        }

        setLoading(false);
    }, [year, selectedOffice, selectedStatuses, selectedDepts, selectedMonth, repParam, repsParam, targetRepsParam]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchData(); }, [fetchData]);
    useEffect(() => {
        // Debounce realtime reloads: batch upserts fire many events in quick
        // succession - wait 3s of silence before re-fetching so the page doesn't
        // thrash while a sync is running.
        let timer: ReturnType<typeof setTimeout>;
        const sub = supabase.channel('inv-db-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, () => {
                clearTimeout(timer);
                timer = setTimeout(() => { invalidateRpcCache(); fetchDataRef.current(); }, 3000);
            })
            .subscribe();
        return () => { clearTimeout(timer); supabase.removeChannel(sub); };
    }, []);

    const officeOptions = useMemo(() => [{ value: 'Toutes', label: 'Tout le réseau' }, ...OFFICES], []);
    const statusOptions = useMemo(() => INVOICE_STATUSES.map(s => ({ value: s.value as string, label: s.label as string })), []);
    const deptOptions = useMemo(() => DEPARTMENTS.map(d => ({ value: d as string, label: d as string })), []);
    const monthOptions = useMemo(() => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))], []);
    // "Interne" first, then the team by name - from the shared hook, so the
    // Factures and Comptes pages offer exactly the same choices.
    const repOptions = repFilter.options;
    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    // objectives_factures is keyed (year, month, department) with no office
    // dimension, so an office-filtered view has no target to be measured against
    // and the RPC returns 0. Show "—", not 0 % — see STATS-INTEGRITY.md.
    const hasTarget = Number(kpis?.annual_target ?? 0) > 0;

    return (
        <>
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div>
                <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">
                    Factures · Tableau de Bord
                    {!isAdmin && authRepName && <span className="ml-2 text-base font-normal text-ink-mute">({authRepName})</span>}
                </h1>
                <p className="text-xs md:text-sm text-ink-mute mt-0.5">Performance de facturation et indicateurs clés</p>
            </div>

            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={(val) => setYear(Number(val))} options={yearOptions} variant="accent" className="w-28" />
                </FilterGroup>
                <FilterGroup label="Siège">
                    <Select value={selectedOffice} onChange={setSelectedOffice} options={officeOptions} className="w-44" />
                </FilterGroup>
                <FilterGroup label="Statut">
                    <MultiSelect values={selectedStatuses} onChange={setSelectedStatuses} options={statusOptions}
                                 allLabel="Tous les statuts" className="w-44" />
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
                    <p className="text-sm text-ink-mute font-medium">Analyse des factures en cours...</p>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                        {/* trend and target only when one exists for this scope: 0 % would
                            read as zero attainment rather than "rien à comparer". */}
                        <KPICard title="Total Facturé YTD" value={formatCurrencyCAD(kpis?.ytd_total || 0)} subText="Net après avoirs" icon={TrendingUp} trend={hasTarget ? kpis?.pct_of_target : undefined} />
                        <KPICard title="Nb Factures" value={String(kpis?.ytd_count || 0)} subText="Factures (filtres actifs)" icon={FileText} />
                        <KPICard title="Montant Moyen" value={formatCurrencyCAD(kpis?.avg_deal_size || 0)} subText="Par facture" icon={Briefcase} />
                        <KPICard title="Objectif Annuel" value={hasTarget ? formatCurrencyCAD(kpis!.annual_target) : '—'} subText={hasTarget ? "Planifié pour l'année" : 'Aucun objectif pour ce filtre'} icon={Target} />
                    </div>

                    {/* Attribution quality. Shown whenever there is anything to report so a
                        growing gap is noticed here rather than in a reconciliation later. */}
                    {unassigned && (unassigned.unassigned_count > 0 || unassigned.internal_count > 0) && (
                        <UnassignedCard data={unassigned} onOpen={() => setShowUnassigned(true)} />
                    )}

                    {showUnassigned && (
                        <UnassignedModal
                            year={year}
                            office={selectedOffice === 'Toutes' ? null : selectedOffice}
                            month={selectedMonth === 'Toutes' ? null : selectedMonth}
                            depts={selectedDepts.length > 0 ? selectedDepts : null}
                            rep={repParam}
                            reps={repsParam}
                            onClose={() => setShowUnassigned(false)}
                        />
                    )}

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
                        {/* Leaderboard */}
                        <div className="bg-white rounded-xl shadow-card overflow-hidden">
                            <div className="px-5 py-4 border-b border-hairline flex items-center justify-between">
                                <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                                    <Trophy className="w-4 h-4 text-ink-mute" /> Leaderboard Reps
                                </h3>
                                <div className="flex items-center gap-2">
                                    <ExportButton rows={leaderboard} columns={LEADERBOARD_CSV}
                                                  filename="leaderboard_reps_factures" disabled={leaderboard.length === 0} label="CSV" />
                                    {leaderboard.length > 5 && (
                                        <button onClick={() => setShowLeaderboard(true)} className="flex items-center gap-1 text-2xs font-bold text-primary-press hover:text-primary-deep transition-colors">
                                            Voir tout ({leaderboard.length}) <ChevronRight className="w-3 h-3" />
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div className="divide-y divide-hairline">
                                {(() => {
                                    return leaderboard.slice(0, 5).map((rep, idx) => (
                                        <div key={rep.rep_name} className="px-5 py-3 flex items-center justify-between hover:bg-sand transition-colors">
                                            <div className="flex items-center gap-3">
                                                <span className={cn(
                                                    "w-6 h-6 rounded-full flex items-center justify-center text-2xs font-bold",
                                                    idx === 0 ? "bg-ink text-white" : "bg-stone text-ink-secondary"
                                                )}>{idx + 1}</span>
                                                <RepAvatar name={rep.rep_name} size="md" />
                                                <div className="min-w-0">
                                                    <p className="text-sm font-semibold text-ink-secondary truncate">{rep.rep_name}</p>
                                                    <p className="text-2xs text-ink-mute uppercase font-semibold">{rep.office}</p>
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <p className="text-sm font-bold text-ink">{formatCurrencyCAD(rep.total_amount)}</p>
                                                <p className="text-sm font-bold text-ink-mute tabular-nums">{rep.deal_count} <span className="text-2xs font-normal text-ink-mute">factures</span></p>
                                            </div>
                                        </div>
                                    ));
                                })()}
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
                                                  filename="top_clients_factures" disabled={topClients.length === 0} label="CSV" />
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
                                            <p className="text-sm font-bold text-ink-mute tabular-nums">{c.deal_count} <span className="text-2xs font-normal text-ink-mute">factures</span></p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="space-y-6">
                        <SommaireTable
                            title={selectedDepts.length === 0 ? "Performance Globale · Factures" : `Performance · ${selectedDepts.join(', ')}`}
                            data={selectedDepts.length === 0 ? grandTotalData : deptData}
                            prevYearData={selectedDepts.length === 0 ? prevGrandTotalData : prevDeptData}
                            year={year}
                            selectedMonth={selectedMonth}
                            dealLabel="factures"
                        />
                    </div>
                </>
            )}
        </div>

        {showLeaderboard && (
            <Modal title="Leaderboard Reps · Factures" onClose={() => setShowLeaderboard(false)}>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hairline bg-sand/50">
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">#</th>
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Représentant</th>
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Siège</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Total</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Factures</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Moy./facture</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {leaderboard.map((rep, idx) => (
                            <tr key={rep.rep_name} className="hover:bg-sand/60 transition-colors">
                                <td className="px-4 py-2.5"><span className={cn("w-6 h-6 rounded-full flex items-center justify-center text-2xs font-bold", idx === 0 ? "bg-ink text-white" : idx === 1 ? "bg-stone text-ink-secondary" : idx === 2 ? "bg-sand text-ink-mute" : "bg-sand text-ink-faint")}>{idx + 1}</span></td>
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

        {showClients && (
            <Modal title="Tous les clients · Factures" onClose={() => setShowClients(false)}>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hairline bg-sand/50">
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">#</th>
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Client</th>
                            <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Siège</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Total</th>
                            <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Factures</th>
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
            <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-[calc(100vw-2rem)] md:max-w-4xl max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="px-5 py-4 border-b border-hairline flex items-center justify-between shrink-0">
                    <h3 className="text-sm font-semibold text-ink">{title}</h3>
                    <button onClick={onClose} className="p-1.5 rounded-md text-ink-mute hover:text-ink-secondary hover:bg-stone transition-all"><X className="w-4 h-4" /></button>
                </div>
                <div className="overflow-y-auto">{children}</div>
            </div>
        </div>
    );
}

/**
 * Invoicing with no CRM account behind it. Those invoices are real money that the
 * Leads view cannot attribute to anyone, so the figure belongs next to the totals
 * rather than in a report nobody opens.
 *
 * Internal billing is reported apart from the gap: the company invoices itself,
 * and that will never have a CRM account, so folding it in would have made the
 * number look four times worse than it is.
 */
function UnassignedCard({ data, onOpen }: {
    data: InvoiceUnassignedSummary;
    onOpen: () => void;
}) {
    return (
        <div className="bg-white rounded-xl shadow-card px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-start gap-3">
                    <div className="p-2 bg-sand rounded-md text-ink-mute">
                        <Unlink className="w-4 h-4" />
                    </div>
                    <div>
                        <div className="flex items-center gap-1.5">
                            <p className="text-2xs md:text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">
                                Factures non attribuées
                            </p>
                            <InfoHint text={
                                "Factures dont le client Zoho Books n'est reli\u00e9 \u00e0 aucun compte Zoho CRM. " +
                                "Elles sont bien compt\u00e9es dans le total factur\u00e9, mais n'apparaissent sur " +
                                "la fiche d'aucun lead ni d'aucun contact. La facturation interne (Affichez Inc. " +
                                "\u00e0 elle-m\u00eame) est exclue de ce chiffre et affich\u00e9e s\u00e9par\u00e9ment, " +
                                "car elle n'aura jamais de compte CRM. Cliquez pour voir les factures concern\u00e9es."
                            } />
                        </div>
                        <p className="mt-1 text-base md:text-xl font-bold text-ink tabular-nums">
                            {formatCurrencyCAD(data.unassigned_amount)}
                            <span className="ml-2 text-xs font-semibold text-ink-mute">
                                {data.unassigned_count.toLocaleString('fr-CA')}{' '}
                                {data.unassigned_count === 1 ? 'facture' : 'factures'}
                            </span>
                        </p>
                        <p className="text-2xs text-ink-mute mt-0.5 font-medium italic">
                            {data.unassigned_share}&nbsp;% de la facturation externe
                            {data.internal_count > 0 && (
                                <>
                                    {' \u00b7 '}interne exclue&nbsp;: {formatCurrencyCAD(data.internal_amount)}
                                </>
                            )}
                        </p>
                    </div>
                </div>
                {data.unassigned_count > 0 && (
                    <button
                        onClick={onOpen}
                        className="inline-flex items-center gap-1.5 rounded-md border border-hairline-strong px-3 py-2
                                   text-xs font-semibold text-ink-secondary transition-colors
                                   hover:border-primary hover:bg-primary-wash hover:text-primary-press"
                    >
                        Voir les factures
                        <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>
        </div>
    );
}

/** The rows behind the figure, with the reason each one could not be linked. */
function UnassignedModal({ year, office, month, depts, rep, reps, onClose }: {
    year: number;
    office: string | null;
    month: number | null;
    depts: string[] | null;
    rep: string | null;
    reps: string[] | null;
    onClose: () => void;
}) {
    const [rows, setRows] = useState<UnassignedInvoiceRow[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            const { data } = await cachedRpc('get_unassigned_invoices', {
                p_year: year, p_office: office, p_month: month,
                p_depts: depts, p_rep: rep, p_reps: reps, p_limit: 500,
            });
            if (cancelled) return;
            setRows((data as UnassignedInvoiceRow[]) ?? []);
            setLoading(false);
        })();
        return () => { cancelled = true; };
    }, [year, office, month, depts, rep, reps]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
            onClick={onClose}
            role="presentation"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label="Factures non attribuées"
                onClick={e => e.stopPropagation()}
                className="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            >
                <div className="flex items-start justify-between gap-4 border-b border-hairline px-6 py-4">
                    <div>
                        <h2 className="text-lg font-semibold text-ink">Factures non attribuées</h2>
                        <p className="mt-0.5 text-sm text-ink-mute">
                            Aucun compte Zoho CRM derrière le client : ces montants n’apparaissent sur aucune fiche lead
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
                        Toutes les factures de cette période sont attribuées.
                    </div>
                ) : (
                    <div className="overflow-auto">
                        <table className="w-full">
                            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_theme(colors.slate.200)]">
                                <tr>
                                    <th className="th">Numéro</th>
                                    <th className="th">Client</th>
                                    <th className="th">Date</th>
                                    <th className="th">Bureau</th>
                                    <th className="th">Représentant</th>
                                    <th className="th">Raison</th>
                                    <th className="th text-right">Montant</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(inv => (
                                    <tr key={inv.zoho_id} className={cn('transition-colors hover:bg-sand/70',
                                                                        inv.is_avoir && 'bg-tone-critical-soft/30')}>
                                        <td className="td font-medium text-ink">{inv.invoice_number ?? '\u2014'}</td>
                                        <td className="td text-ink-secondary">{inv.client_name}</td>
                                        <td className="td whitespace-nowrap text-ink-mute">
                                            {inv.invoice_date ? formatShortDate(new Date(inv.invoice_date)) : '\u2014'}
                                        </td>
                                        <td className="td text-ink-mute">{inv.office ?? '\u2014'}</td>
                                        <td className="td text-ink-mute">{inv.rep_name ?? '\u2014'}</td>
                                        <td className="td">
                                            <span className="badge bg-stone text-ink-secondary">{inv.reason}</span>
                                        </td>
                                        <td className={cn('td text-right font-semibold tabular-nums',
                                                          inv.is_avoir ? 'text-tone-critical-ink' : 'text-ink')}>
                                            {formatCurrencyCAD(inv.amount)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline bg-sand/60 px-6 py-3">
                    <span className="text-sm text-ink-mute" translate="no">
                        {`${rows.length} facture${rows.length > 1 ? 's' : ''}`}
                        {rows.length === 500 && ' (500 premi\u00e8res)'}
                    </span>
                    <span className="text-sm font-semibold text-ink">
                        Total <span className="tabular-nums text-base">{formatCurrencyCAD(total)}</span>
                    </span>
                </div>
            </div>
        </div>
    );
}

function KPICard({ title, value, subText, icon: Icon, trend }: { title: string; value: string; subText: string; icon: React.ElementType; trend?: number }) {
    return (
        <div className="bg-white p-3 md:p-5 rounded-xl shadow-card flex flex-col justify-between hover:shadow-elevated transition-all group">
            <div className="flex items-start justify-between mb-2 md:mb-4">
                <div className="p-2 md:p-2.5 bg-sand rounded-md text-ink-mute group-hover:text-primary-press group-hover:bg-primary-wash transition-colors">
                    <Icon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                {trend !== undefined && (
                    <div className={cn("text-2xs font-bold px-1.5 md:px-2 py-0.5 rounded-full", trend >= 100 ? "bg-tone-good-soft text-tone-good-ink" : "bg-tone-warn-soft text-tone-warn-ink")}>
                        {trend}%
                    </div>
                )}
            </div>
            <div>
                <p className="text-2xs md:text-xs font-semibold text-ink-mute uppercase tracking-eyebrow leading-tight">{title}</p>
                <p className="text-base md:text-2xl font-bold text-ink mt-0.5 md:mt-1 tabular-nums">{value}</p>
                <p className="text-2xs text-ink-mute mt-0.5 md:mt-1 font-medium italic">{subText}</p>
            </div>
        </div>
    );
}
