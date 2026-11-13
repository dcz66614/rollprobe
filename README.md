# Rollprobe

> **Status: Experimental MVP.** Independently verified with PostgreSQL 17 and the six included Orders fixtures on Windows. This is not production ready; third-party applications and other hosts require additional testing.

Local-first verification for rolling deployments. Rollprobe runs a real PostgreSQL database and
real old/new builds of an HTTP service side by side, walks them through
`baseline → expanded → mixed → app rollback`, and decides whether the rollout actually broke a
business contract — not just whether the endpoints returned 200.

It is built for the failures that type systems and unit tests cannot see: a retry that creates a
second order, an old build that quietly deletes metadata it does not model, a warm process that
keeps serving a stale projection after a migration, a backfill that leaves half the rows NULL.

---

## What it actually does

For each scenario Rollprobe:

1. Provisions an isolated PostgreSQL 17 container (own network, own volume, ephemeral port) and
   proves readiness with a real SQL round-trip.
2. Applies the base schema, starts the **old** build as a real OS process and warms it.
3. Runs the baseline operations.
4. Applies the **expand migration**, starts the **new** build, and runs the expanded operations.
5. Runs **mixed** operations: both builds live, both connected to the same database.
6. Switches traffic back to the old build (**app rollback**) while keeping the schema and every
   committed row, then runs the rollback operations.
7. Evaluates the scenario's invariants against the database (independent connection) and through
   the HTTP surface.
8. Writes a hash-chained event log, a coverage matrix with a **planned** denominator, a
   determination, an evidence ZIP with per-file SHA-256, and an offline HTML report.

A run ends in exactly one of three states:

| Status | Meaning |
|---|---|
| `VIOLATION` | an authoritative, required invariant was observed to be broken |
| `BOUNDED_PASS` | every required invariant executed and was satisfied |
| `INCONCLUSIVE` | a required invariant could not be decided, was never executed, or infrastructure failed |

`INCONCLUSIVE` is not a soft pass. Missing data, a failed query, an unreachable app or an
unmigrated schema all produce it, and the CLI exits `2`.

---

## Requirements

- Node.js ≥ 20
- Docker Desktop with a reachable Linux engine (PostgreSQL 17 image is pulled on first use)
- Windows, macOS or Linux

```bash
npm ci
npm run build
node packages/cli/dist/index.js doctor
```

`doctor` checks the engine, the image, the fixtures, every migration and every scenario, and exits
non-zero if the host cannot run a campaign.

---

## Quick start

```bash
# 1. Can this machine run a campaign?
node packages/cli/dist/index.js doctor

# 2. Run one scenario against both control builds
node packages/cli/dist/index.js run --scenario fixtures/cases/F01-cross-version-idempotency.yaml --report

# 3. Or run everything and produce a report
node packages/cli/dist/index.js demo
```

Artifacts land in `.rollprobe/`:

```
.rollprobe/demo/
  F01-cross-version-idempotency__buggy/
    events.ndjson        hash-chained event log
    run.json             full result
    checks.json          every check with observed vs expected
    coverage.json        planned coverage matrix
    observations.json    every HTTP interaction
    scenario.yaml        the exact scenario that was executed
    environment.json     container id, ports, pids
    apps/*.log           stdout/stderr of each build
    bundle/              evidence files + manifest.json + manifest.sha256
    bundle.zip
  report.html            offline report
```

---

## Commands

| Command | Purpose | Exit codes |
|---|---|---|
| `doctor` | verify engine, image, fixtures, scenarios | `0` ready, `2` not ready |
| `run` | execute one scenario (`--scenario`) or all (`--all`) in `buggy`, `fixed` or `both` modes | `0`/`1`/`2` |
| `demo` | run every scenario in both control builds, then render the report | `0` no inconclusive, `2` otherwise |
| `shrink` | reduce a failing scenario by re-execution until it is 1-minimal | `0` reproduced, `2` not reproduced |
| `replay` | re-run a recorded scenario in a clean environment and diff the outcome | `0` stable, `2` unstable |
| `report` | render offline HTML from recorded runs | `0`/`2` |
| `verify` | verify an evidence ZIP offline | `0`/`2` |

Useful flags: `--mode buggy|fixed|both`, `--keep-db`, `--out <dir>`, `--workspace <dir>`.

---

## The six P0 scenarios

| Scenario | Contract under test |
|---|---|
| F01 | A retried logical operation must not create a second order across versions |
| F02 | An old build must not delete metadata keys it does not model |
| F03 | An old build must not reinterpret a status value it does not know |
| F04 | Stored minor units must not be converted to currency twice |
| F05 | A warm old process must see columns added by the migration |
| F06 | A partial backfill must not leave rows without a currency |

Each scenario is executed twice: once with `APP_MODE=buggy` (the fault is present) and once with
`APP_MODE=fixed` (the fault is corrected). Both are real code paths in
`fixtures/orders-app/server.mjs`, and both talk to the same database schema. A scenario only
counts as a valid detector if buggy produces `VIOLATION` and fixed produces `BOUNDED_PASS`.

---

## Scenario format

One YAML file per scenario, one schema for all of them
(`packages/protocol/src/scenario.ts`):

