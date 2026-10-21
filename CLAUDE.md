# CLAUDE.md 

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Affichez-App-Vente** is an internal sales performance dashboard for Affichez, a Quebec-based advertising company. It visualizes sales data (revenue, deals, reps, departments) from a Supabase backend. The frontend is a React + TypeScript + Vite SPA inside the `frontend/` directory.

The frontend has no server of its own — it reads directly from Supabase via `@supabase/supabase-js`, using PostgreSQL RPC functions and direct table queries. Real-time updates are handled via Supabase Realtime channels subscribed to the `sales` table. Writes into Supabase come from the Deno edge functions in `supabase/functions/`, which pull from Zoho on a schedule (see **Zoho Sync** below).

## Development Commands

```bash
cd frontend

# Install dependencies
npm install

# Start development server (port 5173)
npm run dev

# Type-check and build for production
npm run build

# Lint
npm run lint

# Preview production build
npm run preview
```

## Environment Variables

Create `frontend/.env`:
```bash
VITE_SUPABASE_URL=       # Supabase project URL
VITE_SUPABASE_ANON_KEY=  # Supabase anonymous key
```

The app throws at startup if either variable is missing (see `src/lib/supabase.ts`).

## Architecture

### Data Layer
All data flows through `src/lib/supabase.ts` (the singleton Supabase client). Pages call either:
- **`cachedRpc('function_name', params)`** from `src/lib/rpcCache.ts` — for analytics (KPIs, summaries, leaderboards, YoY). **Not `supabase.rpc` directly**; see Performance below.
- `supabase.from('table').select(...)` — for CRUD in Settings (reps, objectives, quarters, webhook_log). Deliberately uncached: a stale row after a write is a bug, not a saving.

There is no service layer abstraction; Supabase calls are made directly inside page components using `useCallback`-wrapped async functions. Real-time subscriptions (Supabase Realtime) are set up in `useEffect` and cleaned up on unmount.

### Access: the user list, then sections

`allowed_users` is the whole access model (migrations `20261001130000_section_access.sql`
and `20261002090000_section_row_access.sql`). Two roles, `admin` and `member`, and
five section flags; there is no third role.

**1. Not in the list, no access.** `zoho-auth` gives a session only to an address
that has a row; the `@affichez.ca` auto-registration is gone. A session without a
row (someone removed from the list, an old sign-in) reads **zero rows from every
table**: each table in `public` carries a RESTRICTIVE policy `listed_users_only`
(`app_is_listed()`), which is ANDed with the table's own policies. The app shows
`AccessDenied` instead of the routes.

> A table created after that migration needs the same policy, and a read policy
> naming the sections that may read it (rule 2 below). Nothing adds either
> automatically, and without them the new table is readable by any session.

Identity is the email in the session token, so two more things hold it up:

- **A session opened with a password is refused** (`app_session_trusted()`, used
  by `app_is_listed`, `app_can_access` and `app_is_admin`). The Zoho sign-in
  issues a one-time link and never sets a password; Supabase's public sign-up
  endpoint would otherwise let anybody register a listed address with a password
  of their own before its owner first signs in. Turning sign-ups off in the
  Supabase dashboard closes the same door one layer earlier.
- **A SECURITY DEFINER function bypasses RLS**, so each one that returns data
  refuses the wrong API caller itself: `get_sales_team` and `tasks_visible_reps`
  an anonymous or unlisted one, the three Publicité RPCs anyone without the
  section (`app_require_section('publicite')`, first statement of the body, which
  raises 42501 and reaches the browser as a 403). Write a new one the same way,
  or make it SECURITY INVOKER.
- **An edge function is reachable with the anon key**, which ships in the
  frontend bundle. One that returns data checks its caller: `get-zoho-users`
  (the Zoho user directory behind the "add user" picker) asks `app_is_admin()`
  with the caller's own session token and answers 403 to anything else. The
  sync functions return counts only and are not gated.

**2. A member opens the sections ticked for them** in Paramètres → Utilisateurs.
One boolean column each, listed once in `src/lib/sections.ts`:

| flag | section | default |
|---|---|---|
| `can_access_devis` | Devis | true |
| `can_access_factures` | Factures | false |
| `can_access_comptes` | Comptes | false |
| `can_access_publicite` | Publicité | false |
| `can_access_portail` | Mon Portail | true |

An admin has all five whatever the columns say. Notre équipe and Administration
have no flag: admin-only. An "ads manager" is a member with only Publicité ticked.

**A flag locks the data, not only the screens.** Each table is readable by the
sections that have a screen on it and by nobody else; the policies call
`app_can_access('<section>')` or `app_can_access_any('<a>', '<b>')`:

| table | read in full by | own rows only |
|---|---|---|
| `sales` | Devis | Mon Portail |
| `invoices` | Factures, Comptes | Mon Portail |
| `zoho_leads` | Comptes, Mon Portail | |
| `zoho_accounts` | Comptes | |
| `ad_spend_daily`, `ad_campaigns` | Publicité | |
| `objectives` | Devis | |
| `objectives_factures` | Factures | |
| `rep_objectives`, `rep_objectives_dept` | Devis, Factures | Mon Portail |
| `excluded_clients`, `excluded_reps` | Devis, Factures, Mon Portail | |
| `fiscal_quarters` | Devis, Factures | |
| `zoho_books_customers` | Factures | |
| `zoho_tasks`, `webhook_log`, `zoho_books_users`, `department_mappings`, `leads`, `meta_audience_log` | admins | |

"Own rows" is `rep_name = app_portal_rep()`: the caller's `rep_name`, and only
while Mon Portail is ticked. Every portal screen already filtered on that name,
so a rep's figures are the same rows as before. Four things in that table are
deliberate and easy to "tidy" into a bug:

- **Mon Portail also reads the invoices of the accounts the rep holds a lead or
  contact on**, whoever sold them. Mes Leads totals revenue per account, and an
  invoice belongs to an account. Without that clause the "facturé" figures drop
  to the rep's own invoices, silently.
- **`zoho_leads` is not cut down to own rows.** `zoho_leads_unique` hides a
  converted lead behind the contact it became, and that contact can belong to
  another rep; with only their own rows a rep's list would grow leads that are
  hidden today.
- **Comptes reads `invoices` in full**: its detail screen opens any account's
  billing history. Publicité reads neither `invoices` nor `zoho_accounts`: its
  three RPCs are SECURITY DEFINER and return aggregates only.
- **The invoices policy reads `rep_name` on every row**, so the covering index
  the Comptes RPCs scan carries it (`invoices_crm_account_cover2_idx`). Take the
  column out and every account lookup pays a heap fetch: 56 → 90 ms measured.

> **A hidden table does not raise an error inside an RPC, it changes the result.**
> A caller who cannot read `excluded_clients` gets totals with the excluded
> clients counted in; one who cannot read `objectives` gets a target of 0. When
> a screen starts reading a table, add its section to that table's policy in
> the same release, and check as a member, not as an admin.

**Settings are written by admins only**, in the database too: `objectives`,
`objectives_factures`, `rep_objectives`, `rep_objectives_dept`, `excluded_clients`,
`reps` and `leads` have one write policy (`<table>_admin_all`) and the restrictive
`admin_*_only` policies on top.

`AuthContext` reads the user's own row with `select('*')` and exposes `access`
(`granted` / `denied` / `error`), `isAdmin` and `sections`. `App.tsx` builds the
routes from `sections`; a URL outside them falls to the catch-all and lands on
`homePathFor(sections)`, the first section the person can open. When you add a
section: a column, a line in `SECTIONS`, a `WHEN` in `app_can_access` and a line
in `app_can_access_any`, the read policies of the tables its screens use, the
route and the nav entry.

### Filters take several values

Every category filter with more than two values is a `MultiSelect`
(`src/components/MultiSelect.tsx`): rep, department, invoice status, source,
service, domain, region, campaign status. Year, month, week and window stay
single (they are periods), and so do the two-value filters (Siège, devis status,
the Statut scope), where ticking both would only mean "all".

- **State** is `useUrlList(key)`: a repeated URL param (`?rep=A&rep=B`). An empty
  list is "no filter", and there is no "Tous" value any more; a link from before
  the change (`?rep=A`, `?dept=Toutes`) still reads correctly.
