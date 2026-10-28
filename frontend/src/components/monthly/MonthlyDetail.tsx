import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import {
    Loader2, ChevronLeft, ChevronRight, TrendingUp,
    DollarSign, FileText, ClipboardList,
} from 'lucide-react';
import { formatCurrencyCAD, cn } from '../../lib/utils';
import { DEPARTMENTS } from '../../lib/constants';
import { ShippingNote } from '../ShippingNote';

// ─── Types ────────────────────────────────────────────────────────────────────

interface InvoiceRow {
    zoho_id: string;
    invoice_number: string;
    invoice_date: string;
    client_name: string;
    amount: number;
    department: string;
    rep_name: string | null;
    status: string;
    is_avoir: boolean;
    /** Zoho's shipping before tax, already inside amount. Shown on the line only. */
    shipping_charge: number | null;
}

interface SaleRow {
    zoho_id: string;
    quote_number: string;
    sale_date: string;
    client_name: string;
    amount: number;
    department: string;
    rep_name: string | null;
    status: string;
}

type Row = InvoiceRow | SaleRow;

interface DeptSummary {
    department: string;
    total: number;
    commission: number;
    count: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_FULL = [
    '', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
    'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];
const MONTH_SHORT = [
    '', 'Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin',
    'Juil', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc',
];

function prevMonth(y: number, m: number) { return m === 1 ? [y - 1, 12] : [y, m - 1]; }
function nextMonth(y: number, m: number) { return m === 12 ? [y + 1, 1] : [y, m + 1]; }

function paddedMonth(m: number) { return String(m).padStart(2, '0'); }

function isSaleRow(r: Row): r is SaleRow {
    return 'quote_number' in r;
}

function getDate(r: Row) { return isSaleRow(r) ? (r as SaleRow).sale_date : (r as InvoiceRow).invoice_date; }
function getRef(r: Row)  { return isSaleRow(r) ? (r as SaleRow).quote_number : (r as InvoiceRow).invoice_number; }
function isAvoir(r: Row) { return !isSaleRow(r) && (r as InvoiceRow).is_avoir; }

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
    module: 'devis' | 'factures';
    repName?: string | null;    // null / undefined → all reps
    commRate?: number;           // default 0.05
    initialYear?: number;
    initialMonth?: number;
    compact?: boolean;           // hide dept breakdown when embedded in a tight space
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MonthlyDetail({
    module,
    repName,
    commRate = 0.05,
    initialYear,
    initialMonth,
    compact = false,
}: Props) {
    const now = new Date();
    const [year,  setYear]  = useState(initialYear  ?? now.getFullYear());
    const [month, setMonth] = useState(initialMonth ?? now.getMonth() + 1);
    const [rows,  setRows]  = useState<Row[]>([]);
    const [loading, setLoading] = useState(true);

    // Sync if parent changes initialYear / initialMonth (portail year filter)
    useEffect(() => {
        if (initialYear  !== undefined) setYear(initialYear);
    }, [initialYear]);
    useEffect(() => {
        if (initialMonth !== undefined) setMonth(initialMonth);
    }, [initialMonth]);

    const fetchRows = useCallback(async () => {
        setLoading(true);
        const dateStart = `${year}-${paddedMonth(month)}-01`;
        const [ny, nm] = nextMonth(year, month);
        const dateEnd   = `${ny}-${paddedMonth(nm)}-01`;

        const { data: excludedClientData } = await supabase.from('excluded_clients').select('client_name');
        const excludedClients = new Set((excludedClientData ?? []).map((r: { client_name: string }) => r.client_name));

        const isExcluded = (r: Row) => excludedClients.has(r.client_name);

        if (module === 'factures') {
            let q = supabase
                .from('invoices')
                .select('zoho_id,invoice_number,invoice_date,client_name,amount,department,rep_name,status,is_avoir,shipping_charge')
                .gte('invoice_date', dateStart)
                .lt('invoice_date', dateEnd)
                .order('invoice_date', { ascending: true });
            if (repName) q = q.eq('rep_name', repName);
            const { data } = await q;
            setRows(((data ?? []) as InvoiceRow[]).filter(r => !isExcluded(r)));
        } else {
            let q = supabase
                .from('sales')
                .select('zoho_id,quote_number,sale_date,client_name,amount,department,rep_name,status')
                // `sales` holds every quote; a sale is a won one, dated by acceptance.
                .in('status', ['accepted', 'invoiced'])
                .gte('sale_date', dateStart)
                .lt('sale_date', dateEnd)
                .order('sale_date', { ascending: true });
            if (repName) q = q.eq('rep_name', repName);
            const { data } = await q;
            setRows(((data ?? []) as SaleRow[]).filter(r => !isExcluded(r)));
        }
        setLoading(false);
    }, [module, repName, year, month]);

    useEffect(() => { fetchRows(); }, [fetchRows]);

    // ─── Derived values ───────────────────────────────────────────────────────

    const regularRows = rows.filter(r => !isAvoir(r));
    const avoirRows   = rows.filter(r => isAvoir(r));

    const totalNet        = rows.reduce((s, r) => s + r.amount, 0);
    // Commission is based on net revenue (avoirs reduce the commission base)
    const totalCommission = totalNet * commRate;

    // Department breakdown - include avoirs so dept totals are net
    const deptMap = new Map<string, DeptSummary>();
    for (const dept of DEPARTMENTS) {
        deptMap.set(dept, { department: dept, total: 0, commission: 0, count: 0 });
    }
    for (const r of rows) {
        const avoir = isAvoir(r);
        const key = r.department ?? '';
        const cur = deptMap.get(key) ?? { department: key, total: 0, commission: 0, count: 0 };
        cur.total += r.amount; // avoirs are negative - naturally subtract
        if (!avoir) { cur.commission += r.amount * commRate; cur.count++; }
        deptMap.set(key, cur);
    }
    // Recalculate dept commissions on net totals to be consistent
    for (const [key, d] of deptMap) {
        d.commission = d.total * commRate;
        deptMap.set(key, d);
    }
    const deptSummaries = [...deptMap.values()].filter(d => d.total !== 0);

    // Navigation
    const [py, pm] = prevMonth(year, month);
    const [ny, nm] = nextMonth(year, month);
    const isFuture = ny > now.getFullYear() || (ny === now.getFullYear() && nm > now.getMonth() + 1);

    const goTo = (y: number, m: number) => { setYear(y); setMonth(m); };

    const isFactures = module === 'factures';

    return (
        <div className="space-y-4">

            {/* ─── Month navigation ─── */}
            <div className="flex items-center justify-between bg-white rounded-xl shadow-card px-5 py-3">
                <button
                    onClick={() => goTo(py, pm)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-ink-mute hover:text-ink hover:bg-sand text-sm font-medium transition-all"
                >
                    <ChevronLeft className="w-4 h-4" />
                    {MONTH_SHORT[pm]} {py}
                </button>

                <div className="text-center">
                    <h3 className="text-base font-semibold text-ink">
                        {MONTH_FULL[month]} {year}
                    </h3>
                    <p className="text-2xs text-ink-mute uppercase tracking-eyebrow mt-0.5">
                        {isFactures ? 'Détail des factures' : 'Détail des devis'}
                        {repName ? ` · ${repName}` : ''}
                    </p>
                </div>

                <button
                    onClick={() => goTo(ny, nm)}
                    disabled={isFuture}
                    className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all",
                        isFuture
                            ? "text-ink-faint cursor-not-allowed"
                            : "text-ink-mute hover:text-ink hover:bg-sand"
                    )}
                >
                    {MONTH_SHORT[nm]} {ny}
                    <ChevronRight className="w-4 h-4" />
                </button>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-16 gap-3 bg-white rounded-xl border border-hairline">
                    <Loader2 className="w-5 h-5 animate-spin text-primary-press" />
                    <span className="text-sm text-ink-mute">Chargement de {MONTH_FULL[month]}...</span>
                </div>
            ) : rows.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 bg-white rounded-xl border border-hairline">
                    {isFactures
                        ? <FileText className="w-8 h-8 text-ink-faint" />
                        : <ClipboardList className="w-8 h-8 text-ink-faint" />
                    }
                    <p className="text-sm text-ink-mute">
                        Aucune {isFactures ? 'facture' : 'vente'} en {MONTH_FULL[month]} {year}
                    </p>
                </div>
            ) : (
                <>
                {/* ─── Summary KPIs ─── */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <SummaryCard
                        icon={TrendingUp}
                        label={isFactures ? 'Total Facturé' : 'Total Ventes'}
                        value={formatCurrencyCAD(totalNet)}
                        sub={`${regularRows.length} ${isFactures ? 'factures' : 'devis'}${avoirRows.length > 0 ? ` · ${avoirRows.length} avoir${avoirRows.length > 1 ? 's' : ''}` : ''}`}
                        color="bg-sand text-ink-mute"
                    />
                    <SummaryCard
                        icon={DollarSign}
                        label="Commission"
                        value={formatCurrencyCAD(totalCommission)}
                        sub={`Taux: ${Math.round(commRate * 100)}%`}
                        color="bg-primary-wash text-primary-press"
                    />
                </div>

                {/* ─── Department breakdown ─── */}
                {!compact && deptSummaries.length > 0 && (
                    <div className="bg-white rounded-xl shadow-card overflow-hidden">
                        <div className="px-5 py-3.5 border-b border-hairline">
                            <h4 className="text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Par département</h4>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-hairline bg-sand/40">
                                        <th className="px-5 py-2.5 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Département</th>
                                        <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Ventes</th>
                                        <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Commission</th>
                                        <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Qty</th>
                                        <th className="px-5 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">% du total</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-hairline">
                                    {deptSummaries.map(d => (
                                        <tr key={d.department} className="hover:bg-sand/60 transition-colors">
                                            <td className="px-5 py-2.5">
                                                <span className="text-xs font-bold text-ink-secondary bg-stone px-2 py-0.5 rounded-full">
                                                    {d.department}
                                                </span>
                                            </td>
                                            <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums">
                                                {formatCurrencyCAD(d.total)}
                                            </td>
                                            <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums">
                                                {formatCurrencyCAD(d.commission)}
                                            </td>
                                            <td className="px-4 py-2.5 text-right text-ink-mute tabular-nums">
                                                {d.count}
                                            </td>
                                            <td className="px-5 py-2.5">
                                                <div className="flex items-center justify-end gap-2">
                                                    <div className="w-20 h-1.5 bg-stone rounded-full overflow-hidden">
                                                        <div
                                                            className="h-full bg-primary rounded-full"
                                                            style={{ width: `${totalNet > 0 ? Math.min((d.total / totalNet) * 100, 100) : 0}%` }}
                                                        />
                                                    </div>
                                                    <span className="text-xs font-semibold text-ink-mute w-8 text-right tabular-nums">
                                                        {totalNet > 0 ? Math.round((d.total / totalNet) * 100) : 0}%
                                                    </span>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                    {/* Total row */}
                                    <tr className="border-t-2 border-hairline-strong bg-sand/80">
                                        <td className="px-5 py-2.5 text-xs font-semibold text-ink-secondary uppercase tracking-wide">Total</td>
                                        <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums">{formatCurrencyCAD(totalNet)}</td>
                                        <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums">{formatCurrencyCAD(totalCommission)}</td>
                                        <td className="px-4 py-2.5 text-right font-bold text-ink-secondary tabular-nums">{regularRows.length}</td>
                                        <td className="px-5 py-2.5" />
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* ─── Line items ─── */}
                <div className="bg-white rounded-xl shadow-card overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-hairline flex items-center justify-between">
                        <h4 className="text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">
                            Détail · {rows.length} transaction{rows.length > 1 ? 's' : ''}
                        </h4>
                        {avoirRows.length > 0 && (
                            <span className="text-2xs font-bold text-tone-critical bg-tone-critical-soft px-2 py-0.5 rounded-full">
                                {avoirRows.length} avoir{avoirRows.length > 1 ? 's' : ''}
                            </span>
                        )}
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-hairline bg-sand/40">
                                    <th className="px-5 py-2.5 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Client</th>
                                    <th className="px-4 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Montant HT</th>
                                    <th className="px-4 py-2.5 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">
                                        {isFactures ? '# Facture' : '# Devis'}
                                    </th>
                                    <th className="px-4 py-2.5 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Date</th>
                                    <th className="px-4 py-2.5 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Département</th>
                                    <th className="px-5 py-2.5 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Commission</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hairline">
                                {rows.map(r => {
                                    const avoir = isAvoir(r);
                                    // Avoirs generate negative commission (amount is already negative)
                                    const comm  = r.amount * commRate;
                                    const dateStr = getDate(r);
                                    const formattedDate = dateStr
                                        ? (() => {
                                            const dt = new Date(dateStr);
                                            return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}`;
                                        })()
                                        : '—';

                                    return (
                                        <tr
                                            key={r.zoho_id}
                                            className={cn(
                                                "transition-colors",
                                                avoir
                                                    ? "bg-tone-critical-soft/40 hover:bg-tone-critical-soft/70"
                                                    : "hover:bg-sand/60"
                                            )}
                                        >
                                            <td className="px-3 md:px-5 py-2 md:py-2.5 max-w-[120px] md:max-w-[200px]">
                                                <p className={cn("font-semibold truncate text-sm", avoir ? "text-tone-critical-ink" : "text-ink")} title={r.client_name}>
                                                    {r.client_name}
                                                </p>
                                                {avoir && (
                                                    <span className="text-2xs font-semibold text-tone-critical uppercase tracking-wide">Avoir</span>
                                                )}
                                            </td>
                                            <td className={cn("px-4 py-2.5 text-right font-bold tabular-nums", avoir ? "text-tone-critical-ink" : "text-ink")}>
                                                {formatCurrencyCAD(r.amount)}
                                                {!isSaleRow(r) && <ShippingNote amount={(r as InvoiceRow).shipping_charge} className="mt-0.5" />}
                                            </td>
                                            <td className="px-4 py-2.5">
                                                <span className={cn("text-xs font-mono font-semibold", avoir ? "text-tone-critical" : "text-ink-mute")}>
                                                    {getRef(r)}
                                                </span>
                                            </td>
                                            <td className="px-4 py-2.5 text-xs text-ink-mute tabular-nums">
                                                {formattedDate}
                                            </td>
                                            <td className="px-4 py-2.5">
                                                <span className="text-2xs font-bold text-ink-secondary bg-stone px-1.5 py-0.5 rounded-full whitespace-nowrap">
                                                    {r.department}
                                                </span>
                                            </td>
                                            <td className={cn("px-5 py-2.5 text-right font-bold tabular-nums", avoir ? "text-tone-critical" : "text-ink")}>
                                                {formatCurrencyCAD(comm)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                            {/* Footer */}
                            <tfoot>
                                <tr className="border-t-2 border-hairline-strong bg-sand/80">
                                    <td className="px-5 py-2.5 text-xs font-semibold text-ink-mute uppercase tracking-wide">
                                        Total · {rows.length} lignes
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-bold text-ink tabular-nums">
                                        {formatCurrencyCAD(totalNet)}
                                    </td>
                                    <td colSpan={3} />
                                    <td className="px-5 py-2.5 text-right font-bold text-ink tabular-nums">
                                        {formatCurrencyCAD(totalCommission)}
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
                </>
            )}
        </div>
    );
}

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({ icon: Icon, label, value, sub, color }: {
    icon: React.ElementType; label: string; value: string; sub: string; color: string;
}) {
    return (
        <div className="bg-white p-3 md:p-4 rounded-xl shadow-card hover:shadow-elevated transition-all">
            <div className={cn("w-7 h-7 md:w-8 md:h-8 rounded-md flex items-center justify-center mb-2 md:mb-3", color)}>
                <Icon className="w-3.5 h-3.5 md:w-4 md:h-4" />
            </div>
            <p className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow leading-tight">{label}</p>
            <p className="text-sm md:text-xl font-bold text-ink mt-0.5 tabular-nums">{value}</p>
            <p className="text-2xs text-ink-mute mt-0.5 italic leading-tight">{sub}</p>
        </div>
    );
}
