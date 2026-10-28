import { useEffect, useState, useMemo, useCallback } from 'react';
import { useUrlState, useUrlStateNumber, useUrlList } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import { Loader2 } from 'lucide-react';
import type { YoYRow, QuarterTotalsRow } from '../types/database';
import { QuarterBlock } from '../components/quarterly/QuarterBlock';
import { OFFICES } from '../lib/constants';
import { useRepTeam, INTERNAL_LABEL } from '../lib/repTeam';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { MultiSelect } from '../components/MultiSelect';
import { useAuth } from '../contexts/AuthContext';
import { useRepFilter, REP_ALL_LABEL } from '../hooks/useRepFilter';

export default function FQuarterlyAverages() {
    const { isAdmin, repName: authRepName } = useAuth();

    const [year, setYear] = useUrlStateNumber('year', 2026);
    const [selectedOffice, setSelectedOffice] = useUrlState('office', 'Toutes');
    // Admin only; a rep is pinned to their own name, whatever the URL says.
    const [selectedReps, setSelectedReps] = useUrlList('rep');
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
            venteInterneRows.push({
                quarter,
                rep_name: INTERNAL_LABEL,
                office: '—',
                current_avg,
                previous_avg,
                resultat: current_avg - previous_avg,
                deal_count: totalCount,
            });
        }
        return [...others, ...venteInterneRows];
    }, [yoyData, repTeam]);

    const uniqueReps = useMemo(() => {
        const reps = new Set<string>();
        groupedYoyData.forEach(row => reps.add(row.rep_name));
        return Array.from(reps).sort((a, b) => a.localeCompare(b));
    }, [groupedYoyData]);

    // "Interne" first, then the current sales team by name. Former staff and
    // internal billing live behind "Interne" rather than as 20 more rows.
    const repFilter = useRepFilter(selectedReps, uniqueReps);
    const repOptions = repFilter.options;
    // One rep is asked for by name. A group or several reps need every rep's
    // rows, so they are fetched unfiltered and narrowed here.
    const repParam = isAdmin ? repFilter.rep : (authRepName ?? null);

    const fetchAverages = useCallback(async () => {
        setLoading(true);
        const p_office = selectedOffice === 'Toutes' ? null : selectedOffice;
        const [{ data, error }, totalsRes] = await Promise.all([
            cachedRpc('get_inv_quarterly_yoy', { p_year: year, p_office, p_status: null, p_rep: repParam }),
            // True whole-team totals only matter for the admin "Tous" view.
            isAdmin
                ? cachedRpc('get_inv_quarterly_yoy_totals', { p_year: year, p_office, p_status: null })
                : Promise.resolve({ data: [] as QuarterTotalsRow[], error: null }),
        ]);
        if (error) console.error('Error fetching invoice quarterly averages:', error);
        else setYoyData(data || []);
        if (totalsRes.error) console.error('Error fetching invoice quarterly team totals:', totalsRes.error);
        else setTeamTotals(totalsRes.data || []);
        setLoading(false);
    }, [year, selectedOffice, repParam, isAdmin]);

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
        const channel = supabase.channel('inv-quarterly')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, () => { invalidateRpcCache(); fetchAverages(); })
            .subscribe();
        return () => { supabase.removeChannel(channel); };
    }, [fetchAverages]);

    const officeOptions = useMemo(() => [{ value: 'Toutes', label: 'Tout le réseau' }, ...OFFICES], []);
    const yearOptions = [2025, 2026].map(y => ({ value: String(y), label: String(y) }));

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold text-ink tracking-tight">
                        Factures · Moyennes Trimestrielles
                        {!isAdmin && authRepName && <span className="ml-2 text-base font-normal text-ink-mute">({authRepName})</span>}
                    </h1>
                    <p className="text-sm text-ink-mute mt-0.5">Analyse comparative des factures moyennes par trimestre.</p>
                </div>
            </div>

            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={(v) => setYear(Number(v))} options={yearOptions} variant="accent" className="w-24" />
                </FilterGroup>
                <FilterGroup label="Siège">
                    <Select value={selectedOffice} onChange={setSelectedOffice} options={officeOptions} className="w-44" />
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
                    <p className="text-sm text-ink-mute font-medium">Calcul des moyennes...</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                    {[1, 2, 3, 4].map((q) => {
                        const dataForQuarter = groupedYoyData
                            .filter(d => d.quarter === q)
                            .filter(d => !isAdmin || repFilter.matches(d.rep_name));
                        return (
                            <QuarterBlock
                                key={`q${q}`}
                                quarter={q}
                                data={dataForQuarter}
                                currentYear={year}
                                dealLabel="facture"
                                previousTotalOverride={isAdmin && repFilter.isAll ? previousTotalByQuarter.get(q) : undefined}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
}
