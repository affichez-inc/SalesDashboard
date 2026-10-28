import { useState, useEffect, useRef, useCallback } from 'react';
import { useUrlState, useUrlStateNumber } from '../hooks/useUrlState';
import { supabase } from '../lib/supabase';
import { cachedRpc, invalidateRpcCache } from '../lib/rpcCache';
import {
    Target, History, Save, RefreshCcw,
    AlertCircle, CheckCircle2, Calendar, ChevronRight,
    Zap, Loader2, Users, Trash2, Plus,
    Ban, Search, X, Link2
} from 'lucide-react';
import { cn, formatShortDate } from '../lib/utils';
import type { InvoiceLinkageStatus } from '../types/database';
import { UnmappedDepartmentsCard, QuoteCreatorCard } from '../components/settings/DataHealthCards';
import { AdsSyncCard } from '../components/settings/AdvertisingCards';
import { DEPARTMENTS, MONTHS } from '../lib/constants';
import { Select } from '../components/Select';
import { useAuth } from '../contexts/AuthContext';
import { SECTIONS, DEFAULT_FLAGS } from '../lib/sections';
import type { SectionFlags } from '../lib/sections';
import { useNow } from '../hooks/useNow';

type Tab = 'objectives' | 'quarters' | 'sync' | 'logs' | 'users' | 'excluded';

interface Objective { id: string; year: number; month: number; department: string; target_amount: number; }
interface Quarter { id: string; year: number; quarter: number; start_date: string; end_date: string; num_weeks: number; }
interface WebhookLog { id: string; received_at: string; action: string; status_code: number; zoho_id: string | null; error_message: string | null; }
interface AllowedUser extends SectionFlags { email: string; name: string | null; role: string; rep_name: string | null; }

const EMPTY_USER: AllowedUser = { email: '', name: '', role: 'member', rep_name: '', ...DEFAULT_FLAGS };

/** The section flags of a row, with the column default wherever one is missing. */
function flagsOf(row: Partial<SectionFlags>): SectionFlags {
    const flags = { ...DEFAULT_FLAGS };
    for (const s of SECTIONS) {
        const value = row[s.column];
        if (typeof value === 'boolean') flags[s.column] = value;
    }
    return flags;
}

