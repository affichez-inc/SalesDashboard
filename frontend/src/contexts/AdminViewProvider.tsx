import { useState } from 'react';
import { AdminViewContext } from './AdminViewContext';

const STORAGE_KEY = 'adminViewAsRep';

export function AdminViewProvider({ children }: { children: React.ReactNode }) {
    const [viewAsRep, setViewAsRepState] = useState<string | null>(
        () => sessionStorage.getItem(STORAGE_KEY) || null
    );

    const setViewAsRep = (rep: string | null) => {
        if (rep) sessionStorage.setItem(STORAGE_KEY, rep);
        else sessionStorage.removeItem(STORAGE_KEY);
        setViewAsRepState(rep);
    };

    return (
        <AdminViewContext.Provider value={{ viewAsRep, setViewAsRep }}>
            {children}
        </AdminViewContext.Provider>
    );
}
