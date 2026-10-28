/**
 * The two document lists and the RPC behind each. Kept out of the page so the
 * nav's hover prefetch can build the page's first call without importing it.
 */

export type DocumentKind = 'factures' | 'devis';

export const DOCUMENT_LIST_RPC: Record<DocumentKind, string> = {
    factures: 'get_invoice_list',
    devis: 'get_quote_list',
};

export const DOCUMENT_OPTIONS_KIND: Record<DocumentKind, 'invoices' | 'quotes'> = {
    factures: 'invoices',
    devis: 'quotes',
};

export const DOCUMENT_PAGE_SIZE = 100;

export interface DocumentListQuery {
    search: string;
    /** In option order, so one selection is one cache key. */
    statuses: string[];
    /** NULL is no rep filter. */
    reps: string[] | null;
    year: number | null;
    sort: 'date' | 'amount';
    desc: boolean;
}

export const DEFAULT_DOCUMENT_QUERY: DocumentListQuery = {
    search: '', statuses: [], reps: null, year: null, sort: 'date', desc: true,
};

/** The RPC's arguments. One builder, so the prefetch and the page share a cache entry. */
export function documentListArgs(q: DocumentListQuery, limit: number, offset: number) {
    return {
        p_search: q.search.trim() || null,
        p_statuses: q.statuses.length > 0 ? q.statuses : null,
        p_reps: q.reps,
        p_year: q.year,
        p_sort: q.sort,
        p_desc: q.desc,
        p_limit: limit,
        p_offset: offset,
    };
}
