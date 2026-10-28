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

/** The columns a list sorts on, as the RPC names them. */
export type DocumentSort = 'date' | 'amount' | 'number' | 'client' | 'rep' | 'department' | 'status';

/** The same columns as the URL spells them (`?tri=`). */
export const SORT_PARAM: Record<DocumentSort, string> = {
    date: 'date', amount: 'montant', number: 'numero', client: 'client',
    rep: 'representant', department: 'departement', status: 'statut',
};

export function sortFromParam(param: string): DocumentSort {
    const hit = (Object.keys(SORT_PARAM) as DocumentSort[]).find(k => SORT_PARAM[k] === param);
    return hit ?? 'date';
}

export interface DocumentListQuery {
    search: string;
    /** In option order, so one selection is one cache key. */
    statuses: string[];
    /** NULL is no rep filter. */
    reps: string[] | null;
    year: number | null;
    /** 1-12, applied only with a year. */
    month: number | null;
    depts: string[];
    office: string | null;
    /** Invoices only: documents carrying a shipping charge. */
    withShipping: boolean;
    sort: DocumentSort;
    desc: boolean;
}

/** What a list shows when opened with no parameter: the current year, newest first. */
export function defaultDocumentQuery(): DocumentListQuery {
    return {
        search: '', statuses: [], reps: null, year: new Date().getFullYear(), month: null,
        depts: [], office: null, withShipping: false, sort: 'date', desc: true,
    };
}

/**
 * The RPC's arguments. One builder, so the prefetch and the page share a cache
 * entry. p_with_shipping exists on the invoice list only; naming it on the
 * quote list would make PostgREST look for a function that does not exist.
 */
export function documentListArgs(kind: DocumentKind, q: DocumentListQuery, limit: number, offset: number) {
    return {
        p_search: q.search.trim() || null,
        p_statuses: q.statuses.length > 0 ? q.statuses : null,
        p_reps: q.reps,
        p_year: q.year,
        p_sort: q.sort,
        p_desc: q.desc,
        p_limit: limit,
        p_offset: offset,
        p_month: q.year === null ? null : q.month,
        p_depts: q.depts.length > 0 ? q.depts : null,
        p_office: q.office,
        ...(kind === 'factures' ? { p_with_shipping: q.withShipping } : {}),
    };
}