- **RPCs take a list beside the scalar they already had** (`p_depts`, `p_statuses`,
  `p_sources`, `p_services`, `p_domaines`, `p_regions`, `p_reps`). The scalar
  parameters still work, and the two forms AND together. New parameters are
  appended, so a function gaining one is `DROP` + `CREATE`, never an overload:
  two signatures for one name make PostgREST refuse the call (PGRST203).
- **Objectives follow the selection.** Several departments: the objectives of
  those departments. Several reps: `p_target_reps`, the sum of their own
  objectives, sent by `useRepFilter` only when every selected rep is on the sales
  team. A selection that includes "Interne" has no objective, like Interne alone.
- **A breakdown ignores its own dimension** in both forms (`get_zoho_accounts_by_source`
  does not receive the source selection), so the table keeps every bar. The by-rep
  table is the one exception it always was: a single rep leaves it whole, a list
  (Interne, or several reps) narrows it to its members.
- Lists are sent in option order, so the same selection is the same cache key.

### Read this before you write a statistic

**No table in this app contains what its name says.** Each sync applies a filter,
and the filter lives thousands of lines away from the SQL that aggregates it, so
it is invisible from the query. The one that has already produced a wrong number
on screen:

> **`sales` holds only quotes that were WON.** `accepted` and `invoiced`, plus
> `declined` *only when the quote was accepted first*. Quotes that were sent,
> drafted or expired are **never written at all** — the sync inserts only on
> `accepted`/`invoiced`/`paid` (`zoho-sync/index.ts:316`) and merely PATCHes
> existing rows on decline (`:343`). Verified: 8,085 rows, 0 of them `sent`,
> `draft` or `expired`; Zoho's QC org alone holds 3,000+ expired and 1,500+
> declined that the database has never seen.

So **you cannot compute a closing rate, win rate or conversion rate from
`sales`** — the losing quotes are not in there. The Créé par page's `Taux` shows
92% for this reason; the real figure is at most ~58%. Fixing it means changing
the sync, not the SQL.

Before adding or changing any statistic, the non-negotiables:

1. **Prove the denominator population.** `GROUP BY status` on the source table
   and confirm every outcome you divide by is actually present.
2. **Narrow numerator and denominator on the same dimensions.** `objectives` and
   `objectives_factures` have no `office` column, so filtering the dashboard by
   office narrows the actuals and leaves the target company-wide — QC currently
   reads 46% when it is measured against the whole company's number.
3. **One cohort per ratio.** "Created in period" and "closed in period" are
   different row sets (this is live in `get_tasks_kpis`, which can exceed 100%).
4. **Count the same thing all over one page.** The Factures KPI card excludes
   credit notes; the Sommaire table under it does not.
5. **An inner join to `fiscal_quarters` or `objectives` is a filter.** Unmatched
   rows vanish silently — `fiscal_quarters` only covers 2025–2026, which is why
   YoY for 2025 reports last year as $0 against 1,868 real 2024 sales.
6. **Never `NOT IN` a nullable subquery.** One NULL in the subquery makes the
   predicate NULL for every row and zeroes the dashboard with no error. The
   existing exclusion tables are safe — their columns are `NOT NULL` — so give any
   new one the same constraint rather than rewriting the 34 call sites.
7. **Verify against Zoho, not against our mirror.** The database is a filtered
   copy; the filter is usually the bug.

Full audit, evidence, live-verification commands, and the list of things already
checked and found sound: **[STATS-INTEGRITY.md](STATS-INTEGRITY.md)** (kept at the
repo root on purpose — `docs/` is gitignored, so nothing filed there survives a
clone). Read it before touching any RPC that aggregates.

### Performance: four rules that are easy to undo by accident

Measured 2026-09-15. The Comptes RPCs averaged 1.2–2.7 s each and the page fires
seven of them; `get_tasks_weekly` averaged 2.6 s. None of it was data volume —
the largest table is 62k rows. After the fixes below the same queries run in
15–90 ms. Each rule is one line away from being reverted, and reverting it
fails silently.

**1. A `LANGUAGE sql` helper must not carry `SET search_path`.** Postgres
refuses to inline a SQL function whose `pg_proc.proconfig` is non-NULL, and an
un-inlined function is a `Function Scan`: the caller's predicates and indexes
cannot reach the table, so the whole table is read every time. That single
clause on `zoho_accounts_scoped` was costing 3× on every Comptes screen.

`SET search_path` protects SECURITY **DEFINER** functions, which run as their
owner. These are SECURITY INVOKER — they already run with the caller's
privileges, so a poisoned search_path gains the caller nothing. The bodies are
schema-qualified anyway. Keep the SET clause on SECURITY DEFINER functions
(`tasks_visible_reps`, `refresh_zoho_service_labels`); never add it back to the
invoker helpers. A guard query:

```sql
SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proconfig IS NOT NULL AND p.prosecdef = false
  AND p.proname LIKE ANY (ARRAY['zoho_%', 'ad_%']);   -- must return zero rows
```

**2. Filter dates with a RANGE, never `EXTRACT(... FROM col)`.** Wrapping the
column in a function makes the predicate unservable by any btree index on it.
`EXTRACT(YEAR FROM created_time AT TIME ZONE 'America/Toronto') = p_year` is
exactly `created_time >= make_timestamptz(p_year,1,1,0,0,0,'America/Toronto')
AND created_time < make_timestamptz(p_year+1,…)`, and only the second form uses
`zoho_accounts_created_idx`. Same for ISO years on `zoho_tasks`: ISO year Y is
`[date_trunc('week', make_date(Y,1,4)), date_trunc('week', make_date(Y+1,1,4)))`.

**3. `zoho_service_labels` is a MATERIALIZED view.** As a plain view it
seq-scanned `zoho_leads`, `zoho_accounts` and `invoices` — 30,208 rows sorted —
to produce **15**, at 354 ms a call, and four RPCs join it. `cron.schedule`
refreshes it every 10 minutes (`refresh-zoho-service-labels-10m`). The cost is
staleness: a service Zoho has never billed or quoted before shows its raw
spelling and is missing from the Service filter until the next refresh. If you
add a sync that can introduce a new service, call
`public.refresh_zoho_service_labels()` at the end of it.

**4. A refetch must invalidate the cache first.** `cachedRpc` holds results for
60 s (10 min for filter options and week lists) and de-duplicates in-flight
requests, which is what makes navigation instant — a round trip between two
dashboards issues **zero** network requests. It also means a Realtime handler
that calls `fetchData()` without `invalidateRpcCache()` is answered out of the
entry the event says is stale, and the page looks refreshed while showing old
numbers. Every Realtime handler, every "Actualiser" button, the post-sync status
read in Settings and `signOut` already call it — keep it that way when adding
more. `cachedRpc` deliberately never serves stale data: past the TTL it waits
for the real answer, because a revenue total that silently changes a second
after someone reads it is worse than one that took a second to arrive.

**Routes are lazy** (`React.lazy` in `App.tsx`), so first paint carries a 147 kB
gzip core plus a 2–8 kB screen instead of one 216 kB bundle. `src/lib/prefetch.ts`
warms both the chunk and the screen's first query on nav-link hover, so add new
routes to `ROUTE_CHUNKS` there when you add them to `App.tsx`.

**Where the time actually goes.** Per-request overhead to Supabase is ~25 ms
from Montreal and dominates the query itself for the fast screens —
`get_dashboard_kpis` runs in 0.6 ms. So *the number of requests matters more
than the cost of each*, which is why the cache and the prefetch are worth more
than further SQL tuning. The project is in **us-east-1**; anyone measuring from
elsewhere will see a much larger fixed cost that the Quebec users do not.

### Zoho Sync (Supabase Edge Functions)

`supabase/functions/` holds the Deno edge functions that pull from Zoho; the React
app only ever reads what they have written. Two different Zoho products are
involved and they do not share ids or credentials:

- **Zoho Books** (`zoho-sync`, `zoho-invoice-sync`, `zoho-quote-creator-sync`) —
  two organisations, QC and MTL, feeding `quotes` and `invoices`. Verified
  2026-09-07 against `GET /books/v3/organizations`: those two are **the only**
  orgs the token can see, so the Royer & Fils revenue below is not reachable
  through these credentials at all.
- **Zoho CRM** (`zoho-lead-sync`, `zoho-task-sync`, `zoho-account-sync`) — one
  org, feeding `zoho_leads`, `zoho_tasks` and `zoho_accounts`.

