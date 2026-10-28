export type SommaireRow = {
    month: number;
    department?: string;
    objectif: number;
    actual_amount: number;
    pct_atteint: number;
    deal_count: number;
};

export type AvailableWeek = {
    week_start: string;
    week_end: string;
    total_amount: number;
    num_sales: number;
};

export type ZoneA_SummaryRow = {
    week_start: string;
    week_end: string;
    rep_name: string;
    office: string;
    status: string;
    department: string;
    total_amount: number;
    num_sales: number;
};

export type ZoneA_DeptTotal = {
    department: string;
    total_amount: number;
    num_sales: number;
};

export type ZoneB_DetailRow = {
    sale_date: string;
    client_name: string;
    amount: number;
    quote_number: string;
    rep_name: string;
    department: string;
    zoho_department_label: string;
    office: 'QC' | 'MTL';
    status: 'accepted' | 'invoiced' | 'declined';
    zoho_id: string;
};

export type YoYRow = {
    quarter: number;
    rep_name: string;
    office: string;
    current_avg: number;
    // null when the comparison year has no fiscal_quarters rows: nothing was
    // queried, which is not the same fact as "sold nothing". Rendered "—".
    previous_avg: number | null;
    resultat: number | null;
    deal_count: number;
};

// True per-quarter team totals (all reps active in each year), from
// get_quarterly_yoy_totals / get_inv_quarterly_yoy_totals. Used to show the real
// last-year comparison in the "Total équipe" row instead of only summing reps
// active in the current year.
export type QuarterTotalsRow = {
    quarter: number;
    // Both null when that year has no fiscal_quarters rows - see YoYRow above.
    current_total: number | null;
    previous_total: number | null;
};

export type InvDetailRow = {
    invoice_date: string;
    client_name: string;
    amount: number;
    invoice_number: string;
    rep_name: string;
    department: string;
    zoho_department_label: string;
    office: 'QC' | 'MTL';
    status: 'sent' | 'viewed' | 'paid' | 'partial' | 'overdue' | 'void' | 'avoir';
    is_avoir: boolean;
    zoho_id: string;
    /** Zoho's shipping charge before tax, already inside `amount`. Null until read from Zoho. */
    shipping_charge: number | null;
};

/**
 * Where a contact's source or service came from, once resolved.
 *
 * 'own'     the record states it itself (always the case for a lead)
 * 'lead'    inherited from the lead this contact converted from
 * 'account' taken from the CRM account the contact belongs to
 * 'invoice' the departments the account has actually been billed under
 */
export type AttributionOrigin = 'own' | 'lead' | 'account' | 'invoice';

/**
 * A row of `zoho_leads` - one Zoho CRM record, Lead or Contact, told apart by
 * `stage`. Synced by the zoho-lead-sync edge function; read-only in the app.
 *
 * `lead_source` and `service_interest` exist only on Zoho's Leads module. For a
 * contact they are inherited from the originating lead by a DB trigger, in which
 * case `attribution_inherited` is true. A contact created directly in Zoho -
 * which no lead points at - has neither, and both come back empty.
 */
export type ZohoLeadRow = {
    zoho_record_id: string;
    stage: 'lead' | 'contact';

    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    company: string | null;
    phone: string | null;
    email: string | null;

    owner_name: string | null;
    owner_email: string | null;
    rep_name: string | null;

    created_time: string | null;
    modified_time: string | null;

    lead_source: string | null;
    service_interest: string[];
    lead_status: string | null;
    attribution_inherited: boolean;

    /**
     * Attribution as it should be shown. For a lead these are just its own
     * values; for a contact they are resolved in zoho_leads_unique from the
     * account and the invoices billed to it, because Zoho's Contacts module
     * carries neither field.
     *
     * Use these for display and filtering. `lead_source` and `service_interest`
     * above stay exactly what Zoho's Leads module said, which for most contacts
     * is nothing at all.
     *
     * Optional only so a frontend build can ship ahead of its migration; both are
     * always present once 20260903060000 is applied.
     */
    source_resolved?: string | null;
    service_resolved?: string[];

    /** Where each resolved value came from, for the inherited-value marker. */
    source_origin?: AttributionOrigin | null;
    service_origin?: AttributionOrigin | null;

    /**
     * CRM account this record belongs to - the join key to invoices. A contact
     * takes it from Account_Name; a lead only has one once converted. Invoices
     * are owned by the account, so contacts at the same company share them.
     */
    account_id: string | null;

    /**
     * The account has at least one invoice or avoir, ever. Computed in
     * zoho_leads_unique rather than derived from the per-page rollup, so the
     * Factures filter can run in Postgres over the whole table instead of over
     * the 100 rows currently on screen.
     *
     * Optional only so a build can precede its migration; the view always
     * supplies it once 20260903020000 is applied.
     */
    has_invoices?: boolean;

    is_converted: boolean;
    converted_contact_id: string | null;
    converted_account_id: string | null;
    converted_deal_id: string | null;
    converted_time: string | null;

    zoho_crm_url: string | null;
    synced_at: string;
};

