import { useState, useEffect, useCallback } from 'react';
import { useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { Save, RefreshCcw, Target } from 'lucide-react';
import { Select } from '../components/Select';
import { DEPARTMENTS, MONTHS } from '../lib/constants';
import { useAuth } from '../contexts/AuthContext';
import { cn } from '../lib/utils';
import { ExportButton } from '../components/ExportButton';
import { autoColumns } from '../lib/csv';

interface Objective { id: string; year: number; month: number; department: string; target_amount: number; }

export default function ObjectifsEquipe() {
    const { isAdmin } = useAuth();
    const [year, setYear] = useUrlStateNumber('obj_year', new Date().getFullYear());
    const [objectives, setObjectives] = useState<Objective[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const fetchObjectives = useCallback(async () => {
        setLoading(true);
        const { data, error } = await supabase
            .from('objectives_factures')
            .select('*')
            .eq('year', year);
        if (error) console.error(error);
        else setObjectives(data || []);
        setLoading(false);
    }, [year]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchObjectives(); }, [fetchObjectives]);

    const handleUpdate = (month: number, dept: string, value: string) => {
        const amount = parseFloat(value) || 0;
        const existing = objectives.find(o => o.month === month && o.department === dept);
        if (existing) {
            setObjectives(prev => prev.map(o => o.id === existing.id ? { ...o, target_amount: amount } : o));
        } else {
            setObjectives(prev => [...prev, { year, month, department: dept, target_amount: amount, id: 'temp-' + Date.now() }]);
        }
    };

    const saveAll = async () => {
        setSaving(true);
        const toSave = objectives.map(o => ({ year, month: o.month, department: o.department, target_amount: o.target_amount }));
        const { error: delError } = await supabase.from('objectives_factures').delete().eq('year', year);
        if (delError) { setSaving(false); return; }
        const { error: insError } = await supabase.from('objectives_factures').insert(toSave);
        if (!insError) { setSaved(true); setTimeout(() => setSaved(false), 3000); fetchObjectives(); }
        setSaving(false);
    };

    const yearOptions = [2024, 2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    if (!isAdmin) {
        return (
            <div className="flex items-center justify-center h-64">
                <p className="text-ink-mute text-sm">Accès réservé aux administrateurs.</p>
            </div>
        );
    }

    return (
        <div className="p-4 md:p-8 max-w-screen-xl mx-auto space-y-6">

            {/* Header */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2.5 mb-1">
                        <div className="p-2 rounded-md bg-primary/10">
                            <Target className="w-4 h-4 text-primary-press" />
                        </div>
                        <h1 className="text-xl font-semibold text-ink tracking-tight">Objectifs Équipe</h1>
                    </div>
                    <p className="text-sm text-ink-mute">Cibles mensuelles de facturation par département · {year}</p>
                </div>

                <div className="flex items-center gap-3">
                    <ExportButton
                        rows={objectives} columns={autoColumns(objectives)}
                        filename={`objectifs_equipe_${year}`}
                        disabled={objectives.length === 0}
                    />
                    <Select
                        value={String(year)}
                        onChange={v => setYear(Number(v))}
                        options={yearOptions}
                        variant="accent"
                        className="w-24"
                    />
                    <button
                        onClick={saveAll}
                        disabled={saving}
                        className={cn(
                            "btn btn-md",
                            saved
                                ? "bg-tone-good text-white"
                                : "btn-primary"
                        )}
                    >
                        {saving
                            ? <RefreshCcw className="w-4 h-4 animate-spin" />
                            : <Save className="w-4 h-4" />}
                        {saved ? 'Sauvegardé !' : 'Enregistrer'}
                    </button>
                </div>
            </div>

            {/* Grid */}
            <div className="bg-white rounded-xl shadow-card overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                    <thead>
                        <tr className="border-b border-hairline bg-sand/60">
                            <th className="px-5 py-3.5 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow sticky left-0 bg-sand/60">
                                Mois
                            </th>
                            {DEPARTMENTS.map(dept => (
                                <th key={dept} className="px-4 py-3.5 text-center text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap">
                                    {dept.length > 15 ? dept.substring(0, 13) + '…' : dept}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {loading ? (
                            <tr>
                                <td colSpan={DEPARTMENTS.length + 1} className="px-5 py-12 text-center text-ink-mute italic text-sm">
                                    Chargement...
                                </td>
                            </tr>
                        ) : MONTHS.map(month => {
                            const monthNum = month.value;
                            return (
                                <tr key={monthNum} className="hover:bg-sand/60 transition-colors">
                                    <td className="px-5 py-2.5 font-semibold text-ink-secondary sticky left-0 bg-white whitespace-nowrap">
                                        {month.label}
                                    </td>
                                    {DEPARTMENTS.map(dept => {
                                        const obj = objectives.find(o => o.month === monthNum && o.department === dept);
                                        return (
                                            <td key={dept} className="px-3 py-2">
                                                <input
                                                    type="number"
                                                    className="w-full bg-sand border-0 rounded-md px-3 py-2 text-right text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/30 focus:bg-white transition-all tabular-nums"
                                                    value={obj?.target_amount || ''}
                                                    placeholder="0"
                                                    onChange={e => handleUpdate(monthNum, dept, e.target.value)}
                                                />
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <p className="text-xs text-ink-mute px-1">
                Montants avant taxes · Cliquez sur Enregistrer après chaque modification.
            </p>
        </div>
    );
}
