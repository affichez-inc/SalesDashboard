import { useEffect, useState, useCallback, useRef } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { invalidateRpcCache } from '../lib/rpcCache';
import { sectionAccessFromRow } from '../lib/sections';
import { AuthContext, NO_PERMS, type Permissions } from './AuthContext';

/** How often a returning tab re-reads its own row, at most. */
const RECHECK_AFTER_MS = 60_000;

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser]       = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [perms, setPerms]     = useState<Permissions>(NO_PERMS);
    // The address `perms` was resolved for. Until it matches the signed-in user
    // the app shows a loader, never the previous user's access or a refusal.
    const [resolvedFor, setResolvedFor] = useState<string | null>(null);
    const lastCheck = useRef(0);
    // The address whose access was last read successfully.
    const grantedFor = useRef<string | null>(null);

    const resolvePerms = useCallback(async (u: User | null) => {
        if (!u?.email) { setPerms(NO_PERMS); setResolvedFor(null); grantedFor.current = null; return; }

        // Always read live from allowed_users so role/permission changes take effect
        // on the user's next page load - no need to log out + back in.
        // Every column: the section flags are read by name, and a column this
        // build knows about but the database does not yet have must not turn the
        // lookup into an error.
        const { data, error } = await supabase
            .from('allowed_users')
            .select('*')
            .eq('email', u.email)
            .maybeSingle();

        lastCheck.current = Date.now();
        if (error) {
            // A re-check that fails (laptop waking, a network blip) says nothing
            // new about someone whose access was already read: keep what they
            // have rather than replace the screen they are working on. Only a
            // first read that fails has nothing to fall back on.
            if (grantedFor.current !== u.email) setPerms({ ...NO_PERMS, access: 'error' });
        } else if (!data) {
            grantedFor.current = null;
            setPerms(NO_PERMS);
        } else {
            grantedFor.current = u.email;
            const row = data as Record<string, unknown>;
            setPerms({
                access: 'granted',
                isAdmin: row.role === 'admin',
                sections: sectionAccessFromRow(row),
                repName: (row.rep_name as string | null) ?? null,
            });
        }
        setResolvedFor(u.email);
    }, []);

    useEffect(() => {
        supabase.auth.getSession().then(async ({ data: { session } }) => {
            const u = session?.user ?? null;
            setUser(u);
            await resolvePerms(u);
            setLoading(false);
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            const u = session?.user ?? null;
            setUser(u);
            resolvePerms(u);
        });

        return () => subscription.unsubscribe();
    }, [resolvePerms]);

    // Live-refresh perms when this user's allowed_users row changes.
    // Also refresh the JWT so admin RLS policies (which read user_metadata
    // from the JWT) pick up the new role without requiring a re-login.
    useEffect(() => {
        if (!user?.email) return;
        const channel = supabase.channel(`perms-${user.email}`)
            .on('postgres_changes',
                { event: '*', schema: 'public', table: 'allowed_users', filter: `email=eq.${user.email}` },
                async () => {
                    await supabase.auth.refreshSession();
                    resolvePerms(user);
                }
            ).subscribe();
        return () => { supabase.removeChannel(channel); };
    }, [user, resolvePerms]);

    // A removal is a DELETE, and Realtime does not deliver filtered deletes, so
    // the channel above never hears about it. Coming back to the tab re-reads
    // the row instead; the data itself is already closed by the database.
    useEffect(() => {
        if (!user) return;
        const onVisible = () => {
            if (document.visibilityState !== 'visible') return;
            if (Date.now() - lastCheck.current < RECHECK_AFTER_MS) return;
            resolvePerms(user);
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [user, resolvePerms]);

    // Cached rows were read under the previous session's permissions. They
    // must not survive into the next one, even on the same machine.
    const signOut = async () => { invalidateRpcCache(); await supabase.auth.signOut(); };

    const refreshAccess = useCallback(() => resolvePerms(user), [resolvePerms, user]);

    const pending = user !== null && resolvedFor !== user.email;

    return (
        <AuthContext.Provider value={{ user, loading: loading || pending, signOut, refreshAccess, ...perms }}>
            {children}
        </AuthContext.Provider>
    );
}
