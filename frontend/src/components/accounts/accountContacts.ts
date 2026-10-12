/**
 * The contacts of the accounts on Comptes · Détail, for the "comptes + contacts"
 * export and the Meta audience summary.
 *
 * Read through get_accounts_contacts, in chunks of account ids and pages of
 * rows: the API returns at most 1,000 rows per request whatever range is asked
 * for, and a filter can keep thousands of accounts.
 */
import { supabase } from '../../lib/supabase';
import type { CsvColumn } from '../../lib/csv';
import type { AccountContactExportRow, ZohoAccountRow } from '../../types/database';

const ACCOUNT_CHUNK = 500;
const PAGE_ROWS = 1000;
const PARALLEL = 3;

export async function fetchAccountContacts(accountIds: string[]): Promise<AccountContactExportRow[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < accountIds.length; i += ACCOUNT_CHUNK) chunks.push(accountIds.slice(i, i + ACCOUNT_CHUNK));

    const readChunk = async (ids: string[]): Promise<AccountContactExportRow[]> => {
        const out: AccountContactExportRow[] = [];
        for (let from = 0; ; from += PAGE_ROWS) {
            const { data, error } = await supabase
                .rpc('get_accounts_contacts', { p_account_ids: ids })
                .order('account_id').order('zoho_record_id')
                .range(from, from + PAGE_ROWS - 1);
            // postgrest-js hands back a plain object here, not an Error: wrapped,
            // so a message reaches the screen instead of "[object Object]".
            if (error) throw new Error(error.message);
            const page = (data as AccountContactExportRow[]) ?? [];
            out.push(...page);
            // Stop on an empty page, not a short one: a lower row cap on the
            // server would otherwise end the read after its first page.
            if (page.length === 0) break;
        }
        return out;
    };

    const results: AccountContactExportRow[][] = new Array(chunks.length);
    let next = 0;
    const worker = async () => {
        while (next < chunks.length) {
            const i = next++;
            results[i] = await readChunk(chunks[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
    return results.flat();
}

export function contactsByAccount(contacts: AccountContactExportRow[]): Map<string, AccountContactExportRow[]> {
    const map = new Map<string, AccountContactExportRow[]>();
    for (const c of contacts) {
        const list = map.get(c.account_id);
        if (list) list.push(c); else map.set(c.account_id, [c]);
    }
    return map;
}

/**
 * Refused marketing email in Zoho, or either flag not known yet - the audience
 * leaves both out. Same rule as the meta-custom-audience function.
 */
export function refusedMarketing(c: AccountContactExportRow): boolean {
    return c.email_opt_out !== false || c.no_marketing !== false;
}

// ─── The grouped export ───────────────────────────────────────────────────────
//
// One file, each account followed by its contacts: the account on a "Compte"
// line, then one "Contact" line per person, with the account's name repeated so
// the file still sorts and filters in Excel. Amounts are on the account line
// only, so summing the column does not count an account once per contact.

export type AccountContactLine = {
    kind: 'account' | 'contact';
    account: ZohoAccountRow;
    contact: AccountContactExportRow | null;
};

export function groupedLines(
    accounts: ZohoAccountRow[],
    contacts: AccountContactExportRow[],
): AccountContactLine[] {
    const byAccount = contactsByAccount(contacts);
    const lines: AccountContactLine[] = [];
    for (const a of accounts) {
        lines.push({ kind: 'account', account: a, contact: null });
        for (const c of byAccount.get(a.zoho_account_id) ?? []) {
            lines.push({ kind: 'contact', account: a, contact: c });
        }
    }
    return lines;
}

const MAIL_SOURCE_LABEL = { shipping: 'Livraison', billing: 'Facturation' } as const;

/** A refusal flag in the file: Oui, Non, or blank while it is not known yet. */
const flag = (v: boolean | null | undefined) => (v === null || v === undefined ? null : v);

export function accountContactColumns(opts: {
    /** Display name for a rep (Interne for someone off the team). */
    displayRep: (name: string | null) => string | null;
    /** The period amount column, when the amount filter is on a period. */
    periodAmount?: { header: string; value: (a: ZohoAccountRow) => number };
}): CsvColumn<AccountContactLine>[] {
    const acct = (l: AccountContactLine) => l.kind === 'account';
    const cols: CsvColumn<AccountContactLine>[] = [
        { header: 'Type',               value: l => (acct(l) ? 'Compte' : 'Contact') },
        { header: 'Compte',             value: l => l.account.account_name },
        { header: 'Prénom',             value: l => l.contact?.first_name ?? null },
        { header: 'Nom',                value: l => l.contact?.last_name ?? null },
        { header: 'Titre',              value: l => l.contact?.title ?? null },
        { header: 'Courriel',           value: l => l.contact?.email ?? null },
        { header: 'Courriel secondaire', value: l => l.contact?.secondary_email ?? null },
        { header: 'Téléphone',          value: l => (acct(l) ? l.account.phone : l.contact?.phone ?? null) },
        { header: 'Cellulaire',         value: l => l.contact?.mobile ?? null },
        { header: 'Langue',             value: l => l.contact?.language ?? null },
        // The account's address on both lines: contacts have none of their own.
        // "d'envoi" because it is the shipping address when there is one, unlike
        // the billing address the accounts-only export carries as "Adresse".
        { header: "Adresse d'envoi",     value: l => l.account.mail_street },
        { header: "Ville d'envoi",       value: l => l.account.mail_city },
        { header: "Province d'envoi",    value: l => l.account.mail_state },
        { header: "Code postal d'envoi", value: l => l.account.mail_code },
        { header: "Pays d'envoi",        value: l => l.account.mail_country },
        { header: "Type d'adresse",      value: l => (l.account.mail_source ? MAIL_SOURCE_LABEL[l.account.mail_source] : null) },
        { header: 'Désabonné des courriels', value: l => (acct(l) ? null : flag(l.contact?.email_opt_out)) },
        { header: 'Refuse le marketing', value: l => (acct(l) ? null : flag(l.contact?.no_marketing)) },
        { header: 'Courriel non remis', value: l => (acct(l) ? null : flag(l.contact?.email_bounced)) },
        { header: 'Propriétaire',       value: l => opts.displayRep(acct(l) ? l.account.rep_name : l.contact?.rep_name ?? null) },
        { header: 'Source',             value: l => (acct(l) ? l.account.origine_du_client : null) },
        { header: 'Domaine',            value: l => (acct(l) ? l.account.domaine_activite : null) },
        { header: 'Revenus (net)',      value: l => (acct(l) ? l.account.revenue_lifetime : null) },
    ];
    if (opts.periodAmount) {
        const p = opts.periodAmount;
        cols.push({ header: p.header, value: l => (acct(l) ? p.value(l.account) : null) });
    }
    cols.push(
        { header: 'Nb factures',      value: l => (acct(l) ? l.account.invoice_count : null) },
        { header: 'Dernière facture', value: l => (acct(l) ? l.account.last_invoice_date : null) },
        { header: 'Lien CRM',         value: l => (acct(l) ? l.account.zoho_crm_url : l.contact?.zoho_crm_url ?? null) },
    );
    return cols;
}
