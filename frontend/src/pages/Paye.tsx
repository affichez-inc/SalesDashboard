import { useEffect, useState, useCallback } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { cachedRpc } from '../lib/rpcCache';
import {
    Loader2,
    TrendingUp, Users, Wallet, Pencil, Check, X,
    ChevronLeft, ChevronRight,
} from 'lucide-react';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { OFFICES } from '../lib/constants';
import { fetchAllCommRates, saveCommRate } from '../utils/commRates';
import { ExportButton } from '../components/ExportButton';
import { autoColumns } from '../lib/csv';
import { RepAvatar } from '../components/RepAvatar';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RepMonthlyData {
    rep_name: string;
    office: string;
    total_amount: number;
    deal_count: number;
    avg_deal: number;
}

// Local state for commission tracking (to be persisted in DB later)
interface PayeRecord {
    rep_name: string;
    taux: number;           // commission rate e.g. 0.05 = 10%
    commission: number;     // calculated
    paid: boolean;
    paid_date: string | null;
    notes: string;
}

// ─── Inline edit for taux ─────────────────────────────────────────────────────

function TauxCell({ value, onSave }: { value: number; onSave: (v: number) => void }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(String(Math.round(value * 100)));

    const commit = () => {
        const n = parseFloat(draft);
        if (!isNaN(n) && n >= 0 && n <= 100) { onSave(n / 100); }
        setEditing(false);
    };

    if (editing) {
        return (
            <div className="inline-flex items-center gap-1">
                <input
                    autoFocus
                    type="number"
                    min={0}
                    max={100}
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
                    className="w-14 px-2 py-1 text-xs border border-primary rounded-md focus:outline-none text-center font-semibold"
                />
                <span className="text-xs text-ink-mute">%</span>
                <button onClick={commit} className="p-1 text-tone-good hover:bg-tone-good-soft rounded-xs transition-colors"><Check className="w-3 h-3" /></button>
                <button onClick={() => setEditing(false)} className="p-1 text-ink-mute hover:bg-stone rounded-xs transition-colors"><X className="w-3 h-3" /></button>
            </div>
        );
    }

    return (
        <button
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 group"
        >
            <span className="text-sm font-bold text-ink-secondary tabular-nums">{Math.round(value * 100)}%</span>
            <Pencil className="w-3 h-3 text-ink-faint group-hover:text-primary-press transition-colors opacity-0 group-hover:opacity-100" />
        </button>
    );
}

// ─── Notes cell ───────────────────────────────────────────────────────────────

function NotesCell({ value, onSave }: { value: string; onSave: (v: string) => void }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);

    const commit = () => { onSave(draft); setEditing(false); };

    if (editing) {
        return (
            <div className="flex items-center gap-1">
                <input
                    autoFocus
                    type="text"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
                    className="w-full min-w-[140px] px-2 py-1 text-xs border border-primary rounded-md focus:outline-none"
                    placeholder="Ajouter une note..."
                />
                <button onClick={commit} className="p-1 text-tone-good hover:bg-tone-good-soft rounded-xs transition-colors"><Check className="w-3 h-3" /></button>
                <button onClick={() => setEditing(false)} className="p-1 text-ink-mute hover:bg-stone rounded-xs transition-colors"><X className="w-3 h-3" /></button>
            </div>
        );
    }

    return (
        <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 group text-left w-full"
        >
            <span className="text-xs text-ink-mute italic group-hover:text-ink-secondary transition-colors truncate max-w-[160px]">
                {value || 'Ajouter une note...'}
            </span>
            <Pencil className="w-3 h-3 text-ink-faint group-hover:text-primary-press transition-colors opacity-0 group-hover:opacity-100 shrink-0" />
        </button>
    );
}

// ─── KPI Summary card ─────────────────────────────────────────────────────────

