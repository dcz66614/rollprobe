-- Rollprobe fixture: expand migration, FIXED control version.
-- Same widening as the buggy variant, but the backfill is complete and the column is
-- protected by a default plus a NOT NULL constraint, so an old writer cannot leave NULLs.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_ref    TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency        TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS orders_external_ref_uniq
  ON orders (external_ref)
  WHERE external_ref IS NOT NULL;

UPDATE orders SET currency = 'USD' WHERE currency IS NULL;

ALTER TABLE orders ALTER COLUMN currency SET DEFAULT 'USD';
ALTER TABLE orders ALTER COLUMN currency SET NOT NULL;
