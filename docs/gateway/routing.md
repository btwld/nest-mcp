# Routing

The gateway uses prefix-based routing to namespace tools and prompts from different upstreams. This prevents name collisions when multiple upstreams expose tools with the same name.

## How prefix routing works

Each upstream has a prefix derived from `toolPrefix` (or the upstream `name` if `toolPrefix` is not set). When the gateway aggregates tools from upstream servers, each tool name is prefixed with `{prefix}_`.

For example, with this configuration:

```typescript
upstreams: [
  { name: 'weather', transport: 'streamable-http', url: '...', toolPrefix: 'weather' },
  { name: 'github',  transport: 'streamable-http', url: '...', toolPrefix: 'gh' },
]
```

| Upstream tool | Gateway tool name |
|---------------|-------------------|
| `forecast` (weather) | `weather_forecast` |
| `alerts` (weather) | `weather_alerts` |
| `search` (github) | `gh_search` |
| `create_issue` (github) | `gh_create_issue` |

When a downstream client calls `weather_forecast`, the `RouterService` splits the name at the first underscore:

- Prefix: `weather`
- Original tool name: `forecast`

The prefix is looked up in the routing table to find the upstream name, and the call is forwarded with the original tool name.

## RoutingConfig

```typescript
import type { RoutingConfig } from '@nest-mcp/gateway';

const routing: RoutingConfig = {
  toolRouting: 'prefix',
  aggregateToolLists: true,
};
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `toolRouting` | `'prefix'` | `'prefix'` | The routing strategy. Currently only `prefix` is supported. |
| `aggregateToolLists` | `boolean` | `true` | Whether to aggregate tool lists from all upstreams. |

The routing config is optional. If omitted, the gateway defaults to `{ toolRouting: 'prefix', aggregateToolLists: true }`.

## RouterService

The `RouterService` manages the prefix-to-upstream mapping and resolves incoming tool calls.

```typescript
import { Injectable } from '@nestjs/common';
import { RouterService } from '@nest-mcp/gateway';

@Injectable()
export class MyService {
  constructor(private readonly router: RouterService) {}

  example() {
    // Resolve a prefixed tool name to its upstream and original name
    const route = this.router.resolve('weather_forecast');
    // route = { upstreamName: 'weather', originalToolName: 'forecast' }

    // Get the prefix for an upstream
    const prefix = this.router.getPrefixForUpstream('weather');
    // prefix = 'weather'

    // Build a prefixed name
    const name = this.router.buildPrefixedName('gh', 'search');
    // name = 'gh_search'
  }
}
```

### Key methods

| Method | Description |
|--------|-------------|
| `configure(upstreams, routing)` | Set up the prefix routing table from the upstream configs. Called during bootstrap. |
| `resolve(toolName)` | Splits the tool name at the first `_` and looks up the prefix. Returns `{ upstreamName, originalToolName }` or `undefined`. |
| `buildPrefixedName(prefix, toolName)` | Returns `prefix_toolName`. |
| `getPrefixForUpstream(upstreamName)` | Returns the prefix mapped to a given upstream name. |

## How resources and resource templates are prefixed

Resources use a URI-based prefix scheme instead of underscore separation. When a resource from an upstream with prefix `weather` has URI `file:///data.json`, the gateway exposes it as `weather://file:///data.json`. The same applies to resource templates.

## How prompts are prefixed

Prompts follow the same underscore-based prefixing as tools. An upstream prompt named `summarize` from an upstream with prefix `gh` becomes `gh_summarize` in the gateway.

## Aggregator services

The gateway includes four aggregator services that collect items from all healthy upstreams:

| Service | Aggregates |
|---------|-----------|
| `ToolAggregatorService` | Tools -- applies prefix to tool names |
| `ResourceAggregatorService` | Resources -- applies prefix to URIs |
| `ResourceTemplateAggregatorService` | Resource templates -- applies prefix to URI templates |
| `PromptAggregatorService` | Prompts -- applies prefix to prompt names |

All aggregators support pagination via `drainAllPages` from `@nest-mcp/common`, so they correctly handle upstream servers that paginate their list responses.

Each aggregator caches its results after the initial aggregation. You can access the cached data without re-fetching via methods like `getCachedTools()`, `getCachedResources()`, `getCachedPrompts()`, and `getCachedTemplates()`.

## See Also

- [Upstreams](./upstreams.md) -- configuring `toolPrefix`
- [Policies](./policies.md) -- policy rules match against prefixed tool names
- [Caching](./caching.md) -- cache rules match against prefixed tool names
