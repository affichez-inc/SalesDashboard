import { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import {
    LayoutDashboard, CalendarDays, LineChart, Settings,
    Menu, LogOut, FileText, ClipboardList, Wallet,
    ChevronDown, Target, Eye, Building2, UserPlus, Percent,
    CheckSquare, FileSignature, Receipt, BookUser, HandCoins, PenLine, List,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useAuth } from '../contexts/AuthContext';
import { useAdminView } from '../contexts/AdminViewContext';
import { useRepList } from '../hooks/useRepList';
import { Select } from './Select';
import { Logo } from './Logo';
import { prefetchRoute } from '../lib/prefetch';
import { RepAvatar } from './RepAvatar';
import { AdvertisingIcon } from './advertising/AdvertisingIcon';
import { RouteErrorBoundary } from './RouteErrorBoundary';
import { supabase } from '../lib/supabase';
import { DEFAULT_FLAGS, sectionAccessFromRow } from '../lib/sections';
import type { SectionAccess } from '../lib/sections';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A screen. */
interface NavLeaf {
    name: string;
    href: string;
    icon: React.ElementType;
    /** Match the path exactly. A module's own dashboard needs it: its path is a
     *  prefix of every other screen in the module. */
    end?: boolean;
}

/** A module - Devis, Factures, Comptes - holding the screens that belong to it. */
interface NavGroup {
    key: string;
    name: string;
    icon: React.ElementType;
    items: NavLeaf[];
}

type NavNode = NavLeaf | NavGroup;

function isGroup(node: NavNode): node is NavGroup {
    return 'items' in node;
}

interface Section {
    key: string;
    label: string;
    items: NavNode[];
}

function leafMatches(item: NavLeaf, pathname: string): boolean {
    return item.end ? pathname === item.href : pathname.startsWith(item.href);
}

// ─── Route → section / module mapping ─────────────────────────────────────────

/**
 * A screen is filed by its SUBJECT, and hidden by a permission - the two are
 * decided separately. `Administration` therefore means configuration, not
 * "admin-only": Publicite, Taches and Documents crees are all restricted and
 * none of them belongs there. The day one of them opens up to reps, a flag
 * changes and nothing moves.
 *
 *   ventes  - what came in, and what it cost to get it
 *   equipe  - the people: what they did, what they earn, what they aim at
 *   portail - me
 *   admin   - screens that CHANGE a setting
 *
 * The settings tests come first: `/portail/parametres` and `/paye/settings`
 * live under a URL whose prefix belongs to another section.
 */
function getSectionKey(pathname: string): string {
    if (pathname.startsWith('/portail/parametres')) return 'admin';
    if (pathname.startsWith('/paye/settings')) return 'admin';
    if (pathname.startsWith('/settings')) return 'admin';
    if (pathname.startsWith('/reps')) return 'admin';
    if (pathname.startsWith('/createurs')) return 'admin';

    if (pathname.startsWith('/portail')) return 'portail';

    if (pathname.startsWith('/taches') || pathname.startsWith('/paye')
        || pathname.startsWith('/objectifs')) return 'equipe';

    // '/', /weekly, /quarterly, /factures, /comptes, /leads, /publicite
    return 'ventes';
}

/**
 * Which module a path belongs to, so arriving on a screen opens the module it
 * lives in. Spelled out rather than derived from the tree because the tree is
 * rebuilt every render and depends on who is signed in.
 */
function getGroupKey(pathname: string): string | null {
    if (pathname === '/' || pathname.startsWith('/weekly') || pathname.startsWith('/quarterly')
        || pathname.startsWith('/devis')) return 'devis';
    if (pathname.startsWith('/factures')) return 'factures';
    if (pathname.startsWith('/comptes') || pathname.startsWith('/leads')) return 'comptes';
    // Publicite, Taches, Commissions, Objectifs d'equipe and Documents crees are
    // all single-screen leaves.
    return null;
}

/** The module that opens on a first visit, before anything has been clicked. */
const DEFAULT_GROUP = 'devis';

// ─── Module-level components (must NOT be defined inside Layout) ──────────────
// Defining components inside a parent causes React to see a new type on every
// render, which unmounts/remounts the subtree and kills CSS transitions.

/** Height animation. grid-template-rows 0fr→1fr animates to the content's own
 *  height, which `height: auto` cannot. */
function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
    return (
        <div style={{
            display: 'grid',
            gridTemplateRows: open ? '1fr' : '0fr',
            transition: 'grid-template-rows 300ms ease-in-out',
        }}>
            <div className="overflow-hidden">{children}</div>
        </div>
    );
}

