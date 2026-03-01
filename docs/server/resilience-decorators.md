# Resilience Decorators

Resilience decorators add rate limiting, retry, circuit breaking, and timeout behavior to individual tool handlers. They override global resilience settings from `McpModule.forRoot`.

## @RateLimit

Limits the number of calls to a tool within a time window.

```typescript
import { Injectable } from '@nestjs/common';
import { Tool, RateLimit } from '@nest-mcp/server';
import { z } from 'zod';

@Injectable()
export class ApiService {
  @Tool({
    name: 'search',
    description: 'Search the web',
    parameters: z.object({ query: z.string() }),
  })
  @RateLimit({ max: 10, window: '1m' })
  async search(args: { query: string }) {
    return { content: [{ type: 'text', text: `Results for: ${args.query}` }] };
  }
}
```

### RateLimitConfig

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `max` | `number` | Yes | Maximum number of calls allowed in the window |
| `window` | `string` | Yes | Time window (e.g., `'1s'`, `'30s'`, `'5m'`, `'1h'`) |
| `perUser` | `boolean` | No | If `true`, limits are tracked per user instead of globally |

When `perUser` is `true`, the bucket key is `toolName:userId`. If the user ID is not available, it falls back to a global (tool-level) bucket.

When the limit is exceeded, an `McpError` is thrown with code `MCP_RATE_LIMIT_EXCEEDED` and a `retryAfter` value in seconds.

## @Retry

Retries a failed tool execution with configurable backoff.

```typescript
import { Injectable } from '@nestjs/common';
import { Tool, Retry } from '@nest-mcp/server';
import { z } from 'zod';

@Injectable()
export class ExternalService {
  @Tool({
    name: 'fetch-data',
    description: 'Fetch data from external API',
    parameters: z.object({ url: z.string() }),
  })
  @Retry({ maxAttempts: 3, backoff: 'exponential', initialDelay: 200 })
  async fetchData(args: { url: string }) {
    // If this throws, it will be retried up to 3 times
    return { content: [{ type: 'text', text: 'data' }] };
  }
}
```

### RetryConfig

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `maxAttempts` | `number` | Yes | Maximum number of attempts (including the first) |
| `backoff` | `'exponential' \| 'linear' \| 'fixed'` | Yes | Backoff strategy |
| `initialDelay` | `number` | No | Initial delay in ms (default: 100) |
| `maxDelay` | `number` | No | Maximum delay in ms (default: 10000) |

### Backoff Strategies

- **`fixed`** -- Constant delay of `initialDelay` ms between retries
- **`linear`** -- Delay increases linearly: `initialDelay * attemptNumber`
- **`exponential`** -- Delay grows exponentially with jitter: `random() * min(maxDelay, initialDelay * 2^(attempt-1))`

Non-retriable `McpError` instances (where `isRetriable` is `false`) are thrown immediately without retrying.

## @CircuitBreaker

Prevents repeated calls to a failing tool by opening a circuit after a threshold of failures.

```typescript
import { Injectable } from '@nestjs/common';
import { Tool, CircuitBreaker } from '@nest-mcp/server';

@Injectable()
export class DatabaseService {
  @Tool({
    name: 'query-db',
    description: 'Run a database query',
  })
  @CircuitBreaker({
    errorThreshold: 0.5,
    minRequests: 5,
    halfOpenTimeout: 30000,
  })
  async queryDb() {
    return { content: [{ type: 'text', text: 'results' }] };
  }
}
```

### CircuitBreakerConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `errorThreshold` | `number` | `0.5` | Failure ratio (0-1) to trip the circuit |
| `timeWindow` | `number` | `60000` | Time window in ms for tracking failures |
| `minRequests` | `number` | `5` | Minimum requests before evaluating the threshold |
| `halfOpenTimeout` | `number` | `30000` | Time in ms before transitioning from OPEN to HALF_OPEN |

### State Transitions

```
CLOSED  --[failure ratio >= threshold]--> OPEN
OPEN    --[halfOpenTimeout elapsed]-----> HALF_OPEN
HALF_OPEN --[success]-------------------> CLOSED
HALF_OPEN --[failure]-------------------> OPEN
```

When the circuit is OPEN, calls immediately fail with an `McpError` (code `MCP_CIRCUIT_OPEN`) without executing the handler.

## @Timeout

Sets a maximum execution time for a tool handler.

```typescript
import { Injectable } from '@nestjs/common';
import { Tool, Timeout } from '@nest-mcp/server';

@Injectable()
export class SlowService {
  @Tool({
    name: 'long-running',
    description: 'A potentially slow operation',
  })
  @Timeout(5000) // 5 seconds
  async longRunning() {
    // If this takes longer than 5s, a McpTimeoutError is thrown
    return { content: [{ type: 'text', text: 'done' }] };
  }
}
```

`@Timeout(ms)` takes a single number argument -- the timeout in milliseconds. If the handler does not complete within the specified time, a `McpTimeoutError` is thrown.

The timeout also respects the `AbortSignal` from client cancellation -- if the client cancels the request, the timeout is cleared and an `McpError` with code `MCP_REQUEST_CANCELLED` is thrown.

## Combining Decorators

Multiple resilience decorators can be stacked on a single handler:

```typescript
@Tool({
  name: 'resilient-tool',
  description: 'A tool with full resilience',
})
@RateLimit({ max: 5, window: '1m' })
@Retry({ maxAttempts: 2, backoff: 'fixed', initialDelay: 500 })
@CircuitBreaker({ errorThreshold: 0.5, minRequests: 3 })
@Timeout(10000)
async resilientTool() {
  return { content: [{ type: 'text', text: 'ok' }] };
}
```

The execution order is: rate limit check -> circuit breaker wrapper -> retry wrapper -> timeout wrapper -> handler execution.

## See Also

- [Resilience](./resilience.md) -- Underlying service implementations
- [Module](./module.md) -- Global resilience defaults
- [Execution Pipeline](./execution-pipeline.md) -- How resilience fits in the request lifecycle
