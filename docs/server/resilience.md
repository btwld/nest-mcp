# Resilience Services

The server package includes three resilience services: `RateLimiterService`, `CircuitBreakerService`, and `RetryService`. These are used internally by the execution pipeline when resilience decorators or global resilience options are configured. They can also be injected directly for custom use.

## RateLimiterService

Tracks per-tool (or per-tool-per-user) request counts within sliding time windows.

### How It Works

The service maintains in-memory buckets keyed by tool name (global) or `toolName:userId` (per-user). Each bucket tracks a count and a reset timestamp. When `checkLimit` is called:

1. Look up or create the bucket for the key.
2. Increment the count.
3. If the count exceeds `config.max`, throw an `McpError` with code `MCP_RATE_LIMIT_EXCEEDED`.

Expired buckets are cleaned up every 60 seconds.

### Configuration

```typescript
interface RateLimitConfig {
  max: number;       // Maximum calls per window
  window: string;    // Duration string: '1s', '30s', '5m', '1h', '1d'
  perUser?: boolean;  // Track per user instead of globally
}
```

### Duration Format

The `window` string is parsed by `parseDurationMs` from `@nest-mcp/common`. Supported suffixes:

| Suffix | Meaning |
|--------|---------|
| `s` | seconds |
| `m` | minutes |
| `h` | hours |
| `d` | days |

Example: `'5m'` = 300,000 ms, `'1h'` = 3,600,000 ms.

### Direct Usage

```typescript
import { Injectable } from '@nestjs/common';
import { RateLimiterService } from '@nest-mcp/server';

@Injectable()
export class MyService {
  constructor(private readonly rateLimiter: RateLimiterService) {}

  async doWork(userId?: string) {
    await this.rateLimiter.checkLimit('my-operation', { max: 10, window: '1m' }, userId);
    // ... proceed
  }
}
```

## CircuitBreakerService

Prevents cascading failures by tracking success/failure ratios and temporarily blocking calls to failing tools.

### States

| State | Behavior |
|-------|----------|
| `CLOSED` | Normal operation. Tracks failures. |
| `OPEN` | All calls immediately rejected with `McpError` (code `MCP_CIRCUIT_OPEN`). |
| `HALF_OPEN` | One test call allowed. Success closes the circuit; failure reopens it. |

### State Transitions

```
CLOSED  --[failures/total >= errorThreshold AND total >= minRequests]--> OPEN
OPEN    --[halfOpenTimeout elapsed]-------------------------------------> HALF_OPEN
HALF_OPEN --[success]---------------------------------------------------> CLOSED
HALF_OPEN --[failure]---------------------------------------------------> OPEN
```

### Configuration

```typescript
interface CircuitBreakerConfig {
  errorThreshold?: number;    // Failure ratio to trip (default: 0.5)
  timeWindow?: number;        // Tracking window in ms (default: 60000)
  minRequests?: number;       // Min requests before evaluating (default: 5)
  halfOpenTimeout?: number;   // Time before retry in ms (default: 30000)
}
```

### Direct Usage

```typescript
import { Injectable } from '@nestjs/common';
import { CircuitBreakerService } from '@nest-mcp/server';

@Injectable()
export class MyService {
  constructor(private readonly circuitBreaker: CircuitBreakerService) {}

  async callExternal() {
    return this.circuitBreaker.execute(
      'external-api',
      { errorThreshold: 0.5, minRequests: 3 },
      async () => {
        // ... your call
      },
    );
  }
}
```

You can also inspect the current state:

```typescript
const state = this.circuitBreaker.getState('external-api');
// Returns CircuitBreakerState.CLOSED | OPEN | HALF_OPEN | undefined
```

## RetryService

Retries a function with configurable backoff on failure.

### Configuration

```typescript
interface RetryConfig {
  maxAttempts: number;                          // Total attempts (including first)
  backoff: 'exponential' | 'linear' | 'fixed'; // Backoff strategy
  initialDelay?: number;                         // Initial delay in ms (default: 100)
  maxDelay?: number;                             // Max delay in ms (default: 10000)
}
```

### Backoff Calculation

| Strategy | Delay formula |
|----------|---------------|
| `fixed` | `initialDelay` (constant) |
| `linear` | `initialDelay * attempt` |
| `exponential` | `random() * min(maxDelay, initialDelay * 2^(attempt-1))` |

All delays are capped at `maxDelay`.

### Non-retriable Errors

`McpError` instances with `isRetriable === false` are thrown immediately without retrying, regardless of the retry configuration.

### Direct Usage

```typescript
import { Injectable } from '@nestjs/common';
import { RetryService } from '@nest-mcp/server';

@Injectable()
export class MyService {
  constructor(private readonly retry: RetryService) {}

  async fetchWithRetry() {
    return this.retry.execute(
      'fetch-op',
      { maxAttempts: 3, backoff: 'exponential', initialDelay: 200 },
      async () => {
        // ... your operation
      },
    );
  }
}
```

## Execution Order in the Pipeline

When resilience decorators are applied to a tool, the execution pipeline builds a chain in this order:

1. **Rate limit** -- Checked first. If exceeded, rejects before any execution.
2. **Circuit breaker** -- Wraps the execution. If OPEN, rejects immediately.
3. **Retry** -- Wraps the base handler. Retries on failure within the circuit breaker.
4. **Timeout** -- Applied as the outermost wrapper. Cancels the entire chain if exceeded.

```
Rate limit check
  -> Circuit breaker wrapper
    -> Retry wrapper
      -> Handler execution
  <- Timeout wrapper (applied to the whole promise)
```

Per-tool decorators override global resilience settings from `McpModule.forRoot`.

## See Also

- [Resilience Decorators](./resilience-decorators.md) -- `@RateLimit`, `@Retry`, `@CircuitBreaker`, `@Timeout`
- [Module](./module.md) -- Global resilience configuration
- [Execution Pipeline](./execution-pipeline.md) -- Full request lifecycle
