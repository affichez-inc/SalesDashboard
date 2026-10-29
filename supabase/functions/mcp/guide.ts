// What Claude reads before it writes SQL: the traps in this database.
//
// Every table is a filtered mirror of Zoho, and the filter is invisible from a
// query. This is the short form of CLAUDE.md and STATS-INTEGRITY.md for a
// reader who only sees the schema. When a sync or an RPC changes what a table
// holds, change it here too: a stale line here is a wrong number in a chat.

/** Sent once, at connection. Points at the full guide. */
export const INSTRUCTIONS = `Read-only access to the Affichez sales database (Zoho Books quotes and invoices, Zoho CRM accounts, leads and tasks, Google and Meta ad spend). Call describe_database before the first query of a conversation: it explains what each table really contains, and several tables do not hold what their name suggests. To reproduce a figure shown on the dashboard, call the dashboard's own function (SELECT * FROM get_dashboard_kpis(p_year => 2026)) rather than re-deriving it.`;

/** Returned by describe_database, above the live list of tables and functions. */
export const GUIDE = `# Affichez sales database: read before querying

Affichez is an advertising company in Quebec with two offices, QC and MTL. This database is a mirror of Zoho Books (quotes, invoices) and Zoho CRM (accounts, leads, contacts, tasks), refreshed every few minutes, plus Google Ads and Meta Ads spend. Money is in CAD.

## How queries run
- Read-only. One statement per call: a SELECT, or WITH ... SELECT.
- The session time zone is America/Toronto, so timestamptz values print in Montreal time and now() and CURRENT_DATE are Montreal's. Group a timestamptz by day or month in that zone, never in UTC.
- A call returns at most max_rows rows. Aggregate in SQL (GROUP BY, SUM, COUNT) rather than reading raw rows.
- Answer in the user's language. Say which table, filters and period a figure comes from.

## Quotes: table sales
- Every Zoho Books quote of every status since 2015: draft, sent, accepted, invoiced, declined, expired.
- A quote is a SALE only when status IN ('accepted','invoiced'). Every sales or revenue figure built on this table must filter on that; without it you count quotes nobody bought.
- sale_date is the acceptance date on a won quote; on any other quote it falls back to the issue date. quote_date is the issue date. Sales of a period: won quotes by sale_date (what the dashboard does).
- Closing rate: one cohort, the quotes ISSUED in the period (by quote_date). The app's definition (get_creator_summary, page Documents créés): won = status 'invoiced', over the quotes that reached a client = every status except 'draft' (a draft was never shown to anybody). Counting 'accepted' as won too reads a little higher; say which definition you used. Never divide a sale_date set by a quote_date set.
- rep_name is the salesperson credited with the sale; use it for anything about a rep's performance. created_by_name is who typed the quote in; creator figures never add up with rep figures.
- office: QC or MTL. department: MULTI-ANNONCEURS, PROMOTIONNEL, DIST. PUBLICITAIRE SOLO, NUMERIQUE, APPLICATION, SERVICES IA, EVENEMENT, or NULL when Zoho's label has no mapping (zoho_department_label keeps Zoho's own label).

## Invoices: table invoices
- Zoho Books invoices and credit notes: QC since 2014, MTL since 2021. Drafts are not stored; voided and deleted documents are removed.
- status: sent, viewed, paid, partial, overdue, or avoir for a credit note. Credit notes have is_avoir = true and a NEGATIVE amount.
- Net billed = SUM(amount) over invoices and credit notes together; that is the dashboard's invoice total. A count of invoices excludes credit notes (WHERE NOT is_avoir).
- Dated by invoice_date. Due dates are not stored.

## Amounts, on both tables
- amount is before tax: Zoho's total minus Zoho's tax, shipping and fees included. Commissions are paid on it. total_incl_tax includes the taxes. Use amount for revenue.

## What the dashboard leaves out
- Rows whose client_name is in excluded_clients, and rows whose rep_name is in excluded_reps, are left out of the dashboard's quote and invoice totals. Use NOT EXISTS against those tables, never NOT IN.
- Reps: the sales team is the list returned by get_sales_team(), minus Simon Fortin Massé, Magasin Affichez, Charles Côté, Pier-Alexandre Lévesque, Vente interne and Vincent Dagenais. The dashboard shows every other rep_name (former staff, billing entities) as one line, "Interne". When you group by rep, merge those the same way, then recompute averages and rates from the merged counts.

## Targets
- objectives: monthly quote (Devis) targets by department. objectives_factures: monthly invoice targets by department. Neither has an office column, so an office's actuals cannot be compared with them.
- rep_objectives: monthly targets per rep, by module ('devis' or 'factures'). rep_objectives_dept: the same per department.
- fiscal_quarters covers 2025 and 2026 only; joining to it drops every other year.

## Clients: CRM accounts
- zoho_accounts: one row per Zoho CRM account, that is one company. Key: zoho_account_id. An invoice belongs to an account (invoices.crm_account_id), never to a person; quotes link the same way (sales.crm_account_id). About 3% of documents have no account link (crm_account_id NULL) and are missing from any per-account total.
- zoho_accounts_enriched: the accounts with their billed revenue, net of credit notes (revenue_lifetime, revenue_12m, revenue_ytd, revenue_prev_year, revenue_last_month, revenue_30d), invoice_count, first and last invoice dates, and is_internal.
- Affichez's own entities are accounts too: rating 'Compte interne : Ne pas reprendre' or 'Fournisseur'. Leave them out when counting or ranking clients (is_internal = false on zoho_accounts_enriched). rating holds Zoho's stored values, which are not always the French labels of the CRM screen.
- ventes_* columns are the revenue of Royer & Fils / VotreLogo.ca, a different business invoiced outside these Zoho Books organisations. Report them beside invoice figures, never add them.
- origine_du_client is the account's source (Google Ads, Meta Ads, Google Organique, Meta Organique, ...). Paid and organic Google were only told apart from 2026-10-01: before that date "Google Organique" mixes both.

## Leads and contacts: table zoho_leads
- stage 'lead' or 'contact'. Most contacts were created directly as clients and never were leads: a lead funnel counts stage = 'lead' only.
- Zoho flags almost every lead converted, which says little. A useful conversion is a lead whose account was invoiced after the lead arrived.
- The table leads is a dead hand-entered archive; do not use it, nor the get_leads_* functions that read it.

## Other tables
- zoho_tasks: CRM tasks (status 'Achevé' = done, 'Non commencé', 'En cours').
- ad_spend_daily: spend per day and campaign, platform 'google' or 'meta'. Revenue is attributed to a channel through the source of the accounts it brought in, by month of account creation, never per campaign: use get_ad_performance and get_ad_monthly.
- account_ai_summaries: the AI summary cards of CRM accounts (result holds the card).
- paye_entries, paye_meta, rep_comm_rates: payroll and commissions.

## Before you state a ratio
- Check the population first: GROUP BY status on the table and confirm every outcome you divide by is there.
- Narrow the numerator and the denominator on the same filters.
- An inner join to a dimension table (fiscal_quarters, objectives) silently drops the rows that do not match.
`;
