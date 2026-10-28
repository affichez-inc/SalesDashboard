import { useState, useEffect, useCallback } from 'react';
import { useUrlStateNumber } from '../hooks/useUrlState';
import { Target, Loader2, FileText, User, BarChart2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { cachedRpc } from '../lib/rpcCache';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { DEPARTMENTS } from '../lib/constants';
import { ExportButton } from '../components/ExportButton';
import { autoColumns } from '../lib/csv';

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_LABELS = [
    'Janvier','Février','Mars','Avril','Mai','Juin',
    'Juillet','Août','Septembre','Octobre','Novembre','Décembre',
];
const MONTH_SHORT = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

const NOW_MONTH = new Date().getMonth() + 1;
const NOW_YEAR  = new Date().getFullYear();

// compact number: 125000 → "125k", 1600 → "1,6k"
function fmtK(v: number): string {
    if (v <= 0) return '';
    if (v >= 1000) {
        const k = v / 1000;
        return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
    }
    return String(Math.round(v));
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface MonthRow {
    month: number;
    label: string;
    target: number;
    actual: number;
    prevActual: number;
}

type DeptMonthData = Record<string, Record<number, { target: number; actual: number; prevActual: number }>>;

interface Props { propRepName?: string; }

// ─── Sub-components ───────────────────────────────────────────────────────────

function Progress({ actual, target }: { actual: number; target: number }) {
    if (target <= 0) return <span className="text-ink-faint text-xs">—</span>;
    const pct = Math.round((actual / target) * 100);
    const clamped = Math.min(pct, 100);
    const color = pct >= 100 ? 'bg-tone-good' : pct >= 70 ? 'bg-tone-warn' : 'bg-tone-critical';
    const textColor = pct >= 100 ? 'text-tone-good-ink' : pct >= 70 ? 'text-tone-warn-ink' : 'text-tone-critical';
    return (
        <div className="flex items-center gap-2 min-w-[90px]">
            <div className="flex-1 h-1.5 bg-stone rounded-full overflow-hidden">
                <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${clamped}%` }} />
            </div>
            <span className={cn('text-xs font-bold tabular-nums w-9 text-right', textColor)}>{pct}%</span>
        </div>
    );
}

function getMotivation(pct: number): { text: string; emoji: string } {
    if (pct >= 100) return { text: 'Objectif atteint! Tu es une légende!', emoji: '🏆' };
    if (pct >= 75)  return { text: 'Presque là, donne tout!',              emoji: '🚀' };
    if (pct >= 50)  return { text: 'À mi-chemin, continue!',               emoji: '🎯' };
    return                  { text: "T'es une machine, lâche pas!",         emoji: '💪' };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PortailObjectifs({ propRepName }: Props) {
    const { repName: authRepName, isAdmin } = useAuth();
    const { viewAsRep } = useAdminView();
    const repName = propRepName ?? viewAsRep ?? authRepName ?? '';

    const [year, setYear] = useUrlStateNumber('year', NOW_YEAR);
    const [loading, setLoading] = useState(true);
    const [rows, setRows]       = useState<MonthRow[]>([]);
    const [deptData, setDeptData] = useState<DeptMonthData>({});
    /** Departments actually present, standard list plus anything the data adds. */
    const [deptKeys, setDeptKeys] = useState<string[]>([...DEPARTMENTS]);

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));
    const prevYear = year - 1;

    // ─── Fetch ───────────────────────────────────────────────────────────────

    const fetchAll = useCallback(async () => {
        if (!repName) { setLoading(false); return; }
        setLoading(true);

        const [objRes, deptObjRes, factRes, factDeptRes, prevFactRes, prevDeptRes] = await Promise.all([
            supabase.from('rep_objectives').select('month, target_amount')
                .eq('rep_name', repName).eq('year', year).eq('module', 'factures'),
            supabase.from('rep_objectives_dept').select('month, department, target_amount')
                .eq('rep_name', repName).eq('year', year).eq('module', 'factures'),
            cachedRpc('get_inv_sommaire_grand_total', { p_year: year, p_office: null, p_status: null, p_rep: repName }),
            cachedRpc('get_rep_dept_actuals_factures', { p_rep: repName, p_year: year }),
            // Previous year actuals
            cachedRpc('get_inv_sommaire_grand_total', { p_year: prevYear, p_office: null, p_status: null, p_rep: repName }),
            cachedRpc('get_rep_dept_actuals_factures', { p_rep: repName, p_year: prevYear }),
        ]);

        const objMap: Record<number, number> = {};
        for (const o of (objRes.data ?? [])) objMap[o.month] = Number(o.target_amount);

        const dObjMap: Record<string, number> = {};
        for (const o of (deptObjRes.data ?? [])) dObjMap[`${o.month}-${o.department}`] = Number(o.target_amount);

        const factMap: Record<number, number> = {};
        for (const f of (factRes.data ?? [])) factMap[f.month] = Number(f.actual_amount);

        const factActMap: Record<string, number> = {};
        for (const f of (factDeptRes.data ?? [])) factActMap[`${f.month}-${f.department}`] = Number(f.actual_amount);

        const prevFactMap: Record<number, number> = {};
        for (const f of (prevFactRes.data ?? [])) prevFactMap[f.month] = Number(f.actual_amount);

        const prevDeptActMap: Record<string, number> = {};
        for (const f of (prevDeptRes.data ?? [])) prevDeptActMap[`${f.month}-${f.department}`] = Number(f.actual_amount);

        // Monthly rows
        setRows(MONTH_LABELS.map((label, i) => {
            const m = i + 1;
            const deptSum = DEPARTMENTS.reduce((s, d) => s + (dObjMap[`${m}-${d}`] ?? 0), 0);
            const target  = deptSum > 0 ? deptSum : (objMap[m] ?? 0);
            return { month: m, label, target, actual: factMap[m] ?? 0, prevActual: prevFactMap[m] ?? 0 };
        }));

        // Every department the data mentions, on top of the standard list.
        // get_rep_dept_actuals_factures returns "Non assigné" for billing whose
        // department Zoho never set, and it is counted in the total above these
        // cards - so leaving it out is what made them fail to add up.
        const seen = new Set<string>(DEPARTMENTS);
        for (const f of (factDeptRes.data ?? [])) seen.add(String(f.department));
        for (const f of (prevDeptRes.data ?? [])) seen.add(String(f.department));
        for (const k of Object.keys(dObjMap)) seen.add(k.slice(k.indexOf('-') + 1));
        const deptList = [...seen].filter(Boolean);
        setDeptKeys(deptList);

        // Dept × month matrix
        const dd: DeptMonthData = {};
        for (const dept of deptList) {
            dd[dept] = {};
            for (let m = 1; m <= 12; m++) {
                dd[dept][m] = {
                    target:     dObjMap[`${m}-${dept}`] ?? 0,
                    actual:     factActMap[`${m}-${dept}`] ?? 0,
                    prevActual: prevDeptActMap[`${m}-${dept}`] ?? 0,
                };
            }
        }
        setDeptData(dd);
        setLoading(false);
    }, [repName, year, prevYear]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchAll(); }, [fetchAll]);

    // ─── Derived ──────────────────────────────────────────────────────────────

    const totals = rows.reduce(
        (acc, r) => ({ target: acc.target + r.target, actual: acc.actual + r.actual, prevActual: acc.prevActual + r.prevActual }),
        { target: 0, actual: 0, prevActual: 0 }
    );
    const pct = totals.target > 0 ? Math.round((totals.actual / totals.target) * 100) : 0;
    const { text: motivText, emoji: motivEmoji } = getMotivation(pct);

    const hasDeptData = deptKeys.some(dept =>
        Object.values(deptData[dept] ?? {}).some(({ target, actual, prevActual }) => target !== 0 || actual !== 0 || prevActual !== 0)
    );

    // ─── Guard ────────────────────────────────────────────────────────────────

    if (!repName && !isAdmin) {
        return (
            <div className="p-4 md:p-8 max-w-screen-xl mx-auto flex items-center justify-center min-h-[60vh]">
                <div className="text-center space-y-3">
                    <div className="w-14 h-14 rounded-xl bg-stone flex items-center justify-center mx-auto">
                        <User className="w-7 h-7 text-ink-faint" />
                    </div>
                    <h2 className="text-base font-semibold text-ink-secondary">Portail non configuré</h2>
                    <p className="text-sm text-ink-mute max-w-xs">Votre compte n'est pas encore associé à un représentant. Contactez un administrateur.</p>
                </div>
            </div>
        );
    }

    // ─── Render ───────────────────────────────────────────────────────────────

    return (
        <div className="p-4 md:p-8 max-w-screen-xl mx-auto space-y-5 md:space-y-6">

            {/* ── Hero banner ── */}
            <div className="relative overflow-hidden bg-primary rounded-xl p-6 md:p-8 text-white shadow-lg">
                <div className="relative flex flex-col gap-5">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                        <div>
                            <div className="flex items-center gap-2 mb-1.5">
                                <Target className="w-4 h-4 text-white" />
                                <span className="text-2xs font-semibold uppercase tracking-eyebrow text-white">
                                    Mes Objectifs Factures {year}
                                </span>
                            </div>
                            <h1 className="text-2xl md:text-3xl font-semibold leading-tight text-white">{repName || 'Représentant'}</h1>
                            <p className="text-white mt-2 text-sm md:text-base flex items-center gap-2 flex-wrap">
                                <span>{motivText}</span>
                                <span className="text-lg">{motivEmoji}</span>
                            </p>
                        </div>
                    </div>
                    {/* KPI */}
                    <div className="bg-black/20 rounded-md p-4 md:p-5 flex items-center justify-between gap-6 flex-wrap">
                        <div className="flex items-center gap-3">
                            <FileText className="w-5 h-5 text-white shrink-0" />
                            <div>
                                <p className="text-2xs font-semibold uppercase tracking-eyebrow text-white">Total Facturé {year}</p>
                                <p className="text-2xl md:text-3xl font-bold tabular-nums leading-none mt-0.5">
                                    {formatCurrencyCAD(totals.actual)}
                                </p>
                                <p className="text-2xs text-white mt-1">
                                    {totals.target > 0
                                        ? `sur ${formatCurrencyCAD(totals.target)} objectif`
                                        : 'Objectif non fixé : configurez dans Paramètres'}
                                    {totals.prevActual > 0 && (
                                        <span className="ml-2 opacity-70">· {formatCurrencyCAD(totals.prevActual)} en {prevYear}</span>
                                    )}
                                </p>
                            </div>
                        </div>
                        {totals.target > 0 && (
                            <div className="flex-1 min-w-[160px] max-w-xs">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-sm font-bold text-white">{pct}% atteint</span>
                                </div>
                                <div className="h-2.5 bg-white/20 rounded-full overflow-hidden">
                                    <div
                                        className={cn('h-full rounded-full transition-all duration-700',
                                            pct >= 100 ? 'bg-tone-good' : pct >= 70 ? 'bg-tone-warn' : 'bg-tone-critical'
                                        )}
                                        style={{ width: `${Math.min(pct, 100)}%` }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Filters ── */}
            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                </FilterGroup>
            </FilterBar>

            {!repName ? (
                <div className="flex flex-col items-center justify-center py-20 gap-2">
                    <Target className="w-8 h-8 text-ink-faint" />
                    <p className="text-sm text-ink-mute">Sélectionnez un représentant</p>
                </div>
            ) : loading ? (
                <div className="flex items-center justify-center py-20 gap-2">
                    <Loader2 className="w-6 h-6 animate-spin text-ink-faint" />
                    <span className="text-sm text-ink-mute">Chargement...</span>
                </div>
            ) : (
                <>
                    {/* ── Monthly totals table ── */}
                    <div className="bg-white rounded-xl shadow-card overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-hairline bg-sand/60">
                                        <th className="px-5 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Mois</th>
                                        <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">{prevYear}</th>
                                        <th className="px-4 py-3 text-right text-2xs font-semibold text-primary-press uppercase tracking-eyebrow">{year}</th>
                                        <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow border-l border-hairline">Objectif</th>
                                        <th className="px-4 py-3 text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow min-w-[130px]">Atteinte</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-hairline">
                                    {rows.map(row => {
                                        const isCurrent = row.month === NOW_MONTH && year === NOW_YEAR;
                                        return (
                                            <tr key={row.month} className={cn(
                                                'hover:bg-sand/60 transition-colors',
                                                isCurrent && 'bg-primary/5 hover:bg-primary/10'
                                            )}>
                                                <td className="px-5 py-3 font-semibold text-ink-secondary whitespace-nowrap">
                                                    <div className="flex items-center gap-2">
                                                        {isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
                                                        {row.label}
                                                        {isCurrent && (
                                                            <span className="text-2xs font-semibold uppercase tracking-label text-primary-press bg-primary/10 px-1.5 py-0.5 rounded-full">En cours</span>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 text-right tabular-nums text-ink-mute">
                                                    {row.prevActual > 0 ? (
                                                        <span className="text-xs font-medium">{formatCurrencyCAD(row.prevActual)}</span>
                                                    ) : (
                                                        <span className="text-ink-faint">—</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 text-right font-semibold tabular-nums text-ink">
                                                    {row.actual > 0 ? formatCurrencyCAD(row.actual) : <span className="text-ink-faint">—</span>}
                                                </td>
                                                <td className="px-4 py-3 text-right font-semibold tabular-nums text-ink-secondary border-l border-hairline">
                                                    {row.target > 0 ? formatCurrencyCAD(row.target) : <span className="text-ink-faint">—</span>}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <Progress actual={row.actual} target={row.target} />
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                                <tfoot>
                                    <tr className="border-t-2 border-hairline-strong bg-sand/80">
                                        <td className="px-5 py-3 text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Total {year}</td>
                                        <td className="px-4 py-3 text-right tabular-nums">
                                            {totals.prevActual > 0 ? (
                                                <span className="text-sm font-semibold text-ink-mute">{formatCurrencyCAD(totals.prevActual)}</span>
                                            ) : (
                                                <span className="text-ink-faint">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-right font-bold text-ink tabular-nums">
                                            {totals.actual > 0 ? formatCurrencyCAD(totals.actual) : <span className="text-ink-faint">—</span>}
                                        </td>
                                        <td className="px-4 py-3 text-right font-bold text-ink tabular-nums border-l border-hairline">
                                            {totals.target > 0 ? formatCurrencyCAD(totals.target) : <span className="text-ink-faint">—</span>}
                                        </td>
                                        <td className="px-4 py-3"><Progress actual={totals.actual} target={totals.target} /></td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </div>

                    {/* ── Department cards ── */}
                    <div className="space-y-3">
                        <div className="flex items-center gap-3">
                            <div className="w-7 h-7 rounded-md bg-stone flex items-center justify-center shrink-0">
                                <BarChart2 className="w-3.5 h-3.5 text-ink-mute" />
                            </div>
                            <div className="flex-1">
                                <h3 className="text-sm font-semibold text-ink">Répartition par département</h3>
                                <p className="text-xs text-ink-mute">
                                    <span className="text-ink-mute font-medium">{prevYear}</span>
                                    {' · '}<span className="text-primary-press font-medium">{year}</span>
                                    {' · '}Objectif
                                </p>
                            </div>
                        </div>

                        {!hasDeptData ? (
                            <div className="bg-white rounded-xl border border-hairline px-6 py-10 flex flex-col items-center gap-2 text-center">
                                <BarChart2 className="w-8 h-8 text-ink-faint" />
                                <p className="text-sm font-medium text-ink-mute">Aucun objectif par département configuré</p>
                                <p className="text-xs text-ink-faint">Rendez-vous dans Paramètres pour définir vos objectifs par département.</p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                <div className="flex justify-end">
                                    {/* One row per department per month: the flat shape
                                        a pivot table wants, rather than the card layout
                                        the screen uses. */}
                                    <ExportButton
                                        rows={deptKeys.flatMap(d =>
                                            Object.entries(deptData[d] ?? {}).map(([m, c]) => ({
                                                departement: d,
                                                mois: Number(m),
                                                realise: c.actual,
                                                objectif: c.target,
                                                annee_precedente: c.prevActual,
                                            })))}
                                        columns={autoColumns([{ departement: '', mois: 0, realise: 0, objectif: 0, annee_precedente: 0 }])}
                                        filename={`objectifs_par_departement_${year}`} label="CSV"
                                        disabled={deptKeys.length === 0}
                                    />
                                </div>
                                {deptKeys.map(dept => {
                                    const monthCells = deptData[dept] ?? {};
                                    // `!== 0`, not `> 0`. A department whose net is
                                    // NEGATIVE is still real: "Non assigné" holds refunds
                                    // whose department could not be traced, and the total
                                    // above these cards counts it. Skipping it left the
                                    // cards short by exactly that amount - which is the
                                    // discrepancy this page was reported for.
                                    const hasRow = Object.values(monthCells).some(c => c.target !== 0 || c.actual !== 0 || c.prevActual !== 0);
                                    if (!hasRow) return null;

                                    const rowTotal = Object.values(monthCells).reduce(
                                        (acc, c) => ({ target: acc.target + c.target, actual: acc.actual + c.actual, prevActual: acc.prevActual + c.prevActual }),
                                        { target: 0, actual: 0, prevActual: 0 }
                                    );
                                    const pct = rowTotal.target > 0 ? Math.round((rowTotal.actual / rowTotal.target) * 100) : null;
                                    const pctColor = pct === null ? '' : pct >= 100 ? 'text-tone-good-ink' : pct >= 70 ? 'text-tone-warn-ink' : 'text-tone-critical';
                                    const barColor = pct === null ? '' : pct >= 100 ? 'bg-tone-good' : pct >= 70 ? 'bg-tone-warn' : 'bg-tone-critical';

                                    return (
                                        <div key={dept} className="bg-white rounded-xl shadow-card overflow-hidden">

                                            {/* Card header */}
                                            <div className="px-5 py-3.5 border-b border-hairline bg-sand/50">
                                                <span className="text-sm font-bold text-ink">{dept}</span>
                                                <div className="flex items-start gap-0 mt-2 divide-x divide-hairline-strong">
                                                    <div className="pr-4">
                                                        <p className="text-2xs font-semibold text-ink-mute uppercase tracking-label">{year}</p>
                                                        <p className="text-sm font-bold text-ink tabular-nums leading-tight">{formatCurrencyCAD(rowTotal.actual)}</p>
                                                    </div>
                                                    {rowTotal.target > 0 && (
                                                        <div className="px-4">
                                                            <p className="text-2xs font-semibold text-ink-mute uppercase tracking-label">Objectif</p>
                                                            <p className="text-sm font-semibold text-ink-secondary tabular-nums leading-tight">{formatCurrencyCAD(rowTotal.target)}</p>
                                                        </div>
                                                    )}
                                                    {pct !== null && (
                                                        <div className="pl-4">
                                                            <p className="text-2xs font-semibold text-ink-mute uppercase tracking-label">Atteinte</p>
                                                            <div className="flex items-center gap-2 mt-1">
                                                                <div className="w-20 h-1.5 bg-hairline-strong rounded-full overflow-hidden">
                                                                    <div className={cn('h-full rounded-full', barColor)} style={{ width: `${Math.min(pct, 100)}%` }} />
                                                                </div>
                                                                <span className={cn('text-sm font-bold tabular-nums', pctColor)}>{pct}%</span>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Month table - one clean row per metric */}
                                            <div className="overflow-x-auto">
                                                <table className="w-full text-xs">
                                                    <thead>
                                                        <tr className="border-b border-hairline">
                                                            <th className="px-4 py-2 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow w-20 shrink-0" />
                                                            {MONTH_SHORT.map((m, i) => (
                                                                <th key={i} className={cn(
                                                                    'px-3 py-2 text-center text-2xs font-semibold uppercase tracking-eyebrow min-w-[52px]',
                                                                    (i + 1) === NOW_MONTH && year === NOW_YEAR
                                                                        ? 'text-primary-press' : 'text-ink-mute'
                                                                )}>
                                                                    {m}
                                                                </th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {/* current year row */}
                                                        <tr className="border-b border-hairline hover:bg-sand/40 transition-colors">
                                                            <td className="px-4 py-2.5 text-2xs font-semibold text-primary-press uppercase tracking-eyebrow whitespace-nowrap">{year}</td>
                                                            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
                                                                const cell = monthCells[m] ?? { target: 0, actual: 0, prevActual: 0 };
                                                                const isCurrent = m === NOW_MONTH && year === NOW_YEAR;
                                                                const cellColor = cell.target > 0
                                                                    ? (cell.actual >= cell.target ? 'text-tone-good' : cell.actual >= cell.target * 0.7 ? 'text-tone-warn-ink' : 'text-tone-critical')
                                                                    : 'text-ink-secondary';
                                                                return (
                                                                    <td key={m} className={cn(
                                                                        'px-3 py-2.5 text-center tabular-nums font-bold',
                                                                        cellColor,
                                                                        isCurrent && 'bg-primary/5'
                                                                    )}>
                                                                        {cell.actual > 0 ? fmtK(cell.actual) : <span className="text-ink-faint font-normal">—</span>}
                                                                    </td>
                                                                );
                                                            })}
                                                        </tr>
                                                        {/* objective row */}
                                                        <tr className="hover:bg-sand/40 transition-colors">
                                                            <td className="px-4 py-2.5 text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap">Objectif</td>
                                                            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
                                                                const cell = monthCells[m] ?? { target: 0, actual: 0, prevActual: 0 };
                                                                return (
                                                                    <td key={m} className="px-3 py-2.5 text-center tabular-nums text-ink-mute font-semibold">
                                                                        {cell.target > 0 ? fmtK(cell.target) : <span className="text-ink-faint font-normal">—</span>}
                                                                    </td>
                                                                );
                                                            })}
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
