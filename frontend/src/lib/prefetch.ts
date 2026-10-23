/**
 * Start loading a screen while the pointer is still on its way to the link.
 *
 * A click is preceded by roughly 200-400 ms of hovering, which is dead time the
 * browser can spend on the two things that make the next screen wait:
 *
 *   1. **the route's JavaScript chunk** - since routes became lazy in App.tsx,
 *      visiting a screen for the first time costs a network fetch before React
 *      can render anything at all;
 *   2. **the first query it will run** - the filter options and week lists,
 *      which are the same for everybody and the slowest queries in the app.
 *
 * Both land in a cache that the page then hits instead of the network:
 * `import()` results are memoised by the module system, and the RPCs go through
 * rpcCache, whose in-flight de-duplication means the page's own call joins the
 * request already in progress rather than starting a second one.
 *
 * Everything here is best-effort. It fires on hover and focus, never on render,
 * so it costs nothing on a screen nobody is heading to, and a failure is
 * swallowed - this is work the user did not ask for and must never surface as
 * an error.
 */
import { prefetchRpc } from './rpcCache';
import { AD_VIEW_PARAM, DEFAULT_AD_VIEW } from '../components/advertising/channel';

/** Routes whose chunk is worth fetching on hover, by path. */
const ROUTE_CHUNKS: Record<string, () => Promise<unknown>> = {
    '/': () => import('../pages/Dashboard'),
    '/weekly': () => import('../pages/WeeklyDetail'),
    '/quarterly': () => import('../pages/QuarterlyAverages'),
    '/settings': () => import('../pages/Settings'),
    '/factures': () => import('../pages/FDashboard'),
    '/factures/weekly': () => import('../pages/FWeeklyDetail'),
    '/factures/quarterly': () => import('../pages/FQuarterlyAverages'),
    '/factures/tous': () => import('../pages/AllInvoices'),
    '/devis/tous': () => import('../pages/AllQuotes'),
    '/comptes': () => import('../pages/AccountsDashboard'),
    '/comptes/detail': () => import('../pages/AccountsDetail'),
    '/publicite': () => import('../pages/Advertising'),
    '/portail': () => import('../pages/PortailObjectifs'),
    '/portail/devis': () => import('../pages/PortailDevis'),
    '/portail/factures': () => import('../pages/PortailFactures'),
    '/portail/paye': () => import('../pages/PortailPaye'),
    '/portail/leads': () => import('../pages/PortailLeads'),
    '/portail/parametres': () => import('../pages/PortailParametres'),
    '/reps': () => import('../pages/AdminReps'),
    '/paye': () => import('../pages/Paye'),
    '/paye/settings': () => import('../pages/PayeRepSettings'),
    '/objectifs/equipe': () => import('../pages/ObjectifsEquipe'),
    '/createurs': () => import('../pages/Createurs'),
    '/taches': () => import('../pages/TasksDashboard'),
};

/**
 * The first query each screen fires, where it is worth paying for early.
 *
 * Only queries whose arguments are knowable before the page mounts are listed -
 * the ones driven by filter state are not, and guessing would just warm an
 * entry nobody reads. These are all cached for ten minutes (rpcCache's
 * LONG_TTL), because they are lists of values that only change when a Zoho sync
 * brings in something new.
 */
const CURRENT_YEAR = new Date().getFullYear();

const ROUTE_QUERIES: Record<string, () => void> = {
    '/comptes': () => prefetchRpc('get_zoho_account_filter_options', {
        p_year: CURRENT_YEAR,
        p_exclude_ratings: ['Compte interne : Ne pas reprendre', 'Fournisseur'],
    }, { single: true }),
    '/comptes/detail': () => prefetchRpc('get_zoho_account_filter_options', {
        p_year: null, p_exclude_ratings: null,
    }, { single: true }),
    '/taches': () => prefetchRpc('get_tasks_available_weeks', { p_year: CURRENT_YEAR }),
    // The filter lists of the view the page opens on.
    '/publicite': () => prefetchRpc('get_ad_filter_options', {
        p_year: CURRENT_YEAR,
        p_exclude_ratings: ['Compte interne : Ne pas reprendre', 'Fournisseur'],
        p_view: AD_VIEW_PARAM[DEFAULT_AD_VIEW],
    }, { single: true }),
    '/portail/leads': () => prefetchRpc('get_zoho_lead_filter_options', {
        p_year: CURRENT_YEAR, p_stage: 'lead',
    }, { single: true }),
};

const started = new Set<string>();

/** Hover or focus on a nav link. Safe to call repeatedly; it only acts once. */
export function prefetchRoute(path: string): void {
    if (started.has(path)) return;
    started.add(path);

    ROUTE_CHUNKS[path]?.().catch(() => {
        // The chunk will be fetched again, and awaited, when the route mounts.
        // Forget the failure so a blip on hover does not disable the retry.
        started.delete(path);
    });

    try {
        ROUTE_QUERIES[path]?.();
    } catch {
        // prefetchRpc already swallows rejections; this catches a throw while
        // building the arguments, which must not break a hover handler.
    }
}
