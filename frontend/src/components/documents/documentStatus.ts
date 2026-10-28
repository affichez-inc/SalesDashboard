/**
 * Status labels for invoices and quotes, as stored. Kept apart from the badge
 * components so a .tsx file exports components only (react-refresh).
 */

/** The filter's options, in the order a document moves through them. Credit
 *  notes are stored with the status `avoir`. */
export const INVOICE_STATUS_OPTIONS = [
    { value: 'sent',    label: 'Envoyé' },
    { value: 'overdue', label: 'En retard' },
    { value: 'partial', label: 'Partiel' },
    { value: 'paid',    label: 'Payé' },
    { value: 'avoir',   label: 'Avoir' },
];

export const QUOTE_STATUS_OPTIONS = [
    { value: 'draft',    label: 'Brouillon' },
    { value: 'sent',     label: 'Envoyé' },
    { value: 'accepted', label: 'Accepté' },
    { value: 'invoiced', label: 'Facturé' },
    { value: 'declined', label: 'Refusé' },
    { value: 'expired',  label: 'Expiré' },
];

const INVOICE_LABELS: Record<string, string> = {
    ...Object.fromEntries(INVOICE_STATUS_OPTIONS.map(o => [o.value, o.label])),
    viewed: 'Envoyé',
    void: 'Annulé',
};

const QUOTE_LABELS: Record<string, string> =
    Object.fromEntries(QUOTE_STATUS_OPTIONS.map(o => [o.value, o.label]));

export function invoiceStatusLabel(status: string, isAvoir: boolean): string {
    const key = isAvoir ? 'avoir' : status;
    return INVOICE_LABELS[key] ?? key;
}

/** A status the sync could not map is stored NULL with Zoho's raw word beside it. */
export function quoteStatusLabel(status: string | null, zohoStatus: string | null): string {
    return status ? (QUOTE_LABELS[status] ?? status) : (zohoStatus ?? '—');
}
