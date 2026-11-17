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

When a downstream client calls `weather_forecast`, the `RouterService` finds the longest registered prefix that the name starts with, followed by `_`:

- Prefix: `weather`
- Original tool name: `forecast`

The call is forwarded to that prefix's upstream with the original tool name. Because the longest prefix wins, prefixes may contain underscores: with prefixes `my` and `my_api` registered, `my_api_search` routes to `my_api` (tool `search`) and `my_search` routes to `my` (tool `search`). Overlapping prefixes like these are logged as a warning at startup, because a `my` tool whose own name starts with `api_` cannot be reached.

### Prefix rules

- Every enabled upstream must resolve to a unique prefix (`toolPrefix`, or `name` when no prefix is set). Two upstreams with the same prefix make the gateway fail at startup with a `Duplicate tool prefix` error, instead of letting one silently shadow the other.
- The MCP specification recommends tool names of 1-128 characters from `A-Z`, `a-z`, `0-9`, `_`, `-` and `.`. The gateway logs a warning for every prefixed tool name outside that set (for example a prefix containing a space or `/`); such tools are still registered, but some clients may reject them.

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
| `configure(upstreams, routing)` | Set up the prefix routing table from the upstream configs. Called during bootstrap. Throws when two enabled upstreams share a prefix. |
| `resolve(toolName)` | Matches the longest registered prefix followed by `_`. Returns `{ upstreamName, originalToolName }` or `undefined`. |
| `buildPrefixedName(prefix, toolName)` | Returns `prefix_toolName`. |
| `getPrefixForUpstream(upstreamName)` | Returns the prefix mapped to a given upstream name. |

## How resources and resource templates are prefixed

Resources use a URI-based prefix scheme instead of underscore separation. When a resource from an upstream with prefix `weather` has URI `file:///data.json`, the gateway exposes it as `weather://file:///data.json`. The same applies to resource templates.

`resources/read` results use the gateway URI as well: the `uri` of each returned content item is rewritten into the gateway's URI space (`weather://file:///data.json`), so clients can match contents to the URI they requested.

Read failures are returned as JSON-RPC errors, not as text content:

| Situation | Error code |
|-----------|------------|
| URI not known to the gateway, or the upstream reports it as not found (`-32002`) | `-32002`, with `data.uri` set to the gateway URI |
| Upstream rejects the request as invalid (`-32602`) | `-32602` |
| Upstream disconnected, unhealthy, timed out or failed | `-32603`, with a message naming the upstream |

## How prompts are prefixed

Prompts follow the same underscore-based prefixing as tools. An upstream prompt named `summarize` from an upstream with prefix `gh` becomes `gh_summarize` in the gateway.

The upstream's prompt `arguments` are advertised in the gateway's `prompts/list` (name, description, required), and the arguments a client passes to `prompts/get` are forwarded to the upstream unchanged. Argument values are strings, as in the MCP specification. A `prompts/get` for an unknown prompt fails with `-32602`; upstream failures fail with the upstream's `-32602` (for example a missing required argument) or `-32603`.

## Metadata passthrough

Besides names, descriptions, schemas and MIME types, the gateway forwards the optional display metadata of upstream items to its own lists:

| List | Forwarded fields |
|------|------------------|
| `tools/list` | `title`, `icons`, `annotations`, `outputSchema`, `execution`, `_meta` |
| `resources/list` | `title`, `icons`, `_meta` |
| `resources/templates/list` | `title`, `icons`, `_meta` |
| `prompts/list` | `title`, `icons`, `_meta`, `arguments` |

Tool `execution` is dropped when the upstream declares `taskSupport: 'optional'` or `'required'`, because the gateway forwards tool calls without task augmentation and cannot run them as tasks. Resource `size` and `annotations`, resource-template `annotations` and prompt-argument `title` are kept on the aggregated items (`GatewayService.listResources()`, etc.) but are not yet included in the gateway's own list responses.

Tool call results are forwarded with their `structuredContent` and `_meta`, so tools that advertise an `outputSchema` keep returning conforming structured results through the gateway.

## Aggregator services

The gateway includes four aggregator services that collect items from all healthy upstreams:

| Service | Aggregates |
|---------|-----------|
| `ToolAggregatorService` | Tools -- applies prefix to tool names |
| `ResourceAggregatorService` | Resources -- applies prefix to URIs |
| `ResourceTemplateAggregatorService` | Resource templates -- applies prefix to URI templates |
| `PromptAggregatorService` | Prompts -- applies prefix to prompt names |

All aggregators support pagination via `drainAllPages` from `@nest-mcp/common`, so they correctly handle upstream servers that paginate their list responses.

Each aggregator caches its results after the initial aggregation. You can access the cached data without re-fetching via methods like `getCachedTools()`, `getCachedResources()`, `getCachedPrompts()`, and `getCachedTemplates()`. `refreshUpstream(upstreamName)` re-fetches one upstream's items and replaces only that upstream's entries in the cache; the gateway calls it when an upstream reports a list change or reconnects.

## See Also

- [Upstreams](./upstreams.md) -- configuring `toolPrefix`
- [Policies](./policies.md) -- policy rules match against prefixed tool names
- [Caching](./caching.md) -- cache rules match against prefixed tool names
