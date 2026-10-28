import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useUrlState, useUrlStateNumber, useUrlList } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import {
    Loader2, FilePlus2, CheckCircle2, Percent, Activity, Inbox, AlertTriangle,
    TrendingUp, TrendingDown, Minus, ChevronLeft, ChevronRight,
} from 'lucide-react';
import type {
    TaskKPIs, TasksByRepRow, TasksByStatusRow, TasksWeeklyRow, TasksWoWRow, TasksAvailableWeek,
} from '../types/database';
import { MONTHS, TASK_STATUSES } from '../lib/constants';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { MultiSelect } from '../components/MultiSelect';
import { SortIcon } from '../components/SortIcon';
import { cn } from '../lib/utils';
import { useSort } from '../hooks/useSort';
import { useRepList } from '../hooks/useRepList';
import { ExportButton } from '../components/ExportButton';
import { autoColumns } from '../lib/csv';
import { RepName, RepAvatar } from '../components/RepAvatar';
import { useRepTeam, mergeInternalRows, INTERNAL_LABEL } from '../lib/repTeam';

const STATUS_LABELS: Record<string, string> = Object.fromEntries(TASK_STATUSES.map(s => [s.value, s.label]));

const STATUS_COLORS: Record<string, string> = {
    'Non commencé': 'bg-stone text-ink-secondary',
    'En cours':     'bg-data-2 text-data-2-ink',
    'Achevé':       'bg-tone-good-soft text-tone-good-ink',
    'Non défini':   'bg-stone text-ink-secondary',
};

const STATUS_BAR: Record<string, string> = {
    'Non commencé': 'bg-hairline-strong',
    'En cours':     'bg-data-2-ink',
    'Achevé':       'bg-tone-good',
    'Non défini':   'bg-hairline-strong',
};

function pctText(pct: number): string {
    if (pct >= 90) return 'text-tone-good';
    if (pct >= 50) return 'text-tone-warn-ink';
    return 'text-ink-mute';
}
function pctBar(pct: number): string {
    if (pct >= 90) return 'bg-tone-good';
    if (pct >= 50) return 'bg-tone-warn';
    return 'bg-primary';
}

