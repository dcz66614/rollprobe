# Rollprobe CLI

Command-line interface for rolling deployment verification.

## Commands

### `rollprobe demo`

Run demonstration campaigns with test fixtures.

```bash
rollprobe demo --port-old 3001 --port-new 3002
```

### `rollprobe run`

Execute campaigns with configuration file.

```bash
rollprobe run --config rollprobe.yaml
```

### `rollprobe report`

Generate HTML report from existing logs.

```bash
rollprobe report --input .rollprobe/logs --output report.html
```

## Usage Example

```bash
# Demo mode
./packages/cli/dist/index.js demo

# With custom ports
./packages/cli/dist/index.js demo --port-old 3001 --port-new 3002

# Generate report
./packages/cli/dist/index.js report
```
