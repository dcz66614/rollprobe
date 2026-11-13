/**
 * Rollprobe fixture: order service with two real control versions.
 *
 *   APP_VERSION=old|new      which generation of the service is running
 *   APP_MODE=buggy|fixed     which control build of that generation is running
 *
 * The old generation carries the backward-compatibility faults that the F01-F06 scenarios
 * probe; `fixed` is a genuine second code path, not a flag that merely changes a status
 * code. Both builds talk to the same PostgreSQL database, keep a persistent connection
 * pool, and expose the same HTTP surface, so a campaign can interleave them.
 *
 * Endpoints
 *   GET  /health
 *   GET  /version
 *   POST /orders              (Idempotency-Key header optional)
 *   GET  /orders/:id
 *   PUT  /orders/:id
 *   GET  /orders/:id/total
 *   GET  /orders?limit=n
 */

import http from 'node:http';
import pg from 'pg';

const VERSION = process.env.APP_VERSION === 'new' ? 'new' : 'old';
const MODE = process.env.APP_MODE === 'fixed' ? 'fixed' : 'buggy';
const PORT = Number(process.env.PORT ?? (VERSION === 'old' ? 3001 : 3002));
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

/** One pool for the whole process lifetime: this is what makes the warm-process cases real. */
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8, idleTimeoutMillis: 30_000 });

/** The statuses v1 shipped with. `refund_pending` is introduced by the new build. */
const V1_STATUSES = new Set(['pending', 'confirmed', 'shipped', 'cancelled']);
const V2_STATUSES = new Set([...V1_STATUSES, 'refund_pending']);
/** The v1 typed model of the metadata column. Anything outside it is "unknown" to old code. */
const V1_METADATA_KEYS = ['source', 'channel'];

let cachedColumns = null;

