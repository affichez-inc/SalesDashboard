import type { SelectOption } from '../components/Select';

/**
 * Zoho CRM's account Rating, the field French users see as "Évaluation".
 *
 * zoho_accounts.rating holds the label an English session reads: the sync logs
 * in in English, and Zoho returns a picklist's labels in the caller's language.
 * Five options carry a different French label (Setup → Translations, fr_FR
 * export of 2026-09-29), and the French one is what the team reads in Zoho, so
 * every screen draws it from here. Filters and queries keep the stored value.
 *
 * `short` is drawn in the dropdown and the table, `full` is Zoho's whole French
 * label, shown on hover and written to the CSV. A value missing from the map
 * (an option added later, or loose text such as "Gagné" on two accounts) is
 * shown as stored. A French label changed in Zoho has to be changed here too:
 * nothing syncs it.
 */
const RATING_LABELS: Record<string, { short: string; full: string }> = {
    'Actif': {
        short: 'Actif',
        full: 'Actif : Client avec une tâche de suivi en cours',
    },
    'Arrêté': {
        short: 'Arrêté',
        full: 'Arrêté : Ne plus contacter',
    },
    'Client à reprendre': {
        short: 'Compte sans représentant associé',
        full: 'Compte sans représentant associé',
    },
    'Compte interne : Ne pas reprendre': {
        short: 'Compte interne : Ne pas reprendre',
        full: 'Compte interne : Ne pas reprendre',
    },
    'Fournisseur': {
        short: 'Fournisseur',
        full: 'Fournisseur',
    },
    'Neutre': {
        short: 'Neutre',
        full: 'Neutre : Petit client qui ne mérite pas une tâche de suivi',
    },
    'Sous-Compte': {
        short: 'Sous-Compte',
        full: 'Sous-Compte : Les notes de ce compte se trouve dans la Société mère',
    },
};

/**
 * Affichez's own entities rather than clients, by stored value. The same list
 * as `zoho_internal_ratings()`, which the view's `is_internal` is built on.
 */
export const INTERNAL_RATINGS: string[] = ['Compte interne : Ne pas reprendre', 'Fournisseur'];

export function ratingLabel(stored: string): { short: string; full: string } {
    return RATING_LABELS[stored] ?? { short: stored, full: stored };
}

/**
 * The Évaluation dropdown, in French and sorted by what it reads.
 *
 * With the Statut switch on "Clients seulement" the internal accounts are
 * already hidden, so their two ratings are not offered: ticking one would only
 * ever empty the page.
 */
export function ratingOptions(stored: string[] | undefined, includeInternal: boolean): SelectOption[] {
    return (stored ?? [])
        .filter(r => includeInternal || !INTERNAL_RATINGS.includes(r))
        .map(r => {
            const { short, full } = ratingLabel(r);
            return { value: r, label: short, hint: full !== short ? full : undefined };
        })
        .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

/**
 * The selection the query applies. An internal rating ticked while Statut
 * included internal accounts stays in the URL after the switch goes back to
 * "Clients seulement"; it is dropped here rather than ANDed into an empty page.
 */
export function ratingsInScope(selected: string[], includeInternal: boolean): string[] {
    return includeInternal ? selected : selected.filter(r => !INTERNAL_RATINGS.includes(r));
}
