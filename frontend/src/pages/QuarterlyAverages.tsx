import { useEffect, useState, useMemo, useCallback } from 'react';
import { useUrlState, useUrlStateNumber, useUrlList } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import { Loader2 } from 'lucide-react';
import type { YoYRow, QuarterTotalsRow } from '../types/database';
import { QuarterBlock } from '../components/quarterly/QuarterBlock';
import { ExportButton } from '../components/ExportButton';
import type { CsvColumn } from '../lib/csv';

const YOY_CSV: CsvColumn<YoYRow>[] = [
    { header: 'Trimestre',        value: r => r.quarter },
    { header: 'Representant',     value: r => r.rep_name },
    { header: 'Bureau',           value: r => r.office },
    { header: 'Devis',            value: r => r.deal_count },
    { header: 'Moyenne courante', value: r => r.current_avg },
    { header: 'Moyenne an dernier', value: r => r.previous_avg },
    { header: 'Ecart (%)',        value: r => r.resultat },
];
import { OFFICES } from '../lib/constants';
import { useRepTeam, INTERNAL_LABEL } from '../lib/repTeam';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { MultiSelect } from '../components/MultiSelect';
import { useRepFilter, REP_ALL_LABEL } from '../hooks/useRepFilter';

export default function QuarterlyAverages() {
    const [year, setYear] = useUrlStateNumber('year', 2026);
    const [selectedReps, setSelectedReps] = useUrlList('rep');
    const [selectedOffice, setSelectedOffice] = useUrlState('office', 'Toutes');
    const [loading, setLoading] = useState(true);
    const [yoyData, setYoyData] = useState<YoYRow[]>([]);
    const [teamTotals, setTeamTotals] = useState<QuarterTotalsRow[]>([]);

    const repTeam = useRepTeam();

    /** Everyone off the sales team is one Interne line per quarter. */
    const groupedYoyData = useMemo((): YoYRow[] => {
        const internals = yoyData.filter(r => repTeam.isInternal(r.rep_name));
        const others = yoyData.filter(r => !repTeam.isInternal(r.rep_name));
        if (internals.length === 0) return yoyData;

        const byQuarter = new Map<number, YoYRow[]>();
        internals.forEach(r => {
            if (!byQuarter.has(r.quarter)) byQuarter.set(r.quarter, []);
            byQuarter.get(r.quarter)!.push(r);
        });
        const venteInterneRows: YoYRow[] = [];
        for (const [quarter, rows] of byQuarter) {
            // current_avg / previous_avg are weekly revenue rates (additive across reps),
            // so the group total is their sum - NOT a deal-count-weighted average.
            const totalCount   = rows.reduce((s, r) => s + Number(r.deal_count), 0);
            const current_avg  = rows.reduce((s, r) => s + Number(r.current_avg), 0);
            const previous_avg = rows.reduce((s, r) => s + Number(r.previous_avg), 0);
            venteInterneRows.push({ quarter, rep_name: INTERNAL_LABEL, office: '—', current_avg, previous_avg, resultat: current_avg - previous_avg, deal_count: totalCount });
        }
        return [...others, ...venteInterneRows];
    }, [yoyData, repTeam]);

    const uniqueReps = useMemo(() => {
        const reps = new Set<string>();
        groupedYoyData.forEach(row => reps.add(row.rep_name));
        return Array.from(reps).sort((a, b) => a.localeCompare(b));
    }, [groupedYoyData]);

    const fetchAverages = useCallback(async () => {
        setLoading(true);
        const p_office = selectedOffice === 'Toutes' ? null : selectedOffice;
        const [{ data, error }, { data: totalsData, error: totalsError }] = await Promise.all([
            cachedRpc('get_quarterly_yoy', { p_year: year, p_office, p_status: null }),
            cachedRpc('get_quarterly_yoy_totals', { p_year: year, p_office, p_status: null }),
        ]);
        if (error) console.error("Error fetching quarterly averages:", error);
        else setYoyData(data || []);
        if (totalsError) console.error("Error fetching quarterly team totals:", totalsError);
        else setTeamTotals(totalsData || []);
        setLoading(false);
    }, [year, selectedOffice]);

    // True per-quarter last-year total (whole team, incl. departed reps). Only applied
    // to the "Total équipe" row when no rep is filtered.
    // Keep null as null: it means the comparison year has no fiscal calendar, and
    // Number(null) would turn that into a 0 the page then reads as a real figure.
    const previousTotalByQuarter = useMemo(() => {
        const m = new Map<number, number | null>();
        teamTotals.forEach(t => m.set(t.quarter, t.previous_total === null ? null : Number(t.previous_total)));
        return m;
    }, [teamTotals]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        fetchAverages();
        const channel = supabase.channel('quarterly-sales')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => { invalidateRpcCache(); fetchAverages(); })
            .subscribe();
        return () => { supabase.removeChannel(channel); };
    }, [fetchAverages]);

    const officeOptions = useMemo(() => [{ value: 'Toutes', label: 'Tout le réseau' }, ...OFFICES], []);
    // "Interne" first, then the current sales team by name. Former staff and
    // internal billing live behind "Interne" rather than as 20 more rows.
    const repFilter = useRepFilter(selectedReps, uniqueReps);
    const repOptions = repFilter.options;
    const yearOptions = [2025, 2026].map(y => ({ value: String(y), label: String(y) }));

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            {/* Header */}
            <div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">Moyennes Trimestrielles</h1>
                        <p className="text-xs md:text-sm text-ink-mute mt-0.5">Analyse comparative des performances par trimestre.</p>
                    </div>
                    {/* Exports every quarter at once, filters applied - the four
                        blocks on screen are one dataset split for reading. */}
                    <ExportButton
                        rows={groupedYoyData} columns={YOY_CSV}
                        filename="moyennes_trimestrielles" disabled={groupedYoyData.length === 0}
                    />
                </div>
            </div>

            {/* Filters */}
            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={(v) => setYear(Number(v))} options={yearOptions} variant="accent" className="w-24" />
                </FilterGroup>
                <FilterGroup label="Siège">
                    <Select value={selectedOffice} onChange={setSelectedOffice} options={officeOptions} className="w-44" />
                </FilterGroup>
                <FilterGroup label="Représentant">
                    <MultiSelect values={repFilter.selected} onChange={setSelectedReps} options={repOptions}
                                 allLabel={REP_ALL_LABEL} allIcon={repFilter.allIcon} className="w-48" />
                </FilterGroup>
            </FilterBar>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-primary-press" />
                    <p className="text-sm text-ink-mute font-medium">Calcul des moyennes...</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                    {[1, 2, 3, 4].map((q) => {
                        const dataForQuarter = groupedYoyData
                            .filter(d => d.quarter === q)
                            .filter(d => repFilter.matches(d.rep_name));
                        return (
                            <QuarterBlock
                                key={`q${q}`}
                                quarter={q}
                                data={dataForQuarter}
                                currentYear={year}
                                previousTotalOverride={repFilter.isAll ? previousTotalByQuarter.get(q) : undefined}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
}
