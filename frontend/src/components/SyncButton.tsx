import { useState, useEffect, useCallback } from 'react';
import { Loader2, RefreshCcw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useNow } from '../hooks/useNow';

interface SyncButtonProps {
    functionName?: string;
    logPattern?: string;
    onSyncComplete?: () => void;
}

export function SyncButton({
    functionName = 'zoho-sync',
    logPattern = 'sync%',
    onSyncComplete,
}: SyncButtonProps) {
    const [syncing, setSyncing] = useState(false);
    const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
    const [badge, setBadge] = useState<{ upserted: number; deleted: number } | null>(null);
    const now = useNow();

    const fetchLastSync = useCallback(async () => {
        const { data } = await supabase
            .from('webhook_log')
            .select('received_at')
            .like('action', logPattern)
            .order('received_at', { ascending: false })
            .limit(1)
            .single();
        setLastSyncTime(data?.received_at ?? null);
    }, [logPattern]);

    // Load last sync timestamp on mount
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchLastSync(); }, [fetchLastSync]);

    const handleSync = useCallback(async () => {
        setSyncing(true);
        setBadge(null);
        try {
            const res = await fetch(
                `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${functionName}`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
                        'x-sync-source': 'manual',
                    },
                }
            );
            const data = await res.json();
            if (res.ok) {
                setBadge({ upserted: data.upserted ?? 0, deleted: data.deleted ?? 0 });
                onSyncComplete?.();
                await fetchLastSync();
            }
        } catch { /* details available in Paramètres → Synchronisation */ }
        setSyncing(false);
    }, [functionName, onSyncComplete, fetchLastSync]);

    const formatRelative = (iso: string) => {
        const diffMs = now - new Date(iso).getTime();
        const diffMin = Math.floor(diffMs / 60000);
        if (diffMin < 1) return 'à l\'instant';
        if (diffMin < 60) return `il y a ${diffMin} min`;
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24) return `il y a ${diffH}h`;
        return new Date(iso).toLocaleString('fr-CA', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    };

    return (
        <div className="flex items-center gap-3 shrink-0">
            {lastSyncTime && (
                <span className="text-xs text-ink-mute hidden sm:block">
                    Sync {formatRelative(lastSyncTime)}
                </span>
            )}
            {badge && (
                <span className="text-xs font-semibold text-tone-good-ink bg-tone-good-soft border border-tone-good/30 px-2.5 py-1 rounded-full">
                    +{badge.upserted} / -{badge.deleted}
                </span>
            )}
            <button
                onClick={handleSync}
                disabled={syncing}
                className="btn btn-md btn-primary"
            >
                {syncing
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Sync...</>
                    : <><RefreshCcw className="w-4 h-4" /> Synchroniser</>
                }
            </button>
        </div>
    );
}
