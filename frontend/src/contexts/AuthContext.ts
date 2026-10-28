import { createContext, useContext } from 'react';
import type { User } from '@supabase/supabase-js';
import { NO_ACCESS } from '../lib/sections';
import type { SectionAccess } from '../lib/sections';

/**
 * Whether the signed-in address is in allowed_users.
 *
 *   granted   it has a row;
 *   denied    it has none - the person can sign in to Zoho but was never added
 *             here, or was removed. The database returns them no rows either;
 *   error     the lookup itself failed, which says nothing about the person.
 */
export type AccessState = 'granted' | 'denied' | 'error';

export interface Permissions {
    access: AccessState;
    isAdmin: boolean;
    /** The sections this user can open. All true for an admin. */
    sections: SectionAccess;
    repName: string | null;
}

interface AuthContextType extends Permissions {
    user: User | null;
    loading: boolean;
    signOut: () => Promise<void>;
    /** Read allowed_users again, e.g. after a failed lookup. */
    refreshAccess: () => Promise<void>;
}

export const NO_PERMS: Permissions = { access: 'denied', isAdmin: false, sections: NO_ACCESS, repName: null };

/** Provided by AuthProvider (AuthProvider.tsx). */
export const AuthContext = createContext<AuthContextType>({
    user: null,
    loading: true,
    signOut: async () => {},
    refreshAccess: async () => {},
    ...NO_PERMS,
});

export const useAuth = () => useContext(AuthContext);
