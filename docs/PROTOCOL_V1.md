# Rollprobe Protocol v1

Frozen protocol specification for the Rollprobe project. This document describes the data structures and validation rules that must be followed across all modules.

## Version

- **Protocol**: `rollprobe/v1`
- **Status**: Frozen - changes require separate migration process

## Core Types

### Phases

- `baseline` - Old version with old schema
- `expanded` - New version with expanded schema (after migration)
- `mixed` - Both old and new versions running together after migration
- `new_only` - Only new version running
- `app_rollback` - Rolling back to old version while keeping new schema and data
- `schema_rollback` - Explicit rollback of schema to old version

### Observation Status

- `ok` - Successful operation
- `sut_error` - System under test produced an error
- `expected_transport_fault` - Planned fault injection (e.g., response discard)
- `infra_error` - Infrastructure failure (DB unavailable, container crash)
- `timeout` - Operation exceeded timeout threshold
- `unsupported` - Capability not supported by current environment

### Check Result Status

- `satisfied` - All requirements met
- `violated` - Business rule broken (authoritative)
- `observed_difference` - Semantic difference detected (version-aware contract)
- `inconclusive` - Cannot determine due to infrastructure issues or missing observations
- `skipped` - Test was not executed

## Configuration Schema

The main configuration file must conform to the ConfigSchema which requires:

- **protocol**: Must be exactly "rollprobe/v1"
- **project**: Human-readable project name
- **versions**: Separate old and new application images
- **database**: PostgreSQL configuration with fixture paths
- **deployment**: Rollback behavior settings
- **scenarios**: Array of YAML scenario files
- **contracts**: Array of contract definition files
- **budget**: Campaign limits (max campaigns, operations, time, evaluations)
- **verification**: Capabilities required for full acceptance

## Validation Rules

1. **Unknown fields rejected**: Any field not in allowed keys causes validation failure
2. **DAG cycles rejected**: Task dependencies must form a directed acyclic graph
3. **Missing references rejected**: Tasks cannot depend on non-existent tasks
4. **Required files validated**: Database fixtures and scenario files must be referenced
5. **Version locking**: Application versions must be resolved to immutable digests before execution

## File Format

- Input configuration uses YAML format
- Internal processing uses TypeScript interfaces with Zod validation
- Results stored as NDJSON (append-only event log)
- Bundle packages use ZIP format with manifest.json

## Usage Example

```typescript
import { ConfigSchema, ProtocolValidator } from '@rollprobe/protocol';

// Parse YAML config into object
const config = parseYAML(configText);

// Validate against frozen schema
const result = ProtocolValidator.validateConfig(config);

if (!result.valid) {
  console.error('Invalid configuration:', result.errors);
  process.exit(64); // Exit code 64 = configuration error
}

// Extract validated config
const validated = ConfigSchema.parse(config);
```

## Extending the Protocol

Changes to this protocol require:

1. ADR (Architecture Decision Record) documenting the change
2. Migration strategy for existing bundles and results
3. Updated schema validation in both read and write paths
4. Backward compatibility layer if possible