/**
 * Distinct values for the Leads filter bar (get_zoho_lead_filter_options).
 *
 * `services` is folded to one entry per service: Zoho's picklist holds the same
 * service under several spellings that differ only in case or spacing, and
 * offering both meant picking one silently excluded the other's rows.
 * `service_variants` maps each label to every raw spelling behind it, so a query
 * can match them all at once - the stored array keeps Zoho's original casing.
 */
export type ZohoLeadFilterOptions = {
    sources: string[];
    services: string[];
    reps: string[];
    service_variants: Record<string, string[]>;
};

/** Legacy hand-entered leads table, superseded by ZohoLeadRow. Kept as an archive. */
export type LeadRow = {
    id: string;
    created_at: string;
    lead_date: string;
    rep_name: string;
    source: string;
    service_interest: string | null;
    amount_sold: number;
    zoho_lead_id: string | null;
    zoho_contact_id: string | null;
    zoho_crm_url: string | null;
    notes: string | null;
    lead_status: 'active' | 'won' | 'lost';
};

export type LeadKPIs = {
    total_leads: number;
    won_leads: number;
    conversion_rate: number;
    total_amount: number;
};

export type LeadsByRepRow = {
    rep_name: string;
    nb_leads: number;
    nb_won: number;
    total_amount: number;
};

export type LeadsBySourceRow = {
    source: string;
    nb_leads: number;
    nb_won: number;
    total_amount: number;
};

export type LeadsByServiceRow = {
    service_interest: string;
    nb_leads: number;
    nb_won: number;
    total_amount: number;
};

export type LeadsMonthlySummaryRow = {
    month: number;
    nb_leads: number;
    nb_won: number;
    total_amount: number;
};

// ─── Tâches CRM (Zoho CRM tasks) ────────────────────────────────────────────

export type TaskKPIs = {
    total_created: number;
    total_completed: number;
    // Throughput: closed in period / created in period. Different cohorts, so it
    // can legitimately exceed 100% when backlog is cleared. Do not clamp it.
    completion_rate: number;
    // One cohort: of the tasks created in the period, the share now closed.
    cohort_rate: number;
    total_touched: number;
    total_open: number;
    total_overdue: number;
    active_reps: number;
};

export type TasksByRepRow = {
    rep_name: string;
    nb_created: number;
    nb_completed: number;
    // cohort_rate's numerator, so merged rows can recompute it: a rate cannot be
    // re-averaged across reps.
    nb_created_closed: number;
    nb_touched: number;
    completion_rate: number;
    cohort_rate: number;
    avg_days_to_close: number | null;
    nb_open: number;
    nb_overdue: number;
};

export type TasksByStatusRow = {
    status: string;
    nb: number;
};

export type TasksWeeklyRow = {
    week_start: string;
    nb_created: number;
    nb_completed: number;
};

export type TasksWoWRow = {
    rep_name: string;
    created_this_week: number;
    created_last_week: number;
    completed_this_week: number;
    completed_last_week: number;
};

export type TasksAvailableWeek = {
    week_start: string;
    week_end: string;
    nb_created: number;
    nb_completed: number;
};

