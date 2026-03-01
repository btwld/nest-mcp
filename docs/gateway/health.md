# Health Checks

The `HealthCheckerService` monitors upstream server availability by sending periodic MCP `ping` requests. Unhealthy upstreams are excluded from tool aggregation and tool call routing.

## Configuration

Health checks are configured per-upstream via the `healthCheck` property in `UpstreamConfig`:

```typescript
McpGatewayModule.forRoot({
  server: { name: 'my-gateway', version: '1.0.0' },
  upstreams: [
    {
      name: 'weather',
      transport: 'streamable-http',
      url: 'http://localhost:4001/mcp',
      healthCheck: {
        enabled: true,
        intervalMs: 15000,
        timeoutMs: 3000,
      },
    },
  ],
})
```

### Health check options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | `boolean` | `true` (when `healthCheck` is not explicitly `false`) | Whether to run periodic health checks. |
| `intervalMs` | `number` | `30000` | Milliseconds between consecutive health check pings. |
| `timeoutMs` | `number` | `5000` | Milliseconds before a health check ping is considered timed out. |

Health checks are automatically started during gateway bootstrap for all enabled upstreams where `healthCheck.enabled` is not explicitly set to `false`.

## How health checks work

1. At each `intervalMs` interval, the `HealthCheckerService` calls `client.ping()` on the upstream's MCP client.
2. The ping uses an `AbortController` with a timeout of `timeoutMs`.
3. If the ping succeeds, the upstream is marked as healthy via `UpstreamManagerService.setHealthy(name, true)`.
4. If the ping fails or times out, the upstream is marked as unhealthy with the error message via `setHealthy(name, false, errorMessage)`.

## Impact of health status

When an upstream is marked unhealthy:

- **Tool aggregation** -- the aggregator services skip unhealthy upstreams, so their tools/resources/prompts are not listed.
- **Tool calls** -- `GatewayService.callTool()` returns an error response (`"Upstream X is unhealthy"`) instead of forwarding the call.
- **Resource reads** -- `readResource()` and `readResourceTemplate()` return error responses for unhealthy upstreams.
- **Prompt fetching** -- `getPrompt()` returns an error response for unhealthy upstreams.
- **Task operations** -- `TaskAggregatorService` skips unhealthy upstreams in `listTasks`, `getTask`, and `cancelTask`.

An upstream automatically recovers when the next health check ping succeeds.

## Using HealthCheckerService directly

```typescript
import { Injectable } from '@nestjs/common';
import { HealthCheckerService, UpstreamManagerService } from '@nest-mcp/gateway';

@Injectable()
export class MyHealthMonitor {
  constructor(
    private readonly healthChecker: HealthCheckerService,
    private readonly upstreamManager: UpstreamManagerService,
  ) {}

  async checkNow(upstreamName: string) {
    // Run an immediate health check
    const healthy = await this.healthChecker.check(upstreamName, 5000);
    console.log(`${upstreamName} is ${healthy ? 'healthy' : 'unhealthy'}`);
  }

  stopChecks(upstreamName: string) {
    // Stop periodic health checks for a specific upstream
    this.healthChecker.stop(upstreamName);
  }

  manualOverride(upstreamName: string) {
    // Manually mark an upstream as healthy or unhealthy
    this.upstreamManager.setHealthy(upstreamName, false, 'Manually disabled');
  }
}
```

### Key methods

| Method | Description |
|--------|-------------|
| `startAll(configs)` | Start periodic health checks for all enabled upstreams. Called during bootstrap. |
| `start(config)` | Start health checks for a single upstream. |
| `check(name, timeoutMs?)` | Run a single immediate health check. Returns `true` if healthy. |
| `stop(name)` | Stop periodic health checks for a specific upstream. |
| `stopAll()` | Stop all periodic health checks. |

## Cleanup

The `HealthCheckerService` implements `OnModuleDestroy` and automatically clears all intervals when the NestJS application shuts down.

## See Also

- [Upstreams](./upstreams.md) -- upstream configuration including health check options
- [Routing](./routing.md) -- how unhealthy upstreams affect tool aggregation
- [Module](./module.md) -- bootstrap lifecycle