`zoho-account-sync` needs `ZohoCRM.modules.accounts.READ` on top of the leads,
contacts and users scopes the shared CRM refresh token was issued with. It was
missing at first; **verified present on 2026-09-07**. Without it every page 401s
and the walk upserts nothing while still reporting success, so re-check before
blaming anything else:

```
curl.exe -H "x-check-scope: true" https://auyfucbskylougsmmrks.supabase.co/functions/v1/zoho-account-sync
```

**A field added to a sync reaches old records only through a full walk.** The
syncs are incremental on Modified Time, so a record nobody edits is never read
again. Since 2026-10-07 `zoho-lead-sync` reads Mobile, Secondary_Email, Title
(`Designation` on Leads), Langue, Email_Opt_Out, Unsubscribed_Mode and, on
Contacts, the "Ne veut pas recevoir nos courriels marketing" and "Email de masse
non remis" checkboxes; `zoho-account-sync` reads the Shipping_* address. Their
columns stay NULL until `scripts/zoho-crm-full-sync.sh` has run once after the
deploy. Deploy the migration before the functions (CI does, in that order): a
payload naming a column that does not exist makes every upsert fail.

**Zoho can leave a requested field out without an error.** On Contacts, the sync's
login never gets `Email_Opt_Out` back (absent on 200 of 200 on 2026-10-07), while
`Unsubscribed_Mode` is always there and set exactly on unsubscribed records; on
Leads the two always agree. `email_opt_out` is therefore "either one says yes"
(`emailOptOut()`). Before trusting a new field, fetch a few records with the
sync's own token and check the field is actually in the response, not just that
the request succeeded.

### Who created a document, vs who sold it

Zoho Books stores two different people on a quote or invoice: the **salesperson**
(who owns the sale) and the **creator** (who typed it in). Everything in the app
reads the salesperson except `/createurs`, which reads the creator — asked for so
Morgane Owczarzak's and Guillaume Montambeault's admin work is visible even when
the sale is credited elsewhere.

The two modules give it away very differently (verified 2026-09-07):

- **Invoices** — `created_by` is a NAME on the list payload. Free.
- **Estimates** — no creator on the list at all; the detail endpoint has only
  `created_by_id`. One API call per quote, resolved through `zoho_books_users`
  (150 users). That is what `zoho-quote-creator-sync` is for: a paced, resumable
  back-fill over 7,961 quotes, cron every 3 min until `pending` hits zero.

`zoho-sync` deliberately omits `created_by_name` from its upsert. PostgREST's
merge-duplicates only touches columns present in the payload, so a routine quote
re-sync cannot wipe a name the back-fill paid an API call for.

**These figures never reconcile with the rep numbers, by design.** A quote created
by Morgane and sold by Dominic counts once under each. `/createurs` is admin-only
and says so on screen; never add its totals to a leaderboard.

### `amount` is Zoho's total minus Zoho's tax — never an estimate

