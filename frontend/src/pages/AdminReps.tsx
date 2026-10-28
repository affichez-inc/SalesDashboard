import { useEffect, useState, useCallback, useRef } from 'react';
import { cachedRpc } from '../lib/rpcCache';
import { Loader2, ClipboardList, FileText, Wallet, User, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useRepTeam } from '../lib/repTeam';
import PortailDevis from './PortailDevis';
import PortailFactures from './PortailFactures';
import PortailPaye from './PortailPaye';
import { RepAvatar } from '../components/RepAvatar';

type Tab = 'devis' | 'factures' | 'paye';

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
    { key: 'devis',     label: 'Devis',     icon: ClipboardList },
    { key: 'factures',  label: 'Factures',  icon: FileText },
    { key: 'paye',      label: 'Paye',      icon: Wallet },
];

// ─── Rep picker ───────────────────────────────────────────────────────────────

function RepPicker({ reps, selected, onChange }: {
    reps: string[];
    selected: string;
    onChange: (rep: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const close = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        window.addEventListener('click', close);
        return () => window.removeEventListener('click', close);
    }, [open]);

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen(v => !v)}
                className="flex items-center gap-2.5 px-4 py-2.5 bg-white border border-hairline-strong rounded-md text-sm font-semibold text-ink-secondary hover:border-primary hover:text-primary-press transition-all shadow-xs min-w-[200px]"
            >
                {selected
                    ? <RepAvatar name={selected} size="md" literal />
                    : <div className="w-8 h-8 rounded-full bg-primary-wash text-primary-press flex items-center justify-center shrink-0">
                          <User className="w-3.5 h-3.5" />
                      </div>}
                <span className="flex-1 text-left">{selected || 'Choisir un représentant'}</span>
                <ChevronDown className={cn("w-4 h-4 text-ink-mute transition-transform", open && "rotate-180")} />
            </button>

            {open && (
                <div className="absolute top-full left-0 mt-2 w-64 bg-white rounded-lg border border-hairline-strong shadow-xl overflow-hidden z-30">
                    <div className="px-3 py-2 border-b border-hairline">
                        <p className="text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">Représentants</p>
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                        {reps.length === 0 ? (
                            <p className="px-4 py-3 text-sm text-ink-mute">Aucun représentant trouvé</p>
                        ) : reps.map(rep => (
                            <button
                                key={rep}
                                onClick={() => { onChange(rep); setOpen(false); }}
                                className={cn(
                                    "w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors text-left",
                                    rep === selected
                                        ? "bg-primary/5 text-primary-press font-semibold"
                                        : "text-ink-secondary hover:bg-sand font-medium"
                                )}
                            >
                                <RepAvatar name={rep} size="md" literal />
                                {rep}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AdminReps() {
    const { isAdmin } = useAuth();

    const [allReps, setAllReps]     = useState<string[]>([]);
    const [selectedRep, setSelectedRep] = useState('');
    const [activeTab, setActiveTab] = useState<Tab>('devis');
    const [loadingReps, setLoadingReps] = useState(true);

    const repTeam = useRepTeam();

    // Load rep list once from the leaderboard RPC. It waits for the team list:
    // before that arrives every name looks off-team, and the picker would offer
    // billing entities.
    const loadReps = useCallback(async () => {
        if (!repTeam.loaded) return;
        setLoadingReps(true);
        const { data } = await cachedRpc('get_inv_rep_leaderboard', {
            p_year: 2026, p_office: null, p_status: null,
            p_month: null, p_dept: null, p_rep: null,
        });
        if (data && Array.isArray(data) && data.length > 0) {
            const names = (data as { rep_name: string }[])
                .map(r => r.rep_name)
                .filter(n => !repTeam.isInternal(n))
                .sort();
            setAllReps(names);
            setSelectedRep(names[0] ?? '');
        }
        setLoadingReps(false);
    }, [repTeam]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { loadReps(); }, [loadReps]);

    if (!isAdmin) {
        return (
            <div className="flex items-center justify-center h-64">
                <p className="text-ink-mute text-sm">Accès réservé aux administrateurs.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">

            {/* ─── Portal header ─── */}
            <div className="bg-white border-b border-hairline px-6 md:px-8 pt-6 pb-0">
                <div className="max-w-screen-2xl mx-auto">

                    {/* Rep identity + picker */}
                    <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
                        <div className="flex items-center gap-4">
                            <RepAvatar name={selectedRep} size="lg" square literal />
                            <div>
                                <h1 className="text-xl font-semibold text-ink tracking-tight">
                                    {selectedRep || '—'}
                                </h1>
                                <p className="text-sm text-ink-mute">Portail représentant · Vue admin</p>
                            </div>
                        </div>

                        {loadingReps ? (
                            <div className="flex items-center gap-2 text-sm text-ink-mute">
                                <Loader2 className="w-4 h-4 animate-spin" /> Chargement des reps...
                            </div>
                        ) : (
                            <RepPicker reps={allReps} selected={selectedRep} onChange={rep => { setSelectedRep(rep); }} />
                        )}
                    </div>

                    {/* Tab bar - same visual as module nav but inline */}
                    <div className="flex items-center gap-1">
                        {TABS.map(tab => {
                            const Icon = tab.icon;
                            const active = activeTab === tab.key;
                            return (
                                <button
                                    key={tab.key}
                                    onClick={() => setActiveTab(tab.key)}
                                    className={cn(
                                        "flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-xl border-b-2 transition-all",
                                        active
                                            ? "border-primary text-primary-press bg-primary/5"
                                            : "border-transparent text-ink-mute hover:text-ink-secondary hover:bg-sand"
                                    )}
                                >
                                    <Icon className="w-4 h-4" />
                                    {tab.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* ─── Tab content ─── */}
            <div className="flex-1 overflow-auto">
                {!selectedRep ? (
                    <div className="flex flex-col items-center justify-center py-24 gap-3">
                        <div className="w-16 h-16 rounded-xl bg-stone flex items-center justify-center">
                            <User className="w-8 h-8 text-ink-faint" />
                        </div>
                        <p className="text-ink-mute font-medium">Sélectionnez un représentant</p>
                    </div>
                ) : (
                    <>
                        {activeTab === 'devis'    && <PortailDevis    propRepName={selectedRep} />}
                        {activeTab === 'factures' && <PortailFactures propRepName={selectedRep} />}
                        {activeTab === 'paye'     && <PortailPaye     propRepName={selectedRep} />}
                    </>
                )}
            </div>
        </div>
    );
}
