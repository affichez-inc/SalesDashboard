import { formatCurrencyCAD, cn } from '../../lib/utils';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { YoYRow } from '../../types/database';
import { useSort } from '../../hooks/useSort';
import { SortIcon } from '../SortIcon';
import { ExportButton } from '../ExportButton';
import type { CsvColumn } from '../../lib/csv';
import { RepName } from '../../components/RepAvatar';

const QUARTER_CSV: CsvColumn<YoYRow>[] = [
    { header: 'Trimestre',          value: r => r.quarter },
    { header: 'Representant',       value: r => r.rep_name },
    { header: 'Bureau',             value: r => r.office },
    { header: 'Documents',          value: r => r.deal_count },
    { header: 'Moyenne courante',   value: r => r.current_avg },
    { header: 'Moyenne precedente', value: r => r.previous_avg },
    { header: 'Ecart (%)',          value: r => r.resultat },
];

export function QuarterBlock({
    quarter,
    data,
    currentYear,
    dealLabel = 'devis',
    previousTotalOverride,
}: {
    quarter: number;
    data: YoYRow[];
    currentYear: number;
    dealLabel?: string;
    // When provided (whole-team view), the "Total équipe" last-year figure uses the
    // true company total for the year - including reps who left or had a dry quarter -
    // instead of only summing the reps shown this year. See get_quarterly_yoy_totals.
    // null means the comparison year has no fiscal calendar, so there is nothing
    // to compare against - distinct from undefined, which means "no override given".
    previousTotalOverride?: number | null;
}) {
    const previousYear = currentYear - 1;
    const { sortedData, sortConfig, handleSort } = useSort(data);

    const totalCurrent = data.reduce((sum, row) => sum + Number(row.current_avg || 0), 0);

    // A year nobody defined a calendar for is unknown, not zero. Printing 0 here
    // is what let the 2025 page show four green gains against a year that was
    // never queried - see STATS-INTEGRITY.md.
    const prevUnavailable = previousTotalOverride === null
        || (previousTotalOverride === undefined
            && data.length > 0 && data.every(row => row.previous_avg === null));

    const totalPrevious = prevUnavailable
        ? null
        : previousTotalOverride ?? data.reduce((sum, row) => sum + Number(row.previous_avg || 0), 0);
    const totalResultat = totalPrevious === null ? null : totalCurrent - totalPrevious;
    const totalDeals = data.reduce((sum, row) => sum + Number(row.deal_count || 0), 0);

    const getStyle = (val: number) => {
        if (val > 0) return 'text-tone-good-ink bg-tone-good-soft';
        if (val < 0) return 'text-tone-critical bg-tone-critical-soft';
        return 'text-ink-mute bg-sand';
    };

    const getIcon = (val: number) => {
        if (val > 0) return <TrendingUp className="w-3.5 h-3.5 inline mr-1" />;
        if (val < 0) return <TrendingDown className="w-3.5 h-3.5 inline mr-1" />;
        return <Minus className="w-3.5 h-3.5 inline mr-1" />;
    };

    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden flex flex-col">
            <div className="px-5 py-3.5 border-b border-hairline flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink-secondary uppercase tracking-label">Trimestre {quarter}</h2>
                <div className="flex items-center gap-2">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-primary-wash text-primary-press"
                          translate="no">
                        Q{quarter} · {currentYear}
                    </span>
                    <ExportButton
                        rows={sortedData} columns={QUARTER_CSV}
                        filename={`trimestre_${quarter}_${currentYear}`} label="CSV"
                        disabled={sortedData.length === 0}
                    />
                </div>
            </div>

            <div className="flex-1 overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hairline bg-sand/50">
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-left text-xs font-semibold text-ink-mute uppercase tracking-eyebrow sticky left-0 bg-sand/50 z-10">
                                Représentant
                            </th>
                            <th
                                className="px-4 py-3 text-right text-xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap cursor-pointer hover:bg-stone transition-colors group"
                                onClick={() => handleSort('deal_count')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    {dealLabel.charAt(0).toUpperCase() + dealLabel.slice(1)} <SortIcon order={sortConfig.key === 'deal_count' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th
                                className="px-4 py-3 text-right text-xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap cursor-pointer hover:bg-stone transition-colors group"
                                onClick={() => handleSort('current_avg')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    {currentYear} <SortIcon order={sortConfig.key === 'current_avg' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th
                                className="px-4 py-3 text-right text-xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap cursor-pointer hover:bg-stone transition-colors group"
                                onClick={() => handleSort('previous_avg')}
                            >
                                <div className="flex items-center justify-end gap-2 text-ink-faint">
                                    {previousYear} <SortIcon order={sortConfig.key === 'previous_avg' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th
                                className="px-4 py-3 text-right text-xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap cursor-pointer hover:bg-stone transition-colors group"
                                onClick={() => handleSort('resultat')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    Δ Résultat <SortIcon order={sortConfig.key === 'resultat' ? sortConfig.order : null} />
                                </div>
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline" translate="no">
                        {sortedData.length === 0 ? (
                            <tr>
                                <td colSpan={4} className="px-5 py-8 text-center text-sm text-ink-mute italic">
                                    Aucune donnée pour ce trimestre
                                </td>
                            </tr>
                        ) : (
                            sortedData.map((row, idx) => {
                                // null = the comparison year has no calendar. "—", not 0.
                                const res = row.resultat === null ? null : Number(row.resultat);
                                return (
                                    <tr key={idx} className="hover:bg-sand/60 transition-colors group">
                                        <td className="px-3 md:px-5 py-2.5 md:py-3 font-medium text-ink-secondary whitespace-nowrap sticky left-0 bg-white z-10"><RepName name={row.rep_name} size="sm" /></td>
                                        <td className="px-4 py-3 text-right whitespace-nowrap">
                                            <span className="text-sm font-bold text-ink-secondary tabular-nums">{row.deal_count}</span>
                                            <span className="text-2xs text-ink-mute ml-1">{Number(row.deal_count) > 1 && !dealLabel.endsWith('s') ? dealLabel + 's' : dealLabel}</span>
                                        </td>
                                        <td className="px-4 py-3 text-right font-semibold text-ink tabular-nums group-hover:text-primary-press transition-colors whitespace-nowrap">
                                            {formatCurrencyCAD(row.current_avg)}
                                        </td>
                                        <td className="px-4 py-3 text-right text-ink-mute tabular-nums whitespace-nowrap">
                                            {row.previous_avg === null ? '—' : formatCurrencyCAD(row.previous_avg)}
                                        </td>
                                        <td className="px-4 py-3 text-right whitespace-nowrap">
                                            {res === null ? (
                                                <span className="text-ink-mute tabular-nums">—</span>
                                            ) : (
                                                <span className={cn("inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold tabular-nums", getStyle(res))}>
                                                    {getIcon(res)}{formatCurrencyCAD(Math.abs(res))}
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                    <tfoot translate="no">
                        <tr className="bg-ink text-white font-bold">
                            <td className="px-3 md:px-5 py-3 md:py-3.5 text-xs uppercase tracking-label sticky left-0 bg-ink z-10">Total équipe</td>
                            <td className="px-4 py-3.5 text-right whitespace-nowrap">
                                <span className="text-sm font-bold tabular-nums">{totalDeals}</span>
                                <span className="text-2xs text-white/60 ml-1">{totalDeals > 1 && !dealLabel.endsWith('s') ? dealLabel + 's' : dealLabel}</span>
                            </td>
                            <td className="px-4 py-3.5 text-right font-bold tabular-nums whitespace-nowrap">{formatCurrencyCAD(totalCurrent)}</td>
                            <td className="px-4 py-3.5 text-right text-white/50 tabular-nums whitespace-nowrap">
                                {totalPrevious === null ? '—' : formatCurrencyCAD(totalPrevious)}
                            </td>
                            <td className="px-4 py-3.5 text-right whitespace-nowrap">
                                {totalResultat === null ? (
                                    <span className="text-white/50 tabular-nums">—</span>
                                ) : (
                                    <span className={cn(
                                        "inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold tabular-nums border border-white/20",
                                        totalResultat >= 0 ? "bg-tone-good text-white" : "bg-tone-critical text-white"
                                    )}>
                                        {getIcon(totalResultat)}{formatCurrencyCAD(Math.abs(totalResultat))}
                                    </span>
                                )}
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}
