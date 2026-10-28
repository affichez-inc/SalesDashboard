#!/usr/bin/env bash
# Back-fill Zoho Books' whole history: the QC invoices and credit notes dated
# before 2021, then every quote of every status.
#
#   bash scripts/zoho-books-history-backfill.sh                   # both parts
#   bash scripts/zoho-books-history-backfill.sh invoices          # invoices only
#   bash scripts/zoho-books-history-backfill.sh invoices 2018     # invoices from 2018 on
#   bash scripts/zoho-books-history-backfill.sh invoices 2014 2014  # one year only
#   bash scripts/zoho-books-history-backfill.sh quotes            # quotes only
#
# When to run it: once, after zoho-sync is deployed without the 2025 cutoff on
# non-won quotes. The scheduled syncs are incremental on last_modified_time, so a
# document nobody edits is never read again and the past never arrives by itself.
#
# Invoices: one calendar year per call, QC only (MTL has nothing before 2021).
# QC's first invoice is dated 2014-04-04; Books holds nothing older.
# Quotes: Books' estimates list has no date filter, so the walk covers the whole
# history in slices of about two minutes and reports walk_complete when done.
# Both are upserts on zoho_id: running the script twice changes nothing.
#
# Afterwards zoho-pretax-sync and zoho-quote-creator-sync read the new documents'
# tax and creator one call each, on their own schedules, within the Books quota.
#
# Needs only the anon key in frontend/.env. No secret is printed.
set -u
cd "$(dirname "$0")/.." || exit 1

ANON="$(grep -E '^VITE_SUPABASE_ANON_KEY=' frontend/.env | cut -d= -f2- | tr -d '\r"')"
[ -n "$ANON" ] || { echo "ERROR: VITE_SUPABASE_ANON_KEY not found in frontend/.env"; exit 1; }
FN="https://auyfucbskylougsmmrks.supabase.co/functions/v1"
FIRST_YEAR=2014
LAST_YEAR=2020
MAX_SLICES=40

MODE="${1:-all}"
case "$MODE" in all|invoices|quotes) ;; *) echo "usage: $0 [all|invoices [FROM [TO]]|quotes]"; exit 1 ;; esac
[ "$MODE" = "invoices" ] && [ -n "${2:-}" ] && FIRST_YEAR="$2"
[ "$MODE" = "invoices" ] && [ -n "${3:-}" ] && LAST_YEAR="$3"

stamp() { date -u +"%Y-%m-%d %H:%M:%SZ"; }

# ── Invoices and credit notes ────────────────────────────────────────────────
if [ "$MODE" != "quotes" ]; then
  for (( y = FIRST_YEAR; y <= LAST_YEAR; y++ )); do
    echo "== $(stamp) invoices QC $y"
    # x-prune: false skips the whole-table duplicate sweep a full sync otherwise runs.
    resp="$(curl -s -m 175 -X POST -H "Authorization: Bearer $ANON" \
      -H "x-sync-source: manual" -H "x-full-sync: true" -H "x-org: QC" -H "x-prune: false" \
      -H "x-date-start: $y-01-01" -H "x-date-end: $y-12-31" "$FN/zoho-invoice-sync")"
    echo "$resp" | head -c 600; echo
    # A reply with no "upserted" key is an error object: stop rather than skip a year.
    if ! grep -q '"upserted"' <<<"$resp"; then
      echo "STOP: the function did not report an import for $y."; exit 2
    fi
    if ! grep -q -E '"errors": ?\[\]' <<<"$resp"; then
      echo "STOP: $y finished with errors (see above). Fix them and run again from $y:"
      echo "  bash scripts/zoho-books-history-backfill.sh invoices $y"; exit 3
    fi
  done
  echo "== $(stamp) invoices done"
  [ "$MODE" = "invoices" ] && exit 0
fi

# ── Quotes, every status ─────────────────────────────────────────────────────
# Each slice resumes from the cursor the previous one saved in sync_state.
n=0; resp=""
until grep -q -E '"walk_complete": ?true' <<<"$resp"; do
  n=$((n+1)); [ $n -gt $MAX_SLICES ] && { echo "ERROR: quotes did not finish in $MAX_SLICES slices"; exit 4; }
  echo "== $(stamp) quotes, slice $n"
  resp="$(curl -s -m 175 -X POST -H "Authorization: Bearer $ANON" \
    -H "x-sync-source: manual" -H "x-full-sync: true" -H "x-store-all: true" "$FN/zoho-sync")"
  echo "$resp" | head -c 600; echo
  # A reply with no "walk_complete" key is an error object: repeating it would repeat it.
  if ! grep -q '"walk_complete"' <<<"$resp"; then
    echo "STOP: the function did not report progress."; exit 5
  fi
  # A Zoho page error leaves the cursor where it was; say so instead of looping on it.
  if grep -q -E '"(QC|MTL) p\.[0-9]+:' <<<"$resp"; then
    echo "STOP: Zoho refused a page (see above). Running the script again resumes from the saved cursor."; exit 6
  fi
done
echo "== $(stamp) quotes done in $n slice(s)"
echo "== $(stamp) finished"
