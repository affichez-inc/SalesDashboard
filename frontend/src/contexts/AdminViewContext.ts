import { createContext, useContext } from 'react';

interface AdminViewContextType {
    viewAsRep: string | null;
    setViewAsRep: (rep: string | null) => void;
}

/** Provided by AdminViewProvider (AdminViewProvider.tsx). */
export const AdminViewContext = createContext<AdminViewContextType>({
    viewAsRep: null,
    setViewAsRep: () => {},
});

export const useAdminView = () => useContext(AdminViewContext);