```yaml
id: f01-cross-version-idempotency
title: Cross-version retry must not duplicate the business effect
faultFamily: idempotency
baseMigration: fixtures/orders/migrations/001-base-schema.sql
expandMigration: fixtures/orders/migrations/002-expand-{mode}.sql   # {mode} -> buggy | fixed

operations:
  - id: lost-response-retry
    kind: discard_retry
    phase: mixed
    target: new
    retryTarget: old
    logicalOperationId: f01-logical-create
    idempotencyKey: f01-idem-key
    request:
      method: POST
      path: /orders
      json: { customer_id: cust_f01, amount_cents: 2500 }
    effectSql: SELECT count(*)::int AS n FROM orders WHERE external_ref = 'f01-idem-key'
    effectExpectedMin: 1

invariants:
  - id: f01-single-effect
    title: The retried logical operation produced exactly one order
    type: sql_scalar
    sql: SELECT count(*)::int AS n FROM orders WHERE customer_id = 'cust_f01'
    expected: 1
```

Operation kinds: `http`, `migrate`, `switch`, `discard_retry`.
Invariant kinds: `sql_scalar`, `sql_rows`, `http_json`, `http_status`.

`discard_retry` is the interesting one: the proxy forwards to the upstream build, consumes the
complete response, proves on an independent connection that the row is committed, records the
evidence, and only then destroys the downstream socket — so the client really does lose the
response before retrying against the other build. If the effect cannot be proven, the operation
fails closed: the retry is **not** sent, and the run becomes `INCONCLUSIVE`.

Each invariant is evaluated at the end of the phase it declares (`baseline`, `expanded`, `mixed`,
`app_rollback`), so a violation that exists only inside the mixed window is still captured even if
the state is repaired later.

---

## Architecture

```
packages/protocol   scenario schema (zod), core types, planned invariants
packages/postgres   Docker engine client, container provisioning, SQL runner
packages/runner     application lifecycle: spawn, readiness, traffic switch, teardown
packages/scenario   HTTP execution, variable interpolation
packages/oracle     business assertions, response-discard proxy
packages/evidence   hash-chained NDJSON log, ZIP writer/reader, bundle + verification
packages/core       campaign engine, coverage matrix, determination
packages/shrinker   ddmin over operations with re-execution and 1-minimality proof
packages/report     self-contained offline HTML
packages/cli        the `rollprobe` command
fixtures/orders-app parameterised service with buggy and fixed control builds
fixtures/orders     v1 schema and the two expand migrations
fixtures/cases      the six scenarios
```

Build: `tsc --build` with per-package project references. Each package emits its own `dist/`, and
`@rollprobe/*` resolves through npm workspace links.

---

## Evidence

`events.ndjson` is append-only and hash-chained: every line stores the hash of the previous line,
so truncation, reordering or editing is detectable. It is a mandatory member of the bundle — a ZIP
whose hashes all match but which carries no event log fails verification, and the manifest's event
count is measured from the archived file rather than supplied by the caller.

Verification recomputes **every event hash, every previous-hash link and every sequence number**
from the archived bytes; a file-level SHA-256 alone is not accepted as proof that the log is
faithful. The canonical form follows JSON semantics exactly (object members whose value is
`undefined` are omitted, `undefined` inside an array becomes `null`), so the hash can be reproduced
by any independent implementation that sorts keys and re-serialises.

`rollprobe verify` reads the ZIP with an independent reader and re-checks every file against
`manifest.json`, plus the manifest's own SHA-256.

`rollprobe replay --bundle <zip>` re-executes the recorded scenario in a fresh database and compares
the full outcome: each invariant's status, its observed and expected values, the failure signature
and the coverage summary. A replay that merely reproduces the same pass/fail flag is not reported as
stable if any of those differ.

---

## Development

```bash
npm run build          # compile all packages
npm run lint           # eslint, real rules
npm test               # 53 unit tests, no Docker needed
npm run test:integration   # requires a reachable Docker engine
```

The integration suite does not skip silently: if the engine is unreachable it fails with an
explicit message, because a silent skip is how a project ends up claiming coverage it never had.

---

## Current status

Verified on a real Docker engine (Docker Desktop 29.9.3, PostgreSQL 17 container). The exact
commit of every run is recorded in its `run.json` and in the bundle manifest (`gitSha`):

| Gate | Result |
|---|---|
| A — engineering | `npm run build` 0, `npm run lint` 0, `npm test` 67/67 |
| B — real execution | `npm run test:integration` 24/24, three consecutive runs (exit 0, 0, 0), zero leftover containers/volumes/networks after each |
| C — correctness | all six scenarios detect the buggy build (`VIOLATION`) and pass the fixed build (`BOUNDED_PASS`), 0 inconclusive |
| D — replay | evidence ZIP verifies offline with 17–21 hash-chained events, F01 reduces 4 → 1 operation with a 1-minimality proof, replay reproduces status, observed values, expectations and coverage |

What is *not* claimed: production readiness. The tool is verified against one fixture service and
six scenarios on one host. The application deployment model is local processes rather than
containers, and `app_rollback` keeps the new build's process alive until teardown so post-rollback
invariants can still be evaluated through it. The Docker engine itself is outside the tool's
control: if Docker Desktop exits mid-run, the run is reported as `INCONCLUSIVE`, never as a pass.

`.control/RECOVERY_AUDIT.md` records what the inherited tree contained. `.control/REWORK_RESPONSE.md`
maps every independent-review finding to its fix, its regression test and its re-verification.