function LeafLink({ item }: { item: NavLeaf }) {
    return (
        <NavLink
            to={item.href}
            end={item.end}
            // The screen's chunk and its first query start loading while the
            // pointer is still travelling.
            onMouseEnter={() => prefetchRoute(item.href)}
            onFocus={() => prefetchRoute(item.href)}
            onTouchStart={() => prefetchRoute(item.href)}
            className={({ isActive }) => cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-all",
                isActive
                    ? "bg-primary text-white shadow-xs"
                    : "text-ink-mute hover:text-ink hover:bg-sand"
            )}
        >
            {({ isActive }) => (
                <>
                    <item.icon className={cn(
                        "w-4 h-4 shrink-0",
                        isActive ? "text-white" : "text-ink-mute"
                    )} />
                    {item.name}
                </>
            )}
        </NavLink>
    );
}

/**
 * A module row: its icon and name, and its screens underneath.
 *
 * The icon of the open module stays ink, never orange - the active screen's
 * orange fill is the one orange on the screen.
 */
function GroupRow({ group, open, active, onToggle }: {
    group: NavGroup;
    open: boolean;
    active: boolean;
    onToggle: () => void;
}) {
    return (
        <div>
            <button
                onClick={onToggle}
                onMouseEnter={() => group.items[0] && prefetchRoute(group.items[0].href)}
                aria-expanded={open}
                className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-semibold transition-all select-none",
                    active ? "text-ink" : "text-ink-mute hover:text-ink-secondary hover:bg-sand"
                )}
            >
                <group.icon className={cn("w-4 h-4 shrink-0 transition-colors", active ? "text-ink" : "text-ink-mute")} />
                <span className="flex-1 text-left">{group.name}</span>
                <ChevronDown className={cn(
                    "w-3 h-3 shrink-0 text-ink-faint transition-transform duration-300",
                    open && "rotate-180"
                )} />
            </button>
            <Collapse open={open}>
                <div className="ml-2.5 pl-3 border-l border-hairline mt-0.5 mb-1 space-y-0.5">
                    {group.items.map(item => <LeafLink key={item.href} item={item} />)}
                </div>
            </Collapse>
        </div>
    );
}

function SubItems({ items, open, openGroups, onToggleGroup, pathname }: {
    items: NavNode[];
    open: boolean;
    openGroups: Set<string>;
    onToggleGroup: (key: string) => void;
    pathname: string;
}) {
    return (
        <Collapse open={open}>
            <div className="ml-3 pl-3 border-l-2 border-hairline mt-0.5 mb-1 space-y-0.5">
                {items.filter(n => !isGroup(n) || n.items.length > 0).map(node => isGroup(node) ? (
                    <GroupRow
                        key={node.key}
                        group={node}
                        open={openGroups.has(node.key)}
                        active={node.items.some(i => leafMatches(i, pathname))}
                        onToggle={() => onToggleGroup(node.key)}
                    />
                ) : (
                    <LeafLink key={node.href} item={node} />
                ))}
            </div>
        </Collapse>
    );
}

function SectionHeader({ label, items, open, active, openGroups, onToggleGroup, onToggle, pathname }: {
    label: string;
    items: NavNode[];
    open: boolean;
    active: boolean;
    openGroups: Set<string>;
    onToggleGroup: (key: string) => void;
    onToggle: () => void;
    pathname: string;
}) {
    return (
        <div>
            <button
                onClick={onToggle}
                aria-expanded={open}
                className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-semibold transition-all select-none",
                    active ? "text-ink" : "text-ink-mute hover:text-ink-secondary hover:bg-sand"
                )}
            >
                <span className="flex-1 text-left">{label}</span>
                <ChevronDown className={cn(
                    "w-3.5 h-3.5 shrink-0 text-ink-faint transition-transform duration-300",
                    open && "rotate-180"
                )} />
            </button>
            <SubItems
                items={items}
                open={open}
                openGroups={openGroups}
                onToggleGroup={onToggleGroup}
                pathname={pathname}
            />
        </div>
    );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * The sections of the rep an admin is previewing, so the nav shows what that
 * person sees and not what the admin can. Until their row has answered, and for
 * a name that has no row, it is what a new member gets.
 */