Until 2026-10-19 every sync stored `amount = total / 1.14975`. Audited against
the live Books API that day (750 documents, three reps' complete 2026): untaxed
invoices came out 13% low, invoices with fees drifted by dollars, most were a
cent off — and commissions are paid on `amount`.

The rule now, for `invoices` (credit notes included, negative) and `sales`:

- **`amount = total_incl_tax − tax_total`**, derived by the
  `zoho_pretax_amount` trigger. **Shipping and fees stay in** — commission is paid
  on them (QC-022298: $3,050 goods + $312.15 shipping = $3,362.15). That is why
  Zoho's `sub_total`, which drops shipping, is not used.
- The list endpoints carry `total` but **no tax**; `tax_total` is on the detail
  payload only. So the syncs write `total_incl_tax` (never `amount`), and the
  tax arrives from a detail read: immediately for anything `zoho-invoice-sync`
  just wrote, and from **`zoho-pretax-sync`** (cron every 2 min, quota-aware,
  newest first) for everything else, quotes included.
- `tax_checked_total` is the total the tax was read against. When Zoho's total
  changes, the row falls back to the estimate and re-queues instead of pairing a
  new total with an old tax. `get_pretax_backfill_status()` reports progress.
- **Never write `amount` from a sync again.** Leaving it out of the payload is
  what stops a list re-sync overwriting an exact figure.

Zoho Books' daily API allowance is **50,000 calls for QC and 10,000 for MTL**
(`x-rate-limit-*` response headers); the back-fill stops an org once less than
30% is left.

### Deleted and voided documents leave the table

Nothing in Zoho reports a deletion, so the incremental sync never saw one: on
2026-10-19, 28 documents deleted in Zoho and 5 voided ones were still counted
(net −$5,469, mostly credit notes). `zoho-invoice-sync` with `x-reconcile: true`
now runs hourly per office (`zoho-invoice-reconcile-{qc,mtl}-1h`): it lists every
document from January of last year, rewrites rows that disagree with Zoho, and
removes rows Zoho deleted or voided — each removal confirmed by a detail read,
never inferred from the list, and skipped entirely if more than 50 go missing at
once. A voided document is deleted rather than set to `void`, because not every
RPC filters on status.

Statuses were audited at the same time and were right: all 4,412 documents of
2026 matched Zoho. A payment does reach the 5-minute incremental sync.

### The syncs no longer discard records silently

`zoho-invoice-sync` and `zoho-sync` used to `continue` past any record whose
department wasn't in `DEPT_MAP` — no error, no log, nothing on screen. On
2026-09-07 that was changed to land the row with a NULL `department`, keeping
Zoho's raw label, surfaced by `get_unmapped_department_summary` in Settings.

It found sixteen months of missing money on the first run:

- **`ÉVÈNEMENT`** — a real seventh department Zoho Books had been billing under
  since 2025-05-29. 160 invoices, $142,918, none of which had ever reached the
  app. Now `EVENEMENT` in `department_enum`, `DEPT_MAP` and `DEPARTMENTS`.
  `objectives_factures` has no target rows for it yet.
- **92 credit notes, -$117,764** across 2025-26 whose department could not be
  resolved from `reference_number`. Dominic's diagnosis in the 2026-09-04
  meeting — *"on n'inclut pas les crédits, les avoirs"* — was correct.

A full sync with `x-date-start: 2021-01-01` also pulled in ~4,000 invoices from
2021-22 that the old window had never covered. They are kept; they carry no
department because Zoho has none on them.

Four Zoho API quirks are worth knowing before touching `zoho-invoice-sync`:

- Books list endpoints filter dates with `date_start` / `date_end`. The dotted
  form `date.start` is accepted and **silently ignored**.
- `date_start` and `filter_by` are mutually exclusive — send both and the date
  range is dropped without an error. **`zcrm_account_id` behaves the same**
  (verified 2026-10-13): alone it returns exactly one CRM account's estimates or
  invoices; with `filter_by=Status.OverDue` beside it, the whole org's overdue
  list comes back. `customer_id` + `filter_by` does filter.
- **Books turns an invoice overdue without changing its `last_modified_time`**,
  so the incremental sync never re-reads it and the row stays `sent`. Measured
  2026-10-13: 63 of Books' 201 overdue invoices were `sent` here. The sync
  therefore re-reads `filter_by=Status.OverDue` at most once an hour
  (`reconcileOverdue`, pointer `sync_state.invoices_overdue`; `x-overdue-check:
  true` forces it) and reads back, one by one, any row it holds as overdue that
  Books no longer lists. Payments do modify the record, so the reverse drift
  does not happen through the normal path.

### Invoices on a lead or contact

An invoice belongs to a CRM **account**, never to a person, so every contact at a
company shows the same invoices. Zoho Books only links its customers at account
level (`zcrm_account_id`), so this is the real grain of the data, not a shortcut.

The chain, resolved right to left because that is the cheap direction — 14k
invoices name only ~3.1k customers, against ~20.6k CRM accounts:

```
zoho_leads.account_id ◀── Contacts.Account_Name.id   (zoho-lead-sync)
        ▲
        │ = invoices.crm_account_id
        │
zoho_books_customers.crm_account_id ◀── Books contact.zcrm_account_id
        ▲                                (zoho-books-customer-link)
        │ = invoices.books_customer_id ◀── Books invoice.customer_id
        │                                 (zoho-invoice-sync)
```

`zoho_books_customers` holds only customers that appear on an invoice, so a client
that has been quoted but never billed has no row there; to reach a CRM account's
quotes, ask Books with `zcrm_account_id` instead (`account-summary` does both).
It is a cache of the one hop that costs an API call, filled a
slice at a time under Zoho's 100-calls/minute/org limit by the
`zoho-books-customer-link` function (cron, every 30 min). Two triggers keep
`invoices.crm_account_id` in step in both directions, so neither sync needs to
know about the other. `get_lead_invoice_totals` / `get_lead_invoices` back the
Factures column and modal on the Leads page; `get_invoice_linkage_status` reports
back-fill coverage in Settings.

### Comptes: the account is the record

The **Comptes** module (`/comptes`, `/comptes/detail`) is the primary funnel view
and replaced the Leads pages on 2026-09-07. It is open to admins and to members
with the **Comptes** section (see **Access** above). Its grain is the Zoho CRM
**account**, because that is the grain the business is run in: a company with
three contacts is one account, so its revenue is counted once with no dedupe layer.

**Restricted at the row level, not just in the nav.** `zoho_accounts` carries a
SELECT policy on `app_can_access('comptes')`, so anyone else reading it through
PostgREST gets zero rows rather than the client list. The Comptes RPCs are
SECURITY INVOKER and follow that policy; `zoho_accounts_enriched` is
`security_invoker=true` and follows the table. The section also reads `invoices`
and `zoho_leads` in full, which its detail screen shows account by account (the
table under **Access** has every reader). The syncs write with the service role
and bypass RLS.

### Comptes · Détail: amount filter, exports, Meta audiences

Migration `20261007120000_account_spend_and_contact_reach.sql`, function
`meta-custom-audience`.

- **"Montant facturé"** filters accounts on what they were billed, net of credit
  notes, over a period: `revenue_lifetime`, `revenue_12m`, `revenue_ytd`,
  `revenue_prev_year`, `revenue_last_month`, `revenue_30d` on
  `zoho_accounts_enriched`, on Montreal's calendar. The filter is a plain
  PostgREST `gte`/`lte` on one of those columns, so the table, its count, the
  popover's live count, both exports and the audience read the same accounts
  (`buildQuery` in `AccountsDetail.tsx`). Filtered by amount, the list sorts by
  that amount. The slider is a ladder of round values (`spendRange.ts`), because
  half the invoiced accounts are under 2 k$ and one is near 5 M$; its top comes
  from `get_account_spend_max` and the end of the track means "no maximum".
- **The period bounds sit behind `OFFSET 0`** in the view. Without it the planner
  flattens the one-row "today" subquery and re-evaluates `now() AT TIME ZONE` for
  every bound on every invoice row: the default page went from 47 to 88 ms.
- **Export** offers "Comptes seulement" and "Comptes et contacts": each account
  followed by its contacts, amounts on the account line only. Both read in pages
  of 1,000, the API's row cap; one large `range()` silently stops at 1,000.
  `get_accounts_contacts` returns contacts only (a converted lead is already its
  contact) with the account's postal address, `mail_*`: the shipping block when it
  has a street, city or postal code, the billing block otherwise. Contacts have no
  address of their own in this org.
- **"Audience Meta"** (Comptes and Publicité both, `app_can_push_meta_audience`)
  sends the account ids to `meta-custom-audience`, which reads the contacts with
  the caller's token, normalises and SHA-256 hashes email, phone, names, city,
  province, postal code and country (`normalize.ts`), creates a customer-list
  audience on the ad account chosen in the dialog and uploads in one session.
  The accounts on offer are `META_AUDIENCE_AD_ACCOUNT_ID` (a comma-separated
  list, default first), else every account in `META_AD_ACCOUNT_ID`: today
  Affichez and La boutique Promo. The function refuses an id outside that list,
  and `meta_audience_log.ad_account_id` records where each audience went. **The
  dialog sends every contact with an email or a phone, marketing refusals
  included** (`exclude_opted_out: false`, a business decision). The function
  still honours the flag for another
  caller, and without it leaves out any contact whose `email_opt_out` or
  `no_marketing` is not `false` (NULL counts as a refusal). A list holding any
  acquired-list account (`is_bulk_import`) is declared
  `BOTH_USER_AND_PARTNER_PROVIDED`, otherwise `USER_PROVIDED_ONLY`.
- **The audit row comes first.** `meta_audience_log` (admins read it) gets a
  `pending` row with the contacts about to be sent before anything reaches Meta,
  and is updated to `created` or `failed`; if that first insert fails, nothing is
  sent. It holds who, when, the counts, the page's filters as URL parameters plus
  `recherche` for the search box (`filters`), and the Zoho ids of the contacts
  sent (`contact_ids`, GIN-indexed, ids only), which can only be captured at
  creation. A row still `pending` an hour later was interrupted.
- **CPU, not wall clock, is the limit.** Supabase stops a function at ~2 s of CPU.
  Hashing is synchronous (`node:crypto` `createHash`; WebCrypto's per-value async
  digest was ~4x the cost) and the contacts are read with an explicit `select=`
  (the sort columns must be in it: PostgREST orders the projection). The largest
  possible audience, every client account, measured 0.7 s. Every page loop stops on
  an EMPTY page, not a short one, so a lower server row cap cannot truncate it.
- The create call is retried only on throttling codes, never on a 5xx: a retry
  after a create that did succeed would leave a second, empty audience. The token
  needs `ads_management`, the system user full control of each ad account, and a
  human admin must have accepted the Custom Audience terms on each. Only an explicit
  permission list without `ads_management` blocks the whole dialog. One account is
  greyed out, with the reason, when the system user has no `MANAGE` or `ADVERTISE`
  task on it: Meta then leaves `user_tasks` out, although the account stays
  readable through the business (spend, audience list), and `me/adaccounts` does
  not list it. The terms flag is not shown: Meta's own refusal at create time
  (1870034) is the real test, and the error it returns says the terms must be
  accepted. A fresh acceptance can take a minute to show in `tos_accepted`.
- **Avoid amounts in an audience name.** Meta blocks audiences whose name or
  description suggests financial status, which is why the default name is just
  "Comptes Affichez <date>".

The Leads pages and every `get_zoho_lead*` RPC are still there and still work —
only the routes and nav entries in `App.tsx` / `Layout.tsx` are commented out.
Uncomment them to compare a number against the old grain.

Three things about the Comptes module that are not obvious:

- **Revenue is windowed.** `p_window_months` (default 12) caps attributed revenue
  at N months from the account's creation. Without it a 2021 account beats a 2026
  one purely by having had five more years to buy, and no month-over-month or
  source-over-source comparison means anything. `NULL` lifts the cap.
- **`revenue_per_account` divides by accounts *created*, not accounts invoiced.**
  The accounts that bought nothing are what makes a bad source bad.
- **1,937 accounts are rated "Compte interne : Ne pas reprendre"** and 3
  "Fournisseur" — Affichez's own entities. Every RPC excludes them by default via
  `p_exclude_ratings`; the pages carry a "Statut" filter to switch them back on.
  The detail table filters `zoho_accounts_enriched.is_internal` instead, because
  PostgREST's `rating=not.in.(…)` is NULL — not TRUE — for the 977 unrated rows
  and would silently hide them.
- **Rating is shown in French and filtered on the stored value.** The
  "Évaluation" filter (`?evaluation=`, `p_ratings` on the Comptes RPCs, `rating=in.(…)`
  on the view) ANDs with Statut, which stays a plain switch. `zoho_accounts.rating`
  holds what the sync's English login reads, and five options read differently in
  Zoho's French UI: `Client à reprendre` is "Compte sans représentant associé",
  `Actif` is "Actif : Client avec une tâche de suivi en cours", and so on.
  `src/lib/accountRating.ts` maps one to the other for the dropdown, the detail
  column and the CSV. It copies the fr_FR Translations export of 2026-09-29 and
  nothing syncs it: a French label renamed in Zoho has to be renamed there too.

**Royer & Fils / VotreLogo.ca is a different company's revenue.** Measured
2026-09-07: `SUM(Ventes_totales_2022_2026)` is $5,530,878.34 across all 20,645
accounts and $5,530,878.34 across just the 2,028 whose origin is "Client Royer &
Fils / VotreLogo.ca" — to the cent. That promo business is invoiced outside the
QC and MTL Books orgs, so it never appears in `invoices` (LUMEN: $1.5M in CRM,
zero invoice rows). It is synced into `zoho_accounts.ventes_*` and reported
*beside* the invoice figures, never added into `revenue_attributed` or
`revenue_lifetime`.

**Source values live in one Zoho Global Set, "Origine".** Since 2026-09-29 the
Leads field `Lead_Source` and the Comptes field `Origine_du_client` share that
set: 21 values, identical on both modules and in both languages, and a converted
lead always lands on a real option. Before that day the two fields had drifted
apart, 126 accounts carried words that were not options at all, and five values
showed a different word in French than in English. The rules that keep it that
way: add or merge a value only in the set (Setup → Global Sets → Origine), in an
English session, never rename in one language only, never delete a value records
still hold (Replace it first), and update the SQL literals (`Meta Ads`,
`Google Ads`, `Client Royer & Fils / VotreLogo.ca`, `Client PLOGG/BUCCO`) before
touching those values. `get_zoho_account_filter_options` still reads stored
values rather than the set, so a stray word would show up in the filter within a
day. The pre-cleanup baseline lives in schema `backup` (not served by the API):
`backup.source_baseline` holds every record's value before the merges. It is a
historical record, so later retags and renames show up as differences in
`backup.source_final_check`; that is expected. The sync login (Eva (IA)) must stay
in English: Zoho returns picklist labels in the caller's language, and a French
login once wrote French labels into 135 rows.

**Renaming a value in the set is a relabel, and it has three consequences.** On
2026-10-01 `Publicité/Recherche Google` became `Google Organique` and `Facebook`
became `Meta Organique`. Zoho kept the stored value and changed the label, and
the API returns the label, so: (1) the syncs write the new word from then on,
but a relabel modifies no record, so rows already mirrored keep the old word
until a full walk (`scripts/zoho-crm-full-sync.sh`); (2) any SQL that names the
value literally must change in the same release (here the organic map,
`20261001120000_organic_source_labels.sql`); (3) the new label applies only to
the language of the session that made it, so the other language needs the same
label through Translations → Import, or French and English users read different
words again.

### Publicité: ad spend against revenue

The **Publicité** module (`/publicite`, admins and members with the Publicité section) compares
Google Ads and Meta Ads spend with the revenue of the accounts attributed to each channel. Only
those two channels. Setup and credentials: **`docs/ADVERTISING.md`**.

- **`ad_spend_daily`** holds daily × campaign spend, written only by `ads-spend-sync` (cron every
  4 h). Each run **re-pulls the last 35 days** instead of walking a cursor, because both platforms
  restate recent spend; the PK `(platform, ad_account_id, campaign_id, spend_date)` makes that an
  idempotent upsert.
- **Google is two ad accounts, summed.** `GOOGLE_ADS_CUSTOMER_ID` is a comma-separated list:
  `579-661-3141` (Affichez - GLOBAL/PUB) and `437-363-4595` (Affichez- BOUTIQUE PROMO), both reached
  through the same manager account and both in CAD. Each is stored under its own `ad_account_id`
  and every RPC groups by platform, so the channel figure is their sum. Adding an account does not
  bring in its past: run `scripts/ads-google-backfill.sh` once.
- **Meta is two ad accounts too.** `META_AD_ACCOUNT_ID` takes a list the same way:
  `1124619897926603` (Affichez) and `6342420329119051` (La boutique Promo), both read with the one
  System User token and both in CAD. Past spend comes from `scripts/ads-meta-backfill.sh`, a
  calendar year per call, clipped to the 37 months Meta keeps. **Deploy the function before
  changing either secret**: a build that expects one id reads a list as a single wrong id and every
  scheduled run fails until the new build is live. One account failing is recorded and the others
  still sync; a Meta rate limit stops the whole walk, since every further request would fail the
  same way.
- **The ad-account filters ("Compte Google Ads", "Compte Meta Ads") narrow the spend, not the
  accounts** (`p_ad_accounts` on
  `get_ad_performance` and `get_ad_monthly`, `20261002100000_ad_account_filter.sql`; the campaign
  table applies the same rule in the browser, its rows carry `ad_account_id`). Spend, impressions,
  clicks and days of data follow the selection. Accounts created and revenue do not: they come
  from the CRM source, which does not say which ad account a client came from. The ratios are
  still computed, the channel's accounts against the selected accounts' spend, and the page says
  so; with GLOBAL/PUB alone that is the figure the page showed before the second account existed
  (2026: 0.45 against 0.25 for both). Three rules: the selection **narrows only the platforms it
  names** (one Google account selected leaves Meta whole); a platform with every one of its
  accounts ticked is not narrowed, so those accounts leave the selection, the same as ticking none
  (`narrowingAdAccounts` in `components/advertising/channel.ts`); and a filter is shown only in
  the paid view, for a platform that has several accounts. There is **one dropdown per platform**
  over a single `?compte=` list: one list of every account read as if ticking a Google account
  left Meta out. A platform with exactly two accounts gets a single-choice `Select` (all, one, or
  the other): in a list to tick, ticking the second account made both ticked, which is "all", and
  the selection appeared to be thrown away. From three accounts on it is a `MultiSelect`. One small account alone gives an absurd return (La boutique Promo, 2026:
  66.73), because the whole channel's revenue is held against its spend; the notice says what is
  being compared, and the figure is only as good as the CRM source tagging. The list on offer is read from `ad_spend_daily`; `ad_accounts` only
  holds the names (`customer.descriptive_name`, Meta's `name`), rewritten by the sync on every
  run, so an account with no name yet is offered by its id. The page sends `p_ad_accounts` only
  when something is selected, which is what lets it run against a database without the parameter.
- **Restricted at the row level** (`app_can_access('publicite')` policy on the two ad tables), not
  just hidden in the nav. `get_ad_performance`, `get_ad_monthly` and `get_ad_filter_options` are
  **SECURITY DEFINER**: revenue per channel is built on `zoho_accounts` and `invoices`, which the
  section must not read, so the functions run as their owner, return aggregates, and refuse a
  caller without the section with a 403. `get_ad_campaigns` and `get_ad_spend_status` read the ad
  tables only and stay SECURITY INVOKER (zero rows without the section, not an error).
- **Three views, one page**, all defined in `ad_channel_source_map(p_view)`
  (`20261001150000_ad_views_and_filters.sql`), which returns each source with the creation-date
  range its accounts are taken from:

  | `?vue=` | `p_view` | Google | Meta |
  |---|---|---|---|
  | `payant` | `paid` | `Google Ads` | `Meta Ads` |
  | `organique` (default, `DEFAULT_AD_VIEW`) | `organic` | `Google Organique`, created **from** 2026-10-01 | `Meta Organique` |
  | `inconnu` | `unknown` | `Google Organique`, created **before** 2026-10-01 | none |

  Until 2026-10-01 `Google Organique` (named `Publicité/Recherche Google` before that day) mixed
  organic search, clicks on a Google ad and the 3,336 former `Internet` accounts, and they cannot
  be told apart after the fact. From that date the source is organic only and paid arrivals are
  tagged `Google Ads`. The old accounts are therefore a view of their own and counted in neither of
  the other two. The date lives in `ad_google_organic_since()` and nowhere else, the two Google
  cohorts always add up to the whole source, and the page reads the date from the RPC
  (`cohort_from` / `cohort_before`). Only the paid view has spend; cost, return and net are NULL
  in the other two, and whenever a period has no spend.
- **The account filters narrow accounts, not spend.** Rep, service, domain and region
  (`p_reps`, `p_services`, `p_domaines`, `p_regions`) filter the accounts and their revenue. Spend
  is reported per campaign and cannot be split that way, so with one of them set
  `cost_per_account`, `cost_per_client`, `roas` and `net` come back NULL and the page says why.
  `p_sources` is different: a source is a whole channel, so it selects channels and keeps every
  ratio. `p_organic` is still accepted and keeps its old meaning (`p_organic => true` without
  `p_view` is every `Google Organique` account, no date split), so a browser holding the previous
  build shows what it always showed; `p_view` wins. Drop the parameter in a later migration.
- **Attribution is by channel and month of account creation, never per lead or per campaign** —
  the CRM stores no click identifiers. The campaign table therefore has no revenue column.
- **Origins only exist from a date** (`Google Ads` from its first tagged account, created after
  2026-09-29; `Meta Ads` regularly from 2024-08-21). Google months before that show no accounts and
  no return, by design. `ad_source_first_used()` exposes it; `roas`/`net` are NULL when a
  period has no tagged accounts, and the page warns when a period starts before first use.
- **Campaign status comes from `ad_campaigns`**, refreshed from each platform's campaign list on
  every sync — never from `ad_spend_daily`, whose older rows are not re-synced.
- **Meta insights are requested one calendar month at a time**; a year of daily rows in one request
  fails with HTTP 500. Meta keeps 37 months of data; the API tier is `development_access`.
- **Open cohorts.** A month's revenue keeps accruing until its attribution window closes. Every
  RPC returns `window_ends_on`; `isCohortOpen()` in `components/advertising/channel.ts` marks those
  figures as provisional. Do not remove it — the most recent month is always open.

### AI account summaries: nightly run and model costs

The `account-summary` function writes the "Résumé IA du compte" card behind the Zoho widget
(migrations `20261012180000_account_ai_summaries.sql`, `20261019180000_account_summary_nightly_costs.sql`).
The model is **GLM-5.3 through OpenRouter** at reasoning effort `high`, with a strict JSON schema
(`openrouter.ts`, `model.ts`). Providers are tried in the order Parasail, Fireworks, Nebius, with
`data_collection: deny` and `max_price` at the list price ($1.40 / $4.40 per M), because a provider
slug also matches its dearer `/fast` variant. Nebius is last: it bills cached prompt tokens at the
full price.

- **Two triggers, one table.** A click in the widget (`trigger = 'manual'`) and the 1 AM run
  (`'nightly'`) both write `account_ai_summaries`. Night rows go `queued → running → done | failed`,
  or `skipped` (`fresh`, `already_queued`, `limit`). The widget shows the latest `done` row by
  `started_at` (when the data was read), never by `created_at`, which is queue time for a night row,
  and reports failures of manual clicks only.
- **1 AM Montreal, in UTC cron.** `account-summary-nightly` fires at 05:00 and 06:00 UTC and only the
  one that falls at 1 AM local posts; runs are unique per `local_date`. The window runs from the end
  of the last successful run (`account_ai_summary_window`), so a failed night is covered by the next.
  `account-summary-worker-1m` starts at most 3 concurrent generations, 6 accounts per worker. Both
  jobs read the key from the Vault secret **`account_summary_key`**: without it they post nothing.
- **What counts as activity** (`activity.ts`): notes, tasks created or closed (automated ones too),
  meetings booked or held, contacts and accounts created, Books quotes and invoices modified.
  Internal and supplier accounts are left out; at most `SUMMARY_NIGHTLY_LIMIT` (1500) a night.
  Emails and calls are not detected. A Books record's `last_modified_time` moves on every edit, so
  replaying an old window misses records edited since; only the live run is complete.
- **Skipped when already fresh.** An account is queued only if no summary started after its
  `ready_at`: the last activity plus the mirror lag of its kind (10 min for invoices, 130 min for new
  contacts and accounts, which the summary reads from the mirror). The claim checks again, so a rep's
  click between 1 AM and the worker saves the call.
- **Each listed invoice goes in whole** (`gather.ts`, migration `20261022120000_invoice_details.sql`).
  The invoices the dossier lists one by one (`listedInvoices`: the last 12 months, every overdue
  one, the last invoice) carry their Books document under the summary line: lines with their
  descriptions, totals, payment, who it was sent to, notes and terms, plus the Books customer's own
  fields once. The mirror has none of it and the detail endpoint is one call per document, so
  `invoice_details` (admins read) caches what was read; a document is read again when the mirror's
  status or amount moved, when an unpaid one's copy is a day old, or when `DETAIL_FORMAT` is raised.
  Reads are paced at 20 per org per minute per function instance and stop after 40 s; the rest keep
  their summary line until the next generation, so a big account is complete after a run or two.
  Without the table every document is read each time. The prompt carries at most 80,000 characters
  of documents, the oldest left out first. Quotes still carry their list fields only.
- **Every model attempt is a row of `ai_model_calls`**, failed ones included (they are billed). The
  authoritative figure is `cost_usd` (OpenRouter's `usage.cost`); the `cost_*` columns split it with
  the serving provider's list prices, and `cost_computed_usd` equals `cost_usd` exactly unless a
  provider discounts. Reasoning tokens are part of `completion_tokens`, billed at the output price.
  Views, admin-only: `ai_summary_costs` (per generation), `ai_cost_by_account`, `ai_cost_daily`
  (Montreal day × trigger), `account_ai_summary_run_report`.
- GLM writes the current year into dates ("7 mai 2026"); `dropCurrentYear` in `clean.ts` restores
  the card's style. A bare `SUMMARY_MODEL` (no `vendor/`) is a leftover Anthropic id and is ignored.
- **Next steps are actions** (`card.ts`, migration `20261020180000_account_summary_refresh_and_crm_fields.sql`):
  `create_task`, `close_task`, `update_task` on an open rep task [T…], `decline_quote` on an open
  quote, `revise_quote` on an open or draft quote [D…]. A step naming a record the dossier does not
  offer for that action (an automatic task, a quote already decided) is dropped, never guessed. Task
  actions run in the widget as the signed-in user; a decline goes through the function
  (`quote_decline`), which re-reads the quote's status in Books first. Declining in Books moves the
  CRM Potential to "Perdu" by itself (Books' own sync, within seconds).
- **Every citation opens what it names** (`SourceRef` in `prompt.ts`): a quote, invoice or credit
  note its Books page (`#/creditnotes/` for a credit note, whose id is what `invoices.zoho_id` holds
  for an `is_avoir` row), a task, meeting or contact its CRM record. Zoho has no page for a single
  note and shows an email only from its contact, so the card stores what the model read of each
  cited note and email (`preview`) and the widget shows it in place, with a link to the record it
  sits on. The computed facts end with the [ids] of the records they rest on (last invoice, latest
  and open quotes, last exchanges, overdue invoices), so a point cites those rather than A1; A1
  ("fiche") is this page and is not a link. Cards written before 2026-10-21 have no `preview`:
  their note chips open the record the note sits on.
- **The card is copied onto the Zoho account** (`crm.ts`): six custom Accounts fields (temperature,
  its reason, first next step, date, open quotes and overdue before tax), written after every
  summary with `trigger: []` so no workflow fires, by the summary token (it alone has write scopes:
  Accounts update, Books estimates create/update). The API names are constants in `crm.ts`; a
  field missing in Zoho fails the write, which is stored on the row (`crm_error`) and retried at
  night (`push_crm`). `SUMMARY_CRM_FIELDS=off` stops the writes.
- **A card goes stale by date** (`refresh_at`, `refreshDays` in `prompt.ts`): an open quote passing 30
  days or expiring, an invoice falling due or passing 30 days late, the last purchase or real
  exchange leaving its window. None of these modifies a record, so activity detection misses them;
  the 1 AM run also queues accounts whose latest card reached its `refresh_at`
  (`account_ai_summary_expired`, `temperature_expired` in the run's detection). The mirror holds no
  invoice due dates: unpaid ones are assumed net 30.

### Leads: which table is which

There are two lead tables, and picking the wrong one is the easiest mistake to
make here.

- **`zoho_leads`** — the real data, ~29k rows synced from Zoho CRM. `stage` says
  whether a row is a Lead or a Contact.
- **`leads`** — a legacy hand-entered archive: 192 rows, every one dated
  2026-01-01, untouched since May 2026. Nothing reads it any more. The
  `get_leads_*` RPCs still point at it and are equally dead; use the
  `get_zoho_lead*` ones.

Three things about `zoho_leads` that are not obvious from the schema:

- **`zoho_leads_unique` is for directories, not funnels.** It hides a converted
  lead behind the contact it became, so counting conversions through it gives
  ~99%. The dashboard reads the base table with `stage = 'lead'`.
- **Contacts are not leads.** Most were created directly in Zoho as clients and
  were never leads; including them inflates revenue several-fold.
- **Conversion needs two numbers.** Zoho marks 97% of leads converted, which says
  nothing. `leads_invoiced` — the lead's account actually being billed after the
  lead arrived — is the figure that moves. The two are nested: every invoiced
  lead is already flagged converted.

### Where a contact's source and service come from

Zoho's Contacts module has **no** `Lead_Source` and no service multiselect —
those fields exist only on Leads. So for a contact both are resolved elsewhere,
in `zoho_leads_unique`, and the answer differs per field:

| | billed (`has_invoices`) | not billed |
|---|---|---|
| **source** | the account's `Origine_du_client` | the lead's own source, else the account's |
| **service** | the distinct `invoices.department` values | the lead's own service, else the account's |

`source_origin` / `service_origin` say which branch won (`own`, `lead`,
`account`, `invoice`) and drive the `*` marker in the table.

**Use `source_resolved` / `service_resolved` for anything user-facing, and for
filtering.** The raw `lead_source` / `service_interest` columns stay exactly what
Zoho's Leads module said, which for most contacts is nothing — filter on those
and the dropdown offers values that match zero rows.

Invoice departments keep Zoho Books' own wording (`DIST. PUBLICITAIRE SOLO`,
`NUMERIQUE`), deliberately **not** translated into the CRM's eight-value service
picklist: six department values against eight services, with no honest mapping
for `MULTI-ANNONCEURS` or `APPLICATION`. The cost is that the detail page's
Service filter offers both vocabularies. `zoho_service_labels` therefore spans
leads, accounts and invoices — but its label is pinned to the *leads* spelling
wherever the service appears there, so widening it cannot rename a dashboard bar.

None of this touches the funnel: the dashboard reads `zoho_leads` with
`stage = 'lead'`, and every rule above applies only to contacts.

Revenue comes in two flavours, both summed once per account so that several leads
on one account do not double-count: `revenue_attributed` (invoices dated on or
after the lead arrived) and `revenue_lifetime` (the account's whole history).

**Dates are counted on Montreal's calendar, not the database's.** The session
runs in UTC, so a bare `EXTRACT(MONTH FROM created_time)` or `created_time::date`
puts a lead created 31 January at 21:00 EST into February. Everything funnel-side
goes through `AT TIME ZONE 'America/Toronto'` (`zoho_leads_scoped`) or
`zoho_lead_local_date()`. Use the helper rather than a fresh `::date`.

**Filter values must come from `get_zoho_lead_filter_options`, never a hardcoded
list — and pass `p_stage`.** The options are drawn from `zoho_leads_unique`,
which is leads *and* contacts, while every dashboard figure counts leads only.
The dashboard and rep portal therefore ask for `p_stage => 'lead'`; the detail
page passes null because it genuinely lists both. Get this wrong and the dropdown
offers a rep who owns only contacts, and picking them empties the page.

Zoho's service picklist holds the same service under several spellings
differing only in case or spacing ("Distribution publicitaire" /
"Distribution Publicitaire", 2,209 leads between them). The RPC folds them via
`zoho_service_key()` and returns `service_variants` so a query can match every
spelling at once — the stored array keeps Zoho's original casing, and normalising
the table would just be overwritten by the next sync.

### Pages and Routes

| Route | Page | Purpose |
|---|---|---|
| `/comptes` | `AccountsDashboard` | Comptes section. Account cohorts by source/rep/service/domaine, monthly evolution vs last year, revenue attribution window |
| `/createurs` | `Createurs` | **Documents créés** in the nav. Admin-only. Who *created* each quote/invoice, vs who sold it — a rep who builds a quote and hands it to another still gets the credit here. Never reconciles with rep figures, by design |
| `/comptes/detail` | `AccountsDetail` | Comptes section. Searchable client directory; a row opens its billing history by department and year |
| `/publicite` | `Advertising` | Publicité section. Google Ads + Meta spend against the revenue of the accounts tagged to each, in three views (payant, organique, Google inconnu). Channel-level and monthly, never per lead |
| `/` | `Dashboard` | Devis section. YTD KPIs, rep leaderboard, top clients, monthly targets. Without the section, `/` redirects to the first section the user has |
| `/weekly` | `WeeklyDetail` | Week-by-week sales breakdown (pivot + line items) |
| `/quarterly` | `QuarterlyAverages` | YoY quarterly average deal size per rep |
| `/taches` | `TasksDashboard` | Admin-only. CRM task completion per rep, by week |
| `/settings` | `Settings` | Admin-only. Users and their sections, monthly objectives, fiscal quarters, syncs, webhook logs |

All routes are children of `Layout`, which provides the sidebar navigation. Which
routes exist depends on the signed-in user's sections (see **Access**).

The sidebar is two levels deep: a **section** (text only, no icon) holds
**modules** (Devis, Factures, Comptes), each with its own icon and its
screens underneath; a module with a single screen is a plain link instead. Both
levels collapse, `getSectionKey` / `getGroupKey` in `Layout.tsx` open the one a
navigation lands in, and Devis is open on a cold start. When you add a route,
add it to the tree, to `getGroupKey` if it belongs to a module, and to
`ROUTE_CHUNKS` in `src/lib/prefetch.ts`.

**A screen is filed by its subject; whether you can see it is a separate
question.** Reorganised 2026-09-18, because the two had been conflated:
`Administration` meant both "settings" and "admin-only", so every restricted
screen was filed there no matter what it was about, and neither Publicité (ad
spend) nor Tâches CRM is a setting.

| section | holds | who sees it |
|---|---|---|
| **Ventes Affichez** | Devis, Factures, Comptes, Publicité | each module has its own section flag |
| **Notre équipe** | Tâches CRM, Commissions, Objectifs d'équipe | admin only, today |
| **Mon Portail** | the signed-in rep's own numbers | the Mon Portail section flag |
| **Administration** | Documents créés, then Objectifs des reps, Taux de commission, Paramètres — screens that **change** something | admin only |

Consequences worth knowing before you edit the tree:

- **Every screen in Notre équipe is admin-only right now**, so a rep sees two
  sections, not four. The nav drops a module with no visible screens and a
  section with no visible modules, so nothing renders as an empty chevron. The
  day one of those screens opens to reps, a flag changes and nothing moves —
  that is the point of filing by subject.
- **`showAdminNav` is `isAdmin && !viewAsRep`**: an admin previewing a rep's
  view sees what that rep sees, including that rep's own sections (`Layout` reads
  the previewed rep's row). The routes stay reachable by URL — the guards in
  `App.tsx` follow the signed-in user, not `viewAsRep`.
- **`Documents créés` (`/createurs`) stays in Administration** even though it is
  a view, not a setting. It is Dominic's own back-office check on who keyed a
  document in — *"c'est vraiment juste pour moi"* — and he asked for it there
  on 2026-09-18. Do not "fix" it into Notre équipe.
- **Notre équipe holds three plain links, not modules.** Tâches CRM is the first
  screen of what will become an **Activité** module — rep actions: tasks, then
  conversations (SMS, courriels) and calls. A module wrapping one screen is a
  chevron that opens onto a single item, so it stays a link until the second
  screen lands; then wrap the links and add the prefix to `getGroupKey`.
- **The nav tree is not the URL tree.** A screen does not need a path prefix
  matching its section — `getGroupKey` and `getSectionKey` map paths explicitly,
  which is why they are spelled out rather than derived. `/comptes/publicite`
  was the exception that had to move: `getSectionKey` files by prefix, so that
  URL made the page a child of Comptes. It is now `/publicite`, with a redirect
  preserving the query string.

### Key Shared Abstractions

- **`src/lib/utils.ts`**: `cn()` (Tailwind class merger), `formatCurrencyCAD()`, `formatShortDate()`, `formatLongDate()`, `formatPercentage()`
- **`src/lib/csv.ts`** + **`src/components/ExportButton.tsx`**: CSV export for any table. Semicolon-delimited with a UTF-8 BOM because these files are opened in a French-locale Excel; numbers use a decimal comma and stay unquoted so they arrive as numbers. On a paginated table, pass `rows` as an async function that refetches without the page limit — exporting the visible 100 rows would answer a different question from the one on screen.
- **`src/lib/constants.ts`**: `DEPARTMENTS`, `MONTHS`, `OFFICES`, `SALE_STATUSES` — used as filter option sources across all pages
- **`src/types/database.ts`**: TypeScript types mirroring Supabase view/RPC return shapes (`SommaireRow`, `ZoneA_SummaryRow`, `ZoneB_DetailRow`, `YoYRow`, etc.)
- **`src/components/FilterBar.tsx`**: `<FilterBar>` / `<FilterGroup>` composable filter bar used on every page
- **`src/components/Select.tsx`**: Reusable styled dropdown with an `accent` variant (brand orange). One value: periods, modes, two-value filters
- **`src/components/MultiSelect.tsx`** + **`useUrlList`** (`src/hooks/useUrlState.ts`): the same dropdown taking several values, for category filters. See **Filters take several values**
- **`src/hooks/useRepFilter.ts`**: the rep filter (Interne + the team by name). Returns `rep` / `reps` / `targetReps` for the RPCs and `matches()` for pages that filter in memory
- **`src/lib/sections.ts`**: the five section flags, and `homePathFor()`
- **`src/hooks/useSort.ts`**: Generic column sort hook used in data tables

### Styling

**Tailwind CSS 4**, CSS-first. There is no `tailwind.config.js` and no
`postcss.config.js` — the theme is CSS, compiled by `@tailwindcss/vite`.
`src/index.css` loads, in this order:

1. `tailwindcss`
2. `branding/tokens/tokens.css` — every brand value as `:root` custom properties
3. `branding/tokens/tailwind-v4.css` — those values as utilities, plus the brand base layer
4. the app's own additions, then `@layer components`

Fonts come from `index.html` (Inter, plus the 400 italic cut of Inria Serif).

App-level helpers in `src/index.css` `@layer components`: `.card`, `.badge`,
`.th`, `.td`, `.form-input`, `.link`, and `.btn` + `.btn-{xs,sm,md,lg}` +
`.btn-{primary,secondary,dark,ghost,danger,quiet}`. The brand kit adds
`.eyebrow`, `.label-caps`, `.accent-serif` and `.tnum`. Use `cn()` from
`src/lib/utils.ts` for conditional class merging (wraps `clsx` + `tailwind-merge`).

## Brand (2026 — affichez.ca)

Read `frontend/branding/brand-guide.md` before building or restyling any UI.
The essentials:

- **Orange `#F5570E`** = action (primary button, links, active accents, logo).
  **Black** = headings, primary text, and emphasis — including a table's TOTAL
  row, which is a full-width black band. Type on an orange fill is **white**.
  The retired 2025 brand — `#e38800` as a brand orange, deep green `#154633`,
  Poppins, the uppercase swoosh wordmark — must not appear anywhere. `#E38800`
  survives only as `--tone-warn`, the amber status colour.
- **Inter** everywhere. Headings and every uppercase label are **600**, never
  700; 700 is kept for figures — money, counts, totals — where it is data
  hierarchy rather than the heading voice. One accent word per display heading
  in **Inria Serif italic**: write `*word*` in the copy and render with
  `<Accented>` (`src/components/Accented.tsx`). Used on the login screen only.
- Buttons, inputs, selects and tabs are **10px radius** (`rounded-md`), never
  pills; cards are `rounded-xl` (16px); menus and popovers `rounded-lg` (12px).
  Pills are for chips, tags, avatars, badges and progress tracks only.
- Page ground is **sand**; app chrome (sidebar, headers) and cards are white.
  `shadow-card` already carries a 1px hairline ring — do not add a `border`
  beside it.
- **One orange thing per screen.** Orange never marks status, severity, or a
  value in a data column — pick a `--tone-*` for status and ink for emphasis.
- **No hex values in component code.** Everything comes from
  `branding/tokens/tokens.css`. No gradients, glows, or decorative blobs — the
  brand is flat colour and type.
- Logo only through `src/components/Logo.tsx`, which serves the real files from
  `public/brand/`. Heights: 22 dense toolbar, 24 sidebar, 28–30 page chrome.

### The data palette is not brand colour

`Tag`/`TagCell` colours ~45 picklist values (sources, services, departments) by
hashing the label, which needs more distinguishable fills than the brand owns.
Those ten tones are declared separately in `src/index.css` as
`--color-data-1..10` and are **deliberately not** brand or status colours. Use
them for anything categorical: module identity, department badges, payroll
columns. Never use a `--tone-*` for a category or a `--color-data-*` for a
status.

### Rep names always carry a face

Anywhere a rep name is shown — filter dropdowns, leaderboards, tables, pickers,
the View switcher, the signed-in user row — it goes through `RepAvatar` /
`RepName` (`src/components/RepAvatar.tsx`). Never render a bare `{rep_name}`.

`src/lib/reps.ts` resolves a name to one of four things, in order:

| | when |
|---|---|
| the portrait | one of the nine in `public/reps/` |
| a group glyph | "Tous les reps", "Interne" — a label standing for several people |
| a building glyph | "Vente interne", "Magasin Affichez", "Zoho Books" — not a person |
| initials on a stable colour | everyone else |

**The nine portraits are the whole View list**, so every name a filter offers has
a real face. The ~60 other names in the data — former staff, CRM task owners,
invoice creators — reach only the initials branch. That is deliberate: a single
stock silhouette repeated sixty times removes the one thing an avatar is for,
which is telling rows apart at a glance.

The initials colour comes from `dataToneIndex` in `src/lib/dataTone.ts`, the
same hash `TagCell` uses for service and source badges — one implementation, so
a rep without a photo is the same colour on every screen.

**It is a snapshot and it does not sync.** A rep added to `allowed_users`
appears in every dropdown immediately and silently falls back to initials. To
add a face: put the portrait in `assets/reps-source/` (outside `frontend/`, so
Vite neither serves nor bundles it), run `scratchpad/build_rep_photos.py` to cut
it square at 128x128, and add the name to `PHOTO_BY_NAME`. Do not serve the
768x768 originals — the whole nine-photo set is 23 KB at 128 and 574 KB at 768,
for something drawn between 20px and 48px.

Avatars are **not** lazy-loaded, on purpose: nine files totalling 23 KB are all
in cache after the first screen, and `loading="lazy"` only bought a visible
pop-in every time a dropdown opened.

### A rep off the sales team is "Interne", by name and by row

`src/lib/repTeam.ts` holds the one membership rule: the team is `allowed_users`
minus `INTERNAL_REP_NAMES`, and **every other name in the data is Interne** —
former staff, billing entities, CRM task owners. `useRepTeam()` exposes
`isInternal`, `display` (the name, or `Interne`) and `mergeInternalRows`, and
the list is fetched **once per session and shared** through
`useSyncExternalStore`, because table cells read it now and a per-component
fetch would be one request per avatar.

There used to be two definitions of "internal" and they disagreed on screen:
the rep filter's dynamic one, and a fixed six-name list each page grouped under
"Vente Interne" of its own accord. The Dashboard card also pinned that row as a
sixth entry numbered 6 while the "Voir tout" modal ranked it by amount — the
same group at two different ranks, with two reps missing from the card. Pages
now store the RPC's rows unchanged and merge in a `useMemo`:

```ts
const leaderboard = useMemo(() => mergeInternalRows(
    rawLeaderboard, repTeam, r => r.rep_name,
    r => ({ ...r, rep_name: INTERNAL_LABEL, office: '—' }),
    (acc, r) => ({ ...acc, total_amount: … , deal_count: … }),
).map(recomputeDerived).sort(…).map(rerank), [rawLeaderboard, repTeam]);
```

Merge the counts, **recompute** everything derived from them (`avg_deal`,
`completion_rate`, `revenue_per_account`, an average delay weighted by what
each row actually closed) — an average of averages is not the group's average —
then re-sort and re-rank, because one merged row lands in a different place.

`RepName` applies `display()` for you, so a name and its face can never
disagree; CSV exports map through `display()` too, since the file has to say
what the screen says.

**Three screens pass `literal` and name the person**: `/createurs` (its whole
subject is who typed a document, and most of those names are admin staff and
former employees — merging them would collapse the page into one line), Ma Paye
(a commission line belongs to one person and is keyed by that name), and the
signed-in user's own row and the rep pickers. Everywhere a rep's *numbers* are
reported, the merge applies.

### Component Patterns

Pages are self-contained — state, data fetching, filters, and rendering are colocated. Feature-specific sub-components live in `src/components/{feature}/` (e.g., `weekly/ZoneAPivotTable`, `dashboard/SommaireTable`).

The `Settings` page uses an internal tab system (`reps | objectives | quarters | logs`) with each section as a separate function component defined in the same file.

### No `any` Types
TypeScript's `no-any` rule is enforced. All Supabase RPC results must be typed against `src/types/database.ts`. Extend the types file when new RPC functions or views are added.
