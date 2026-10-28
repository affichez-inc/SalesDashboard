import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useUrlState } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import { formatCurrencyCAD } from '../lib/utils';
import { Loader2, Calendar, TrendingUp, Briefcase, Users, ChevronLeft, ChevronRight } from 'lucide-react';
import type { AvailableWeek, ZoneA_SummaryRow, ZoneA_DeptTotal, ZoneB_DetailRow } from '../types/database';
import { ZoneAPivotTable } from '../components/weekly/ZoneAPivotTable';
import { ZoneBTable } from '../components/weekly/ZoneBTable';
import { cn } from '../lib/utils';
import { MultiSelect } from '../components/MultiSelect';
import { useRepList } from '../hooks/useRepList';
import { useRepTeam, INTERNAL_LABEL } from '../lib/repTeam';
import { ExportButton } from '../components/ExportButton';
import type { CsvColumn } from '../lib/csv';
import { useRepFilter, REP_ALL_LABEL } from '../hooks/useRepFilter';

// "Je veux tout le temps qu'on puisse telecharger les rapports partout"
// (2026-09-04). Exports the filtered line items for the selected week - the same
// rows the table below shows, not the whole year.
const WEEK_CSV: CsvColumn<ZoneB_DetailRow>[] = [
    { header: 'Date',          value: r => r.sale_date },
    { header: 'Numero',        value: r => r.quote_number },
    { header: 'Client',        value: r => r.client_name },
    { header: 'Representant',  value: r => r.rep_name },
    { header: 'Departement',   value: r => r.department },
    { header: 'Etiquette Zoho', value: r => r.zoho_department_label },
    { header: 'Bureau',        value: r => r.office },
    { header: 'Statut',        value: r => r.status },
    { header: 'Montant',       value: r => r.amount },
];

// ─── Week label helpers ───────────────────────────────────────────────────────

function fmtShort(dateStr: string): string {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' });
}

function fmtWeekRange(start: string, end: string): string {
    return `${fmtShort(start)} au ${fmtShort(end)}`;
}

