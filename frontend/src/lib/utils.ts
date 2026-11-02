import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { format } from "date-fns";
import { frCA } from "date-fns/locale";

// Tailwind class merger
export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/** Accent- and case-insensitive, so "evenement" finds "Évènement". */
export function foldForSearch(v: string): string {
    return v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// ─── Canadian French Currency Formatter (CAD) ───
// Rules: '1 287 016,80 $', space as thousands separator, comma for decimals, $ after
// The native Intl.NumberFormat for fr-CA gets very close to this automatically.
export function formatCurrencyCAD(amount: number): string {
    // Normalize -0 and any value that rounds to 0 at 2 decimals → display as 0.
    // Avoids "-0,00 $" from floating-point math or 0 × -rate.
    if (!Number.isFinite(amount) || Math.abs(amount) < 0.005) amount = 0;

    // Use Intl.NumberFormat to handle the heavy lifting
    const formatter = new Intl.NumberFormat('fr-CA', {
        style: 'currency',
        currency: 'CAD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });

    // Intl format string looks like "1 234,56 $"
    // Some browsers might output "1 234,56 $ CA" or encode non-breaking spaces.
    let formatted = formatter.format(amount);

    // Clean up standard Canadian output if 'CA' is appended
    if (formatted.includes('CA')) {
        formatted = formatted.replace('CA', '').trim();
    }

    return formatted;
}

// ─── Canadian French Date Formatter ───
// Long format: '16 février 2026'
export function formatLongDate(dateString: string | Date): string {
    let date: Date;
    if (typeof dateString === 'string' && dateString.length === 10 && dateString.includes('-')) {
        const [year, month, day] = dateString.split('-').map(Number);
        date = new Date(year, month - 1, day);
    } else {
        date = typeof dateString === 'string' ? new Date(dateString) : dateString;
    }
    return format(date, 'd MMMM yyyy', { locale: frCA });
}

// Short format: '16 févr. 2026'
export function formatShortDate(dateString: string | Date): string {
    let date: Date;
    if (typeof dateString === 'string' && dateString.length === 10 && dateString.includes('-')) {
        const [year, month, day] = dateString.split('-').map(Number);
        date = new Date(year, month - 1, day);
    } else {
        date = typeof dateString === 'string' ? new Date(dateString) : dateString;
    }
    return format(date, 'd MMM yyyy', { locale: frCA });
}

export function formatPercentage(value: number): string {
    if (!Number.isFinite(value) || Math.abs(value) < 0.005) value = 0;
    const formatter = new Intl.NumberFormat('fr-CA', {
        style: 'percent',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    // value expected as decimal for Intl, but DB returns % like 89.04.
    // We divide by 100 since Intl expects 0.8904
    return formatter.format(value / 100);
}

// ─── Phone Formatter ───
// Zoho stores whatever the rep typed, so the same column holds '4502883775',
// '514 606-0878', '(450) 288-3775' and '+1 450 288 3775'. Render every North
// American number the one way - '514 606-0878' - and hand anything else back
// exactly as entered: an international or malformed number squeezed into a
// 10-digit shape is worse than an unformatted one.

// Pulled off before the digits are counted, so '514 606-0878 poste 12' is a
// ten-digit number with an extension rather than a twelve-digit mystery.
const PHONE_EXTENSION = /\s*(?:,|;|#|x|ext\.?|extension|poste)\s*(\d{1,6})\s*$/i;

export function formatPhone(raw: string | null | undefined): string | null {
    const trimmed = raw?.trim();
    if (!trimmed) return null;

    let base = trimmed;
    let extension = '';
    const ext = trimmed.match(PHONE_EXTENSION);
    if (ext?.index !== undefined) {
        base = trimmed.slice(0, ext.index).trim();
        extension = ` poste ${ext[1]}`;
    }

    const digits = base.replace(/\D/g, '');
    // Eleven digits opening with 1 is the same number carrying its country code:
    // '+1 450 288 3775' and '4502883775' have to come out identical.
    const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;

    // Neither a NANP area code nor an exchange may begin with 0 or 1, so a
    // ten-digit string that does is not a phone number - leave it alone.
    if (local.length !== 10 || /^[01]/.test(local) || /^[01]/.test(local.slice(3))) {
        return trimmed;
    }

    return `${local.slice(0, 3)} ${local.slice(3, 6)}-${local.slice(6)}${extension}`;
}

// The search box has to survive the same inconsistency formatPhone hides: the
// table now reads '450 288-3775' while the column still holds '4502883775', so a
// user copying what they see would find nothing. Interleaving wildcards between
// the digits matches that sequence under any punctuation, in one pattern rather
// than a guess at every separator style in the data.
const PHONE_SHAPED = /^[\d\s()+.-]+$/;

/**
 * PostgREST's `or` filter is comma-separated and paren-grouped, so those
 * characters in a search term would corrupt the query rather than match text.
 * `%` and `_` are ilike wildcards and are escaped so they match literally.
 */
export function sanitizeSearch(raw: string): string {
    return raw.replace(/[,()]/g, ' ').replace(/[%_\\]/g, '\\$&').trim();
}

export function phoneSearchPattern(term: string): string {
    const digits = term.replace(/\D/g, '');
    // Below four digits the loose pattern matches most of the table, and a term
    // that is not phone-shaped ('Bell 514') is a name - both search literally.
    if (digits.length < 4 || !PHONE_SHAPED.test(term)) return `%${term}%`;
    return `%${digits.split('').join('%')}%`;
}

// ─── Service list clipping ───
// A contact billed across several departments gets one service entry per
// department, so this column is the one that breaks the table's rhythm if left
// to run. Only the first is shown; the rest live in the hover title.
//
// 32, not 30: "Développement d'application Web" is 31 characters, and it is a
// real picklist value, not an outlier. At 30 the commonest long service was
// being cut for the sake of two columns of width. The two genuinely long ones
// ("Imprimés, articles et vêtements promo", "Solutions d'intelligence
// artificielle", both 37) still truncate, which is why `truncated` is reported.
export const SERVICE_MAX_CHARS = 32;

/**
 * The first service, whether it had to be cut, and how many were left out.
 *
 * `truncated` matters as much as `hiddenCount`: a single name too long for the
 * column is elided just as surely as a second service is, and the caller has to
 * put BOTH cases in the tooltip or the value becomes unrecoverable - the reader
 * sees "Développement d'application W…" and has nowhere to find the rest.
 */
export function clipServices(
    services: string[], maxChars: number = SERVICE_MAX_CHARS,
): { text: string; hiddenCount: number; truncated: boolean } {
    const first = services[0] ?? '';
    const truncated = first.length > maxChars;
    return {
        text: truncated ? first.slice(0, maxChars - 1).trimEnd() + '…' : first,
        hiddenCount: Math.max(0, services.length - 1),
        truncated,
    };
}