async function loadColumns() {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'orders'
      ORDER BY ordinal_position`
  );
  return rows.map((r) => r.column_name);
}

async function columnsForRead() {
  if (VERSION === 'new') return null; // SELECT *
  if (MODE === 'fixed') {
    // Fixed build: never trust a cached projection, refresh it on every read.
    cachedColumns = await loadColumns();
    return cachedColumns;
  }
  // Buggy build: the projection was captured at boot and is never refreshed.
  if (!cachedColumns) cachedColumns = await loadColumns();
  return cachedColumns;
}

function orderIdFor() {
  if (VERSION === 'new') return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  if (MODE === 'fixed') return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  // Buggy old build: millisecond timestamp only, collides under concurrency.
  return String(Date.now());
}

/**
 * Columns that exist *right now*. Writes must adapt to the schema they are pointed at:
 * the fixed build has to work both before the expand migration (v1 schema) and after it.
 */
async function existingColumns() {
  return new Set(await loadColumns());
}

function v1Metadata(input) {
  return {
    source: typeof input.source === 'string' ? input.source : 'old-api',
    channel: typeof input.channel === 'string' ? input.channel : 'web',
  };
}

function unknownMetadata(input) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (['customer_id', 'amount_cents', 'status', 'id', 'source', 'channel'].includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Old code only understands the statuses it shipped with. */
function presentStatus(status) {
  if (VERSION === 'new') return { status, status_known: V2_STATUSES.has(status) };
  if (MODE === 'fixed') return { status, status_known: V1_STATUSES.has(status) };
  return { status: V1_STATUSES.has(status) ? status : 'active' };
}

function projectRow(row, columns) {
  const shaped = columns ? Object.fromEntries(columns.map((c) => [c, row[c]])) : { ...row };
  return { ...shaped, ...presentStatus(row.status) };
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'x-service-version': VERSION,
    'x-service-mode': MODE,
    ...extraHeaders,
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function handleCreateOrder(req, res, body) {
  const idempotencyKey = req.headers['idempotency-key'] ?? null;
  const customerId = body.customer_id;
  const amountCents = Number(body.amount_cents);

  if (!customerId || !Number.isInteger(amountCents) || amountCents <= 0) {
    return json(res, 400, { error: 'customer_id and a positive integer amount_cents are required' });
  }

  // ---- old / buggy: the idempotency key is accepted but silently ignored ----
  if (VERSION === 'old' && MODE === 'buggy') {
    const id = orderIdFor();
    const { rows } = await pool.query(
      `INSERT INTO orders (id, customer_id, amount_cents, status, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, customer_id, amount_cents, status, metadata, created_at`,
      [id, customerId, amountCents, body.status ?? 'confirmed', JSON.stringify(v1Metadata(body))]
    );
    return json(res, 201, rows[0]);
  }

  // ---- old / fixed and new: idempotent create keyed on external_ref ----
  // The write adapts to the schema that is actually present, so the same build works
  // before and after the expand migration.
  const available = await existingColumns();
  const hasExternalRef = available.has('external_ref');
  const hasCurrency = available.has('currency');

  if (idempotencyKey && hasExternalRef) {
    const existing = await pool.query(`SELECT * FROM orders WHERE external_ref = $1`, [idempotencyKey]);
    if (existing.rows.length > 0) {
      return json(res, 200, projectRow(existing.rows[0], VERSION === 'old' ? await columnsForRead() : null));
    }
  }

  const id = orderIdFor();
  const metadata = VERSION === 'old' ? { ...v1Metadata(body), ...unknownMetadata(body) } : unknownMetadata(body);

  const insertColumns = ['id', 'customer_id', 'amount_cents', 'status', 'metadata'];
  const insertValues = [id, customerId, amountCents, body.status ?? 'confirmed', JSON.stringify(metadata)];
  if (hasExternalRef) {
    insertColumns.push('external_ref');
    insertValues.push(idempotencyKey);
  }
  if (hasCurrency) {
    insertColumns.push('currency');
    insertValues.push('USD');
  }
  const placeholders = insertColumns.map((_, index) => `$${index + 1}`).join(', ');

  try {
    const { rows } = await pool.query(
      `INSERT INTO orders (${insertColumns.join(', ')})
       VALUES (${placeholders})
       RETURNING *`,
      insertValues
    );
    return json(res, 201, projectRow(rows[0], VERSION === 'old' ? await columnsForRead() : null));
  } catch (error) {
    // Concurrent duplicate on the unique external_ref index: resolve to the winner.
    if (error.code === '23505' && idempotencyKey) {
      const existing = await pool.query(`SELECT * FROM orders WHERE external_ref = $1`, [idempotencyKey]);
      if (existing.rows.length > 0) return json(res, 200, existing.rows[0]);
    }
    throw error;
  }
}

async function handleUpdateOrder(req, res, id, body) {
  const columns = VERSION === 'old' ? await columnsForRead() : null;
  const selectList = columns ? columns.join(', ') : '*';
  const current = await pool.query(`SELECT ${selectList} FROM orders WHERE id = $1`, [id]);
  if (current.rows.length === 0) return json(res, 404, { error: 'order not found' });

  const row = current.rows[0];
  const status = body.status ?? row.status;
  const trackingNumber = body.tracking_number ?? row.tracking_number ?? null;
  const hasTracking = (await existingColumns()).has('tracking_number');

  // ---- old / buggy: rewrites metadata from its typed v1 model, dropping unknown keys ----
  if (VERSION === 'old' && MODE === 'buggy') {
    const rewritten = v1Metadata({ ...row.metadata, ...body });
    return json(res, 200, await applyUpdate(res, id, status, trackingNumber, rewritten, hasTracking, selectList, columns));
  }

  // ---- fixed paths merge metadata instead of replacing it ----
  const merged = { ...(row.metadata ?? {}), ...unknownMetadata(body) };
  if (VERSION === 'old') {
    Object.assign(merged, v1Metadata({ ...row.metadata, ...body }));
  }
  return json(res, 200, await applyUpdate(res, id, status, trackingNumber, merged, hasTracking, selectList, columns));
}

async function applyUpdate(res, id, status, trackingNumber, metadata, hasTracking, selectList, columns) {
  const setClauses = [];
  const values = [];
  const assign = (column, value) => {
    values.push(value);
    setClauses.push(`${column} = $${values.length}`);
  };

  assign('status', status);
  if (hasTracking) assign('tracking_number', trackingNumber);
  assign('metadata', JSON.stringify(metadata));
  setClauses.push('updated_at = now()');

  values.push(id);
  const { rows } = await pool.query(
    `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING ${selectList}`,
    values
  );
  return projectRow(rows[0], columns);
}

async function handleGetOrder(res, id) {
  const columns = VERSION === 'old' ? await columnsForRead() : null;
  const selectList = columns ? columns.join(', ') : '*';
  const { rows } = await pool.query(`SELECT ${selectList} FROM orders WHERE id = $1`, [id]);
  if (rows.length === 0) return json(res, 404, { error: 'order not found' });
  return json(res, 200, projectRow(rows[0], columns));
}

async function handleTotal(res, id) {
  const columns = VERSION === 'old' ? await columnsForRead() : null;
  const selectList = columns ? columns.join(', ') : '*';
  const { rows } = await pool.query(`SELECT ${selectList} FROM orders WHERE id = $1`, [id]);
  if (rows.length === 0) return json(res, 404, { error: 'order not found' });

  const amountCents = rows[0].amount_cents;
  // The bug: the old build treats an already-cent value as dollars and converts again.
  const divisor = VERSION === 'old' && MODE === 'buggy' ? 10_000 : 100;
  return json(res, 200, {
    order_id: id,
    amount_cents: amountCents,
    total_dollars: amountCents / divisor,
  });
}

async function handleList(res, limit) {
  const columns = VERSION === 'old' ? await columnsForRead() : null;
  const selectList = columns ? columns.join(', ') : '*';
  const { rows } = await pool.query(`SELECT ${selectList} FROM orders ORDER BY created_at LIMIT $1`, [limit]);
  return json(res, 200, { items: rows.map((r) => projectRow(r, columns)), count: rows.length });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/health') {
      await pool.query('SELECT 1');
      return json(res, 200, { status: 'ok', version: VERSION, mode: MODE, pid: process.pid });
    }

    if (req.method === 'GET' && url.pathname === '/version') {
      return json(res, 200, { version: VERSION, mode: MODE, pid: process.pid });
    }

    if (req.method === 'POST' && url.pathname === '/orders') {
      return await handleCreateOrder(req, res, await readBody(req));
    }

    if (req.method === 'GET' && url.pathname === '/orders') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 200);
      return await handleList(res, limit);
    }

    if (parts[0] === 'orders' && parts[1]) {
      const id = decodeURIComponent(parts[1]);
      if (req.method === 'GET' && parts.length === 2) return await handleGetOrder(res, id);
      if (req.method === 'GET' && parts[2] === 'total') return await handleTotal(res, id);
      if (req.method === 'PUT' && parts.length === 2) return await handleUpdateOrder(req, res, id, await readBody(req));
    }

    return json(res, 404, { error: 'not found', path: url.pathname });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

async function start() {
  cachedColumns = await loadColumns();
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  console.log(
    JSON.stringify({
      event: 'listening',
      version: VERSION,
      mode: MODE,
      port: actualPort,
      pid: process.pid,
      cachedColumns,
    })
  );
}

async function shutdown(signal) {
  console.log(JSON.stringify({ event: 'shutdown', signal }));
  server.close();
  await pool.end().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch(async (error) => {
  console.error(JSON.stringify({ event: 'startup_failed', error: String(error) }));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