/**
 * One invoice or credit note attached to a CRM account, from get_lead_invoices.
 * `amount` is pre-tax and negative on an avoir, so a plain sum is the net figure.
 */
export type LeadInvoiceRow = {
    zoho_id: string;
    invoice_number: string | null;
    client_name: string;
    amount: number;
    invoice_date: string | null;
    status: 'sent' | 'viewed' | 'paid' | 'partial' | 'overdue' | 'void' | 'avoir';
    is_avoir: boolean;
    department: string | null;
    office: 'QC' | 'MTL' | null;
    rep_name: string | null;
    books_customer_id: string | null;
};

/** Per-account rollup from get_lead_invoice_totals - one row per account with invoices. */
export type LeadInvoiceTotals = {
    account_id: string;
    invoice_count: number;
    credit_count: number;
    total_amount: number;
    last_invoice_date: string | null;
};

/** Progress of the Books-customer → CRM-account back-fill, from get_invoice_linkage_status. */
export type InvoiceLinkageStatus = {
    customers_total: number;
    customers_pending: number;
    customers_linked: number;
    customers_unlinked: number;
    customers_error: number;
    invoices_total: number;
    invoices_with_account: number;
};

/**
 * Leads dashboard KPI row (get_zoho_lead_kpis), computed over Zoho's Leads module.
 *
 * Two conversion figures on purpose. `leads_converted` is Zoho's own flow, which
 * marks ~97% of leads converted and so says little; `leads_invoiced` is the lead's
 * account actually being billed after the lead arrived. The second is the one that
 * moves. They are nested, not overlapping - every invoiced lead is also converted.
 *
 * `revenue_attributed` counts only invoices dated on or after the lead arrived;
 * `revenue_lifetime` is the account's whole billing history. Both are summed once
 * per account, so several leads on one account do not double-count.
 */
export type ZohoLeadKPIs = {
    leads_received: number;
    leads_converted: number;
    leads_invoiced: number;
    conversion_rate: number;
    invoiced_rate: number;
    revenue_attributed: number;
    revenue_lifetime: number;
};

/** One row of any get_zoho_leads_by_* breakdown - same shape for rep, source and service. */
export type ZohoLeadBreakdownRow = {
    label: string;
    nb_leads: number;
    nb_converted: number;
    nb_invoiced: number;
    total_amount: number;
};

/** get_zoho_leads_monthly_summary - `month` is 1-12. */
export type ZohoLeadsMonthlyRow = {
    month: number;
    nb_leads: number;
    nb_converted: number;
    nb_invoiced: number;
    total_amount: number;
};

/**
 * Invoicing the app cannot tie to a CRM account (get_invoice_unassigned_summary).
 * Internal billing - the company invoicing itself - is reported separately rather
 * than counted as a gap, since it will never have a CRM account.
 */
export type InvoiceUnassignedSummary = {
    unassigned_count: number;
    unassigned_amount: number;
    internal_count: number;
    internal_amount: number;
    assigned_amount: number;
    total_count: number;
    total_amount: number;
    unassigned_share: number;
};

/** One unattributed invoice, with why it could not be linked (get_unassigned_invoices). */
export type UnassignedInvoiceRow = {
    zoho_id: string;
    invoice_number: string | null;
    client_name: string;
    amount: number;
    invoice_date: string | null;
    status: string;
    is_avoir: boolean;
    department: string | null;
    office: 'QC' | 'MTL' | null;
    rep_name: string | null;
    reason: string;
};

// ─── Comptes (Zoho CRM Accounts) ──────────────────────────────────────────────
//
// The Comptes module reads the ACCOUNT as the record, not the lead or the
// contact. An account is unique where a contact is not: a company with three
// contacts is one account, so revenue is counted once without any dedupe layer.
// That is the whole reason this module exists - see docs/COMPTES.md.

/**
 * One row of zoho_accounts_enriched - a Zoho account with its lifetime invoice
 * rollup attached. Revenue here is lifetime, not windowed: a row is an account,
 * and the 12-month attribution window is a property of a cohort comparison,
 * which lives on the dashboard RPCs instead.
 */