// ─── Week label helpers (same as WeeklyDetail) ───────────────────────────────
function fmtShort(dateStr: string): string {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' });
}
function fmtWeekRange(start: string, end: string): string {
    return `${fmtShort(start)} au ${fmtShort(end)}`;
}
function addDaysStr(dateStr: string, days: number): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${dt.getFullYear()}-${mm}-${dd}`;
}

/**
 * The average delay of two merged rows, weighted by the tasks each actually
 * closed - averaging the two averages would give a rep who closed one task the
 * same weight as one who closed two hundred.
 */
function weightedDays(a: TasksByRepRow, b: TasksByRepRow): number | null {
    if (a.avg_days_to_close === null) return b.avg_days_to_close;
    if (b.avg_days_to_close === null) return a.avg_days_to_close;
    const n = a.nb_completed + b.nb_completed;
    if (n === 0) return null;
    return Math.round(((a.avg_days_to_close * a.nb_completed + b.avg_days_to_close * b.nb_completed) / n) * 10) / 10;
}

export default function TasksDashboard() {
    const [tab, setTab] = useUrlState('tab', 'dashboard'); // 'dashboard' | 'hebdo'
    const isWeekly = tab === 'hebdo';

    const [year, setYear] = useUrlStateNumber('year', 2026);
    const [_monthParam, _setMonthParam] = useUrlState('month', 'Toutes');
    const selectedMonth: number | 'Toutes' = _monthParam === 'Toutes' ? 'Toutes' : Number(_monthParam);
    const setSelectedMonth = (v: number | 'Toutes') => _setMonthParam(v === 'Toutes' ? 'Toutes' : String(v));
    // Several reps at once; an empty list is everyone.
    const [selectedReps, setSelectedReps] = useUrlList('rep');
    const [selectedWeek, setSelectedWeek] = useUrlState('week', '');

    const [availableWeeks, setAvailableWeeks] = useState<TasksAvailableWeek[]>([]);
    const [loading, setLoading] = useState(true);
    const [kpis, setKpis] = useState<TaskKPIs | null>(null);
    const [rawByRep, setRawByRep] = useState<TasksByRepRow[]>([]);
    const [byStatus, setByStatus] = useState<TasksByStatusRow[]>([]);
    const [weekly, setWeekly] = useState<TasksWeeklyRow[]>([]);
    const [rawWow, setRawWow] = useState<TasksWoWRow[]>([]);

    const repList = useRepList();

    // useUrlState's setter changes with every URL change; reading the latest
    // one through a ref keeps the week list from reloading on each of them.
    const setSelectedWeekRef = useRef(setSelectedWeek);
    useEffect(() => { setSelectedWeekRef.current = setSelectedWeek; });

    // Available weeks for the week switcher (newest-first)
    const fetchWeeks = useCallback(async () => {
        const { data } = await cachedRpc('get_tasks_available_weeks', { p_year: new Date().getFullYear() });
        const weeks: TasksAvailableWeek[] = data || [];
        setAvailableWeeks(weeks);
        if (weeks.length > 0 && !weeks.find(w => w.week_start === selectedWeek)) {
            setSelectedWeekRef.current(weeks[0].week_start);
        }
    }, [selectedWeek]);

    const fetchData = useCallback(async () => {
        // In weekly mode wait until a week is chosen (avoids a flash of yearly data)
        if (isWeekly && !selectedWeek) { setLoading(true); return; }
        setLoading(true);
        const monthParam = isWeekly ? null : (selectedMonth === 'Toutes' ? null : selectedMonth);
        const weekParam = isWeekly ? selectedWeek : null;
        const repsParam = selectedReps.length > 0 ? selectedReps : null;

        const [
            { data: kpiData },
            { data: repData },
            { data: statusData },
            { data: weeklyData },
            { data: wowData },
        ] = await Promise.all([
            cachedRpc('get_tasks_kpis', { p_year: year, p_month: monthParam, p_reps: repsParam, p_week_start: weekParam }),
            cachedRpc('get_tasks_by_rep', { p_year: year, p_month: monthParam, p_week_start: weekParam }),
            cachedRpc('get_tasks_by_status', { p_reps: repsParam }),
            cachedRpc('get_tasks_weekly', { p_year: year, p_reps: repsParam }),
            cachedRpc('get_tasks_wow', { p_reps: repsParam }),
        ]);

        setKpis(kpiData?.[0] ?? null);
        setRawByRep(repData ?? []);
        setByStatus(statusData ?? []);
        setWeekly(weeklyData ?? []);
        setRawWow(wowData ?? []);
        setLoading(false);
    }, [isWeekly, year, selectedMonth, selectedReps, selectedWeek]);

    const fetchDataRef = useRef(fetchData);
    const fetchWeeksRef = useRef(fetchWeeks);
    useEffect(() => { fetchDataRef.current = fetchData; fetchWeeksRef.current = fetchWeeks; }, [fetchData, fetchWeeks]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchWeeks(); }, [fetchWeeks]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchData(); }, [fetchData]);

    useEffect(() => {
        const sub = supabase
            .channel('tasks-dashboard-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'zoho_tasks' }, () => {
                invalidateRpcCache();
                fetchWeeksRef.current();
                fetchDataRef.current();
            })
            .subscribe();
        return () => { supabase.removeChannel(sub); };
    }, []);

    const repTeam = useRepTeam();

    /**
     * Everyone off the sales team is one Interne line. The two rates are
     * recomputed from the summed counts - a completion rate is not the average
     * of rates, and the average delay is weighted by tasks actually closed.
     */
    const byRep = useMemo(() => mergeInternalRows(
        rawByRep, repTeam, r => r.rep_name,
        r => ({ ...r, rep_name: INTERNAL_LABEL }),
        (acc, r) => ({
            ...acc,
            nb_created: acc.nb_created + r.nb_created,
            nb_completed: acc.nb_completed + r.nb_completed,
            nb_created_closed: acc.nb_created_closed + r.nb_created_closed,
            nb_touched: acc.nb_touched + r.nb_touched,
            nb_open: acc.nb_open + r.nb_open,
            nb_overdue: acc.nb_overdue + r.nb_overdue,
            avg_days_to_close: weightedDays(acc, r),
        }),
    ).map(r => ({
        ...r,
        // Both rates are recomputed from the summed counts, never averaged.
        completion_rate: r.nb_created > 0 ? Math.round((r.nb_completed / r.nb_created) * 100) : 0,
        cohort_rate: r.nb_created > 0 ? Math.round((r.nb_created_closed / r.nb_created) * 100) : 0,
    })), [rawByRep, repTeam]);

    const wow = useMemo(() => mergeInternalRows(
        rawWow, repTeam, r => r.rep_name,
        r => ({ ...r, rep_name: INTERNAL_LABEL }),
        (acc, r) => ({
            ...acc,
            created_this_week: acc.created_this_week + r.created_this_week,
            created_last_week: acc.created_last_week + r.created_last_week,
            completed_this_week: acc.completed_this_week + r.completed_this_week,
            completed_last_week: acc.completed_last_week + r.completed_last_week,
        }),
    ), [rawWow, repTeam]);

    const { sortedData: sortedReps, sortConfig, handleSort } = useSort<TasksByRepRow>(byRep, 'nb_completed', 'desc');

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));
    const monthOptions = useMemo(() => [{ value: 'Toutes', label: 'Année complète' }, ...MONTHS.map(m => ({ value: String(m.value), label: m.label }))], []);
    const repOptions = useMemo(
        () => repList.map(r => ({ value: r, label: r, icon: <RepAvatar name={r} size="sm" /> })),
        [repList],
    );

    // Week navigation (availableWeeks is newest-first)
    const currentIdx = availableWeeks.findIndex(w => w.week_start === selectedWeek);
    const currentWeekObj = availableWeeks[currentIdx] ?? null;
    const prevWeekObj = currentIdx < availableWeeks.length - 1 ? availableWeeks[currentIdx + 1] : null;
    const nextWeekObj = currentIdx > 0 ? availableWeeks[currentIdx - 1] : null;

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div>
                <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">Tâches CRM · Activité des représentants</h1>
                <p className="text-xs md:text-sm text-ink-mute mt-0.5">
                    Ce que chaque rep fait dans Zoho CRM. Créées / complétées / traitées sur la période. Ouvertes et en retard en temps réel.
                </p>
            </div>

            {/* Tab switcher */}
            <div className="flex items-center gap-1 bg-stone rounded-md p-1 w-fit">
                <TabButton active={!isWeekly} onClick={() => setTab('dashboard')}>Tableau de bord</TabButton>
                <TabButton active={isWeekly} onClick={() => setTab('hebdo')}>Hebdomadaire</TabButton>
            </div>

            {/* Period + rep filters */}
            {isWeekly ? (
                <div className="space-y-4">
                    <FilterBar>
                        <FilterGroup label="Représentant">
                            <MultiSelect values={selectedReps} onChange={setSelectedReps} options={repOptions}
                                         allLabel="Tous les reps" allIcon={<RepAvatar name="Tous" size="sm" />} className="w-48" />
                        </FilterGroup>
                    </FilterBar>
                    {/* Week switcher */}
                    <div className="flex items-center justify-between bg-white rounded-xl shadow-card px-5 py-3">
                        <button
                            onClick={() => prevWeekObj && setSelectedWeek(prevWeekObj.week_start)}
                            disabled={!prevWeekObj}
                            className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
                                !prevWeekObj ? "text-ink-faint cursor-not-allowed" : "text-ink-mute hover:text-ink hover:bg-sand")}
                        >
                            <ChevronLeft className="w-4 h-4" />{prevWeekObj ? fmtShort(prevWeekObj.week_start) : '—'}
                        </button>
                        <div className="text-center">
                            <h3 className="text-base font-semibold text-ink">
                                {currentWeekObj ? fmtWeekRange(currentWeekObj.week_start, currentWeekObj.week_end) : '—'}
                            </h3>
                            <p className="text-2xs text-ink-mute uppercase tracking-eyebrow mt-0.5">Semaine sélectionnée</p>
                        </div>
                        <button
                            onClick={() => nextWeekObj && setSelectedWeek(nextWeekObj.week_start)}
                            disabled={!nextWeekObj}
                            className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
                                !nextWeekObj ? "text-ink-faint cursor-not-allowed" : "text-ink-mute hover:text-ink hover:bg-sand")}
                        >
                            {nextWeekObj ? fmtShort(nextWeekObj.week_start) : '—'}<ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            ) : (
                <FilterBar>
                    <FilterGroup label="Année">
                        <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                    </FilterGroup>
                    <FilterGroup label="Mois">
                        <Select value={String(selectedMonth)} onChange={v => setSelectedMonth(v === 'Toutes' ? 'Toutes' : Number(v))} options={monthOptions} className="w-40" />
                    </FilterGroup>
                    <FilterGroup label="Représentant">
                        <MultiSelect values={selectedReps} onChange={setSelectedReps} options={repOptions}
                                     allLabel="Tous les reps" allIcon={<RepAvatar name="Tous" size="sm" />} className="w-48" />
                    </FilterGroup>
                </FilterBar>
            )}

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-press" />
                    <p className="text-sm text-ink-mute font-medium">Chargement des tâches...</p>
                </div>
            ) : (
                <>
                    {/* KPI strip */}
                    <div className="grid grid-cols-2 lg:grid-cols-7 gap-3 md:gap-4">
                        <KPICard title="Créées"        value={String(kpis?.total_created ?? 0)}   subText={isWeekly ? 'Cette semaine' : 'Sur la période'} icon={FilePlus2} />
                        <KPICard title="Complétées"    value={String(kpis?.total_completed ?? 0)} subText={isWeekly ? 'Cette semaine' : 'Sur la période'} icon={CheckCircle2} />
                        {/* Two different questions, so two numbers. The old single "taux"
                            mixed them and was clamped to 100 % in the display to hide it. */}
                        <KPICard title="Taux compl."   value={`${Math.round(kpis?.cohort_rate ?? 0)}%`} subText="Des créées, % fermées" icon={Percent} highlight={(kpis?.cohort_rate ?? 0) >= 80} />
                        <KPICard title="Débit"         value={`${Math.round(kpis?.completion_rate ?? 0)}%`} subText="Complétées / créées" icon={Activity} />
                        <KPICard title="Traitées"      value={String(kpis?.total_touched ?? 0)}   subText="Modifiées" icon={Activity} />
                        <KPICard title="Ouvertes"      value={String(kpis?.total_open ?? 0)}      subText="État actuel" icon={Inbox} />
                        <KPICard title="En retard"     value={String(kpis?.total_overdue ?? 0)}   subText="Échéance dépassée" icon={AlertTriangle} danger={(kpis?.total_overdue ?? 0) > 0} />
                    </div>

                    {/* Rep leaderboard - the core comparison */}
                    <div className="bg-white rounded-xl shadow-card overflow-hidden">
                        <div className="px-5 py-4 border-b border-hairline flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-ink">Classement des représentants</h3>
                            <ExportButton
                                rows={byRep}
                                columns={autoColumns(byRep)}
                                filename="taches_par_rep" label="CSV"
                                disabled={byRep.length === 0}
                            />
                            <span className="text-2xs text-ink-mute">{sortedReps.length} reps · {kpis?.active_reps ?? 0} actifs {isWeekly ? 'cette semaine' : 'sur la période'}</span>
                        </div>
                        {sortedReps.length === 0 ? (
                            <p className="px-5 py-10 text-sm text-ink-mute text-center">Aucune tâche pour cette période</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm min-w-[820px]">
                                    <thead>
                                        <tr className="border-b border-hairline bg-sand/60">
                                            <SortTh label="Représentant" col="rep_name" align="left" sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="Créées"      col="nb_created"        sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="Complétées"  col="nb_completed"      sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="Taux compl." col="cohort_rate"       sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="Débit"       col="completion_rate"   sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="Traitées"    col="nb_touched"        sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="Délai moyen" col="avg_days_to_close" sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="Ouvertes"    col="nb_open"           sortConfig={sortConfig} onSort={handleSort} />
                                            <SortTh label="En retard"   col="nb_overdue"        sortConfig={sortConfig} onSort={handleSort} />
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-hairline">
                                        {sortedReps.map(r => {
                                            // The bar shows the bounded cohort rate; throughput sits
                                            // beside it unclamped, because >100 % is real information.
                                            const rate = Number(r.cohort_rate) || 0;
                                            const throughput = Number(r.completion_rate) || 0;
                                            return (
                                                <tr key={r.rep_name} className="hover:bg-sand/60 transition-colors">
                                                    <td className="px-4 py-3 font-semibold text-ink-secondary whitespace-nowrap">
                                                        <RepName name={r.rep_name} size="sm" />
                                                    </td>
                                                    <td className="px-4 py-3 text-right font-bold text-ink-secondary tabular-nums">{r.nb_created}</td>
                                                    <td className="px-4 py-3 text-right tabular-nums"><span className="font-bold text-tone-good-ink">{r.nb_completed}</span></td>
                                                    <td className="px-4 py-3">
                                                        <div className="flex items-center justify-end gap-2">
                                                            <div className="h-1.5 rounded-full bg-stone w-16 shrink-0">
                                                                <div className={cn('h-1.5 rounded-full', pctBar(rate))} style={{ width: `${Math.min(rate, 100)}%` }} />
                                                            </div>
                                                            <span className={cn('text-xs font-bold tabular-nums w-9 text-right', pctText(rate))}>{Math.round(rate)}%</span>
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-3 text-right text-ink-mute tabular-nums">{Math.round(throughput)}%</td>
                                                    <td className="px-4 py-3 text-right text-ink-mute tabular-nums">{r.nb_touched}</td>
                                                    <td className="px-4 py-3 text-right text-ink-mute tabular-nums">
                                                        {r.avg_days_to_close != null ? `${Number(r.avg_days_to_close).toFixed(1)} j` : <span className="text-ink-faint">—</span>}
                                                    </td>
                                                    <td className="px-4 py-3 text-right text-ink-mute tabular-nums">{r.nb_open}</td>
                                                    <td className="px-4 py-3 text-right tabular-nums">
                                                        <span className={cn('font-bold', r.nb_overdue > 0 ? 'text-tone-critical' : 'text-ink-faint')}>{r.nb_overdue}</span>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    {/* Week-over-week + open tasks by status */}
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 md:gap-6">
                        <WeekOverWeekPanel rows={wow} />
                        <StatusPanel rows={byStatus} />
                    </div>

                    {/* Weekly trend */}
                    <WeeklyTrend rows={weekly} />
                </>
            )}
        </div>
    );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            onClick={onClick}
            className={cn(
                'px-4 py-1.5 rounded-md text-sm font-semibold transition-all',
                active ? 'bg-white text-ink shadow-xs' : 'text-ink-secondary hover:text-ink',
            )}
        >
            {children}
        </button>
    );
}

// ─── Sortable header cell ───────────────────────────────────────────────────

function SortTh<T>({ label, col, align = 'right', sortConfig, onSort }: {
    label: string;
    col: keyof T;
    align?: 'left' | 'right';
    sortConfig: { key: keyof T | null; order: 'asc' | 'desc' | null };
    onSort: (key: keyof T) => void;
}) {
    const active = sortConfig.key === col ? sortConfig.order : null;
    return (
        <th className={cn('px-4 py-2.5 text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow', align === 'left' ? 'text-left' : 'text-right')}>
            <button onClick={() => onSort(col)} className={cn('group inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
                {label}
                <SortIcon order={active} />
            </button>
        </th>
    );
}

// ─── Week-over-week panel ───────────────────────────────────────────────────

function WeekOverWeekPanel({ rows }: { rows: TasksWoWRow[] }) {
    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-hairline">
                <h3 className="text-sm font-semibold text-ink">Cette semaine vs semaine dernière</h3>
                <p className="text-2xs text-ink-mute mt-0.5">
                    Tâches complétées, par rep : qui accélère, qui ralentit. La semaine dernière
                    est mesurée jusqu&apos;au même jour et à la même heure, pour que la comparaison
                    tienne en milieu de semaine.
                </p>
            </div>
            {rows.length === 0 ? (
                <p className="px-5 py-8 text-sm text-ink-mute text-center">Aucune activité récente</p>
            ) : (
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hairline bg-sand/60">
                            <th className="px-4 py-2.5 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Rep</th>
                            <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Sem. dern. (même pér.)</th>
                            <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Cette sem.</th>
                            <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Évol.</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {rows.map(r => {
                            const delta = r.completed_this_week - r.completed_last_week;
                            const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
                            const color = delta > 0 ? 'text-tone-good' : delta < 0 ? 'text-tone-critical' : 'text-ink-faint';
                            return (
                                <tr key={r.rep_name} className="hover:bg-sand/60 transition-colors">
                                    <td className="px-4 py-2.5 font-semibold text-ink-secondary">
                                        <RepName name={r.rep_name} size="sm" />
                                    </td>
                                    <td className="px-4 py-2.5 text-right text-ink-mute tabular-nums">{r.completed_last_week}</td>
                                    <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums">{r.completed_this_week}</td>
                                    <td className="px-4 py-2.5 text-right">
                                        <span className={cn('inline-flex items-center gap-1 text-xs font-bold tabular-nums', color)}>
                                            <Icon className="w-3.5 h-3.5" />
                                            {delta > 0 ? `+${delta}` : delta}
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}

// ─── Open tasks by status ───────────────────────────────────────────────────

function StatusPanel({ rows }: { rows: TasksByStatusRow[] }) {
    const total = rows.reduce((s, r) => s + r.nb, 0);
    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-hairline">
                <h3 className="text-sm font-semibold text-ink">Tâches ouvertes par statut</h3>
                <p className="text-2xs text-ink-mute mt-0.5">Composition du backlog : beaucoup de « Non commencé » = tâches créées mais pas travaillées</p>
            </div>
            {rows.length === 0 ? (
                <p className="px-5 py-8 text-sm text-ink-mute text-center">Aucune tâche ouverte</p>
            ) : (
                <div className="p-5 space-y-3">
                    {rows.map(r => {
                        const pct = total > 0 ? Math.round((r.nb / total) * 100) : 0;
                        return (
                            <div key={r.status} className="flex items-center gap-3">
                                <span className={cn('shrink-0 px-2 py-0.5 rounded-full text-2xs font-semibold uppercase w-32 text-center', STATUS_COLORS[r.status] ?? 'bg-stone text-ink-secondary')}>
                                    {STATUS_LABELS[r.status] ?? r.status}
                                </span>
                                <div className="flex-1 h-2 rounded-full bg-stone">
                                    <div className={cn('h-2 rounded-full', STATUS_BAR[r.status] ?? 'bg-hairline-strong')} style={{ width: `${pct}%` }} />
                                </div>
                                <span className="shrink-0 w-16 text-right text-xs tabular-nums">
                                    <span className="font-bold text-ink-secondary">{r.nb}</span>
                                    <span className="text-ink-mute ml-1">{pct}%</span>
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ─── Weekly trend ───────────────────────────────────────────────────────────

function WeeklyTrend({ rows }: { rows: TasksWeeklyRow[] }) {
    const active = rows.filter(w => w.nb_created > 0 || w.nb_completed > 0);
    const maxVal = Math.max(1, ...active.map(w => Math.max(w.nb_created, w.nb_completed)));

    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
            <div className="px-5 py-4 border-b border-hairline flex items-center justify-between">
                <div>
                    <h3 className="text-sm font-semibold text-ink">Tendance hebdomadaire</h3>
                    <p className="text-2xs text-ink-mute mt-0.5">Tâches créées vs complétées, par semaine</p>
                </div>
                <div className="flex items-center gap-4 text-2xs text-ink-mute">
                    <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-xs bg-hairline-strong" /> Créées</span>
                    <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-xs bg-primary" /> Complétées</span>
                </div>
            </div>
            {active.length === 0 ? (
                <p className="px-5 py-8 text-sm text-ink-mute text-center">Aucune donnée hebdomadaire</p>
            ) : (
                <div className="p-5 pt-20 overflow-x-auto">
                    <div className="flex items-end gap-3 h-32 min-w-min">
                        {active.map(w => {
                            const label = fmtShort(w.week_start);
                            const range = fmtWeekRange(w.week_start, addDaysStr(w.week_start, 6));
                            // Throughput for the week: completed / created. Different cohorts,
                            // so >100 % means backlog was cleared. Not clamped.
                            const rate = w.nb_created > 0 ? Math.round((w.nb_completed / w.nb_created) * 100) : 0;
                            return (
                                <div key={w.week_start} className="group relative flex flex-col items-center gap-1.5 shrink-0 rounded-md px-0.5 pt-1 hover:bg-sand transition-colors">
                                    {/* Hover tooltip */}
                                    <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 hidden group-hover:block">
                                        <div className="bg-ink text-white rounded-md px-3 py-2 shadow-xl text-2xs whitespace-nowrap">
                                            <div className="font-bold mb-1 text-center">{range}</div>
                                            <div className="flex items-center gap-3">
                                                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-xs bg-ink-faint" /><span className="tabular-nums font-bold">{w.nb_created}</span> créées</span>
                                                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-xs bg-primary" /><span className="tabular-nums font-bold">{w.nb_completed}</span> compl.</span>
                                                <span className="tabular-nums font-bold text-tone-good">{rate}%</span>
                                            </div>
                                        </div>
                                        <div className="w-2 h-2 bg-ink rotate-45 absolute left-1/2 -translate-x-1/2 -bottom-1" />
                                    </div>

                                    <div className="flex items-end gap-1 h-24">
                                        <div className="w-3 rounded-t-xs bg-hairline-strong group-hover:bg-ink-faint transition-colors" style={{ height: `${(w.nb_created / maxVal) * 100}%` }} />
                                        <div className="w-3 rounded-t-xs bg-primary group-hover:bg-primary-deep transition-colors" style={{ height: `${(w.nb_completed / maxVal) * 100}%` }} />
                                    </div>
                                    <span className="text-2xs text-ink-mute group-hover:text-ink-secondary whitespace-nowrap transition-colors">{label}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── KPI card ───────────────────────────────────────────────────────────────

function KPICard({ title, value, subText, icon: Icon, highlight, danger }: {
    title: string; value: string; subText: string; icon: React.ElementType; highlight?: boolean; danger?: boolean;
}) {
    return (
        <div className="bg-white p-3 md:p-5 rounded-xl shadow-card flex flex-col justify-between hover:shadow-elevated transition-all group">
            <div className="flex items-start justify-between mb-2 md:mb-4">
                <div className={cn(
                    'p-2 md:p-2.5 rounded-md transition-colors',
                    danger ? 'bg-tone-critical-soft text-tone-critical' : 'bg-sand text-ink-mute group-hover:text-primary-press group-hover:bg-primary-wash',
                )}>
                    <Icon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                {highlight && (
                    <span className="text-2xs font-bold px-2 py-0.5 rounded-full bg-tone-good-soft text-tone-good-ink">Bon</span>
                )}
            </div>
            <div>
                <p className="text-2xs md:text-xs font-semibold text-ink-mute uppercase tracking-eyebrow leading-tight">{title}</p>
                <p className="mt-1 text-base md:text-2xl font-bold text-ink tabular-nums">{value}</p>
                <p className="text-2xs text-ink-mute mt-0.5 md:mt-1 font-medium italic">{subText}</p>
            </div>
        </div>
    );
}
