# @rollprobe/scenario

HTTP operation executor for Rollprobe scenarios.

## Features

- HTTP request execution with proper retry handling disabled
- Variable reference resolution (ref syntax)
- Logical operation ID tracking for idempotency
- Response capture and observation recording
- Transport fault detection and classification

## Usage

```typescript
import { HTTPExecutor, Operation } from '@rollprobe/scenario';

const executor = new HTTPExecutor({
  baseUrl: 'http://localhost:3001',
  timeoutMs: 30000,
  redirectMode: 'manual'
});

const operation: Operation = {
  id: 'create-order',
  kind: 'http',
  phase: 'baseline',
  requires: [],
  produces: { orderId: 'response.body.id' },
  payload: {
    method: 'POST',
    endpoint: '/orders',
    body: { customer_id: 'CUST-001', amount_cents: 5000 }
  },
  removable: false
};

const result = await executor.execute(operation, {
  campaignId: 'campaign-123',
  runId: 'run-456',
  producedVars: new Map()
});
```
