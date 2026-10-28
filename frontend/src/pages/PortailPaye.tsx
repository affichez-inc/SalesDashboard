import { useState, useEffect, useCallback, useRef } from 'react';
import { useUrlStateNumber } from '../hooks/useUrlState';
import { Wallet, Trash2, Loader2, Plus, User, Pencil, Check, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { FilterBar, FilterGroup } from '../components/FilterBar';
import { Select } from '../components/Select';
import { fetchCommRate } from '../utils/commRates';
import { ExportButton } from '../components/ExportButton';
import { autoColumns } from '../lib/csv';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PayEntry {
    id: string;
    rep_name: string;
    year: number;
    pay_date: string;
    base_salary: number | null;
    commission: number | null;
    expenses: number | null;
    holidays: number | null;
    vacation: number | null;
    note: string;
    sort_order: number;
}

interface PayMeta {
    previous_year_balance: number;
    annual_bonus: number;
    commission_prev_year: number;
    bank_balance: number;
}

const EMPTY_META: PayMeta = {
    previous_year_balance: 0,
    annual_bonus: 0,
    commission_prev_year: 0,
    bank_balance: 0,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function n(v: number | null | undefined): number { return v ?? 0; }

function fmt(v: number | null): string {
    if (v === null || v === undefined || v === 0) return '';
    return v.toFixed(2);
}

function formatPayDate(d: string): string {
    if (!d) return '—';
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        const [y, m, day] = d.split('-').map(Number);
        return new Date(y, m - 1, day).toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' });
    }
    return d;
}

// ─── DD/MM/YYYY <-> YYYY-MM-DD helpers ───────────────────────────────────────
function isoToDDMMYYYY(iso: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}

function ddmmyyyyToISO(s: string): string | null {
    const m = /^(\d{1,2})[/\-\s.](\d{1,2})[/\-\s.](\d{2,4})$/.exec(s.trim());
    if (!m) return null;
    const [, dd, mm, yyRaw] = m;
    const yy = yyRaw.length === 2 ? `20${yyRaw}` : yyRaw;
    const day = parseInt(dd, 10), month = parseInt(mm, 10), year = parseInt(yy, 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ─── Schedule generator ───────────────────────────────────────────────────────

function generateBiweeklyDates(startDate: string, year: number): string[] {
    if (!startDate) return [];
    const dates: string[] = [];
    const d = new Date(startDate + 'T12:00:00');
    if (isNaN(d.getTime())) return [];
    while (d.getFullYear() <= year) {
        if (d.getFullYear() === year) {
            dates.push(d.toISOString().slice(0, 10));
        }
        d.setDate(d.getDate() + 14);
    }
    return dates;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props { propRepName?: string; embedded?: boolean; }

// ─── Component ────────────────────────────────────────────────────────────────

export default function PortailPaye({ propRepName, embedded }: Props) {
    const { repName: authRepName, isAdmin } = useAuth();
    const { viewAsRep } = useAdminView();
    const repName = propRepName ?? viewAsRep ?? authRepName ?? '';

    /**
     * Payroll is admin-only to edit, wherever the lines are shown.
     *
     * This was `isAdmin && !viewAsRep`, which contradicted itself. An admin has
     * no rep row of their own, so the only way to see any payroll at all is to
     * name a rep - through the View switcher here, or through propRepName on
     * the admin screen - and the View switcher then withdrew the very right it
     * took to get there. Worse, that switcher is sticky (sessionStorage), so a
     * preview left on a rep made payroll read-only on the admin screen too,
     * silently: the "Lecture seule" badge below only renders on the portal view.
     */
    const canEdit = isAdmin;
    const isAdminView = !!propRepName;

    const [year, setYear]         = useUrlStateNumber('year', 2026);
    const [loading, setLoading]   = useState(true);
    const [entries, setEntries]   = useState<PayEntry[]>([]);
    const [meta, setMeta]         = useState<PayMeta>(EMPTY_META);
    const [commRate, setCommRate] = useState(0.05);
    const [invoiceTotal, setInvoiceTotal] = useState(0);
    const [generating, setGenerating] = useState(false);

    // Inline commission rate editing
    const [editingRate, setEditingRate] = useState(false);
    const [rateDraft, setRateDraft]     = useState('');

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    // ─── Fetch ───────────────────────────────────────────────────────────────

    const fetchAll = useCallback(async () => {
        if (!repName) { setLoading(false); return; }
        setLoading(true);
        const [entriesRes, metaRes, rate, invRes] = await Promise.all([
            supabase
                .from('paye_entries')
                .select('*')
                .eq('rep_name', repName)
                .eq('year', year)
                .order('sort_order', { ascending: true }),
            supabase
                .from('paye_meta')
                .select('*')
                .eq('rep_name', repName)
                .eq('year', year)
                .single(),
            fetchCommRate(repName),
            supabase
                .from('invoices')
                .select('amount')
                .eq('rep_name', repName)
                .gte('invoice_date', `${year}-01-01`)
                .lte('invoice_date', `${year}-12-31`)
                .neq('status', 'void'),
        ]);
        setEntries((entriesRes.data ?? []) as PayEntry[]);
        setMeta((metaRes.data as PayMeta | null) ?? EMPTY_META);
        setCommRate(rate);
        const invSum = (invRes.data ?? []).reduce(
            (s: number, r: { amount: number | string }) => s + Number(r.amount ?? 0), 0
        );
        setInvoiceTotal(invSum);
        setLoading(false);
    }, [repName, year]);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    // ─── Auto-generate bi-weekly dates for admin view when year is empty ──────

    useEffect(() => {
        if (!isAdminView || !canEdit || loading || entries.length > 0 || !repName || generating) return;
        const defaultStart = `${year}-01-09`;
        const dates = generateBiweeklyDates(defaultStart, year);
        if (dates.length === 0) return;
        setGenerating(true);
        const rows = dates.map((pay_date, i) => ({ rep_name: repName, year, pay_date, sort_order: i }));
        supabase.from('paye_entries').insert(rows).select().then(({ data }) => {
            if (data) setEntries((data as PayEntry[]).sort((a, b) => a.pay_date < b.pay_date ? -1 : 1));
            setGenerating(false);
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, entries.length, isAdminView, canEdit, repName, year]);

    // In admin view, always show full year (no month filter)
    const filteredEntries = entries;

    // ─── Entry mutations (admin only) ────────────────────────────────────────


    const addEntry = async () => {
        if (!repName || !canEdit) return;
        const sort_order = entries.length;
        const { data } = await supabase
            .from('paye_entries')
            .insert({ rep_name: repName, year, sort_order })
            .select()
            .single();
        if (data) setEntries(prev => [...prev, data as PayEntry]);
    };

    const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

    const updateField = (id: string, field: keyof PayEntry, raw: string) => {
        if (!canEdit) return;
        const numericFields: (keyof PayEntry)[] = ['base_salary', 'commission', 'expenses', 'holidays', 'vacation'];
        const value = numericFields.includes(field)
            ? (raw === '' ? null : parseFloat(raw.replace(/[$,\s]/g, '').replace(',', '.')) || null)
            : raw;

        setEntries(prev => prev.map(e => e.id === id ? { ...e, [field]: value } : e));

        clearTimeout(saveTimers.current[id + field]);
        saveTimers.current[id + field] = setTimeout(async () => {
            await supabase
                .from('paye_entries')
                .update({ [field]: value, updated_at: new Date().toISOString() })
                .eq('id', id);
        }, 600);
    };

    const deleteEntry = async (id: string) => {
        if (!canEdit) return;
        setEntries(prev => prev.filter(e => e.id !== id));
        await supabase.from('paye_entries').delete().eq('id', id);
    };

    // ─── Meta mutations (admin only) ──────────────────────────────────────────

    const metaTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const updateMeta = (field: keyof PayMeta, raw: string) => {
        if (!canEdit) return;
        const value = raw === '' ? 0 : parseFloat(raw.replace(/[$,\s]/g, '').replace(',', '.')) || 0;
        setMeta(prev => ({ ...prev, [field]: value }));

        clearTimeout(metaTimer.current);
        metaTimer.current = setTimeout(async () => {
            await supabase
                .from('paye_meta')
                .upsert(
                    { rep_name: repName, year, [field]: value, updated_at: new Date().toISOString() },
                    { onConflict: 'rep_name,year' }
                );
        }, 600);
    };

    // ─── Totals (based on filtered entries for display, all entries for net) ──

    const totals = filteredEntries.reduce(
        (acc, e) => ({
            base_salary: acc.base_salary + n(e.base_salary),
            commission:  acc.commission  + n(e.commission),
            expenses:    acc.expenses    + n(e.expenses),
            holidays:    acc.holidays    + n(e.holidays),
            vacation:    acc.vacation    + n(e.vacation),
        }),
        { base_salary: 0, commission: 0, expenses: 0, holidays: 0, vacation: 0 }
    );
    const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0);

    const commissionFacturees = invoiceTotal * commRate;
    const bankBalance         = n(meta.previous_year_balance) + commissionFacturees - totals.commission;

    const netTotal = grandTotal + n(meta.previous_year_balance) + n(meta.annual_bonus);

    // ─── Guard ────────────────────────────────────────────────────────────────

    if (!repName && !isAdmin) {
        return (
            <div className="p-4 md:p-8 max-w-screen-2xl mx-auto flex items-center justify-center min-h-[60vh]">
                <div className="text-center space-y-3">
                    <div className="w-14 h-14 rounded-xl bg-stone flex items-center justify-center mx-auto">
                        <User className="w-7 h-7 text-ink-faint" />
                    </div>
                    <h2 className="text-base font-semibold text-ink-secondary">Portail non configuré</h2>
                    <p className="text-sm text-ink-mute max-w-xs">Votre compte n'est pas encore associé à un représentant. Contactez un administrateur pour configurer votre accès.</p>
                </div>
            </div>
        );
    }

    // ─── Render ───────────────────────────────────────────────────────────────

    return (
        <div className={cn(
            "space-y-5 md:space-y-6",
            !embedded && "p-4 md:p-8 max-w-screen-2xl mx-auto"
        )}>

            {/* Header */}
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                    <h2 className="text-xl font-semibold text-ink tracking-tight flex items-center gap-2">
                        <Wallet className="w-5 h-5 text-data-1-ink" />
                        {isAdminView ? `Paye de ${repName}` : 'Ma Paye'}
                    </h2>
                    {/* The read-only state is stated on every view, never only on
                        the portal one: a payroll screen that quietly refuses to
                        save looks like a broken page, not a permission. */}
                    {(!isAdminView || !canEdit) && (
                        <p className="text-sm text-ink-mute mt-0.5">
                            {!isAdminView && (repName || 'Représentant')}
                            {!canEdit && <span className={cn('text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow', !isAdminView && 'ml-2')}>Lecture seule</span>}
                        </p>
                    )}
                </div>
            </div>

            {/* Filters - year only */}
            <FilterBar>
                <FilterGroup label="Année">
                    <Select value={String(year)} onChange={v => setYear(Number(v))} options={yearOptions} variant="accent" className="w-28" />
                </FilterGroup>
            </FilterBar>

            {/* ─── Meta cards ──────────────────────────────────────────────── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <MetaCard label="Solde Année Précédente"            value={meta.previous_year_balance} onChange={v => updateMeta('previous_year_balance', v)} bg="bg-data-2 border-data-2-edge"   text="text-data-2-ink"    readOnly={!canEdit} />
                <MetaCard label="Bonus Annuel"                       value={meta.annual_bonus}          onChange={v => updateMeta('annual_bonus', v)}          bg="bg-primary/5 border-primary/20" text="text-primary-press"  readOnly={!canEdit} />
                <MetaCard label={`Commission ${year} Facturées`}     value={commissionFacturees}                                                                bg="bg-data-3 border-data-3-edge"   text="text-data-3-ink"   readOnly />
                <MetaCard label="Montant en Banque"                  value={bankBalance}                                                                        bg="bg-data-1 border-data-1-edge"   text="text-data-1-ink" readOnly />
            </div>

            {/* ─── Payroll table ───────────────────────────────────────────── */}
            <div className="bg-white rounded-xl shadow-card overflow-hidden">
                <div className="px-5 py-4 border-b border-hairline-strong bg-sand flex items-center justify-between gap-4 flex-wrap">
                    <div>
                        <h3 className="text-sm font-semibold text-ink">Détail des paies · {year}</h3>
                        <ExportButton
                            rows={entries}
                            columns={autoColumns(entries)}
                            filename={`mes_paies_${year}`} label="CSV"
                            disabled={entries.length === 0}
                        />
                        <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs text-ink-mute">Taux commission :</span>
                            {canEdit && editingRate ? (
                                <div className="flex items-center gap-1.5">
                                    <input
                                        autoFocus
                                        type="number"
                                        min={0} max={100}
                                        value={rateDraft}
                                        onChange={e => setRateDraft(e.target.value)}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') {
                                                const n = parseFloat(rateDraft);
                                                if (!isNaN(n)) {
                                                    const r = n / 100;
                                                    import('../utils/commRates').then(m => m.saveCommRate(repName, r));
                                                    setCommRate(r);
                                                }
                                                setEditingRate(false);
                                            }
                                            if (e.key === 'Escape') setEditingRate(false);
                                        }}
                                        className="w-14 px-1.5 py-0.5 text-xs border border-primary rounded-md focus:outline-none text-center font-bold text-primary-press"
                                    />
                                    <span className="text-xs text-ink-mute">%</span>
                                    <button
                                        onClick={() => {
                                            const n = parseFloat(rateDraft);
                                            if (!isNaN(n)) {
                                                const r = n / 100;
                                                import('../utils/commRates').then(m => m.saveCommRate(repName, r));
                                                setCommRate(r);
                                            }
                                            setEditingRate(false);
                                        }}
                                        className="p-0.5 text-tone-good hover:text-tone-good-ink"
                                    ><Check className="w-3 h-3" /></button>
                                    <button onClick={() => setEditingRate(false)} className="p-0.5 text-ink-faint hover:text-ink-mute">
                                        <X className="w-3 h-3" />
                                    </button>
                                </div>
                            ) : canEdit ? (
                                <button
                                    onClick={() => { setRateDraft(String(Math.round(commRate * 100))); setEditingRate(true); }}
                                    className="flex items-center gap-1 group"
                                >
                                    <span className="text-xs font-bold text-ink tabular-nums">{Math.round(commRate * 100)}%</span>
                                    <Pencil className="w-2.5 h-2.5 text-ink-faint group-hover:text-primary-press transition-colors" />
                                </button>
                            ) : (
                                <span className="text-xs font-bold text-ink tabular-nums">{Math.round(commRate * 100)}%</span>
                            )}
                        </div>
                    </div>
                    {generating && (
                        <div className="flex items-center gap-1.5 text-xs text-ink-mute">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Génération du calendrier...
                        </div>
                    )}
                </div>

                {!repName ? (
                    <div className="flex items-center justify-center py-16">
                        <p className="text-sm text-ink-mute">Sélectionnez un représentant ci-dessus</p>
                    </div>
                ) : loading ? (
                    <div className="flex items-center justify-center py-16 gap-2">
                        <Loader2 className="w-5 h-5 animate-spin text-ink-faint" />
                        <span className="text-sm text-ink-mute">Chargement...</span>
                    </div>
                ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr className="bg-stone border-b-2 border-hairline-strong">
                                <Th align="left"  color="text-ink-secondary" className="min-w-[160px]">Date</Th>
                                <Th align="right" color="text-data-2-ink">Salaire de base</Th>
                                <Th align="right" color="text-primary-press">Commission</Th>
                                <Th align="right" color="text-tone-good-ink">Remb. Dépenses</Th>
                                <Th align="right" color="text-data-4-ink">Fériés</Th>
                                <Th align="right" color="text-data-6-ink">Vacances</Th>
                                <Th align="right" color="text-ink-secondary">Total</Th>
                                <Th align="left"  color="text-ink-mute" className="min-w-[130px]">Note</Th>
                                {canEdit && <th className="w-8 border-l border-hairline-strong" />}
                            </tr>
                        </thead>

                        <tbody>
                            {filteredEntries.length === 0 && (
                                <tr>
                                    <td colSpan={canEdit ? 9 : 8} className="px-5 py-12 text-center text-sm text-ink-faint italic">
                                        {`Aucune paie enregistrée pour ${year}`}
                                    </td>
                                </tr>
                            )}
                            {filteredEntries.map((entry) => {
                                const rowTotal = n(entry.base_salary) + n(entry.commission) + n(entry.expenses) + n(entry.holidays) + n(entry.vacation);
                                const dateVal = /^\d{4}-\d{2}-\d{2}$/.test(entry.pay_date) ? entry.pay_date : '';
                                return (
                                    <tr key={entry.id} className="border-b border-hairline-strong hover:bg-primary-wash/30 transition-colors group">
                                        {/* Date */}
                                        <td className="px-3 py-2 border-r border-hairline-strong">
                                            {canEdit ? (
                                                <DateDDMMInput
                                                    isoValue={dateVal}
                                                    onChange={iso => updateField(entry.id, 'pay_date', iso)}
                                                />
                                            ) : (
                                                <span className="text-ink-secondary font-medium text-sm">{formatPayDate(entry.pay_date) || '—'}</span>
                                            )}
                                        </td>

                                        {canEdit ? (
                                            <>
                                                <NumInput value={fmt(entry.base_salary)} onChange={v => updateField(entry.id, 'base_salary', v)} color="text-data-2-ink" />
                                                <NumInput value={fmt(entry.commission)}  onChange={v => updateField(entry.id, 'commission', v)}  color="text-primary-press" />
                                                <NumInput value={fmt(entry.expenses)}    onChange={v => updateField(entry.id, 'expenses', v)}    color="text-tone-good-ink" />
                                                <NumInput value={fmt(entry.holidays)}    onChange={v => updateField(entry.id, 'holidays', v)}    color="text-data-4-ink" />
                                                <NumInput value={fmt(entry.vacation)}    onChange={v => updateField(entry.id, 'vacation', v)}    color="text-data-6-ink" />
                                            </>
                                        ) : (
                                            <>
                                                <NumDisplay value={entry.base_salary} color="text-data-2-ink" />
                                                <NumDisplay value={entry.commission}  color="text-primary-press" />
                                                <NumDisplay value={entry.expenses}    color="text-tone-good-ink" />
                                                <NumDisplay value={entry.holidays}    color="text-data-4-ink" />
                                                <NumDisplay value={entry.vacation}    color="text-data-6-ink" />
                                            </>
                                        )}

                                        {/* Row total */}
                                        <td className="px-3 py-2 text-right font-bold text-ink tabular-nums border-r border-hairline-strong">
                                            {rowTotal > 0 ? formatCurrencyCAD(rowTotal) : <span className="text-ink-faint">—</span>}
                                        </td>

                                        {/* Note */}
                                        <td className="px-3 py-2 border-r border-hairline-strong">
                                            {canEdit ? (
                                                <input
                                                    type="text"
                                                    value={entry.note}
                                                    onChange={e => updateField(entry.id, 'note', e.target.value)}
                                                    placeholder="Note..."
                                                    className="w-full bg-transparent text-xs text-ink-mute placeholder:text-ink-faint focus:outline-none italic"
                                                />
                                            ) : (
                                                <span className="text-xs text-ink-mute italic">{entry.note || ''}</span>
                                            )}
                                        </td>

                                        {canEdit && (
                                            <td className="px-2 py-2">
                                                <button
                                                    onClick={() => deleteEntry(entry.id)}
                                                    className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-ink-faint hover:text-tone-critical hover:bg-tone-critical-soft transition-all"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </td>
                                        )}
                                    </tr>
                                );
                            })}
                        </tbody>

                        <tfoot>
                            {/* Add row - admin only */}
                            {canEdit && (
                                <tr className="border-t border-hairline-strong bg-white">
                                    <td colSpan={9} className="px-4 py-2">
                                        <button
                                            onClick={addEntry}
                                            className="flex items-center gap-1.5 text-xs text-ink-faint hover:text-primary-press transition-colors font-medium"
                                        >
                                            <Plus className="w-3.5 h-3.5" />
                                            Nouvelle ligne
                                        </button>
                                    </td>
                                </tr>
                            )}
                            {/* Totals */}
                            <tr className="border-t-2 border-hairline-strong bg-stone">
                                <td className="px-3 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-eyebrow border-r border-hairline-strong">
                                    {`Total ${year}`}
                                </td>
                                <TotalCell value={totals.base_salary} color="text-data-2-ink" />
                                <TotalCell value={totals.commission}  color="text-primary-press" />
                                <TotalCell value={totals.expenses}    color="text-tone-good-ink" />
                                <TotalCell value={totals.holidays}    color="text-data-4-ink" />
                                <TotalCell value={totals.vacation}    color="text-data-6-ink" />
                                <td className="px-3 py-3 text-right font-bold text-ink tabular-nums text-base border-r border-hairline-strong">
                                    {formatCurrencyCAD(grandTotal)}
                                </td>
                                <td colSpan={canEdit ? 2 : 1} />
                            </tr>
                        </tfoot>
                    </table>
                </div>
                )}
            </div>

            {/* ─── Net total banner ────────────────────────────────────────── */}
            <div className="bg-white rounded-xl shadow-card px-4 md:px-6 py-4 md:py-5 flex items-center justify-between flex-wrap gap-4">
                <div>
                    <p className="text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Total Net · {year}</p>
                    <p className="text-2xl md:text-3xl font-bold text-ink mt-1 tabular-nums">{formatCurrencyCAD(netTotal)}</p>
                    <p className="text-xs text-ink-mute mt-1">
                        Paies{n(meta.previous_year_balance) !== 0 ? ` + Solde ${year - 1}` : ''}{n(meta.annual_bonus) !== 0 ? ' + Bonus' : ''}
                    </p>
                </div>
                <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-right">
                    <p className="text-xs text-ink-mute">Total des paies</p>
                    <p className="text-sm font-bold text-ink-secondary tabular-nums">{formatCurrencyCAD(grandTotal)}</p>
                    {n(meta.previous_year_balance) !== 0 && (<>
                        <p className="text-xs text-ink-mute">Solde {year - 1}</p>
                        <p className="text-sm font-bold text-data-2-ink tabular-nums">{formatCurrencyCAD(n(meta.previous_year_balance))}</p>
                    </>)}
                    {n(meta.annual_bonus) !== 0 && (<>
                        <p className="text-xs text-ink-mute">Bonus annuel</p>
                        <p className="text-sm font-bold text-primary-press tabular-nums">{formatCurrencyCAD(n(meta.annual_bonus))}</p>
                    </>)}
                </div>
            </div>
        </div>
    );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Th({ children, align, color, className }: {
    children?: React.ReactNode; align: 'left' | 'right'; color: string; className?: string;
}) {
    return (
        <th className={cn(
            "px-3 py-3 text-2xs font-semibold uppercase tracking-eyebrow border-r border-hairline-strong last:border-r-0",
            align === 'right' ? 'text-right' : 'text-left',
            color, className
        )}>
            {children}
        </th>
    );
}

function DateDDMMInput({ isoValue, onChange }: { isoValue: string; onChange: (iso: string) => void }) {
    const [focused, setFocused] = useState(false);
    const [draft, setDraft] = useState(isoToDDMMYYYY(isoValue));

    const handleBlur = () => {
        setFocused(false);
        const trimmed = draft.trim();
        if (trimmed === '') {
            if (isoValue) onChange('');
            return;
        }
        const iso = ddmmyyyyToISO(trimmed);
        if (iso) {
            if (iso !== isoValue) onChange(iso);
            setDraft(isoToDDMMYYYY(iso));
        } else {
            // Invalid input → revert to last good value
            setDraft(isoToDDMMYYYY(isoValue));
        }
    };

    // Pretty French long format when not editing; compact DD/MM/YYYY when typing.
    const displayValue = focused ? draft : (formatPayDate(isoValue) === '—' ? '' : formatPayDate(isoValue));

    return (
        <input
            type="text"
            inputMode={focused ? 'numeric' : undefined}
            value={displayValue}
            placeholder="JJ/MM/AAAA"
            onFocus={() => { setFocused(true); setDraft(isoToDDMMYYYY(isoValue)); }}
            onChange={e => setDraft(e.target.value)}
            onBlur={handleBlur}
            className="w-full bg-transparent text-ink-secondary font-medium focus:outline-none text-sm placeholder:text-ink-faint tabular-nums"
        />
    );
}

function NumInput({ value, onChange, color }: { value: string; onChange: (v: string) => void; color: string }) {
    const [focused, setFocused] = useState(false);
    const [draft, setDraft] = useState(value);

    const handleBlur = () => {
        setFocused(false);
        const trimmed = draft.trim();
        if (trimmed === '') return;
        const parsed = parseFloat(trimmed.replace(/[$,\s]/g, '').replace(',', '.'));
        if (isNaN(parsed)) return;
        const formatted = parsed.toFixed(2);
        if (formatted !== draft) onChange(formatted);
    };

    return (
        <td className="px-3 py-2 border-r border-hairline-strong">
            <input
                type="text"
                value={focused ? draft : value}
                onFocus={() => { setFocused(true); setDraft(value); }}
                onChange={e => {
                    const v = e.target.value.replace(/,/g, '.');
                    setDraft(v);
                    onChange(v);
                }}
                onBlur={handleBlur}
                placeholder="—"
                className={cn(
                    "w-full bg-transparent text-right font-semibold placeholder:text-ink-faint focus:outline-none tabular-nums text-sm min-w-[90px]",
                    color
                )}
            />
        </td>
    );
}

function NumDisplay({ value, color }: { value: number | null; color: string }) {
    return (
        <td className={cn("px-3 py-2 text-right font-semibold tabular-nums text-sm border-r border-hairline-strong", color)}>
            {value ? formatCurrencyCAD(value) : <span className="text-ink-faint">—</span>}
        </td>
    );
}

function TotalCell({ value, color }: { value: number; color: string }) {
    return (
        <td className={cn("px-3 py-3 text-right font-bold tabular-nums border-r border-hairline-strong", color)}>
            {value > 0 ? formatCurrencyCAD(value) : <span className="text-ink-faint">—</span>}
        </td>
    );
}

function MetaCard({ label, value, onChange, bg, text, readOnly }: {
    label: string; value: number; onChange?: (v: string) => void; bg: string; text: string; readOnly?: boolean;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value === 0 ? '' : String(value));

    return (
        <div className={cn("p-3 md:p-4 rounded-xl border", bg)}>
            <p className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow leading-tight mb-1.5 md:mb-2">{label}</p>
            {readOnly ? (
                <p className={cn("text-base md:text-xl font-bold tabular-nums", text)}>
                    {value ? formatCurrencyCAD(value) : <span className="text-ink-faint">—</span>}
                </p>
            ) : (
                <input
                    type="text"
                    value={editing ? draft : (value === 0 ? '' : formatCurrencyCAD(value))}
                    onFocus={() => { setEditing(true); setDraft(value === 0 ? '' : String(value)); }}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={() => { setEditing(false); onChange?.(draft); }}
                    placeholder="0,00$"
                    className={cn("text-base md:text-xl font-bold w-full bg-transparent focus:outline-none placeholder:text-ink-faint tabular-nums", text)}
                />
            )}
        </div>
    );
}