export default function Settings() {
    const { isAdmin } = useAuth();
    const [activeTab, setActiveTab] = useUrlState('tab', 'objectives') as [Tab, (v: Tab) => void];
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

    const tabItems: { id: Tab; label: string; icon: React.ElementType; adminOnly?: boolean }[] = [
        { id: 'objectives', label: 'Objectifs Équipe', icon: Target },
        { id: 'quarters', label: 'Trimestres', icon: Calendar },
        { id: 'sync', label: 'Synchronisation', icon: Zap },
        { id: 'logs', label: 'Historique', icon: History },
        { id: 'users', label: 'Utilisateurs', icon: Users, adminOnly: true },
        { id: 'excluded', label: 'Clients Exclus', icon: Ban, adminOnly: true },
    ];

    useEffect(() => {
        if (message) { const t = setTimeout(() => setMessage(null), 4000); return () => clearTimeout(t); }
    }, [message]);

    const visibleTabs = tabItems.filter(t => !t.adminOnly || isAdmin);

    return (
        <div className="p-4 md:p-8 max-w-screen-xl mx-auto">
            <div className="mb-6">
                <h1 className="text-xl md:text-2xl font-semibold text-ink tracking-tight">Paramètres</h1>
                <p className="text-xs md:text-sm text-ink-mute mt-0.5">Objectifs, trimestres, synchronisation et utilisateurs.</p>
            </div>

            {message && (
                <div className={cn("flex items-center gap-3 p-4 rounded-md border mb-6 text-sm font-medium",
                    message.type === 'success' ? "bg-tone-good-soft border-tone-good/30 text-tone-good-ink" : "bg-tone-critical-soft border-tone-critical/30 text-tone-critical-ink")}>
                    {message.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                    {message.text}
                </div>
            )}

            <div className="flex gap-1 bg-stone p-1 rounded-md mb-6 overflow-x-auto max-w-full">
                {visibleTabs.map(tab => (
                    <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                        className={cn("flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all",
                            activeTab === tab.id ? "bg-white text-ink shadow-card" : "text-ink-mute hover:text-ink-secondary")}>
                        <tab.icon className="w-4 h-4" />
                        {tab.label}
                    </button>
                ))}
            </div>

            {activeTab === 'objectives' && <ObjectivesManager setMessage={setMessage} />}
            {activeTab === 'quarters' && <QuartersViewer />}
            {activeTab === 'sync' && <SyncManager />}
            {activeTab === 'logs' && <WebhookLogs />}
            {activeTab === 'users' && isAdmin && <UsersManager setMessage={setMessage} />}
            {activeTab === 'excluded' && isAdmin && <ExcludedClientsManager setMessage={setMessage} />}
        </div>
    );
}

// ─── Objectives Manager (Factures only) ──────────────────────────────────────
function ObjectivesManager({ setMessage }: { setMessage: (m: { type: 'success' | 'error', text: string }) => void }) {
    const [year, setYear] = useUrlStateNumber('obj_year', new Date().getFullYear());
    const [objectives, setObjectives] = useState<Objective[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const fetchObjectives = useCallback(async () => {
        setLoading(true);
        const { data, error } = await supabase.from('objectives_factures').select('*').eq('year', year);
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
        if (delError) { setMessage({ type: 'error', text: 'Erreur lors du nettoyage.' }); setSaving(false); return; }
        const { error: insError } = await supabase.from('objectives_factures').insert(toSave);
        if (insError) setMessage({ type: 'error', text: 'Erreur lors de la sauvegarde.' });
        else { setMessage({ type: 'success', text: 'Objectifs sauvegardés.' }); fetchObjectives(); }
        setSaving(false);
    };

    const yearOptions = [2024, 2025, 2026, 2027].map(y => ({ value: String(y), label: String(y) }));

    return (
        <div className="space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3 flex-wrap">
                    <h2 className="text-base font-semibold text-ink">Objectifs Factures par département</h2>
                    <Select value={String(year)} onChange={(val) => setYear(Number(val))} options={yearOptions} variant="accent" className="w-24" />
                </div>
                <button onClick={saveAll} disabled={saving}
                    className="btn btn-md btn-primary">
                    {saving ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Enregistrer
                </button>
            </div>

            <div className="bg-white rounded-xl shadow-card overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                    <thead>
                        <tr className="border-b border-hairline">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-ink-mute uppercase tracking-eyebrow sticky left-0 bg-white">Mois</th>
                            {DEPARTMENTS.map(dept => (
                                <th key={dept} className="px-4 py-3 text-center text-xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap">
                                    {dept.length > 15 ? dept.substring(0, 13) + '…' : dept}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {loading ? (
                            <tr><td colSpan={7} className="px-5 py-10 text-center text-ink-mute italic text-sm">Chargement...</td></tr>
                        ) : MONTHS.map((month) => {
                            const monthNum = month.value;
                            return (
                                <tr key={month.value} className="hover:bg-sand/60 transition-colors">
                                    <td className="px-5 py-2.5 font-semibold text-ink-secondary sticky left-0 bg-white whitespace-nowrap">{month.label}</td>
                                    {DEPARTMENTS.map(dept => {
                                        const obj = objectives.find(o => o.month === monthNum && o.department === dept);
                                        return (
                                            <td key={dept} className="px-3 py-2">
                                                <input type="number"
                                                    className="w-full bg-sand border-0 rounded-md px-3 py-2 text-right text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/30 focus:bg-white transition-all"
                                                    value={obj?.target_amount || ''}
                                                    placeholder="0"
                                                    onChange={e => handleUpdate(monthNum, dept, e.target.value)} />
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <p className="text-xs text-ink-mute px-1">* Montants avant taxes. Sauvegardez après chaque modification.</p>
        </div>
    );
}

// ─── Quarters Viewer ──────────────────────────────────────────────────────────
function QuartersViewer() {
    const [quarters, setQuarters] = useState<Quarter[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        supabase.from('fiscal_quarters').select('*').order('year', { ascending: false }).order('quarter')
            .then(({ data, error }) => { if (error) console.error(error); else setQuarters(data || []); setLoading(false); });
    }, []);

    return (
        <div className="space-y-4 max-w-3xl">
            <h2 className="text-base font-semibold text-ink">Calendrier Fiscal (13 semaines / trimestre)</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {loading ? (
                    <div className="col-span-2 py-10 text-center text-ink-mute italic text-sm">Chargement...</div>
                ) : quarters.map(q => (
                    <div key={q.id} className="bg-white shadow-card rounded-xl p-5 flex items-center justify-between hover:border-primary/20 transition-colors">
                        <div>
                            <div className="text-xs font-semibold text-primary-press uppercase tracking-eyebrow mb-0.5">Trimestre #{q.quarter}</div>
                            <div className="font-bold text-ink">Année {q.year}</div>
                            <div className="text-xs text-ink-mute mt-0.5">{q.num_weeks} semaines</div>
                        </div>
                        <div className="text-right">
                            <div className="text-sm font-medium text-ink-secondary">{formatShortDate(q.start_date)}</div>
                            <ChevronRight className="w-4 h-4 text-ink-faint mx-auto my-0.5" />
                            <div className="text-sm font-medium text-ink-secondary">{formatShortDate(q.end_date)}</div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ─── Sync Manager ─────────────────────────────────────────────────────────────
interface SyncResult { upserted: number; deleted?: number; voided?: number; errors: string[]; duration_ms: number; }

function SyncManager() {
    const { isAdmin } = useAuth();
    return (
        <div className="space-y-8 max-w-3xl">
            <SyncCard
                title="Synchronisation Devis (Zoho Books)"
                description="Importe les devis Acceptés et Facturés depuis QC + MTL. Les devis refusés sont mis à jour automatiquement."
                endpoint="zoho-sync"
                actionLabel="sync_manual"
            />
            <SyncCard
                title="Synchronisation Factures (Zoho Books)"
                description="Importe les factures Payées, Partielles, Envoyées et En retard depuis QC + MTL. Inclut les factures d'avoir (crédits)."
                endpoint="zoho-invoice-sync"
                actionLabel="sync_invoices_manual"
            />
            <SyncCard
                title="Synchronisation Tâches (Zoho CRM)"
                description="Importe les tâches Zoho CRM (créées, complétées, échéances, propriétaire). Synchronisation incrémentale via Modified_Time."
                endpoint="zoho-task-sync"
                actionLabel="sync_tasks_manual"
            />
            <LinkageCard />
            <QuoteCreatorCard />
            {isAdmin && <AdsSyncCard />}
            {/* Placed last and deliberately loud when it has anything to say: this
                card is the alarm that did not exist when ÉVÈNEMENT went missing
                for sixteen months. */}
            <UnmappedDepartmentsCard />
            <div className="flex items-start gap-3 px-4 py-3 bg-sand rounded-md border border-hairline text-xs text-ink-mute">
                <Calendar className="w-4 h-4 text-ink-mute shrink-0 mt-0.5" />
                <span>
                    Synchronisation automatique planifiée via pg_cron : <strong className="text-ink-secondary">Devis et Factures aux 5 min</strong>, <strong className="text-ink-secondary">Tâches CRM aux 20 min</strong>, <strong className="text-ink-secondary">Liaison factures aux 30 min</strong>, <strong className="text-ink-secondary">Créateurs des devis aux 3 min</strong>,{' '}<strong className="text-ink-secondary">Dépenses publicitaires aux 4 h</strong>.
                </span>
            </div>
        </div>
    );
}

/**
 * Progress of the Books-customer -> CRM-account bridge, which is what puts an
 * invoice on a lead.
 *
 * Worth its own card rather than a SyncCard: this job is not a plain import. It
 * works through a queue a slice at a time under Zoho's rate limit (100 calls per
 * minute per organisation), so the useful thing to show is how much is left, not
 * how many rows the last run touched. The button takes one slice; press it again,
 * or wait for the half-hourly cron, until "restant" reaches zero.
 */
function LinkageCard() {
    const [status, setStatus] = useState<InvoiceLinkageStatus | null>(null);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastRun, setLastRun] = useState<string | null>(null);

    const fetchStatus = async () => {
        const { data } = await cachedRpc('get_invoice_linkage_status', undefined, { single: true });
        setStatus((data as InvoiceLinkageStatus) ?? null);
    };

    // Load once when the Synchronisation tab mounts. The lint rule fires on any
    // setState reachable from an effect body; here the write happens in the
    // awaited continuation, not synchronously, so there is no cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchStatus(); }, []);

    const runLink = async () => {
        setRunning(true); setError(null);
        try {
            const res = await fetch(
                `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/zoho-books-customer-link`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
                        'x-sync-source': 'manual',
                    },
                },
            );
            const data = await res.json();
            if (!res.ok) setError(data.error ?? 'Erreur inconnue');
            else {
                setLastRun(
                    `${(data.orgs ?? []).reduce((n: number, o: { linked: number }) => n + o.linked, 0)} li\u00e9s, ` +
                    `${data.remaining ?? 0} restant`,
                );
                // The sync just wrote rows; the linkage figures it reports
                // are exactly what changed.
                invalidateRpcCache();
                await fetchStatus();
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Erreur r\u00e9seau');
        }
        setRunning(false);
    };

    const pending = status?.customers_pending ?? 0;
    const coverage = status && status.invoices_total > 0
        ? Math.round((status.invoices_with_account / status.invoices_total) * 100)
        : 0;

    return (
        <div className="bg-white rounded-xl shadow-card p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-base font-semibold text-ink flex items-center gap-2">
                        <Link2 className="w-4 h-4 text-primary-press" />
                        Liaison Factures &rarr; Comptes CRM
                    </h2>
                    <p className="text-xs text-ink-mute mt-1">
                        Associe chaque client Zoho Books \u00e0 son compte Zoho CRM, ce qui permet
                        d&rsquo;afficher les factures sur la fiche d&rsquo;un lead ou d&rsquo;un contact.
                        Chaque ex\u00e9cution traite une tranche&nbsp;: relancer jusqu&rsquo;\u00e0 ce
                        qu&rsquo;il ne reste rien.
                    </p>
                    {lastRun && (
                        <p className="text-xs text-ink-mute mt-2 font-medium">
                            Dernier passage&nbsp;: <span className="text-ink-secondary">{lastRun}</span>
                        </p>
                    )}
                </div>
                <button
                    onClick={runLink}
                    disabled={running}
                    className="btn btn-md btn-primary shrink-0"
                >
                    {running
                        ? <><Loader2 className="w-4 h-4 animate-spin" /> Liaison...</>
                        : <><RefreshCcw className="w-4 h-4" /> Lier</>}
                </button>
            </div>

            {status && (
                <div className="pt-4 border-t border-hairline space-y-3">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone">
                        <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${coverage}%` }}
                        />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
                        <Stat label="Factures reli\u00e9es"
                              value={`${status.invoices_with_account.toLocaleString('fr-CA')} / ${status.invoices_total.toLocaleString('fr-CA')} (${coverage}%)`} />
                        <Stat label="Clients li\u00e9s" value={String(status.customers_linked)} />
                        <Stat label="Sans compte CRM" value={String(status.customers_unlinked)} muted />
                        <Stat label="Restant" value={String(pending)} highlight={pending > 0} />
                        {status.customers_error > 0 && (
                            <Stat label="Erreurs" value={String(status.customers_error)} danger />
                        )}
                    </div>
                </div>
            )}

            {error && (
                <div className="flex items-center gap-2 text-sm text-tone-critical-ink">
                    <AlertCircle className="w-4 h-4" />{error}
                </div>
            )}
        </div>
    );
}

function Stat({ label, value, muted, highlight, danger }: {
    label: string; value: string; muted?: boolean; highlight?: boolean; danger?: boolean;
}) {
    return (
        <span className="flex items-baseline gap-1.5">
            <span className="text-ink-mute">{label}</span>
            <span className={cn(
                'font-bold tabular-nums',
                danger ? 'text-tone-critical-ink'
                    : highlight ? 'text-primary-press'
                    : muted ? 'text-ink-mute'
                    : 'text-ink-secondary',
            )}>{value}</span>
        </span>
    );
}

function SyncCard({ title, description, endpoint, actionLabel }: { title: string; description: string; endpoint: string; actionLabel: string }) {
    const [syncing, setSyncing] = useState(false);
    const [fullSyncing, setFullSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
    const [syncError, setSyncError] = useState<string | null>(null);
    const [lastSync, setLastSync] = useState<WebhookLog | null>(null);
    const [recentLogs, setRecentLogs] = useState<WebhookLog[]>([]);
    const [logsLoading, setLogsLoading] = useState(true);
    const now = useNow();

    const fetchSyncLogs = async () => {
        setLogsLoading(true);
        const { data } = await supabase.from('webhook_log').select('*')
            .like('action', actionLabel.replace('_manual', '%'))
            .order('received_at', { ascending: false }).limit(8);
        const logs = data || [];
        setRecentLogs(logs);
        setLastSync(logs[0] ?? null);
        setLogsLoading(false);
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchSyncLogs(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const runSync = async (fullSync: boolean) => {
        if (fullSync) setFullSyncing(true); else setSyncing(true);
        setSyncResult(null); setSyncError(null);
        try {
            const headers: Record<string, string> = {
                Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
                'x-sync-source': 'manual',
            };
            if (fullSync) headers['x-full-sync'] = 'true';
            const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${endpoint}`, {
                method: 'POST', headers,
            });
            const data = await res.json();
            if (!res.ok) setSyncError(data.error ?? 'Erreur inconnue');
            else { setSyncResult(data as SyncResult); fetchSyncLogs(); }
        } catch (err) { setSyncError(err instanceof Error ? err.message : 'Erreur réseau'); }
        if (fullSync) setFullSyncing(false); else setSyncing(false);
    };

    const handleSync = () => runSync(false);
    const handleFullSync = () => runSync(true);

    const formatRelative = (iso: string) => {
        const diffMin = Math.floor((now - new Date(iso).getTime()) / 60000);
        if (diffMin < 1) return 'il y a quelques secondes';
        if (diffMin < 60) return `il y a ${diffMin} min`;
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24) return `il y a ${diffH}h`;
        return `il y a ${Math.floor(diffH / 24)}j`;
    };

    return (
        <div className="bg-white rounded-xl shadow-card p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-base font-semibold text-ink flex items-center gap-2">
                        <Zap className="w-4 h-4 text-ink-mute" />{title}
                    </h2>
                    <p className="text-xs text-ink-mute mt-1">{description}</p>
                    {lastSync && (
                        <p className="text-xs text-ink-mute mt-2 font-medium">
                            Dernière sync : <span className="text-ink-secondary">{formatRelative(lastSync.received_at)}</span>
                            {' '}· <span className="font-mono text-2xs text-ink-mute">{new Date(lastSync.received_at).toLocaleString('fr-CA')}</span>
                        </p>
                    )}
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                    <button onClick={handleSync} disabled={syncing || fullSyncing}
                        className="btn btn-md btn-primary">
                        {syncing ? <><Loader2 className="w-4 h-4 animate-spin" /> Sync...</> : <><RefreshCcw className="w-4 h-4" /> Synchroniser</>}
                    </button>
                    <button onClick={handleFullSync} disabled={syncing || fullSyncing}
                        className="flex items-center gap-1.5 text-xs text-ink-mute hover:text-primary-press transition-colors disabled:opacity-50"
                        title="Importe tout l'historique sans filtre de date (plus lent)">
                        {fullSyncing ? <><Loader2 className="w-3 h-3 animate-spin" /> Sync complète...</> : <><RefreshCcw className="w-3 h-3" /> Sync complète (historique)</>}
                    </button>
                </div>
            </div>

            {syncResult && (
                <div className="pt-4 border-t border-hairline flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-1.5 text-sm font-semibold text-tone-good-ink">
                        <CheckCircle2 className="w-4 h-4" />{syncResult.upserted} upsertés
                    </div>
                    {syncResult.deleted !== undefined && <><div className="text-ink-faint">|</div><div className="text-sm font-semibold text-ink-mute">{syncResult.deleted} supprimés</div></>}
                    {syncResult.voided !== undefined && <><div className="text-ink-faint">|</div><div className="text-sm font-semibold text-ink-mute">{syncResult.voided} annulés</div></>}
                    <div className="text-ink-faint">|</div>
                    <div className="text-xs text-ink-mute font-mono">{(syncResult.duration_ms / 1000).toFixed(1)}s</div>
                    {syncResult.errors.length > 0 && (
                        <div className="w-full text-xs text-tone-critical-ink bg-tone-critical-soft rounded-md p-2">{syncResult.errors.join(' · ')}</div>
                    )}
                </div>
            )}
            {syncError && (
                <div className="pt-4 border-t border-hairline flex items-center gap-2 text-sm text-tone-critical-ink">
                    <AlertCircle className="w-4 h-4 shrink-0" />{syncError}
                </div>
            )}

            {/* Recent history */}
            <div className="pt-2">
                <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Historique récent</h3>
                    <button onClick={fetchSyncLogs} className="p-1 text-ink-mute hover:text-ink-secondary hover:bg-stone rounded-md transition-colors"><RefreshCcw className="w-3 h-3" /></button>
                </div>
                <div className="bg-sand rounded-md overflow-hidden">
                    <table className="w-full text-xs">
                        <tbody className="divide-y divide-hairline">
                            {logsLoading ? (
                                <tr><td className="px-4 py-3 text-center text-ink-mute italic">Chargement...</td></tr>
                            ) : recentLogs.length === 0 ? (
                                <tr><td className="px-4 py-3 text-center text-ink-mute italic">Aucune synchronisation.</td></tr>
                            ) : recentLogs.map(log => (
                                <tr key={log.id} className="hover:bg-stone/60">
                                    <td className="px-4 py-2.5 text-ink-mute">{new Date(log.received_at).toLocaleString('fr-CA')}</td>
                                    <td className="px-4 py-2.5">
                                        <span className={cn("px-2 py-0.5 rounded-full text-2xs font-semibold uppercase",
                                            log.action.includes('full') ? "bg-data-4 text-data-4-ink" :
                                            log.action.includes('manual') ? "bg-primary-wash text-primary-press" :
                                            "bg-hairline-strong text-ink-secondary")}>
                                            {log.action.includes('full') ? 'Complète' : log.action.includes('manual') ? 'Manuel' : 'Auto'}
                                        </span>
                                    </td>
                                    <td className="px-4 py-2.5">
                                        <span className={cn("flex items-center gap-1 font-semibold", log.status_code === 200 ? "text-tone-good-ink" : "text-tone-critical")}>
                                            {log.status_code === 200 ? <CheckCircle2 className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}{log.status_code}
                                        </span>
                                    </td>
                                    <td className="px-4 py-2.5 text-ink-mute max-w-[200px] truncate">{log.error_message || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

// ─── Webhook Logs ─────────────────────────────────────────────────────────────
function WebhookLogs() {
    const [logs, setLogs] = useState<WebhookLog[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchLogs = async () => {
        const { data, error } = await supabase.from('webhook_log').select('*').order('received_at', { ascending: false }).limit(20);
        if (error) console.error(error); else setLogs(data || []);
        setLoading(false);
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchLogs(); }, []);

    return (
        <div className="space-y-4 max-w-4xl">
            <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-ink">Historique Webhook (20 derniers)</h2>
                <button onClick={fetchLogs} className="p-2 text-ink-mute hover:text-ink-secondary hover:bg-stone rounded-md transition-colors"><RefreshCcw className="w-4 h-4" /></button>
            </div>
            <div className="bg-white rounded-xl shadow-card overflow-hidden">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hairline">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Date</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Événement</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Status</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Réf.</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {loading ? (
                            <tr><td colSpan={4} className="px-5 py-10 text-center text-ink-mute italic text-sm">Chargement...</td></tr>
                        ) : logs.length === 0 ? (
                            <tr><td colSpan={4} className="px-5 py-10 text-center text-ink-mute italic text-sm">Aucun log trouvé.</td></tr>
                        ) : logs.map(log => (
                            <tr key={log.id} className="hover:bg-sand/60 transition-colors">
                                <td className="px-5 py-3 text-ink-mute text-xs">{new Date(log.received_at).toLocaleString('fr-CA')}</td>
                                <td className="px-5 py-3">
                                    <span className={cn("inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold",
                                        log.action === 'upserted' ? "bg-tone-good-soft text-tone-good-ink" : log.action === 'deleted' ? "bg-tone-critical-soft text-tone-critical-ink" : "bg-stone text-ink-secondary")}>
                                        {log.action}
                                    </span>
                                </td>
                                <td className="px-5 py-3 font-mono text-xs text-ink-mute">{log.status_code}</td>
                                <td className="px-5 py-3 font-medium text-ink-secondary">{log.zoho_id || '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ─── Users Manager (admin only) ───────────────────────────────────────────────
function UsersManager({ setMessage }: { setMessage: (m: { type: 'success' | 'error', text: string }) => void }) {
    const [users, setUsers] = useState<AllowedUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState<AllowedUser>(EMPTY_USER);
    // Somebody who is not a user of the Zoho organisation - an outside ad manager,
    // for instance - is not in the picker and is added by address.
    const [manualEmail, setManualEmail] = useState(false);
    const [saving, setSaving] = useState(false);
    const [repOptions, setRepOptions] = useState<string[]>([]);
    const [zohoUsers, setZohoUsers] = useState<{ name: string; email: string }[]>([]);
    const [zohoUsersLoading, setZohoUsersLoading] = useState(false);
    const [zohoUsersError, setZohoUsersError] = useState(false);

    useEffect(() => {
        cachedRpc('get_distinct_rep_names').then(({ data }) => {
            if (data) setRepOptions((data as { rep_name: string }[]).map(r => r.rep_name));
        });
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setZohoUsersLoading(true);
        // The signed-in admin's own token: the function refuses anything else,
        // the anon key included.
        supabase.auth.getSession()
            .then(({ data: { session } }) => fetch(
                `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-zoho-users`,
                { headers: { Authorization: `Bearer ${session?.access_token ?? ''}` } },
            ))
            .then(r => r.json())
            .then(data => {
                if (data.users?.length) setZohoUsers(data.users);
                else setZohoUsersError(true);
            })
            .catch(() => setZohoUsersError(true))
            .finally(() => setZohoUsersLoading(false));
    }, []);

    const fetchUsers = async () => {
        setLoading(true);
        const { data, error } = await supabase.from('allowed_users').select('*').order('email');
        if (error) console.error(error); else setUsers(data || []);
        setLoading(false);
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchUsers(); }, []);

    const handleSave = async () => {
        if (!form.email.trim()) return;
        setSaving(true);
        const payload = {
            email: form.email.trim().toLowerCase(),
            name: form.name?.trim() || null,
            role: form.role,
            ...flagsOf(form),
            rep_name: form.rep_name?.trim() || null,
        };
        const { error } = await supabase.from('allowed_users').upsert(payload, { onConflict: 'email' });
        if (error) setMessage({ type: 'error', text: 'Erreur: ' + error.message });
        else { setMessage({ type: 'success', text: 'Utilisateur sauvegardé.' }); setShowForm(false); setForm(EMPTY_USER); fetchUsers(); }
        setSaving(false);
    };

    const handleDelete = async (email: string) => {
        if (!confirm(`Supprimer l'accès pour ${email} ?`)) return;
        const { error } = await supabase.from('allowed_users').delete().eq('email', email);
        if (error) setMessage({ type: 'error', text: 'Erreur: ' + error.message });
        else { setMessage({ type: 'success', text: 'Utilisateur supprimé.' }); fetchUsers(); }
    };

    const handleEdit = (user: AllowedUser) => {
        setForm({ ...user, ...flagsOf(user), name: user.name ?? '', rep_name: user.rep_name ?? '' });
        setManualEmail(false);
        setShowForm(true);
    };

    return (
        <div className="space-y-6 max-w-4xl">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-base font-semibold text-ink">Gestion des utilisateurs</h2>
                    <p className="text-xs text-ink-mute mt-0.5">Seules les personnes de cette liste peuvent se connecter. Cochez les sections que chacune peut ouvrir.</p>
                </div>
                <button onClick={() => { setForm(EMPTY_USER); setManualEmail(false); setShowForm(true); }}
                    className="btn btn-md btn-primary">
                    <Plus className="w-4 h-4" /> Ajouter
                </button>
            </div>

            {/* Add/Edit Form */}
            {showForm && (() => {
                const isEditing = !!(form.email && users.find(u => u.email === form.email));
                return (
                <div className="bg-white border border-primary/20 rounded-xl p-5 shadow-card space-y-4">
                    <h3 className="text-sm font-semibold text-ink">
                        {isEditing ? 'Modifier' : 'Ajouter'} un utilisateur
                    </h3>

                    {/* User identity row */}
                    {isEditing ? (
                        /* Editing: email is locked, show as display */
                        <div className="flex items-center gap-3 bg-sand rounded-md px-4 py-3">
                            <div className="w-8 h-8 rounded-full bg-primary-wash text-primary-press flex items-center justify-center text-sm font-bold shrink-0">
                                {(form.name || form.email).charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-ink truncate">{form.name || '—'}</p>
                                <p className="text-xs text-ink-mute truncate">{form.email}</p>
                            </div>
                        </div>
                    ) : (
                        /* Adding: Zoho user picker */
                        <div>
                            <div className="flex items-center justify-between gap-3 mb-1.5">
                                <label className="block text-xs font-semibold text-ink-mute">
                                    {manualEmail ? 'Courriel *' : 'Utilisateur Zoho *'}
                                </label>
                                {!zohoUsersError && (
                                    <button type="button"
                                            onClick={() => { setManualEmail(m => !m); setForm(f => ({ ...f, email: '', name: '', rep_name: '' })); }}
                                            className="text-2xs font-semibold text-ink-mute hover:text-primary-press transition-colors">
                                        {manualEmail ? 'Choisir dans la liste Zoho' : 'Saisir un autre courriel'}
                                    </button>
                                )}
                            </div>
                            {manualEmail && !zohoUsersError ? (
                                <div className="space-y-2">
                                    <input
                                        type="email"
                                        value={form.email}
                                        onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                                        className="w-full bg-sand rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                                        placeholder="prenom@exemple.com"
                                    />
                                    <input
                                        type="text"
                                        value={form.name ?? ''}
                                        onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                                        className="w-full bg-sand rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                                        placeholder="Nom (facultatif)"
                                    />
                                    <p className="text-2xs text-ink-mute">
                                        Pour quelqu&rsquo;un qui n&rsquo;est pas dans votre organisation Zoho. La connexion se fait
                                        toujours avec Zoho : la personne doit avoir un compte Zoho à cette adresse.
                                    </p>
                                </div>
                            ) : zohoUsersError ? (
                                <div className="bg-tone-warn-soft border border-tone-warn/40 rounded-md px-3 py-2.5 text-xs text-tone-warn-ink space-y-2">
                                    <p className="font-semibold">Impossible de charger les utilisateurs Zoho.</p>
                                    <p>Vérifiez que la fonction <code className="font-mono bg-tone-warn/20 px-1 rounded-xs">get-zoho-users</code> est déployée et que le token Zoho a le scope <code className="font-mono bg-tone-warn/20 px-1 rounded-xs">ZohoBooks.settings.READ</code>.</p>
                                    <p>En attendant, entrez le courriel manuellement :</p>
                                    <input
                                        type="email"
                                        value={form.email}
                                        onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                                        className="w-full bg-white rounded-md px-3 py-2 text-sm border border-tone-warn/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
                                        placeholder="jean@affichez.ca"
                                    />
                                </div>
                            ) : (
                                <select
                                    value={form.email}
                                    onChange={e => {
                                        const u = zohoUsers.find(z => z.email === e.target.value);
                                        if (u) {
                                            const matched = repOptions.find(r => r.toLowerCase() === u.name.toLowerCase()) ?? '';
                                            setForm(f => ({ ...f, email: u.email, name: u.name, rep_name: matched }));
                                        } else {
                                            setForm(f => ({ ...f, email: '', name: '', rep_name: '' }));
                                        }
                                    }}
                                    disabled={zohoUsersLoading}
                                    className="w-full bg-sand rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:text-ink-mute"
                                >
                                    <option value="">
                                        {zohoUsersLoading ? 'Chargement des utilisateurs Zoho…' : 'Sélectionner un utilisateur Zoho…'}
                                    </option>
                                    {zohoUsers.map(u => (
                                        <option key={u.email} value={u.email}>
                                            {u.name} · {u.email}
                                        </option>
                                    ))}
                                </select>
                            )}
                            {form.email && !zohoUsersError && !manualEmail && (
                                <div className="flex items-center gap-2 mt-2 pl-1">
                                    <span className="text-xs text-ink-mute truncate">{form.email}</span>
                                    {form.rep_name && (
                                        <span className="flex items-center gap-1 text-2xs font-semibold text-tone-good-ink bg-tone-good-soft border border-tone-good/30 px-2 py-0.5 rounded-full shrink-0">
                                            <CheckCircle2 className="w-3 h-3" /> Associé : {form.rep_name}
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Permissions grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-semibold text-ink-mute mb-1">Rôle</label>
                            <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                                className="w-full bg-sand rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                                <option value="member">Membre</option>
                                <option value="admin">Admin</option>
                            </select>
                        </div>
                        {/* Rep name: auto-matched on add, manually editable on edit */}
                        {isEditing && (
                            <div>
                                <label className="block text-xs font-semibold text-ink-mute mb-1">Représentant Zoho</label>
                                <select
                                    value={form.rep_name ?? ''}
                                    onChange={e => setForm(f => ({ ...f, rep_name: e.target.value }))}
                                    className="w-full bg-sand rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                                >
                                    <option value="">Aucun</option>
                                    {repOptions.map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                            </div>
                        )}
                    </div>
                    <fieldset>
                        <legend className="block text-xs font-semibold text-ink-mute mb-1.5">Sections accessibles</legend>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
                            {SECTIONS.map(s => {
                                const admin = form.role === 'admin';
                                return (
                                    <label key={s.key}
                                           className={cn('flex items-center gap-2.5 text-sm font-medium',
                                                         admin ? 'text-ink-mute' : 'text-ink-secondary cursor-pointer')}>
                                        <input type="checkbox"
                                               checked={admin || form[s.column]}
                                               disabled={admin}
                                               onChange={e => setForm(f => ({ ...f, [s.column]: e.target.checked }))}
                                               className="w-4 h-4 accent-primary rounded-xs" />
                                        {s.label}
                                    </label>
                                );
                            })}
                        </div>
                        <p className="text-2xs text-ink-mute mt-2">
                            {form.role === 'admin'
                                ? 'Un administrateur a accès à toutes les sections, à Notre équipe et à l’Administration.'
                                : 'Un membre ne voit que les sections cochées. Notre équipe et l’Administration restent réservées aux administrateurs.'}
                        </p>
                    </fieldset>
                    <div className="flex items-center gap-3">
                        <button onClick={handleSave} disabled={saving || !form.email.trim()}
                            className="btn btn-md btn-primary">
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Enregistrer
                        </button>
                        <button onClick={() => setShowForm(false)} className="btn btn-md btn-ghost text-ink-mute">Annuler</button>
                    </div>
                </div>
                );
            })()}

            {/* Users Table */}
            <div className="bg-white rounded-xl shadow-card overflow-hidden">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hairline bg-sand/50">
                            <th className="px-5 py-3 text-left text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Courriel</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Nom</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Rôle</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Sections</th>
                            <th className="px-5 py-3 text-left text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Rep Zoho</th>
                            <th className="px-5 py-3 text-center text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {loading ? (
                            <tr><td colSpan={6} className="px-5 py-10 text-center text-ink-mute italic">Chargement...</td></tr>
                        ) : users.length === 0 ? (
                            <tr><td colSpan={6} className="px-5 py-10 text-center text-ink-mute italic">Aucun utilisateur enregistré.</td></tr>
                        ) : users.map(user => (
                            <tr key={user.email} className="hover:bg-sand/60 transition-colors">
                                <td className="px-5 py-3 text-ink-secondary font-medium">{user.email}</td>
                                <td className="px-5 py-3 text-ink-mute">{user.name || '—'}</td>
                                <td className="px-5 py-3">
                                    <span className={cn("px-2 py-0.5 rounded-full text-2xs font-semibold uppercase tracking-wide",
                                        user.role === 'admin' ? "bg-primary-wash text-primary-press" : "bg-stone text-ink-secondary")}>
                                        {user.role}
                                    </span>
                                </td>
                                <td className="px-5 py-3">
                                    <SectionChips user={user} />
                                </td>
                                <td className="px-5 py-3">
                                    {user.rep_name
                                        ? repOptions.some(r => r.toLowerCase() === user.rep_name!.toLowerCase())
                                            ? <span className="flex items-center gap-1.5 text-xs font-semibold text-tone-good-ink">
                                                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />{user.rep_name}
                                              </span>
                                            : <span className="text-xs text-tone-warn-ink font-medium">{user.rep_name}</span>
                                        : <span className="text-ink-faint text-xs">—</span>}
                                </td>
                                <td className="px-5 py-3 text-center">
                                    <div className="flex items-center justify-center gap-1">
                                        <button onClick={() => handleEdit(user)}
                                            className="p-1.5 text-ink-mute hover:text-primary-press hover:bg-primary-wash rounded-md transition-all text-xs font-bold">
                                            Éditer
                                        </button>
                                        <button onClick={() => handleDelete(user.email)}
                                            className="p-1.5 text-ink-faint hover:text-tone-critical hover:bg-tone-critical-soft rounded-md transition-all">
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="text-xs text-ink-mute px-1">
                Une personne absente de cette liste ne peut pas se connecter, même avec une adresse @affichez.ca. Supprimer quelqu&rsquo;un lui retire l&rsquo;accès immédiatement. Dans Devis et Factures, un membre ne voit que ses propres données.
            </p>
        </div>
    );
}

/** The sections a user can open, as chips. An admin has them all by role. */
function SectionChips({ user }: { user: AllowedUser }) {
    const chip = 'px-2 py-0.5 rounded-full text-2xs font-semibold whitespace-nowrap';
    if (user.role === 'admin') {
        return <span className={cn(chip, 'bg-stone text-ink-secondary')}>Toutes</span>;
    }
    const flags = flagsOf(user);
    const open = SECTIONS.filter(s => flags[s.column]);
    if (open.length === 0) {
        return <span className={cn(chip, 'bg-tone-warn-soft text-tone-warn-ink')}>Aucune</span>;
    }
    return (
        <div className="flex flex-wrap gap-1">
            {open.map(s => <span key={s.key} className={cn(chip, 'bg-stone text-ink-secondary')}>{s.label}</span>)}
        </div>
    );
}

// ─── Excluded Clients Manager (admin only) ────────────────────────────────────
interface ExcludedClient { id: number; client_name: string; created_at: string; }

function ExcludedClientsManager({ setMessage }: { setMessage: (m: { type: 'success' | 'error', text: string }) => void }) {
    const [excluded, setExcluded] = useState<ExcludedClient[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<string[]>([]);
    const [searching, setSearching] = useState(false);
    const [showDropdown, setShowDropdown] = useState(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const fetchExcluded = async () => {
        setLoading(true);
        const { data, error } = await supabase.from('excluded_clients').select('*').order('client_name');
        if (error) console.error(error); else setExcluded(data || []);
        setLoading(false);
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchExcluded(); }, []);
    useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

    const handleSearchChange = (value: string) => {
        setSearchQuery(value);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (!value.trim() || value.trim().length < 2) { setSearchResults([]); setShowDropdown(false); return; }
        const timer = setTimeout(async () => {
            setSearching(true);
            const { data } = await cachedRpc('search_clients', { p_query: value.trim(), p_limit: 20 });
            setSearchResults((data || []).map((r: { client_name: string }) => r.client_name));
            setShowDropdown(true);
            setSearching(false);
        }, 300);
        debounceRef.current = timer;
    };

    const handleAdd = async (clientName: string) => {
        const { error } = await supabase.from('excluded_clients').insert({ client_name: clientName });
        if (error) setMessage({ type: 'error', text: 'Erreur: ' + error.message });
        else {
            setMessage({ type: 'success', text: `"${clientName}" exclu.` });
            setSearchQuery('');
            setSearchResults([]);
            setShowDropdown(false);
            fetchExcluded();
        }
    };

    const handleRemove = async (id: number, clientName: string) => {
        const { error } = await supabase.from('excluded_clients').delete().eq('id', id);
        if (error) setMessage({ type: 'error', text: 'Erreur: ' + error.message });
        else { setMessage({ type: 'success', text: `"${clientName}" réintégré.` }); fetchExcluded(); }
    };

    return (
        <div className="space-y-6 max-w-2xl">
            <div>
                <h2 className="text-base font-semibold text-ink">Clients exclus</h2>
                <p className="text-xs text-ink-mute mt-0.5">
                    Les clients exclus n'apparaissent dans aucun tableau de bord, ni dans les KPIs des modules Devis et Factures.
                </p>
            </div>

            {/* Search & Add */}
            <div className="relative">
                <div className="flex items-center gap-2 bg-white border border-hairline-strong rounded-md px-3 py-2.5 focus-within:ring-2 focus-within:ring-primary/30 focus-within:border-primary/40 transition-all">
                    {searching
                        ? <Loader2 className="w-4 h-4 text-ink-mute shrink-0 animate-spin" />
                        : <Search className="w-4 h-4 text-ink-mute shrink-0" />}
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={e => handleSearchChange(e.target.value)}
                        onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
                        placeholder="Rechercher un client à exclure…"
                        className="flex-1 text-sm bg-transparent outline-none placeholder:text-ink-mute"
                    />
                    {searchQuery && (
                        <button onClick={() => { setSearchQuery(''); setSearchResults([]); setShowDropdown(false); }}
                            className="p-0.5 text-ink-faint hover:text-ink-mute transition-colors">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>

                {showDropdown && searchResults.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-hairline-strong rounded-lg shadow-lg z-20 max-h-64 overflow-y-auto">
                        {searchResults.map(name => (
                            <button
                                key={name}
                                onClick={() => handleAdd(name)}
                                className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-left hover:bg-sand transition-colors first:rounded-t-xl last:rounded-b-xl group"
                            >
                                <span className="text-ink-secondary truncate">{name}</span>
                                <span className="text-xs font-semibold text-primary-press opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2">
                                    + Exclure
                                </span>
                            </button>
                        ))}
                    </div>
                )}
                {showDropdown && !searching && searchResults.length === 0 && searchQuery.trim().length >= 2 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-hairline-strong rounded-lg shadow-lg z-20 px-4 py-3 text-sm text-ink-mute italic">
                        Aucun client trouvé pour « {searchQuery} »
                    </div>
                )}
            </div>

            {/* Excluded list */}
            <div className="bg-white rounded-xl shadow-card overflow-hidden">
                <div className="px-5 py-3 border-b border-hairline bg-sand/50">
                    <span className="text-xs font-semibold text-ink-mute uppercase tracking-eyebrow">
                        {loading ? '…' : excluded.length} client{excluded.length !== 1 ? 's' : ''} exclu{excluded.length !== 1 ? 's' : ''}
                    </span>
                </div>
                {loading ? (
                    <div className="py-10 text-center text-ink-mute italic text-sm">Chargement…</div>
                ) : excluded.length === 0 ? (
                    <div className="py-10 text-center text-ink-mute italic text-sm">Aucun client exclu pour l'instant.</div>
                ) : (
                    <ul className="divide-y divide-hairline">
                        {excluded.map(ec => (
                            <li key={ec.id} className="flex items-center justify-between px-5 py-3 hover:bg-sand/60 transition-colors group">
                                <div className="flex items-center gap-2.5 min-w-0">
                                    <Ban className="w-3.5 h-3.5 text-tone-critical shrink-0" />
                                    <span className="text-sm font-medium text-ink-secondary truncate">{ec.client_name}</span>
                                </div>
                                <button
                                    onClick={() => handleRemove(ec.id, ec.client_name)}
                                    title="Réintégrer ce client"
                                    className="p-1.5 text-ink-faint hover:text-tone-critical hover:bg-tone-critical-soft rounded-md transition-all opacity-0 group-hover:opacity-100 shrink-0"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <p className="text-xs text-ink-mute px-1">
                Les modifications sont immédiates : les filtres SQL excluent ces clients de tous les calculs en temps réel.
            </p>
        </div>
    );
}