function usePreviewedSections(repName: string | null): SectionAccess {
    const [found, setFound] = useState<{ repName: string; access: SectionAccess } | null>(null);

    useEffect(() => {
        if (!repName) return;
        let cancelled = false;
        supabase.from('allowed_users').select('*').eq('rep_name', repName).limit(1).maybeSingle()
            .then(({ data }) => {
                if (cancelled || !data) return;
                setFound({ repName, access: sectionAccessFromRow(data as Record<string, unknown>) });
            });
        return () => { cancelled = true; };
    }, [repName]);

    return found && found.repName === repName
        ? found.access
        : sectionAccessFromRow(DEFAULT_FLAGS);
}

export default function Layout() {
    const location = useLocation();
    const { user, signOut, isAdmin, sections: ownSections, repName } = useAuth();
    const { viewAsRep, setViewAsRep } = useAdminView();
    const repList = useRepList();
    const previewing = isAdmin && viewAsRep ? viewAsRep : null;
    const previewedSections = usePreviewedSections(previewing);
    // What the nav offers. The routes themselves follow the signed-in user, so
    // an admin previewing a rep can still reach every screen by URL.
    const sections = previewing ? previewedSections : ownSections;

    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [openSections, setOpenSections] = useState<Set<string>>(
        () => new Set([getSectionKey(location.pathname)])
    );
    // Devis is the module the app opens on, so its screens are one click away
    // from a cold start rather than two.
    const [openGroups, setOpenGroups] = useState<Set<string>>(
        () => new Set([getGroupKey(location.pathname) ?? DEFAULT_GROUP])
    );
    // Auto-open the section and the module a navigation lands in
    useEffect(() => {
        const key = getSectionKey(location.pathname);
        setOpenSections(prev => prev.has(key) ? prev : new Set([...prev, key]));
        const group = getGroupKey(location.pathname);
        if (group) setOpenGroups(prev => prev.has(group) ? prev : new Set([...prev, group]));
    }, [location.pathname]);

    // Close mobile menu on route change
    useEffect(() => { setIsMobileMenuOpen(false); }, [location.pathname]);

    const displayName = user?.email
        ? user.email.split('@')[0].charAt(0).toUpperCase() + user.email.split('@')[0].slice(1)
        : '';

    // ─── Section definitions ─────────────────────────────────────────────────

    // Admin-only entries follow the rule the Administration section already
    // used: while an admin previews a rep's view, they see what that rep sees.
    const showAdminNav = isAdmin && !viewAsRep;

    // Each module of "Ventes Affichez" and the whole of "Mon Portail" is shown to
    // whoever has the matching section ticked in Paramètres → Utilisateurs.
    const navSections: Section[] = [
        {
            key: 'ventes',
            label: 'Ventes Affichez',
            items: [
                ...(sections.devis ? [{
                    key: 'devis', name: 'Devis', icon: FileSignature,
                    items: [
                        { name: 'Tableau de bord', href: '/',          icon: LayoutDashboard, end: true },
                        { name: 'Par semaine',     href: '/weekly',    icon: CalendarDays },
                        { name: 'Par trimestre',   href: '/quarterly', icon: LineChart },
                        { name: 'Tous les devis',  href: '/devis/tous', icon: List },
                    ],
                }] : []),
                ...(sections.factures ? [{
                    key: 'factures', name: 'Factures', icon: Receipt,
                    items: [
                        { name: 'Tableau de bord', href: '/factures',           icon: LayoutDashboard, end: true },
                        { name: 'Par semaine',     href: '/factures/weekly',    icon: CalendarDays },
                        { name: 'Par trimestre',   href: '/factures/quarterly', icon: LineChart },
                        { name: 'Toutes les factures', href: '/factures/tous', icon: List },
                    ],
                }] : []),
                // Gated like the routes, and zoho_accounts is restricted the same
                // way at the row level: without the section a member sees no
                // entry, cannot reach it by URL, and could not read the accounts
                // even by asking the API directly.
                ...(sections.comptes ? [{
                    key: 'comptes', name: 'Comptes', icon: Building2,
                    items: [
                        { name: 'Tableau de bord', href: '/comptes',        icon: LayoutDashboard, end: true },
                        { name: 'Détail comptes',  href: '/comptes/detail', icon: BookUser },
                    ],
                }] : []),
                // Publicite sits beside the revenue it is measured against: it
                // owns ad_spend_daily and its own syncs, and Comptes is a lens
                // it looks through, not its parent. A leaf until a second
                // screen exists - a module wrapping one screen is a collapse
                // level that buys nothing.
                ...(sections.publicite ? [
                    { name: 'Publicité', href: '/publicite', icon: AdvertisingIcon, end: true },
                ] : []),
                // Leads - hidden while the Comptes module replaces it. Routes are
                // commented out in App.tsx; leaving these visible would 404.
                // {
                //     key: 'leads', name: 'Leads', icon: UserPlus,
                //     items: [
                //         { name: 'Tableau de bord', href: '/leads',        icon: LayoutDashboard, end: true },
                //         { name: 'Détail leads',    href: '/leads/detail', icon: BookUser },
                //     ],
                // },
            ],
        },
        {
            key: 'equipe',
            label: 'Notre équipe',
            // Every screen here is admin-only today, so a rep sees no section
            // at all rather than an empty header (see the filter in the nav).
            items: showAdminNav ? [
                // What a rep DID, as opposed to what they were credited with.
                // A plain link while Tâches is the only screen; when
                // Conversations (SMS, courriels) and Appels arrive, wrap these
                // in an `activite` module and add the prefix to getGroupKey.
                { name: 'Tâches CRM',         href: '/taches',           icon: CheckSquare, end: true },
                { name: 'Commissions',        href: '/paye',             icon: HandCoins,   end: true },
                { name: "Objectifs d'équipe", href: '/objectifs/equipe', icon: Target,      end: true },
            ] : [],
        },
        {
            key: 'portail',
            label: 'Mon Portail',
            items: sections.portail ? [
                { name: 'Mes Objectifs',   href: '/portail',             icon: Target,             end: true },
                { name: 'Mes Devis',       href: '/portail/devis',       icon: ClipboardList },
                { name: 'Mes Factures',    href: '/portail/factures',    icon: FileText },
                { name: 'Ma Paye',         href: '/portail/paye',        icon: Wallet },
                { name: 'Mes Leads',       href: '/portail/leads',       icon: UserPlus },
            ] : [],
        },
    ];

    // Administration is configuration - plus Documents créés, which is here
    // because the owner put it here: it is his own back-office view of who
    // keyed what in, not a team figure. Leave it. Everything else in this list
    // CHANGES something.
    const adminItems: NavNode[] = [
        { name: 'Documents créés',    href: '/createurs',          icon: PenLine, end: true },
        { name: 'Objectifs des reps', href: '/portail/parametres', icon: Target },
        { name: 'Taux de commission', href: '/paye/settings',      icon: Percent },
        { name: 'Paramètres',         href: '/settings',           icon: Settings },
    ];

    // ─── Helpers ──────────────────────────────────────────────────────────────

    const toggle = (key: string) =>
        setOpenSections(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });

    const toggleGroup = (key: string) =>
        setOpenGroups(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });

    const isSectionActive = (items: NavNode[]) =>
        items.some(node => isGroup(node)
            ? node.items.some(i => leafMatches(i, location.pathname))
            : leafMatches(node, location.pathname));


    // ─── Sidebar content ──────────────────────────────────────────────────────

    const sidebar = (
        <div className="flex flex-col h-full bg-white">

            {/* Logo */}
            <div className="h-16 px-6 flex items-center shrink-0 border-b border-hairline">
                <Logo height={24} />
            </div>

            {/* Main nav */}
            <nav className="flex-1 px-3 py-3 overflow-y-auto space-y-0.5">
                {navSections.filter(s => s.items.length > 0).map(s => (
                    <SectionHeader
                        key={s.key}
                        label={s.label}
                        items={s.items}
                        open={openSections.has(s.key)}
                        active={isSectionActive(s.items)}
                        openGroups={openGroups}
                        onToggleGroup={toggleGroup}
                        onToggle={() => toggle(s.key)}
                        pathname={location.pathname}
                    />
                ))}
            </nav>

            {/* Bottom: Admin + rep switcher + user */}
            <div className="shrink-0 border-t border-hairline px-3 py-3 space-y-0.5">

                {/* Admin section - hidden when viewing as rep */}
                {isAdmin && !viewAsRep && (
                    <SectionHeader
                        label="Administration"
                        items={adminItems}
                        open={openSections.has('admin')}
                        active={isSectionActive(adminItems)}
                        openGroups={openGroups}
                        onToggleGroup={toggleGroup}
                        onToggle={() => toggle('admin')}
                        pathname={location.pathname}
                    />
                )}

                {/* User row */}
                <div className="flex items-center gap-3 px-3 py-2 mt-1 rounded-md hover:bg-sand transition-colors">
                    {/* The signed-in person's own face. repName comes from
                      * allowed_users, so an admin with no rep row falls through
                      * to the initial of their email handle, as before. */}
                    {repName
                        ? <RepAvatar name={repName} size="md" literal />
                        : <div className="w-8 h-8 rounded-full bg-primary-wash text-primary-press flex items-center justify-center text-xs font-bold shrink-0">
                              {displayName.charAt(0)}
                          </div>}
                    <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-ink-secondary truncate">{displayName}</p>
                        <p className="text-2xs text-ink-mute truncate">{user?.email}</p>
                    </div>
                    <button
                        onClick={signOut}
                        title="Se déconnecter"
                        className="p-1.5 rounded-md text-ink-faint hover:text-ink-secondary hover:bg-stone transition-all shrink-0"
                    >
                        <LogOut className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>
        </div>
    );

    // ─── Layout ───────────────────────────────────────────────────────────────

    return (
        <div className="min-h-screen bg-sand flex font-sans">

            {/* Sidebar */}
            <aside className={cn(
                "fixed md:sticky top-0 left-0 z-50 h-screen w-60 border-r border-hairline shrink-0 transition-transform duration-300",
                isMobileMenuOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
            )}>
                {sidebar}
            </aside>

            {/* Mobile backdrop */}
            {isMobileMenuOpen && (
                <div
                    className="fixed inset-0 bg-black/30 z-40 md:hidden backdrop-blur-xs"
                    onClick={() => setIsMobileMenuOpen(false)}
                />
            )}

            {/* Main content */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

                {/* Mobile header */}
                <header className="md:hidden h-14 bg-white border-b border-hairline flex items-center justify-between px-4 sticky top-0 z-30">
                    <button
                        onClick={() => setIsMobileMenuOpen(true)}
                        className="p-2 text-ink-mute hover:bg-sand rounded-md"
                    >
                        <Menu className="w-5 h-5" />
                    </button>
                    <Logo height={22} />
                    <div className="w-9" />
                </header>

                {/* Admin view-as bar */}
                {isAdmin && repList.length > 0 && (
                    <div className="shrink-0 bg-white border-b border-hairline px-3 md:px-4 py-2 flex items-center gap-2 md:gap-3">
                        <Eye className="w-3.5 h-3.5 text-ink-mute shrink-0" />
                        <span className="text-xs font-semibold text-ink-mute shrink-0">Vue :</span>
                        <Select
                            value={viewAsRep ?? ''}
                            onChange={v => setViewAsRep(v || null)}
                            options={[
                                { value: '', label: 'Admin (ma vue)' },
                                ...repList.map(r => ({ value: r, label: r, icon: <RepAvatar name={r} size="sm" /> })),
                            ]}
                            variant={viewAsRep ? 'accent' : 'default'}
                            className="w-40 md:w-48 min-w-0"
                        />
                    </div>
                )}

                <main className="flex-1 overflow-auto">
                    <RouteErrorBoundary key={location.pathname}>
                        <Outlet />
                    </RouteErrorBoundary>
                </main>
            </div>
        </div>
    );
}