export type ZohoAccountRow = {
    zoho_account_id: string;
    account_name: string | null;

    phone: string | null;
    website: string | null;
    description: string | null;
    billing_street: string | null;
    billing_city: string | null;
    billing_state: string | null;
    billing_code: string | null;
    billing_country: string | null;

    owner_name: string | null;
    owner_email: string | null;
    rep_name: string | null;
    charge_de_projets: string | null;

    created_time: string | null;
    created_date: string | null;
    modified_time: string | null;
    last_activity_time: string | null;

    origine_du_client: string | null;
    service_interest: string[];
    domaine_activite: string | null;
    region_administrative: string | null;
    region_cible: string[];
    type_marche: string[];
    periode_publicitaire: string[];
    nombre_employes: string | null;
    budget_publicitaire_annuel: number | null;
    potentiel_multi_annonceurs: string | null;
    potentiel_services_ia: boolean | null;
    revendeur: boolean | null;
    rating: string | null;
    tags: string[];

    parent_account_id: string | null;
    parent_account_name: string | null;

    nombre_taches: number | null;
    derniere_tache_fermee: string | null;

    /**
     * Royer & Fils / VotreLogo.ca promo revenue, from a Zoho CRM rollup field.
     * That business is invoiced outside the QC and MTL Books orgs, so it never
     * appears in `invoices` and must never be added to revenue_lifetime - the
     * two measure different companies.
     */
    ventes_totales: number | null;
    ventes_2026: number | null;
    ventes_2025: number | null;

    zoho_crm_url: string | null;

    invoice_count: number;
    credit_count: number;
    revenue_lifetime: number;
    first_invoice_date: string | null;
    last_invoice_date: string | null;
    has_invoices: boolean;

    /** "Client Royer & Fils / VotreLogo.ca" or "Client PLOGG/BUCCO" - an acquired
     *  customer list, not a campaign. Flagged so a 2,028-account import is never
     *  read against a Meta Ads bar as though they measured the same thing. */
    is_bulk_import: boolean;

    /**
     * Rating is one of Affichez's own entities ("Compte interne : Ne pas
     * reprendre", "Fournisseur") rather than a client. Precomputed in the view
     * because PostgREST's `rating=not.in.(...)` becomes NOT (rating IN ...),
     * which is NULL - not TRUE - for the 977 accounts with no rating, and would
     * hide them from the table while the dashboard still counted them.
     */
    is_internal: boolean;

    /**
     * What the Service column shows: the CRM multiselect when the account has
     * one, otherwise the departments actually billed. 59% of accounts never had
     * the CRM field filled in, so without the fallback the column sat empty for
     * companies that had plainly bought things.
     *
     * `service_origin` says which branch won, so a borrowed value can be marked
     * rather than passed off as a CRM answer.
     */
    service_resolved: string[];
    service_origin: 'crm' | 'invoice' | 'none';

    /**
     * Net amount billed over a period, on Montreal's calendar. What the
     * "Montant facturé" filter compares; see components/accounts/spendRange.
     */
    revenue_30d: number;
    revenue_last_month: number;
    revenue_12m: number;
    revenue_ytd: number;
    revenue_prev_year: number;

    /**
     * One postal address, taken whole from the shipping block when it has a
     * street, city or postal code, from the billing block otherwise. Contacts
     * have no address of their own, so this is theirs too.
     */
    mail_street: string | null;
    mail_city: string | null;
    mail_state: string | null;
    mail_code: string | null;
    mail_country: string | null;
    mail_source: 'shipping' | 'billing' | null;
};

/** get_account_spend_max: the top of the range slider, per period. */
export type AccountSpendMax = {
    /** Montreal's date the periods were computed from, YYYY-MM-DD. */
    today: string;
    lifetime: number | null;
    last_30d: number | null;
    last_month: number | null;
    last_12m: number | null;
    ytd: number | null;
    prev_year: number | null;
};

