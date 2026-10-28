import { useState, useEffect, useCallback } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import {
    Settings, Loader2, Check, X, Save, Users, ClipboardList, FileText,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatCurrencyCAD, cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { useRepList } from '../hooks/useRepList';
import { Select } from '../components/Select';
import { DEPARTMENTS, MONTHS } from '../lib/constants';
import { RepAvatar } from '../components/RepAvatar';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RepObjective {
    module: 'devis' | 'factures';
    month: number;
    target_amount: number;
}

interface RepObjectiveDept {
    module: 'devis' | 'factures';
    month: number;
    department: string;
    target_amount: number;
}

interface Props { propRepName?: string; }

const MONTH_LABELS = [
    'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
    'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

const DEPT_SHORT: Record<string, string> = {
    'MULTI-ANNONCEURS':        'Multi',
    'PROMOTIONNEL':            'Promo',
    'DIST. PUBLICITAIRE SOLO': 'Solo',
    'NUMERIQUE':               'Num.',
    'APPLICATION':             'App.',
    'SERVICES IA':             'IA',
};

// ─── Inline target cell ───────────────────────────────────────────────────────

function TargetCell({
    value, onSave, compact, placeholder,
}: {
    value: number; onSave: (v: number) => void; compact?: boolean; placeholder?: string;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');

    const commit = () => {
        const n = parseFloat(draft.replace(/[^0-9.]/g, '')) || 0;
        onSave(n);
        setEditing(false);
    };

    if (editing) {
        return (
            <div className="flex items-center gap-1">
                <input
                    autoFocus
                    type="text"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
                    className={cn(
                        'px-2 py-1.5 text-sm border border-primary rounded-md focus:outline-none text-right font-semibold bg-white',
                        compact ? 'w-24' : 'w-32'
                    )}
                    placeholder="0"
                />
                <button onClick={commit} className="p-1.5 text-tone-good hover:bg-tone-good-soft rounded-md transition-colors">
                    <Check className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setEditing(false)} className="p-1.5 text-ink-faint hover:bg-stone rounded-md transition-colors">
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
        );
    }

    return (
        <button
            onClick={() => { setDraft(value > 0 ? String(value) : ''); setEditing(true); }}
            className={cn(
                'w-full flex items-center justify-between gap-1.5 px-2.5 py-2 rounded-md transition-all group',
                value > 0
                    ? 'bg-sand hover:bg-primary/5 hover:text-primary-press text-ink-secondary'
                    : 'bg-sand hover:bg-primary/5 text-ink-faint hover:text-primary-press'
            )}
        >
            <Save className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity text-primary-press shrink-0" />
            <span className={cn('flex-1 text-right tabular-nums font-semibold', compact ? 'text-xs' : 'text-sm')}>
                {value > 0 ? formatCurrencyCAD(value) : (placeholder ?? '—')}
            </span>
        </button>
    );
}

// ─── Component ────────────────────────────────────────────────────────────────

// The admin check comes first and alone: an early return placed among the
// editor's hooks would change their number between renders.
export default function PortailParametres({ propRepName }: Props) {
    const { isAdmin } = useAuth();
    if (!isAdmin) {
        return (
            <div className="p-4 md:p-8 max-w-screen-xl mx-auto flex items-center justify-center min-h-[60vh]">
                <div className="text-center space-y-3">
                    <div className="w-14 h-14 rounded-xl bg-stone flex items-center justify-center mx-auto">
                        <Settings className="w-7 h-7 text-ink-faint" />
                    </div>
                    <h2 className="text-base font-semibold text-ink-secondary">Accès réservé aux administrateurs</h2>
                    <p className="text-sm text-ink-mute max-w-xs">Cette section est gérée par l'administrateur.</p>
                </div>
            </div>
        );
    }
    return <RepObjectivesEditor propRepName={propRepName} />;
}

function RepObjectivesEditor({ propRepName }: Props) {
    const { repName: authRepName, isAdmin } = useAuth();
    const { viewAsRep } = useAdminView();
    const repList = useRepList();
    const [adminPickedRep, setAdminPickedRep] = useUrlState('rep', '');

    // Admin accessing directly (no propRepName, not in view-as-rep): use their own picker
    // Admin in view-as-rep mode or with propRepName: use that rep
    // Member: not allowed
    const repName = propRepName
        ?? viewAsRep
        ?? (isAdmin ? adminPickedRep : authRepName)
        ?? '';

    const [year, setYear]           = useUrlStateNumber('year', new Date().getFullYear());
    const [deptModule, setDeptModule] = useUrlState('dept_module', 'devis');
    const module = deptModule as 'devis' | 'factures';

    // ── Data ──────────────────────────────────────────────────────────────────
    const [loading, setLoading]     = useState(true);
    const [saving, setSaving]       = useState<string | null>(null);
    const [objectives, setObjectives]     = useState<Record<string, number>>({});  // dept key: `month-dept`
    const [monthTargets, setMonthTargets] = useState<Record<string, number>>({});  // `module-month`

    const yearOptions = [2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    const deptKey = (month: number, dept: string) => `${month}-${dept}`;

    // ── Fetch ─────────────────────────────────────────────────────────────────

    const fetchAll = useCallback(async () => {
        if (!repName) { setLoading(false); return; }
        setLoading(true);

        const [deptRes, monthRes] = await Promise.all([
            supabase
                .from('rep_objectives_dept')
                .select('module, month, department, target_amount')
                .eq('rep_name', repName)
                .eq('module', module)
                .eq('year', year),
            supabase
                .from('rep_objectives')
                .select('module, month, target_amount')
                .eq('rep_name', repName)
                .eq('module', module)
                .eq('year', year),
        ]);

        const deptMap: Record<string, number> = {};
        for (const o of (deptRes.data ?? []) as RepObjectiveDept[]) {
            deptMap[deptKey(o.month, o.department)] = o.target_amount;
        }
        setObjectives(deptMap);

        const mMap: Record<string, number> = {};
        for (const o of (monthRes.data ?? []) as RepObjective[]) {
            mMap[`${o.module}-${o.month}`] = o.target_amount;
        }
        setMonthTargets(mMap);

        setLoading(false);
    }, [repName, module, year]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchAll(); }, [fetchAll]);

    // ── Save dept cell ────────────────────────────────────────────────────────

    const saveDept = async (month: number, department: string, target_amount: number) => {
        const key = deptKey(month, department);
        setSaving(key);
        await supabase.from('rep_objectives_dept').upsert(
            { rep_name: repName, module, year, month, department, target_amount, updated_at: new Date().toISOString() },
            { onConflict: 'rep_name,module,year,month,department' }
        );
        setObjectives(prev => ({ ...prev, [key]: target_amount }));
        setSaving(null);
    };

    // ── Save monthly total (manual, when no dept data) ────────────────────────

    const saveMonthTotal = async (month: number, target_amount: number) => {
        const key = `${module}-${month}`;
        setSaving(key);
        await supabase.from('rep_objectives').upsert(
            { rep_name: repName, module, year, month, target_amount, updated_at: new Date().toISOString() },
            { onConflict: 'rep_name,module,year,month' }
        );
        setMonthTargets(prev => ({ ...prev, [key]: target_amount }));
        setSaving(null);
    };

    // ── Derived totals ────────────────────────────────────────────────────────

    const deptSumForMonth = (month: number) =>
        DEPARTMENTS.reduce((s, d) => s + (objectives[deptKey(month, d)] ?? 0), 0);

    const effectiveMonthTotal = (month: number) => {
        const ds = deptSumForMonth(month);
        return ds > 0 ? ds : (monthTargets[`${module}-${month}`] ?? 0);
    };

    const deptAnnualTotal = (dept: string) =>
        MONTHS.reduce((s, m) => s + (objectives[deptKey(m.value, dept)] ?? 0), 0);

    const grandTotal = MONTHS.reduce((s, m) => s + effectiveMonthTotal(m.value), 0);

    // ── Render ────────────────────────────────────────────────────────────────

    // ─── Shared content (objectives grid) ───────────────────────────────────────

    const objectivesContent = (
        <div className="space-y-5">
            {/* Header row */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h2 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">
                        Objectifs Reps
                    </h2>
                    <p className="text-sm text-ink-mute mt-0.5">
                        {repName ? `Objectifs de ${repName}` : 'Sélectionnez un représentant'}
                    </p>
                </div>
                <Select
                    value={String(year)}
                    onChange={v => setYear(Number(v))}
                    options={yearOptions}
                    variant="accent"
                    className="w-28"
                />
            </div>

            {/* Module tabs */}
            <div className="flex items-center gap-1 p-1 bg-stone rounded-xl w-fit">
                {(['devis', 'factures'] as const).map(m => (
                    <button
                        key={m}
                        onClick={() => setDeptModule(m)}
                        className={cn(
                            'flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-semibold transition-all',
                            module === m
                                ? 'bg-white text-ink shadow-xs'
                                : 'text-ink-mute hover:text-ink-secondary'
                        )}
                    >
                        {m === 'devis'
                            ? <ClipboardList className={cn('w-4 h-4', module === m ? 'text-data-2-ink' : 'text-ink-mute')} />
                            : <FileText className={cn('w-4 h-4', module === m ? 'text-data-3-ink' : 'text-ink-mute')} />}
                        {m === 'devis' ? 'Objectifs Devis' : 'Objectifs Factures'}
                    </button>
                ))}
            </div>

            {/* Objectives table */}
            {!repName ? (
                <div className="flex items-center justify-center py-16 bg-white rounded-xl border border-hairline">
                    <p className="text-sm text-ink-mute">Représentant non sélectionné</p>
                </div>
            ) : loading ? (
                <div className="flex items-center justify-center py-12 gap-2">
                    <Loader2 className="w-5 h-5 animate-spin text-ink-faint" />
                    <span className="text-sm text-ink-mute">Chargement...</span>
                </div>
            ) : (
                <div className="bg-white rounded-xl shadow-card overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-hairline bg-sand/60">
                                    <th className="px-4 py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow sticky left-0 bg-sand/60 whitespace-nowrap">
                                        Mois
                                    </th>
                                    {DEPARTMENTS.map(d => (
                                        <th key={d} className="px-2 py-3 text-2xs font-semibold uppercase tracking-eyebrow text-ink-mute whitespace-nowrap min-w-[110px]">
                                            <span title={d}>{DEPT_SHORT[d] ?? d}</span>
                                        </th>
                                    ))}
                                    <th className="px-4 py-3 text-right text-2xs font-semibold text-ink-secondary uppercase tracking-eyebrow whitespace-nowrap min-w-[130px] border-l border-hairline">
                                        Total mois
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hairline">
                                {MONTH_LABELS.map((label, i) => {
                                    const month = i + 1;
                                    const deptSum = deptSumForMonth(month);
                                    const manualTotal = monthTargets[`${module}-${month}`] ?? 0;
                                    const hasDeptsSet = deptSum > 0;
                                    return (
                                        <tr key={month} className="hover:bg-sand/40 transition-colors">
                                            <td className="px-4 py-2 font-semibold text-ink-secondary sticky left-0 bg-white whitespace-nowrap text-sm">
                                                {label}
                                                {saving?.startsWith(`${month}-`) || saving === `${module}-${month}` ? (
                                                    <Loader2 className="w-3 h-3 animate-spin text-ink-faint inline ml-2" />
                                                ) : null}
                                            </td>
                                            {DEPARTMENTS.map(dept => {
                                                const key = deptKey(month, dept);
                                                return (
                                                    <td key={dept} className="px-2 py-1.5">
                                                        {saving === key ? (
                                                            <div className="flex items-center justify-center h-8">
                                                                <Loader2 className="w-3 h-3 animate-spin text-ink-faint" />
                                                            </div>
                                                        ) : (
                                                            <TargetCell
                                                                value={objectives[key] ?? 0}
                                                                onSave={v => saveDept(month, dept, v)}
                                                                compact
                                                            />
                                                        )}
                                                    </td>
                                                );
                                            })}
                                            <td className="px-3 py-1.5 border-l border-hairline">
                                                {hasDeptsSet ? (
                                                    <div className="flex items-center justify-end gap-1.5 px-2.5 py-2">
                                                        <span className="text-2xs font-semibold uppercase tracking-label text-tone-good bg-tone-good-soft px-1.5 py-0.5 rounded-full shrink-0">auto</span>
                                                        <span className="text-sm font-bold tabular-nums text-ink">
                                                            {formatCurrencyCAD(deptSum)}
                                                        </span>
                                                    </div>
                                                ) : (
                                                    <TargetCell
                                                        value={manualTotal}
                                                        onSave={v => saveMonthTotal(month, v)}
                                                        placeholder="Fixer objectif"
                                                    />
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                            <tfoot>
                                <tr className="border-t-2 border-hairline bg-sand/60">
                                    <td className="px-4 py-3 text-xs font-semibold text-ink-mute uppercase tracking-eyebrow sticky left-0 bg-sand/60">
                                        Total {year}
                                    </td>
                                    {DEPARTMENTS.map(dept => {
                                        const t = deptAnnualTotal(dept);
                                        return (
                                            <td key={dept} className="px-2 py-3 text-center">
                                                <span className="text-xs font-bold text-ink-secondary tabular-nums">
                                                    {t > 0 ? formatCurrencyCAD(t) : <span className="text-ink-faint">—</span>}
                                                </span>
                                            </td>
                                        );
                                    })}
                                    <td className="px-4 py-3 text-right border-l border-hairline">
                                        <span className="text-sm font-bold text-ink tabular-nums">
                                            {grandTotal > 0 ? formatCurrencyCAD(grandTotal) : <span className="text-ink-faint">—</span>}
                                        </span>
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );

    return (
        <div className="p-4 md:p-8 max-w-screen-2xl mx-auto">

            {isAdmin && !propRepName && !viewAsRep ? (
                /* ─── Admin view: bordered container with hero + content ─── */
                <div className="rounded-xl border border-primary/20 shadow-card overflow-visible">
                    {/* Hero - orange gradient */}
                    <div className="bg-primary rounded-t-xl px-6 py-6 md:py-7">
                        <p className="text-2xs font-semibold text-white uppercase tracking-eyebrow mb-5">
                            Objectifs du représentant
                        </p>
                        <div className="flex flex-col md:flex-row md:items-center gap-5 md:gap-8">
                            <div className="flex items-center gap-4 flex-1 min-w-0">
                                {adminPickedRep
                                    ? <RepAvatar name={adminPickedRep} size="lg" square className="w-14 h-14 ring-2 ring-white/70 shadow-lg shadow-black/10" literal />
                                    : <div className="w-14 h-14 rounded-xl bg-black/15 text-white flex items-center justify-center shrink-0">
                                          <Users className="w-6 h-6" />
                                      </div>}
                                <div className="min-w-0">
                                    {adminPickedRep ? (
                                        <h2 className="text-xl md:text-2xl font-semibold text-white tracking-tight truncate">
                                            {adminPickedRep}
                                        </h2>
                                    ) : (
                                        <h2 className="text-lg md:text-xl font-semibold text-white">
                                            Sélectionner un représentant
                                        </h2>
                                    )}
                                    <p className="text-xs text-white mt-0.5">
                                        {adminPickedRep
                                            ? 'Tous les objectifs ci-dessous correspondent à ce représentant'
                                            : 'Choisissez un représentant pour modifier ses objectifs'}
                                    </p>
                                </div>
                            </div>
                            <div className="w-full md:w-64 shrink-0">
                                <Select
                                    value={adminPickedRep}
                                    onChange={setAdminPickedRep}
                                    options={[
                                        { value: '', label: adminPickedRep ? 'Changer de représentant...' : 'Choisir un représentant...' },
                                        ...repList.map(r => ({ value: r, label: r })),
                                    ]}
                                    variant={adminPickedRep ? 'accent' : 'default'}
                                    className="w-full"
                                />
                            </div>
                        </div>
                    </div>
                    {/* Content inside the border box */}
                    <div className="px-4 md:px-6 py-5 bg-white rounded-b-xl">
                        {objectivesContent}
                    </div>
                </div>
            ) : (
                /* ─── Embedded / rep view: plain content ─── */
                objectivesContent
            )}
        </div>
    );
}

