import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AdminViewProvider } from './contexts/AdminViewContext';
import Layout from './components/Layout';

import Login from './pages/Login';
import AccessDenied from './pages/AccessDenied';
import { homePathFor } from './lib/sections';

// Leads module - hidden from the UI while the Comptes module replaces it.
// The pages and every get_zoho_lead* RPC behind them are left intact: the
// account view is the same data at a different grain, and until it is trusted
// this is the only way back to a number someone has already quoted.
// import LeadsDashboard from './pages/LeadsDashboard';
// import LeadsDetail from './pages/LeadsDetail';

/**
 * Every screen is its own chunk.
 *
 * The app used to ship as a single 820 KB bundle, so a rep opening their own
 * portal first downloaded Settings, both payroll screens and every admin page
 * - none of which they can even reach. Now the first paint carries the shell
 * and the one route being visited.
 *
 * Layout imports these same modules for its hover prefetch (see
 * src/lib/prefetch.ts), and Vite gives both importers the same chunk, so
 * hovering a nav link downloads the screen before the click lands.
 */
const Dashboard = lazy(() => import('./pages/Dashboard'));
const WeeklyDetail = lazy(() => import('./pages/WeeklyDetail'));
const QuarterlyAverages = lazy(() => import('./pages/QuarterlyAverages'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const FDashboard = lazy(() => import('./pages/FDashboard'));
const FWeeklyDetail = lazy(() => import('./pages/FWeeklyDetail'));
const FQuarterlyAverages = lazy(() => import('./pages/FQuarterlyAverages'));
const AdminReps = lazy(() => import('./pages/AdminReps'));
const Paye = lazy(() => import('./pages/Paye'));
const PayeRepSettings = lazy(() => import('./pages/PayeRepSettings'));
const PortailDevis = lazy(() => import('./pages/PortailDevis'));
const PortailFactures = lazy(() => import('./pages/PortailFactures'));
const PortailPaye = lazy(() => import('./pages/PortailPaye'));
const PortailObjectifs = lazy(() => import('./pages/PortailObjectifs'));
const PortailParametres = lazy(() => import('./pages/PortailParametres'));
const ObjectifsEquipe = lazy(() => import('./pages/ObjectifsEquipe'));
const AccountsDashboard = lazy(() => import('./pages/AccountsDashboard'));
const AccountsDetail = lazy(() => import('./pages/AccountsDetail'));
const Advertising = lazy(() => import('./pages/Advertising'));
const Createurs = lazy(() => import('./pages/Createurs'));
const PortailLeads = lazy(() => import('./pages/PortailLeads'));
const TasksDashboard = lazy(() => import('./pages/TasksDashboard'));
const DocumentList = lazy(() => import('./pages/DocumentList'));

/**
 * Which routes exist depends on who is signed in.
 *
 * A member gets the routes of the sections ticked for them in Paramètres →
 * Utilisateurs; an admin gets all of them plus the admin-only screens. A URL
 * outside that set falls through to the catch-all and lands on the first
 * section the person can open, never on an empty screen.
 */
function AppRoutes() {
    const { user, loading, access, sections, isAdmin } = useAuth();

    if (loading) {
        return (
            <div className="min-h-screen bg-sand flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-primary-press" />
            </div>
        );
    }

    if (!user) {
        return <Login />;
    }

    // Signed in to Zoho is not enough: the address has to be in the user list.
    if (access === 'error') return <AccessDenied reason="error" />;
    if (access === 'denied') return <AccessDenied reason="denied" />;

    const home = homePathFor(sections);
    if (home === null && !isAdmin) return <AccessDenied reason="empty" />;

    return (
        <Suspense fallback={<RouteFallback />}>
        <Routes>
            <Route path="/" element={<Layout />}>
                {/* ─── Devis module. "/" is its dashboard; without the section
                    the address still has to lead somewhere. ─── */}
                {sections.devis ? (
                    <>
                        <Route index element={<Dashboard />} />
                        <Route path="weekly" element={<WeeklyDetail />} />
                        <Route path="quarterly" element={<QuarterlyAverages />} />
                        {/* Keyed: the two lists are one component, and without a key
                            moving from one to the other would keep the first one's
                            search and rows. */}
                        <Route path="devis/tous" element={<DocumentList key="devis" kind="devis" />} />
                    </>
                ) : (
                    <Route index element={<Navigate to={home ?? '/settings'} replace />} />
                )}

                {/* ─── Factures module ─── */}
                {sections.factures && (
                    <>
                        <Route path="factures" element={<FDashboard />} />
                        <Route path="factures/weekly" element={<FWeeklyDetail />} />
                        <Route path="factures/quarterly" element={<FQuarterlyAverages />} />
                        <Route path="factures/tous" element={<DocumentList key="factures" kind="factures" />} />
                    </>
                )}

                {/* ─── Leads module - superseded by Comptes, routes disabled ─── */}
                {/* <Route path="leads" element={<LeadsDashboard />} /> */}
                {/* <Route path="leads/detail" element={<LeadsDetail />} /> */}

                {/* ─── Mon Portail - the signed-in rep's own numbers ─── */}
                {sections.portail && (
                    <>
                        <Route path="portail" element={<PortailObjectifs />} />
                        <Route path="portail/devis" element={<PortailDevis />} />
                        <Route path="portail/factures" element={<PortailFactures />} />
                        <Route path="portail/paye" element={<PortailPaye />} />
                        <Route path="portail/leads" element={<PortailLeads />} />
                    </>
                )}

                {/* ─── Comptes module - Zoho CRM Accounts, the grain that
                    replaced leads. zoho_accounts is restricted by RLS to the
                    same people, so a URL reached without the section shows
                    nothing rather than the client list. ─── */}
                {sections.comptes && (
                    <>
                        <Route path="comptes" element={<AccountsDashboard />} />
                        <Route path="comptes/detail" element={<AccountsDetail />} />
                    </>
                )}

                {/* ─── Publicité - a screen of its own. ad_spend_daily is
                    restricted by RLS to the same people. ─── */}
                {sections.publicite && (
                    <>
                        <Route path="publicite" element={<Advertising />} />
                        {/* Its former address. Bookmarked and shared links carry
                            the filters in the query string, so keep them. */}
                        <Route path="comptes/publicite" element={<RedirectToPublicite />} />
                    </>
                )}

                {/* ─── Admin-only ─── */}
                {isAdmin && (
                    <>
                        <Route path="settings" element={<SettingsPage />} />
                        <Route path="portail/parametres" element={<PortailParametres />} />
                        <Route path="reps" element={<AdminReps />} />
                        <Route path="paye" element={<Paye />} />
                        <Route path="paye/settings" element={<PayeRepSettings />} />
                        <Route path="objectifs/equipe" element={<ObjectifsEquipe />} />

                        {/* "Documents créés" - admin-only on purpose. These numbers overlap
                            the rep figures by design and would be misread as a second
                            leaderboard. Dominic, who asked for it: "c'est vraiment
                            juste pour moi, c'est même pas pour personne." */}
                        <Route path="createurs" element={<Createurs />} />

                        {/* ─── Tâches CRM module (owner-only) - dashboard + weekly tabs ─── */}
                        <Route path="taches" element={<TasksDashboard />} />
                    </>
                )}
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
    );
}

/** `/comptes/publicite` -> `/publicite`, filters and all. */
function RedirectToPublicite() {
    const { search, hash } = useLocation();
    return <Navigate to={{ pathname: '/publicite', search, hash }} replace />;
}

function RouteFallback() {
    return (
        <div className="flex items-center justify-center py-24">
            <Loader2 className="w-6 h-6 animate-spin text-primary-press" />
        </div>
    );
}

export default function App() {
    return (
        <BrowserRouter>
            <AuthProvider>
                <AdminViewProvider>
                    <AppRoutes />
                </AdminViewProvider>
            </AuthProvider>
        </BrowserRouter>
    );
}
