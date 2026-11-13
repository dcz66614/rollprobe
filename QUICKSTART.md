# Quick start

Five minutes from a clean checkout to a real verification run.

## 1. Prerequisites

- Node.js 20 or newer (`node -v`)
- Docker Desktop running with a reachable Linux engine (`docker info`)

Rollprobe pulls `postgres:17` the first time it provisions a database.

## 2. Install and build

```bash
npm ci
npm run build
```

## 3. Check the host

```bash
node packages/cli/dist/index.js doctor
```

You should see `Environment looks ready.` If the engine line says `FAIL`, start Docker Desktop and
re-run. `doctor` exits `2` when something critical is missing, so it is safe to use in scripts.

## 4. Run one scenario

```bash
node packages/cli/dist/index.js run \
  --scenario fixtures/cases/F01-cross-version-idempotency.yaml \
  --mode both \
  --report
```

Expected output shape:

```
== f01-cross-version-idempotency [buggy] ==
  scenario   f01-cross-version-idempotency
  control    buggy
  status     VIOLATION  (exit 1)
  coverage   1/2 satisfied, 1 violated, 0 inconclusive
  bundle     .rollprobe/runs/<campaign>/f01...__buggy/bundle.zip (verified: true, 7 files)

== f01-cross-version-idempotency [fixed] ==
  status     BOUNDED_PASS  (exit 0)
```

The buggy build must produce `VIOLATION` and the fixed build must produce `BOUNDED_PASS`. If both
produce the same status, the scenario is not a valid detector.

## 5. Run everything

```bash
node packages/cli/dist/index.js demo
open .rollprobe/demo/report.html
```

The report is a single self-contained HTML file — no network access required.

## 6. Inspect the evidence

```bash
# verify an archive offline
node packages/cli/dist/index.js verify --bundle .rollprobe/demo/f01-cross-version-idempotency__buggy/bundle.zip

# re-run the recorded scenario in a clean database and diff the outcome
node packages/cli/dist/index.js replay --bundle .rollprobe/demo/f01-cross-version-idempotency__buggy/bundle.zip

# reduce a failing scenario to the smallest sequence that still fails
node packages/cli/dist/index.js shrink \
  --scenario fixtures/cases/F01-cross-version-idempotency.yaml \
  --mode buggy
```

## 7. Write your own scenario

Copy `fixtures/cases/F05-warm-old-stale-schema-cache.yaml`, change the `id`, the operations and the
invariants, and run it with `--scenario`. The schema is defined once in
`packages/protocol/src/scenario.ts`; `doctor` validates every file in `fixtures/cases/`, so a
malformed scenario is reported before anything is provisioned.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `doctor` prints `docker-engine FAIL` | Docker Desktop is not running, or the Linux engine is stopped |
| `status INCONCLUSIVE`, reason mentions `transport` | the application process died; check `apps/*.log` in the run directory |
| `status INCONCLUSIVE`, reason mentions `no rows` | the invariant's query returned nothing — usually the scenario's setup operations did not run |
| `bundle.zip (verified: false)` | a file changed after the manifest was written; treat the run as invalid |
