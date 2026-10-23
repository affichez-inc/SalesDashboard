import { ExternalLink } from 'lucide-react';
import { formatCurrencyCAD, formatShortDate, cn } from '../../lib/utils';
import type { ZoneB_DetailRow, InvDetailRow } from '../../types/database';
import { useSort } from '../../hooks/useSort';
import { SortIcon } from '../SortIcon';
import { ExportButton } from '../ExportButton';
import type { CsvColumn } from '../../lib/csv';
import { RepName } from '../../components/RepAvatar';
import { ShippingNote } from '../ShippingNote';
import { DEPT_COLORS } from './deptColors';

type AnyDetailRow = ZoneB_DetailRow | InvDetailRow;

/** Both row shapes carry these; the ones that differ are read defensively. */
const DETAIL_CSV: CsvColumn<AnyDetailRow>[] = [
    { header: 'Date',         value: r => ('sale_date' in r ? r.sale_date : r.invoice_date) ?? null },
    { header: 'Numero',       value: r => ('quote_number' in r ? r.quote_number : r.invoice_number) ?? null },
    { header: 'Client',       value: r => r.client_name },
    { header: 'Representant', value: r => r.rep_name },
    { header: 'Departement',  value: r => r.department },
    { header: 'Bureau',       value: r => r.office },
    { header: 'Statut',       value: r => String(r.status ?? '') },
    { header: 'Montant',      value: r => Number(r.amount) },
];

/** Invoices add the shipping inside Montant, so the accountant can see it in the file too. */
const INVOICE_CSV: CsvColumn<AnyDetailRow>[] = [
    ...DETAIL_CSV,
    { header: 'Dont livraison', value: r => ('shipping_charge' in r && r.shipping_charge != null ? Number(r.shipping_charge) : null) },
];

interface ZoneBTableProps {
    lineItems: AnyDetailRow[];
    module?: 'devis' | 'factures';
}

