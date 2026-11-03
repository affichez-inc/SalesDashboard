import { createContext, useContext, useEffect, type RefObject } from 'react';

/**
 * True inside the filter drawer. A dropdown there opens in the flow rather than
 * floating: a floating menu would be cut by the drawer's own scrolling, and could
 * not be wider than the drawer anyway.
 */
export const FilterPanelContext = createContext(false);

export const useInFilterPanel = () => useContext(FilterPanelContext);

/** Scrolls a list opened near the bottom of the drawer into view. */
export function useRevealInPanel(open: boolean, ref: RefObject<HTMLElement | null>) {
    const inPanel = useInFilterPanel();
    useEffect(() => {
        if (open && inPanel) ref.current?.scrollIntoView({ block: 'nearest' });
    }, [open, inPanel, ref]);
}