/**
 * get_accounts_contacts: the contacts of a list of accounts, with the account's
 * postal address. Contacts only - a converted lead is already its contact.
 *
 * The three refusal flags are null until the record has been read by a sync
 * that knows them, which is not the same as false.
 */
export type AccountContactExportRow = {
    account_id: string;
    zoho_record_id: string;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    title: string | null;
    email: string | null;
    secondary_email: string | null;
    phone: string | null;
    mobile: string | null;
    language: string | null;
    email_opt_out: boolean | null;
    no_marketing: boolean | null;
    email_bounced: boolean | null;
    rep_name: string | null;
    created_time: string | null;
    zoho_crm_url: string | null;
    mail_street: string | null;
    mail_city: string | null;
    mail_state: string | null;
    mail_code: string | null;
    mail_country: string | null;
    mail_source: 'shipping' | 'billing' | null;
    /** The account came from an acquired client list (Royer & Fils, PLOGG/BUCCO). */
    is_bulk_import: boolean;
};

/**
 * get_zoho_account_kpis.
 *
 * `revenue_per_account` is the figure the module exists for: what a cohort
 * actually billed, per account acquired. Divided by accounts_created, not by
 * accounts_invoiced - the accounts that bought nothing are exactly what makes a
 * bad source bad.
 *
 * `ventes_royer` sits beside the invoice figures and never inside them.
 */
export type ZohoAccountKPIs = {
    accounts_created: number;
    accounts_invoiced: number;
    invoiced_rate: number;
    revenue_attributed: number;
    revenue_lifetime: number;
    revenue_per_account: number;
    avg_days_to_first_invoice: number | null;
    ventes_royer: number;
};

/** One row of any get_zoho_accounts_by_* breakdown - rep, source, service, domaine. */
export type ZohoAccountBreakdownRow = {
    label: string;
    nb_accounts: number;
    nb_invoiced: number;
    total_amount: number;
    revenue_per_account: number;
    is_bulk_import: boolean;
};

/** get_zoho_accounts_monthly_summary - `month` is 1-12, every month present. */
export type ZohoAccountMonthlyRow = {
    month: number;
    nb_accounts: number;
    nb_invoiced: number;
    total_amount: number;
    revenue_per_account: number;
};

/**
 * get_zoho_account_filter_options.
 *
 * Drawn from the stored data, never from Zoho's picklist definition. Accounts
 * hold 26 distinct sources against 21 live picklist entries, and the orphans
 * include "Publicité/Recherche Google" (108 accounts) - the segment Dominic
 * asked to report on. A hardcoded list offers every source except that one.
 */
export type ZohoAccountFilterOptions = {
    years: number[];
    sources: string[];
    services: string[];
    service_variants: Record<string, string[]>;
    reps: string[];
    domaines: string[];
    regions: string[];
    ratings: string[];
};

/** get_account_revenue_by_department - one row per (year, department) for one account. */
export type AccountDeptRevenueRow = {
    year: number;
    department: string;
    invoice_count: number;
    credit_count: number;
    total_amount: number;
};

// ─── Créé par (who keyed a quote or invoice in, not who sold it) ──────────────
//
// Zoho Books stores two different people on a document: the salesperson, who
// owns the sale, and the creator, who typed it in. Everything else in this app
// reads the salesperson. This module reads the creator.
//
// These numbers deliberately do NOT reconcile with the rep figures elsewhere. A
// quote created by Morgane and sold by Dominic is counted here under Morgane and
// on the Factures dashboard under Dominic. That is what Jérémi warned about in
// the 2026-09-04 meeting - "faut pas que ça fausse les chiffres" - and the
// agreed answer was a separate page, never a column on an existing table.

/** get_creator_summary - one row per person who has created a quote or invoice. */
export type CreatorSummaryRow = {
    creator: string;
    quotes_created: number;
    // Quotes that actually reached a client: sent, accepted, invoiced, declined,
    // expired. Drafts are counted in quotes_created but never shown to anybody,
    // so they are not a lost opportunity. This is win_rate's denominator.
    quotes_sent: number;
    quotes_won: number;
    quotes_amount: number;
    quotes_won_amount: number;
    invoices_created: number;
    invoices_amount: number;
    // null when nothing was sent — no rate to show, which is not a rate of zero.
    win_rate: number | null;
};

