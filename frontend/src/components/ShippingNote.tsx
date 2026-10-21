import { Truck } from 'lucide-react';
import { formatCurrencyCAD, cn } from '../lib/utils';

/**
 * "dont 312,15 $ livraison" under an invoice amount.
 *
 * The amount already includes shipping — commission is paid on it — and nothing
 * on screen used to say so: QC-022298 reads $3,362.15, of which $312.15 is
 * shipping, and the hand-kept commission sheet recorded $3,050. This line is
 * the whole fix on screen, so it renders only when there is shipping to show:
 * most invoices carry none, and a "0 $ livraison" on every row would bury the
 * few that matter.
 */
export function ShippingNote({ amount, className }: {
    amount: number | string | null | undefined;
    className?: string;
}) {
    const value = Number(amount ?? 0);
    if (!value) return null;
    return (
        <span
            className={cn('flex items-center justify-end gap-1 text-2xs font-normal text-ink-mute tabular-nums whitespace-nowrap', className)}
            title="Frais de livraison facturés au client, avant taxes. Inclus dans le montant, donc dans la base de commission."
        >
            <Truck className="w-3 h-3 shrink-0" aria-hidden="true" />
            dont {formatCurrencyCAD(value)} livraison
        </span>
    );
}
