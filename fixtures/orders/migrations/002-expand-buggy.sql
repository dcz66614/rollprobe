-- Rollprobe fixture: expand migration, BUGGY control version.
-- The schema is widened, but the new currency column is only backfilled for a subset of
-- rows (status = 'confirmed') and stays nullable. Old writers keep inserting NULL.
-- This is the fault F06 is meant to detect.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_ref    TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency        TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS orders_external_ref_uniq
  ON orders (external_ref)
  WHERE external_ref IS NOT NULL;

UPDATE orders SET currency = 'USD' WHERE currency IS NULL AND status = 'confirmed';