/** get_creator_detail - quotes and invoices in one list. `sold_by` is the point:
 *  it is routinely somebody other than the creator. */
export type CreatorDetailRow = {
    module: 'devis' | 'factures';
    doc_number: string | null;
    doc_date: string | null;
    client_name: string | null;
    department: string;
    office: 'QC' | 'MTL' | null;
    sold_by: string | null;
    status: string;
    amount: number;
    is_avoir: boolean;
};

/**
 * get_quote_creator_link_status - progress of the quote back-fill.
 *
 * Quotes only. Invoices need no back-fill: Zoho puts `created_by` on the invoice
 * list payload, while an estimate's creator exists only on the detail endpoint
 * and only as an id, which is one API call per quote.
 */
export type QuoteCreatorLinkStatus = {
    quotes_total: number;
    quotes_linked: number;
    quotes_pending: number;
    quotes_error: number;
    invoices_total: number;
    invoices_linked: number;
    distinct_creators: number;
};

/**
 * get_unmapped_department_summary - records Zoho sent under a department name
 * the sync does not recognise.
 *
 * Expected to be empty. A row means the money is safely stored but missing from
 * every per-department figure until the label is added to DEPT_MAP in both
 * zoho-invoice-sync and zoho-sync. This alert is how EVENEMENT was found: 160
 * invoices and $142,918 that the sync had been discarding since May 2025.
 */
export type UnmappedDepartmentRow = {
    module: 'devis' | 'factures';
    zoho_label: string;
    record_count: number;
    total_amount: number;
    first_seen: string | null;
    last_seen: string | null;
};

/**
 * get_account_contacts - the people at one company.
 *
 * Shown only on the Comptes detail modal, and counted nowhere. The Comptes
 * module measures companies on purpose; this exists because once someone has
 * found the company, "who do I call" is the next question.
 */
export type AccountContactRow = {
    zoho_record_id: string;
    stage: 'lead' | 'contact';
    full_name: string | null;
    email: string | null;
    phone: string | null;
    rep_name: string | null;
    lead_status: string | null;
    created_time: string | null;
    zoho_crm_url: string | null;
};

// ─── Publicité (Google Ads + Meta) ────────────────────────────────────────────
//
// Channel-level spend against the revenue of the CRM accounts attributed to each
// channel, by month of account creation. Ratios are null when their denominator
// is zero. `window_ends_on` is the date the period's attribution window closes;
// null when the window is uncapped.

/** Same string as `ad_spend_daily.platform`. */
export type AdChannel = 'google' | 'meta';

/**
 * get_ad_performance - one row per channel the view counts: both in the paid and
 * organic views, Google alone in the "inconnu" view, and only the channels of
 * the selected sources when a source filter is set.
 *
 * `cost_per_account`, `cost_per_client`, `roas` and `net` are also null when the
 * accounts are narrowed by rep, service, domain or region: spend cannot be
 * narrowed the same way, so there is nothing honest to divide.
 */
export type AdPerformanceRow = {
    channel: AdChannel;
    /** origine_du_client values counted as this channel. */
    sources: string[];
    currencies: string[];
    spend: number;
    impressions: number;
    clicks: number;
    platform_conversions: number;
    platform_leads: number;
    accounts_created: number;
    accounts_invoiced: number;
    revenue_attributed: number;
    revenue_lifetime: number;
    revenue_per_account: number | null;
    cost_per_account: number | null;
    cost_per_client: number | null;
    roas: number | null;
    /** Null when the period has no accounts tagged to the channel. */
    net: number | null;
    days_with_spend: number;
    window_ends_on: string | null;
    /** Creation date of the first account ever tagged with this channel's origin. */
    source_first_used: string | null;
    /** The view only counts accounts created on or after this date. Null: no lower bound. */
    cohort_from: string | null;
    /** The view only counts accounts created before this date. Null: no upper bound. */
    cohort_before: string | null;
};

/**
 * get_ad_filter_options - the values the Publicité filters offer, drawn from the
 * accounts the current view counts in the selected year.
 */
