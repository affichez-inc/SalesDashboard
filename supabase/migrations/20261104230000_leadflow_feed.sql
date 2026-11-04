-- The LeadFlow Feed (docs/LEADFLOW-FEED.md): LeadFlow reads this app's quotes, invoices, credit notes and
-- Books customers through the edge function `leadflow-feed`, by modification time. `sales` already has
-- `updated_at` kept by trg_sales_updated_at; `invoices` has only `synced_at`, set on insert and never moved
-- by the incremental sync's upserts (they omit it), so a paid invoice would not be re-read until a full
-- pass. This adds the same `updated_at` to `invoices`, and the keyset indexes the feed pages on.
--
-- Nothing here changes what the app shows. Rollback: drop the trigger, the column and the three indexes.

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_invoices_updated_at ON public.invoices;
CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- The feed's "changes since" pages: newest first by (updated_at, id); its full passes and id sweeps by id.
CREATE INDEX IF NOT EXISTS sales_feed_updated_idx ON public.sales (updated_at, zoho_id);
CREATE INDEX IF NOT EXISTS invoices_feed_updated_idx ON public.invoices (updated_at, zoho_id);
CREATE INDEX IF NOT EXISTS zoho_books_customers_feed_synced_idx ON public.zoho_books_customers (synced_at, books_customer_id);
CREATE INDEX IF NOT EXISTS sales_feed_id_idx ON public.sales (zoho_id);

COMMENT ON COLUMN public.invoices.updated_at IS
  'When this row last changed (trigger), for the LeadFlow Feed''s incremental reads. synced_at stays the sync''s own mark.';
