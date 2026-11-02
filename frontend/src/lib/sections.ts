/**
 * The sections of the app a member can be given, one checkbox each in
 * Paramètres → Utilisateurs.
 *
 * Each maps to a boolean column of `allowed_users`. An admin has all of them
 * whatever the columns say. "Notre équipe" and "Administration" are not listed:
 * they are admin-only and have no checkbox.
 *
 * The same five names are known to the database (`app_can_access(section)`),
 * which is what actually protects the Comptes and Publicité data; this file
 * decides which screens exist for whom.
 */
export const SECTIONS = [
    { key: 'devis',     column: 'can_access_devis',     label: 'Devis',       home: '/',          byDefault: true },
    { key: 'factures',  column: 'can_access_factures',  label: 'Factures',    home: '/factures',  byDefault: false },
    { key: 'comptes',   column: 'can_access_comptes',   label: 'Comptes',     home: '/comptes',   byDefault: false },
    { key: 'publicite', column: 'can_access_publicite', label: 'Publicité',   home: '/publicite/devis', byDefault: false },
    { key: 'portail',   column: 'can_access_portail',   label: 'Mon Portail', home: '/portail',   byDefault: true },
] as const;

export type SectionKey = (typeof SECTIONS)[number]['key'];
export type SectionColumn = (typeof SECTIONS)[number]['column'];
export type SectionAccess = Record<SectionKey, boolean>;
export type SectionFlags = Record<SectionColumn, boolean>;

export const NO_ACCESS: SectionAccess = {
    devis: false, factures: false, comptes: false, publicite: false, portail: false,
};

/** What a new member gets until an admin decides otherwise - the column defaults. */
export const DEFAULT_FLAGS: SectionFlags = {
    can_access_devis: true,
    can_access_factures: false,
    can_access_comptes: false,
    can_access_publicite: false,
    can_access_portail: true,
};

/**
 * The sections an `allowed_users` row opens.
 *
 * A column the row does not carry falls back to its default rather than to
 * "closed", so a build that reaches production before its migration leaves
 * everybody where they were.
 */
export function sectionAccessFromRow(row: Record<string, unknown>): SectionAccess {
    const isAdmin = row.role === 'admin';
    const access = { ...NO_ACCESS };
    for (const s of SECTIONS) {
        const value = row[s.column];
        access[s.key] = isAdmin || (typeof value === 'boolean' ? value : s.byDefault);
    }
    return access;
}

/** Where a user lands: the first section they can open, in nav order. */
export function homePathFor(access: SectionAccess): string | null {
    return SECTIONS.find(s => access[s.key])?.home ?? null;
}
