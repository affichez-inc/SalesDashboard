import { cn } from '../../lib/utils';
import { DEPT_COLORS } from '../weekly/deptColors';
import { invoiceStatusLabel, quoteStatusLabel } from './documentStatus';


/**
 * A document's department. One Zoho has no mapping for keeps its raw label,
 * uncoloured; one Zoho gives no department at all is a dash.
 */
export function DeptBadge({ department, rawLabel }: { department: string | null; rawLabel?: string | null }) {
    const text = department ?? rawLabel;
    if (!text) return <span className="text-ink-faint">—</span>;
    return (
        <span className={cn(
            "inline-flex items-center px-2 py-0.5 rounded-md text-2xs font-bold whitespace-nowrap border",
            (department && DEPT_COLORS[department]) ?? 'bg-stone text-ink-secondary border-hairline-strong/50'
        )}>
            {text}
        </span>
    );
}

const BADGE = "inline-flex items-center px-2 py-0.5 rounded-xs text-2xs font-semibold uppercase tracking-tighter border whitespace-nowrap";
const GOOD = 'bg-tone-good-soft text-tone-good-ink border-tone-good/30';
const WARN = 'bg-tone-warn-soft text-tone-warn-ink border-tone-warn/30';
const CRITICAL = 'bg-tone-critical-soft text-tone-critical-ink border-tone-critical/30';
const NEUTRAL = 'bg-tone-neutral-soft text-tone-neutral-ink border-hairline-strong';

const INVOICE_TONES: Record<string, string> = {
    paid: GOOD, partial: WARN, sent: WARN, viewed: WARN, overdue: CRITICAL, avoir: CRITICAL,
};

export function InvoiceStatusBadge({ status, isAvoir }: { status: string; isAvoir: boolean }) {
    const key = isAvoir ? 'avoir' : status;
    return (
        <span className={cn(BADGE, INVOICE_TONES[key] ?? 'bg-stone text-ink-secondary border-hairline-strong')}>
            {invoiceStatusLabel(status, isAvoir)}
        </span>
    );
}

const QUOTE_TONES: Record<string, string> = {
    draft: NEUTRAL, sent: WARN, accepted: GOOD, invoiced: GOOD, declined: CRITICAL, expired: NEUTRAL,
};

export function QuoteStatusBadge({ status, zohoStatus }: { status: string | null; zohoStatus: string | null }) {
    return (
        <span className={cn(BADGE, (status && QUOTE_TONES[status]) ?? NEUTRAL)}>
            {quoteStatusLabel(status, zohoStatus)}
        </span>
    );
}
