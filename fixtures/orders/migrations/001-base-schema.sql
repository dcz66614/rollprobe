-- Rollprobe fixture: baseline schema (v1 of the order service)
-- Applied once per campaign before the baseline phase.
-- Every statement here must be valid PostgreSQL 17.

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status       TEXT NOT NULL DEFAULT 'pending',
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customer_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);

CREATE TABLE IF NOT EXISTS inventory (
  sku        TEXT PRIMARY KEY,
  quantity   INTEGER NOT NULL CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO inventory (sku, quantity) VALUES ('SKU-1', 100)
ON CONFLICT (sku) DO NOTHING;

-- Row level security is exercised on a table that the scenarios do not mutate, so that
-- the positive/negative RLS tests can run without perturbing the campaign data.
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  tenant     TEXT NOT NULL,
  action     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_tenant_isolation ON audit_log;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  FOR ALL
  USING (tenant = current_setting('rollprobe.tenant', true))
  WITH CHECK (tenant = current_setting('rollprobe.tenant', true));

GRANT SELECT, INSERT ON audit_log TO app;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO app;
GRANT SELECT ON audit_log TO observer;

INSERT INTO audit_log (tenant, action) VALUES
  ('acme', 'baseline-seed'),
  ('globex', 'baseline-seed');