export default function WeeklyDetail() {
    const [availableWeeks, setAvailableWeeks] = useState<AvailableWeek[]>([]);
    const [selectedWeek, setSelectedWeek] = useUrlState('week', '');
    const [selectedReps, setSelectedReps] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [summaryData, setSummaryData] = useState<ZoneA_SummaryRow[]>([]);
    const [lineItems, setLineItems] = useState<ZoneB_DetailRow[]>([]);
    const repList = useRepList();

    // "Interne" first, then the current sales team by name. The rows arrive
    // unfiltered and are narrowed in memory, so the hook's `matches` carries the
    // same membership rule the server-side pages send as p_reps.
    const repFilter = useRepFilter(selectedReps, repList);

    // useUrlState's setter changes with every URL change; reading the latest
    // one through a ref keeps the week list from reloading on each of them.
    const setSelectedWeekRef = useRef(setSelectedWeek);
    useEffect(() => { setSelectedWeekRef.current = setSelectedWeek; });

    const fetchAvailableWeeks = useCallback(async (showLoader = true) => {
        if (showLoader) setLoading(true);
        const { data } = await cachedRpc('get_available_weeks', { p_year: new Date().getFullYear(), p_office: null, p_status: null });
        const weeks = data || [];
        setAvailableWeeks(weeks);
        if (weeks.length > 0) {
            if (!weeks.find((w: AvailableWeek) => w.week_start === selectedWeek)) {
                setSelectedWeekRef.current(weeks[0].week_start);
            }
        } else { setSelectedWeekRef.current(''); setSummaryData([]); setLineItems([]); }
        if (showLoader) setLoading(false);
    }, [selectedWeek]);

    const fetchWeekData = useCallback(async (weekStart: string, showLoader = true) => {
        if (showLoader) setLoading(true);
        const [{ data: sData }, { data: lData }] = await Promise.all([
            supabase.from('v_weekly_summary').select('*').eq('week_start', weekStart),
            cachedRpc('get_weekly_detail', { p_week_start: weekStart, p_office: null, p_status: null })
        ]);
        setSummaryData(sData || []);
        setLineItems(lData || []);
        if (showLoader) setLoading(false);
    }, []);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchAvailableWeeks(); }, [fetchAvailableWeeks]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { if (selectedWeek) fetchWeekData(selectedWeek); }, [selectedWeek, fetchWeekData]);
    useEffect(() => {
        const channel = supabase.channel('weekly-sales')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => {
                invalidateRpcCache();
                fetchAvailableWeeks(false);
                if (selectedWeek) fetchWeekData(selectedWeek, false);
            }).subscribe();
        return () => { supabase.removeChannel(channel); };
    }, [selectedWeek, fetchAvailableWeeks, fetchWeekData]);

    // Week navigation (availableWeeks is newest-first)
    const currentIdx = availableWeeks.findIndex(w => w.week_start === selectedWeek);
    const currentWeekObj = availableWeeks[currentIdx] ?? null;
    const prevWeekObj = currentIdx < availableWeeks.length - 1 ? availableWeeks[currentIdx + 1] : null;
    const nextWeekObj = currentIdx > 0 ? availableWeeks[currentIdx - 1] : null;

    const repTeam = useRepTeam();

    const filteredSummary = useMemo(() => {
        return summaryData.filter(r => repFilter.matches(r.rep_name));
    }, [summaryData, repFilter]);

    const filteredLineItems = useMemo(() => {
        return lineItems.filter(r => repFilter.matches(r.rep_name));
    }, [lineItems, repFilter]);

    const exportLineItems = useMemo(() =>
        // The export says what the screen says: a rep off the sales team is
        // Interne there too.
        filteredLineItems.map(r => ({ ...r, rep_name: repTeam.display(r.rep_name) })),
        [filteredLineItems, repTeam]);

    const grandTotal = useMemo(() =>
        filteredSummary.reduce((sum, row) => sum + Number(row.total_amount), 0), [filteredSummary]);

    const avgTicket = useMemo(() =>
        filteredLineItems.length > 0 ? grandTotal / filteredLineItems.length : 0, [grandTotal, filteredLineItems]);

    const deptTotals = useMemo(() => {
        const map = new Map<string, ZoneA_DeptTotal>();
        filteredSummary.forEach(row => {
            if (!map.has(row.department)) map.set(row.department, { department: row.department, total_amount: 0, num_sales: 0 });
            const dt = map.get(row.department)!;
            dt.total_amount += Number(row.total_amount);
            dt.num_sales += Number(row.num_sales);
        });
        return Array.from(map.values());
    }, [filteredSummary]);

    const repPivotRows = useMemo(() => {
        const repsMap = new Map<string, Record<string, number>>();
        filteredSummary.forEach(row => {
            // Everyone off the sales team shares one Interne row.
            const displayName = repTeam.isInternal(row.rep_name) ? INTERNAL_LABEL : row.rep_name;
            if (!repsMap.has(displayName)) repsMap.set(displayName, { "Total": 0 });
            const r = repsMap.get(displayName)!;
            r[row.department] = (r[row.department] || 0) + Number(row.total_amount);
            r["Total"] += Number(row.total_amount);
        });
        return Array.from(repsMap.entries()).map(([repName, depts]) => ({ repName, ...depts }))
            .sort((a, b) => a.repName.localeCompare(b.repName));
    }, [filteredSummary, repTeam]);

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            {/* Header */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">Détail Hebdomadaire</h1>
                    <p className="text-xs md:text-sm text-ink-mute mt-0.5">Devis · Vue équipe complète</p>
                </div>
                <div className="rounded-md border border-primary/40">
                    <MultiSelect
                        values={repFilter.selected}
                        onChange={setSelectedReps}
                        options={repFilter.options}
                        allLabel={REP_ALL_LABEL}
                        allIcon={repFilter.allIcon}
                        className="w-52"
                    />
                </div>
            </div>

            {/* Week switcher */}
            <div className="flex items-center justify-between bg-white rounded-xl shadow-card px-5 py-3">
                <button
                    onClick={() => prevWeekObj && setSelectedWeek(prevWeekObj.week_start)}
                    disabled={!prevWeekObj}
                    className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
                        !prevWeekObj ? "text-ink-faint cursor-not-allowed" : "text-ink-mute hover:text-ink hover:bg-sand"
                    )}
                >
                    <ChevronLeft className="w-4 h-4" />
                    {prevWeekObj ? fmtShort(prevWeekObj.week_start) : '—'}
                </button>

                <div className="text-center">
                    <h3 className="text-base font-semibold text-ink">
                        {currentWeekObj ? fmtWeekRange(currentWeekObj.week_start, currentWeekObj.week_end) : '—'}
                    </h3>
                    <p className="text-2xs text-ink-mute uppercase tracking-eyebrow mt-0.5">
                        Détail des devis
                    </p>
                </div>

                <button
                    onClick={() => nextWeekObj && setSelectedWeek(nextWeekObj.week_start)}
                    disabled={!nextWeekObj}
                    className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
                        !nextWeekObj ? "text-ink-faint cursor-not-allowed" : "text-ink-mute hover:text-ink hover:bg-sand"
                    )}
                >
                    {nextWeekObj ? fmtShort(nextWeekObj.week_start) : '—'}
                    <ChevronRight className="w-4 h-4" />
                </button>
            </div>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-press" />
                    <p className="text-sm text-ink-mute font-medium">Récupération des détails...</p>
                </div>
            ) : availableWeeks.length === 0 ? (
                <div className="bg-white rounded-xl shadow-card p-20 text-center">
                    <div className="w-16 h-16 bg-sand rounded-full flex items-center justify-center mx-auto mb-4">
                        <Calendar className="w-8 h-8 text-ink-faint" />
                    </div>
                    <h3 className="text-base font-semibold text-ink-secondary">Aucune vente enregistrée</h3>
                    <p className="text-sm text-ink-mute mt-1">Essayez de modifier l'année.</p>
                </div>
            ) : (
                <div className="space-y-4 md:space-y-6">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 md:gap-6">
                        <div className="bg-primary rounded-xl p-3 md:p-6 text-white shadow-lg flex items-center justify-between">
                            <div className="min-w-0">
                                <p className="text-white text-2xs font-semibold uppercase tracking-eyebrow">Total Hebdo</p>
                                <p className="text-base md:text-3xl font-bold mt-1 tabular-nums truncate">{formatCurrencyCAD(grandTotal)}</p>
                            </div>
                            <div className="p-2 md:p-3 bg-black/15 rounded-md shrink-0 ml-2">
                                <TrendingUp className="w-4 h-4 md:w-6 md:h-6" />
                            </div>
                        </div>
                        <div className="hidden sm:flex bg-white rounded-xl p-3 md:p-6 shadow-card items-center justify-between group hover:shadow-elevated transition-all">
                            <div className="min-w-0">
                                <p className="text-ink-mute text-2xs font-semibold uppercase tracking-eyebrow">Moy./vente</p>
                                <p className="text-base md:text-2xl font-bold text-ink mt-1 tabular-nums truncate">{formatCurrencyCAD(avgTicket)}</p>
                            </div>
                            <div className="p-2 md:p-3 bg-sand rounded-md text-ink-faint group-hover:bg-primary-wash group-hover:text-primary-press transition-colors shrink-0 ml-2 hidden sm:flex">
                                <Briefcase className="w-4 h-4 md:w-6 md:h-6" />
                            </div>
                        </div>
                        <div className="bg-white rounded-xl p-3 md:p-6 shadow-card flex items-center justify-between group hover:shadow-elevated transition-all">
                            <div className="min-w-0">
                                <p className="text-ink-mute text-2xs font-semibold uppercase tracking-eyebrow">Volume</p>
                                <p className="text-base md:text-2xl font-bold text-ink mt-1">{filteredLineItems.length} <span className="text-xs md:text-base">Devis</span></p>
                            </div>
                            <div className="p-2 md:p-3 bg-sand rounded-md text-ink-faint group-hover:bg-primary-wash group-hover:text-primary-press transition-colors shrink-0 ml-2 hidden sm:flex">
                                <Users className="w-4 h-4 md:w-6 md:h-6" />
                            </div>
                        </div>
                    </div>

                    <div className="flex justify-end">
                        <ExportButton
                            rows={exportLineItems} columns={WEEK_CSV}
                            filename="devis_semaine" disabled={filteredLineItems.length === 0}
                            label={`Exporter ${filteredLineItems.length} devis`}
                        />
                    </div>
                    <ZoneAPivotTable repPivotRows={repPivotRows} grandTotal={grandTotal} deptTotals={deptTotals} />
                    <ZoneBTable lineItems={filteredLineItems} />
                </div>
            )}
        </div>
    );
}