export function ZoneBTable({ lineItems, module = 'devis' }: ZoneBTableProps) {
    const dateKey = (module === 'factures' ? 'invoice_date' : 'sale_date') as keyof AnyDetailRow;
    const { sortedData, sortConfig, handleSort } = useSort(lineItems as AnyDetailRow[], dateKey, 'desc');
    const totalAmount = lineItems.reduce((sum, item) => sum + Number(item.amount), 0);

    const getZohoUrl = (item: AnyDetailRow) => {
        const orgId = item.office === 'MTL' ? '815683274' : '48244978';
        const path = module === 'factures' ? 'invoices' : 'quotes';
        return `https://books.zoho.com/app/${orgId}#/${path}/${item.zoho_id}`;
    };

    const getDate = (item: AnyDetailRow) =>
        module === 'factures' ? (item as InvDetailRow).invoice_date : (item as ZoneB_DetailRow).sale_date;

    const getNumber = (item: AnyDetailRow) =>
        module === 'factures' ? (item as InvDetailRow).invoice_number : (item as ZoneB_DetailRow).quote_number;

    return (
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
            <div className="px-5 py-3.5 border-b border-hairline flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ink-secondary uppercase tracking-label">
                    {module === 'factures' ? 'Liste détaillée des factures' : 'Liste détaillée des devis'}
                </h2>
                <div className="flex items-center gap-2">
                    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-2xs font-semibold bg-stone text-ink-secondary uppercase tracking-label"
                          translate="no">
                        {lineItems.length} transactions
                    </span>
                    <ExportButton
                        rows={sortedData} columns={module === 'factures' ? INVOICE_CSV : DETAIL_CSV}
                        filename={module === 'factures' ? 'factures_semaine' : 'devis_semaine'}
                        label="CSV" disabled={lineItems.length === 0}
                    />
                </div>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hairline bg-sand/50">
                            <th
                                className="px-3 md:px-5 py-2.5 md:py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap cursor-pointer hover:bg-stone transition-colors group"
                                onClick={() => handleSort(dateKey)}
                            >
                                <div className="flex items-center gap-2">
                                    Date <SortIcon order={sortConfig.key === dateKey ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap">
                                Statut
                            </th>
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow">
                                Client
                            </th>
                            <th
                                className="px-3 md:px-5 py-2.5 md:py-3 text-right text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap cursor-pointer hover:bg-stone transition-colors group"
                                onClick={() => handleSort('amount')}
                            >
                                <div className="flex items-center justify-end gap-2">
                                    Montant <SortIcon order={sortConfig.key === 'amount' ? sortConfig.order : null} />
                                </div>
                            </th>
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap">
                                {module === 'factures' ? '# Facture' : '# Devis'}
                            </th>
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap">
                                Représentant
                            </th>
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-left text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap">
                                Département
                            </th>
                            <th className="px-3 md:px-5 py-2.5 md:py-3 text-center text-2xs font-semibold text-ink-mute uppercase tracking-eyebrow whitespace-nowrap">Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hairline">
                        {sortedData.length === 0 ? (
                            <tr>
                                <td colSpan={8} className="px-5 py-20 text-center">
                                    <div className="flex flex-col items-center gap-2">
                                        <span className="text-2xl opacity-20">📂</span>
                                        <p className="text-sm text-ink-mute font-medium">Aucun{module === 'factures' ? 'e facture' : ' devis'} trouvé{module === 'factures' ? 'e' : ''} pour ces critères.</p>
                                    </div>
                                </td>
                            </tr>
                        ) : (
                            sortedData.map((item, idx) => {
                                const isAvoir = module === 'factures' && (item as InvDetailRow).is_avoir;
                                return (
                                <tr key={`${getNumber(item)}-${idx}`} className={cn("hover:bg-sand/60 transition-colors group", isAvoir && "bg-tone-critical-soft/30")}>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 text-ink-mute whitespace-nowrap text-2xs font-medium">{formatShortDate(getDate(item))}</td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5">
                                        {module === 'factures' ? (
                                            <InvStatusBadge status={(item as InvDetailRow).status} isAvoir={isAvoir} />
                                        ) : (
                                        <span className={cn(
                                            "inline-flex items-center px-2 py-0.5 rounded-xs text-2xs font-semibold uppercase tracking-tighter",
                                            (item as ZoneB_DetailRow).status === 'invoiced'
                                                ? "bg-tone-good-soft text-tone-good-ink border border-tone-good/30"
                                                : "bg-tone-warn-soft text-tone-warn-ink border border-tone-warn/30"
                                        )}>
                                            {(item as ZoneB_DetailRow).status === 'invoiced' ? 'Facturé' : 'Accepté'}
                                        </span>
                                        )}
                                    </td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 font-bold text-ink max-w-[140px] md:max-w-[200px] truncate" title={item.client_name}>
                                        {item.client_name}
                                    </td>
                                    <td className={cn("px-3 md:px-5 py-2.5 md:py-3.5 text-right font-bold tabular-nums whitespace-nowrap transition-colors", isAvoir ? "text-tone-critical-ink" : "text-ink group-hover:text-primary-press")}>
                                        {formatCurrencyCAD(item.amount)}
                                        {module === 'factures' && <ShippingNote amount={(item as InvDetailRow).shipping_charge} className="mt-0.5" />}
                                    </td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 font-mono text-2xs text-ink-mute whitespace-nowrap">{getNumber(item)}</td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 text-ink-secondary whitespace-nowrap font-medium"><RepName name={item.rep_name} size="sm" /></td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5">
                                        <span className={cn(
                                            "inline-flex items-center px-2 py-0.5 rounded-md text-2xs font-bold whitespace-nowrap border",
                                            DEPT_COLORS[item.department] ?? 'bg-stone text-ink-secondary border-hairline-strong/50'
                                        )}>
                                            {item.department}
                                        </span>
                                    </td>
                                    <td className="px-3 md:px-5 py-2.5 md:py-3.5 text-center">
                                        <a
                                            href={getZohoUrl(item)}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center justify-center p-1.5 rounded-md text-ink-faint hover:text-primary-press hover:bg-primary-wash transition-all"
                                            title="Voir dans Zoho Books"
                                        >
                                            <ExternalLink className="w-4 h-4" />
                                        </a>
                                    </td>
                                </tr>
                                );
                            })
                        )}
                    </tbody>
                    {sortedData.length > 0 && (
                        <tfoot>
                            <tr className="bg-ink text-white font-bold">
                                <td colSpan={3} className="px-3 md:px-5 py-3 md:py-4 text-2xs uppercase tracking-eyebrow">Total hebdo.</td>
                                <td className="px-3 md:px-5 py-3 md:py-4 text-right font-bold tabular-nums whitespace-nowrap">
                                    {formatCurrencyCAD(totalAmount)}
                                </td>
                                <td colSpan={4} className="px-3 md:px-5 py-3 md:py-4"></td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
        </div>
    );
}

const INV_STATUS_STYLES: Record<string, string> = {
    paid:    'bg-tone-good-soft text-tone-good-ink border-tone-good/30',
    partial: 'bg-tone-warn-soft text-tone-warn-ink border-tone-warn/30',
    sent:    'bg-tone-warn-soft text-tone-warn-ink border-tone-warn/30',
    viewed:  'bg-tone-warn-soft text-tone-warn-ink border-tone-warn/30',
    overdue: 'bg-tone-critical-soft text-tone-critical-ink border-tone-critical/30',
    avoir:   'bg-tone-critical-soft text-tone-critical-ink border-tone-critical/30',
};
const INV_STATUS_LABELS: Record<string, string> = {
    paid: 'Payé', partial: 'Partiel', sent: 'Envoyé',
    viewed: 'Envoyé', overdue: 'En retard', avoir: 'Avoir',
};

function InvStatusBadge({ status, isAvoir }: { status: string; isAvoir: boolean }) {
    const key = isAvoir ? 'avoir' : status;
    return (
        <span className={cn(
            "inline-flex items-center px-2 py-0.5 rounded-xs text-2xs font-semibold uppercase tracking-tighter border",
            INV_STATUS_STYLES[key] ?? 'bg-stone text-ink-secondary border-hairline-strong'
        )}>
            {INV_STATUS_LABELS[key] ?? key}
        </span>
    );
}