function KPICard({ title, value, sub, icon: Icon, color }: {
    title: string; value: string; sub: string;
    icon: React.ElementType; color: string;
}) {
    return (
        <div className="bg-white p-3 md:p-5 rounded-xl shadow-card flex flex-col justify-between hover:shadow-elevated transition-all group">
            <div className="flex items-start justify-between mb-2 md:mb-4">
                <div className={cn("p-2 md:p-2.5 rounded-md", color)}>
                    <Icon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
            </div>
            <div>
                <p className="text-2xs md:text-xs font-semibold text-ink-mute uppercase tracking-eyebrow leading-tight">{title}</p>
                <p className="text-base md:text-2xl font-bold text-ink mt-0.5 md:mt-1 tabular-nums">{value}</p>
                <p className="text-2xs text-ink-mute mt-0.5 md:mt-1 font-medium italic">{sub}</p>
            </div>
        </div>
    );
}

// ─── Month navigation helpers (mirrors MonthlyDetail) ────────────────────────

const MONTH_FULL = [
    '', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
    'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];
const MONTH_SHORT = [
    '', 'Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin',
    'Juil', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc',
];

function prevMonth(y: number, m: number): [number, number] { return m === 1  ? [y - 1, 12] : [y, m - 1]; }
function nextMonth(y: number, m: number): [number, number] { return m === 12 ? [y + 1,  1] : [y, m + 1]; }

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Paye() {
    const { isAdmin } = useAuth();

    const [viewMode, setViewMode] = useUrlState('view', 'annual') as ['annual' | 'monthly', (v: 'annual' | 'monthly') => void];
    const [year, setYear] = useUrlStateNumber('year', 2026);
    const [selectedMonth, setSelectedMonth] = useUrlStateNumber('month', new Date().getMonth() + 1);
    const [selectedOffice, setSelectedOffice] = useUrlState('office', 'Toutes');
    const [loading, setLoading] = useState(false);

    const [repData, setRepData] = useState<RepMonthlyData[]>([]);
    const [payeRecords, setPayeRecords] = useState<Record<string, PayeRecord>>({});

    const monthParam = viewMode === 'monthly' ? selectedMonth : null;
    const officeParam = selectedOffice === 'Toutes' ? null : selectedOffice;

    // Month navigation (used in monthly view)
    const [py, pm] = prevMonth(year, selectedMonth);
    const [ny, nm] = nextMonth(year, selectedMonth);
    const now = new Date();
    const isFuture = ny > now.getFullYear() || (ny === now.getFullYear() && nm > now.getMonth() + 1);
    const goTo = (y: number, m: number) => { setYear(y); setSelectedMonth(m); };

    const fetchData = useCallback(async () => {
        setLoading(true);
        const { data } = await cachedRpc('get_inv_rep_leaderboard', {
            p_year: year,
            p_office: officeParam,
            p_status: null,
            p_month: monthParam,
            p_dept: null,
            p_rep: null,
        });
        const rows: RepMonthlyData[] = (data || []) as RepMonthlyData[];
        setRepData(rows);

        // Initialize paye records - read persisted rates from Supabase
        const savedRates = await fetchAllCommRates();
        setPayeRecords(prev => {
            const next = { ...prev };
            for (const r of rows) {
                const taux = savedRates[r.rep_name] ?? next[r.rep_name]?.taux ?? 0.05;
                if (!next[r.rep_name]) {
                    next[r.rep_name] = {
                        rep_name: r.rep_name,
                        taux,
                        commission: r.total_amount * taux,
                        paid: false,
                        paid_date: null,
                        notes: '',
                    };
                } else {
                    // Refresh commission with latest facturé total + current rate
                    next[r.rep_name] = {
                        ...next[r.rep_name],
                        taux,
                        commission: r.total_amount * taux,
                    };
                }
            }
            return next;
        });

        setLoading(false);
    }, [year, officeParam, monthParam]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchData(); }, [fetchData]);

    // Helpers to update paye records
    const setTaux = (rep: string, taux: number) => {
        saveCommRate(rep, taux); // persist to Supabase
        setPayeRecords(prev => {
            const r = repData.find(d => d.rep_name === rep);
            const total = r?.total_amount ?? 0;
            return { ...prev, [rep]: { ...prev[rep], taux, commission: total * taux } };
        });
    };
    const setNotes = (rep: string, notes: string) => {
        setPayeRecords(prev => ({ ...prev, [rep]: { ...prev[rep], notes } }));
    };

    // Summary KPIs
    const totalFacture = repData.reduce((s, r) => s + r.total_amount, 0);
    const totalCommission = repData.reduce((s, r) => s + (payeRecords[r.rep_name]?.commission ?? 0), 0);

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));
    const officeOptions = [{ value: 'Toutes', label: 'Tous les sièges' }, ...OFFICES];

    if (!isAdmin) {
        return (
            <div className="flex items-center justify-center h-64">
                <p className="text-ink-mute text-sm">Accès réservé aux administrateurs.</p>
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto space-y-6 md:space-y-8">

            {/* ─── Header ─── */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-2xl font-semibold text-ink tracking-tight">
                        Commissions
                    </h1>
                    <p className="text-sm text-ink-mute mt-0.5">
                        {viewMode === 'annual'
                            ? `Vue annuelle · ${year}`
                            : `${MONTH_FULL[selectedMonth]} ${year}`}
                    </p>
                </div>

                {/* Annual / Monthly toggle */}
                <div className="flex items-center gap-1 p-1 bg-stone rounded-xl">
                    {(['annual', 'monthly'] as const).map(mode => (
                        <button
                            key={mode}
                            onClick={() => setViewMode(mode)}
                            className={cn(
                                'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold transition-all',
                                viewMode === mode
                                    ? 'bg-white text-ink shadow-xs'
                                    : 'text-ink-secondary hover:text-ink'
                            )}
                        >
                            {mode === 'annual' ? 'Annuel' : 'Mensuel'}
                        </button>
                    ))}
                </div>
            </div>

            {/* ─── Filters (annual) / Month switcher (monthly) ─── */}
            {viewMode === 'annual' ? (
                <FilterBar>
                    <FilterGroup label="Année">
                        <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                    </FilterGroup>
                    <FilterGroup label="Siège">
                        <Select value={selectedOffice} onChange={setSelectedOffice} options={officeOptions} className="w-44" />
                    </FilterGroup>
                </FilterBar>
            ) : (
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
                            {MONTH_FULL[selectedMonth]} {year}
                        </h3>
                        <p className="text-2xs text-ink-mute uppercase tracking-eyebrow mt-0.5">
                            Commissions
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
            )}

            {/* ─── Summary KPIs ─── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KPICard
                    title="Total Facturé"
                    value={formatCurrencyCAD(totalFacture)}
                    sub={`${repData.length} représentants actifs`}
                    icon={TrendingUp}
                    color="bg-sand text-ink-mute"
                />
                <KPICard
                    title="Commissions Totales"
                    value={formatCurrencyCAD(totalCommission)}
                    sub="Basé sur les taux individuels"
                    icon={Wallet}
                    color="bg-primary-wash text-primary-press"
                />
            </div>

            {/* ─── Main Table ─── */}
            <div className="bg-white rounded-xl shadow-card overflow-hidden">
                <div className="px-5 py-4 border-b border-hairline flex items-center gap-2">
                    <Users className="w-4 h-4 text-ink-mute" />
                    <h3 className="text-sm font-semibold text-ink">Suivi des paiements</h3>
                    <ExportButton
                        rows={repData}
                        columns={autoColumns(repData)}
                        filename="suivi_paiements" label="CSV"
                        disabled={repData.length === 0}
                    />
                    <span className="ml-auto text-xs text-ink-mute italic">
                        Les taux sont sauvegardés dans la base de données
                    </span>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center py-16 gap-2">
                        <Loader2 className="w-5 h-5 animate-spin text-ink-mute" />
                        <span className="text-sm text-ink-mute">Chargement...</span>
                    </div>
                ) : repData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 gap-2">
                        <Users className="w-8 h-8 text-ink-faint" />
                        <p className="text-sm text-ink-mute">Aucune donnée pour cette période</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-hairline bg-sand/60">
                                    <th className="px-5 py-3 text-left   text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Représentant</th>
                                    <th className="px-4 py-3 text-center text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Siège</th>
                                    <th className="px-4 py-3 text-center text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Facturé</th>
                                    <th className="px-4 py-3 text-center text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Nb Fact.</th>
                                    <th className="px-4 py-3 text-center text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Taux</th>
                                    <th className="px-4 py-3 text-center text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Commission</th>
                                    <th className="px-4 py-3 text-left   text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Notes</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hairline">
                                {repData.map((rep) => {
                                    const paye = payeRecords[rep.rep_name] ?? {
                                        taux: 0.05, commission: rep.total_amount * 0.05,
                                        paid: false, paid_date: null, notes: '',
                                    };
                                    return (
                                        <tr
                                            key={rep.rep_name}
                                            className={cn(
                                                "hover:bg-sand/60 transition-colors",
                                                paye.paid && "bg-tone-good-soft/20"
                                            )}
                                        >
                                            {/* Rep name */}
                                            <td className="px-5 py-3">
                                                <div className="flex items-center gap-3">
                                                    <RepAvatar
                                                        name={rep.rep_name}
                                                        size="md"
                                                        // A pay line belongs to one person, so it is
                                                        // named and keyed by that person - the Interne
                                                        // group has no commission rate to edit.
                                                        literal
                                                        // Paid reps keep the green they had when this
                                                        // was a letter circle - as a ring, so the state
                                                        // survives putting a photo inside it.
                                                        className={cn('ring-2', paye.paid ? 'ring-tone-good' : 'ring-transparent')}
                                                    />
                                                    <span className="font-semibold text-ink">{rep.rep_name}</span>
                                                </div>
                                            </td>

                                            {/* Office */}
                                            <td className="px-4 py-3 text-center">
                                                <span className="text-2xs font-semibold text-ink-secondary uppercase bg-stone px-2 py-0.5 rounded-full">
                                                    {rep.office}
                                                </span>
                                            </td>

                                            {/* Facturé */}
                                            <td className="px-4 py-3 text-center font-bold text-ink tabular-nums">
                                                {formatCurrencyCAD(rep.total_amount)}
                                            </td>

                                            {/* Nb factures */}
                                            <td className="px-4 py-3 text-center text-ink-mute tabular-nums">
                                                {rep.deal_count}
                                            </td>

                                            {/* Taux commission */}
                                            <td className="px-4 py-3 text-center">
                                                <TauxCell value={paye.taux} onSave={v => setTaux(rep.rep_name, v)} />
                                            </td>

                                            {/* Commission calculée */}
                                            <td className="px-4 py-3 text-center">
                                                <span className="font-bold text-ink tabular-nums text-sm">
                                                    {formatCurrencyCAD(paye.commission)}
                                                </span>
                                            </td>

                                            {/* Notes */}
                                            <td className="px-4 py-3">
                                                <NotesCell value={paye.notes} onSave={v => setNotes(rep.rep_name, v)} />
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>

                            {/* Footer totals */}
                            <tfoot>
                                <tr className="border-t-2 border-hairline-strong bg-sand/80">
                                    <td className="px-5 py-3 text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">
                                        Total · {repData.length} reps
                                    </td>
                                    <td className="px-4 py-3" />
                                    <td className="px-4 py-3 text-center font-bold text-ink tabular-nums">
                                        {formatCurrencyCAD(totalFacture)}
                                    </td>
                                    <td className="px-4 py-3 text-center text-ink-mute tabular-nums font-bold">
                                        {repData.reduce((s, r) => s + r.deal_count, 0)}
                                    </td>
                                    <td className="px-4 py-3" />
                                    <td className="px-4 py-3 text-center font-bold text-ink tabular-nums">
                                        {formatCurrencyCAD(totalCommission)}
                                    </td>
                                    <td className="px-4 py-3" />
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                )}
            </div>

        </div>
    );
}
