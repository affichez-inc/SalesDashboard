import { useMemo } from 'react';
import { formatCurrencyCAD, formatPercentage, cn } from '../../lib/utils';
import type { SommaireRow } from '../../types/database';
import { MONTHS } from '../../lib/constants';
import { useSort } from '../../hooks/useSort';
import { SortIcon } from '../SortIcon';
import { ExportButton } from '../ExportButton';
import type { CsvColumn } from '../../lib/csv';

interface SommaireTableRow {
    label: string;
    month: number;
    prevYear: number;
    actual_amount: number;
    delta: number;
    objectif: number;
    pct_atteint: number;
    deal_count: number;
}

const SOMMAIRE_CSV: CsvColumn<SommaireTableRow>[] = [
    { header: 'Mois',            value: r => r.label },
    { header: 'Annee precedente', value: r => r.prevYear },
    { header: 'Realise',         value: r => r.actual_amount },
    { header: 'Variation',       value: r => r.delta },
    { header: 'Objectif',        value: r => r.objectif },
    { header: 'Atteinte (%)',    value: r => r.pct_atteint },
    { header: 'Documents',       value: r => r.deal_count },
];

export function SommaireTable({
    title,
    data,
    prevYearData,
    year,
    selectedMonth,
    dealLabel = 'devis',
}: {
    title: string;
    data: SommaireRow[];
    prevYearData?: SommaireRow[];
    year: number;
    selectedMonth?: number | 'Toutes';
    dealLabel?: string;
}) {
    const displayMonths = useMemo(
        () => selectedMonth && selectedMonth !== 'Toutes'
            ? MONTHS.filter(m => m.value === selectedMonth)
            : MONTHS,
        [selectedMonth]
    );

    // Build a record of rows for easier sorting
    const rowsWithData = useMemo<SommaireTableRow[]>(() => {
        return displayMonths.map(monthObj => {
            const row = data.find(d => d.month === monthObj.value) || {
                month: monthObj.value, objectif: 0, actual_amount: 0, pct_atteint: 0, deal_count: 0
            };
            const prevRow = prevYearData?.find(d => d.month === monthObj.value);
            const prevYearAmt = Number(prevRow?.actual_amount || 0);
            const actualAmt = Number(row.actual_amount || 0);
            return {
                label: monthObj.label,
                month: monthObj.value,
                prevYear: prevYearAmt,
                actual_amount: actualAmt,
                delta: actualAmt - prevYearAmt,
                objectif: Number(row.objectif || 0),
                pct_atteint: Number(row.pct_atteint || 0),
                deal_count: Number(row.deal_count || 0)
            };
        });
    }, [data, prevYearData, displayMonths]);

    const { sortedData, sortConfig, handleSort } = useSort<SommaireTableRow>(rowsWithData);

    let totalObjectif = 0;
    let totalActual = 0;
    let totalPrevYear = 0;
    let totalDeals = 0;

    displayMonths.forEach(m => {
        const rowData = data.find(d => d.month === m.value);
        if (rowData) {
            totalObjectif += Number(rowData.objectif || 0);
            totalActual += Number(rowData.actual_amount || 0);
            totalDeals += Number(rowData.deal_count || 0);
        }
        const prevRow = prevYearData?.find(d => d.month === m.value);
        if (prevRow) {
            totalPrevYear += Number(prevRow.actual_amount || 0);
        }
    });

    const totalPct = totalObjectif > 0 ? (totalActual / totalObjectif) * 100 : 0;
    const totalDelta = totalActual - totalPrevYear;
    const totalDeltaPct = totalPrevYear > 0 ? Math.round((totalDelta / totalPrevYear) * 100) : null;

    const getPctStyle = (pct: number) => {
        if (pct >= 90) return 'text-tone-good-ink bg-tone-good-soft';
        if (pct >= 50) return 'text-tone-warn-ink bg-tone-warn-soft';
        return 'text-ink-mute bg-sand';
    };

    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
            {/* Card header */}
            <div className="px-5 py-3.5 border-b border-hairline flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink-secondary uppercase tracking-label">{title}</h2>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-mute font-medium" translate="no">
                        {displayMonths.length === 1 ? displayMonths[0].label : `${year}`}
                    </span>
                    {/* Exports the rows as sorted on screen, so the file matches
                        what the reader is looking at rather than the raw order. */}
                    <ExportButton
                        rows={sortedData} columns={SOMMAIRE_CSV}
                        filename={`sommaire_${year}`} label="CSV"
                        disabled={sortedData.length === 0}
                    />
                </div>
            </div>

            {/* Table with horizontal scroll on mobile */}
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hairline">
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-left text-xs font-semibold text-ink-mute uppercase tracking-eyebrow sticky left-0 bg-white z-10 whitespace-nowrap">
                                Période
                            </th>
                            <th
                                className="px-3 md:px-5 py-2.5 md:py-3 text-right text-xs font-semibold text-ink-mute uppercase tracking-eyebrow cursor-pointer hover:bg-sand transition-colors group whitespace-nowrap"
                                onClick={() => handleSort('actual_amount')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    {year} <SortIcon order={sortConfig.key === 'actual_amount' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th
                                className="px-3 md:px-5 py-2.5 md:py-3 text-right text-xs font-semibold text-ink-mute uppercase tracking-eyebrow cursor-pointer hover:bg-sand transition-colors group whitespace-nowrap"
                                onClick={() => handleSort('objectif')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    Objectif <SortIcon order={sortConfig.key === 'objectif' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th
                                className="px-3 md:px-5 py-2.5 md:py-3 text-right text-xs font-semibold text-ink-mute uppercase tracking-eyebrow cursor-pointer hover:bg-sand transition-colors group whitespace-nowrap"
                                onClick={() => handleSort('pct_atteint')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    % Atteint <SortIcon order={sortConfig.key === 'pct_atteint' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-right text-xs font-semibold text-ink-mute uppercase tracking-eyebrow select-none whitespace-nowrap">
                                {year - 1}
                            </th>
                            <th
                                className="px-3 md:px-5 py-2.5 md:py-3 text-right text-xs font-semibold text-ink-mute uppercase tracking-eyebrow cursor-pointer hover:bg-sand transition-colors group whitespace-nowrap"
                                onClick={() => handleSort('delta')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    vs {year - 1} <SortIcon order={sortConfig.key === 'delta' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th
                                className="px-3 md:px-5 py-2.5 md:py-3 text-right text-xs font-semibold text-ink-mute uppercase tracking-eyebrow cursor-pointer hover:bg-sand transition-colors group whitespace-nowrap"
                                onClick={() => handleSort('deal_count')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    {dealLabel.charAt(0).toUpperCase() + dealLabel.slice(1)} <SortIcon order={sortConfig.key === 'deal_count' ? sortConfig.order : null} />
                                </div>
                            </th>
                        </tr>
                    </thead>
                    {/* translate="no": Chrome Translate swaps these figures' text nodes for
                        its own, and React then crashes the screen removing one when a
                        filter changes the rows. */}
                    <tbody className="divide-y divide-hairline" translate="no">
                        {sortedData.map((row) => {
                            const pct = row.pct_atteint;
                            const hasData = row.actual_amount > 0;

                            return (
                                <tr key={row.month} className="hover:bg-sand/60 transition-colors">
                                    <td className="px-3 md:px-5 py-2 md:py-3 font-medium text-ink-secondary sticky left-0 bg-white z-10 whitespace-nowrap">{row.label}</td>
                                    <td className={cn("px-3 md:px-5 py-2 md:py-3 text-right tabular-nums font-medium whitespace-nowrap", hasData ? "text-ink" : "text-ink-mute")}>
                                        {formatCurrencyCAD(row.actual_amount)}
                                    </td>
                                    <td className="px-3 md:px-5 py-2 md:py-3 text-right text-ink-mute tabular-nums text-xs whitespace-nowrap">{formatCurrencyCAD(row.objectif)}</td>
                                    <td className="px-3 md:px-5 py-2 md:py-3 text-right">
                                        {hasData ? (
                                            <span className={cn("inline-block px-2 py-0.5 rounded-md text-xs font-semibold tabular-nums", getPctStyle(pct))}>
                                                {formatPercentage(pct)}
                                            </span>
                                        ) : (
                                            <span className="text-ink-faint text-xs">—</span>
                                        )}
                                    </td>
                                    <td className={cn("px-3 md:px-5 py-2 md:py-3 text-right tabular-nums whitespace-nowrap", row.prevYear > 0 ? "text-ink-mute" : "text-ink-mute")}>{formatCurrencyCAD(row.prevYear)}</td>
                                    <td className="px-3 md:px-5 py-2 md:py-3 text-right">
                                        {row.prevYear > 0 ? (
                                            <div className="flex flex-col items-end gap-0.5">
                                                <span className={cn(
                                                    "text-xs font-semibold tabular-nums whitespace-nowrap",
                                                    row.delta > 0 ? "text-tone-good-ink" : row.delta < 0 ? "text-tone-critical" : "text-ink-mute"
                                                )}>
                                                    {row.delta > 0 ? '+' : ''}{formatCurrencyCAD(row.delta)}
                                                </span>
                                                <span className={cn(
                                                    "text-2xs font-bold tabular-nums",
                                                    row.delta > 0 ? "text-tone-good" : row.delta < 0 ? "text-tone-critical" : "text-ink-faint"
                                                )}>
                                                    {row.delta > 0 ? '+' : ''}{Math.round((row.delta / row.prevYear) * 100)}%
                                                </span>
                                            </div>
                                        ) : (
                                            <span className="text-ink-faint text-xs">—</span>
                                        )}
                                    </td>
                                    <td className="px-3 md:px-5 py-2 md:py-3 text-right whitespace-nowrap">
                                        {row.deal_count > 0 ? (
                                            <>
                                                <span className="text-sm font-bold text-ink-secondary tabular-nums">{row.deal_count}</span>
                                                <span className="text-2xs text-ink-mute ml-1">{dealLabel}</span>
                                            </>
                                        ) : (
                                            <span className="text-ink-faint text-xs">—</span>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                    <tfoot translate="no">
                        <tr className="bg-ink text-white font-bold">
                            <td className="px-3 md:px-5 py-3 md:py-4 text-xs uppercase tracking-label sticky left-0 bg-ink z-10">Total</td>
                            <td className="px-3 md:px-5 py-3 md:py-4 text-right font-bold tabular-nums whitespace-nowrap">{formatCurrencyCAD(totalActual)}</td>
                            <td className="px-3 md:px-5 py-3 md:py-4 text-right text-white/70 tabular-nums text-xs whitespace-nowrap">{formatCurrencyCAD(totalObjectif)}</td>
                            <td className="px-3 md:px-5 py-3 md:py-4 text-right">
                                <span className={cn(
                                    "inline-block px-2 py-1 rounded-md text-xs font-bold tabular-nums border border-white/20",
                                    totalPct >= 90 ? "bg-tone-good text-white" : "bg-tone-warn text-ink"
                                )}>
                                    {formatPercentage(totalPct)}
                                </span>
                            </td>
                            <td className="px-3 md:px-5 py-3 md:py-4 text-right text-white/50 tabular-nums text-sm whitespace-nowrap">{formatCurrencyCAD(totalPrevYear)}</td>
                            <td className="px-3 md:px-5 py-3 md:py-4 text-right">
                                {totalPrevYear > 0 ? (
                                    <div className="flex flex-col items-end gap-0.5">
                                        <span className={cn(
                                            "text-xs font-bold tabular-nums whitespace-nowrap",
                                            totalDelta > 0 ? "text-tone-good" : totalDelta < 0 ? "text-tone-critical-soft" : "text-white/50"
                                        )}>
                                            {totalDelta > 0 ? '+' : ''}{formatCurrencyCAD(totalDelta)}
                                        </span>
                                        {totalDeltaPct !== null && (
                                            <span className={cn(
                                                "text-2xs font-bold tabular-nums",
                                                totalDelta > 0 ? "text-tone-good" : totalDelta < 0 ? "text-tone-critical-soft" : "text-white/50"
                                            )}>
                                                {totalDelta > 0 ? '+' : ''}{totalDeltaPct}%
                                            </span>
                                        )}
                                    </div>
                                ) : (
                                    <span className="text-white/50">—</span>
                                )}
                            </td>
                            <td className="px-3 md:px-5 py-3 md:py-4 text-right whitespace-nowrap">
                                <span className="text-sm font-bold tabular-nums">{totalDeals}</span>
                                <span className="text-2xs text-white/60 ml-1">{dealLabel}</span>
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}