export type AdFilterOptions = {
    sources: string[];
    services: string[];
    reps: string[];
    domaines: string[];
    regions: string[];
    /** Every ad account spend was imported from. Missing on a database older than the filter. */
    ad_accounts?: AdAccountOption[];
};

/** An ad account. `name` is null until a sync has read it from the platform. */
export type AdAccountOption = {
    platform: AdChannel;
    id: string;
    name: string | null;
};

/** get_ad_monthly - one row per channel per month, all 12 months present. */
export type AdMonthlyRow = {
    channel: AdChannel;
    month: number;
    spend: number;
    platform_conversions: number;
    accounts_created: number;
    accounts_invoiced: number;
    revenue_attributed: number;
    revenue_per_account: number | null;
    cost_per_account: number | null;
    roas: number | null;
    window_ends_on: string | null;
    source_first_used: string | null;
};

/** Campaign status normalised across platforms (ad_campaigns.status). */
export type AdCampaignStatus = 'active' | 'paused' | 'removed' | 'unknown';

/** get_ad_campaigns - platform-reported figures per campaign; no revenue. */
export type AdCampaignRow = {
    platform: AdChannel;
    ad_account_id: string;
    campaign_id: string;
    campaign_name: string | null;
    /** Current status from the platform's campaign list. */
    status: AdCampaignStatus;
    /** Raw platform value, e.g. ENABLED or ARCHIVED. */
    platform_status: string | null;
    currency: string | null;
    /** Unrounded, so the table total equals the channel total. */
    spend: number;
    impressions: number;
    clicks: number;
    conversions: number;
    leads: number;
    cpc: number | null;
    cpm: number | null;
    cost_per_conv: number | null;
    first_date: string | null;
    last_date: string | null;
};

/** get_ad_spend_status - sync coverage per platform. */
export type AdSpendStatusRow = {
    platform: AdChannel;
    ad_accounts: string[];
    currencies: string[];
    campaigns: number;
    first_date: string | null;
    last_date: string | null;
    days: number;
    total_spend: number;
    last_synced: string | null;
};

/** get_invoice_list - every stored invoice and credit note, one page at a time. */
export type InvoiceListRow = {
    zoho_id: string;
    invoice_number: string | null;
    invoice_date: string | null;
    client_name: string;
    /** Before tax; negative on a credit note. */
    amount: number;
    /** Zoho's shipping charge before tax, already inside `amount`. */
    shipping_charge: number | null;
    rep_name: string | null;
    /** NULL when Zoho's label has no mapping, or there is none. */
    department: string | null;
    zoho_department_label: string | null;
    office: 'QC' | 'MTL' | null;
    status: string;
    is_avoir: boolean;
};

/** get_quote_list - every stored quote, any status, one page at a time. */
export type QuoteListRow = {
    zoho_id: string;
    quote_number: string | null;
    /** When the quote was issued. */
    quote_date: string | null;
    accepted_date: string | null;
    client_name: string;
    amount: number;
    rep_name: string | null;
    department: string | null;
    zoho_department_label: string | null;
    office: 'QC' | 'MTL';
    /** NULL when the sync did not recognise Zoho's status; zoho_status holds it. */
    status: string | null;
    zoho_status: string | null;
};

/** One page of a document list, with the size and total of the whole filtered set. */
export type DocumentListPage<T> = {
    total_count: number;
    total_amount: number;
    rows: T[];
};

/** get_document_list_options - the years and rep names in one table. */
export type DocumentListOptions = {
    years: number[];
    reps: string[];
};

/** One row of the "Tous les devis" list: a quote of any status, straight from `sales`. */
export type AllQuoteRow = {
    zoho_id: string;
    quote_number: string;
    client_name: string;
    rep_name: string;
    department: string;
    zoho_department_label: string | null;
    office: 'QC' | 'MTL';
    status: 'draft' | 'sent' | 'accepted' | 'invoiced' | 'declined' | 'expired' | null;
    amount: number;
    quote_date: string | null;
    sale_date: string | null;
};
