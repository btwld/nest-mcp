# Caching

The gateway includes an in-memory response cache that can reduce latency and load on upstream servers by caching successful tool call results.

## Configuration

Caching is configured via the `cache` option in `McpGatewayOptions`:

```typescript
import { McpGatewayModule } from '@nest-mcp/gateway';

McpGatewayModule.forRoot({
  server: { name: 'my-gateway', version: '1.0.0' },
  upstreams: [/* ... */],
  cache: {
    enabled: true,
    defaultTtl: 60000,
    maxSize: 500,
    rules: [
      { pattern: 'weather_forecast', ttl: 120000 },
      { pattern: 'gh_*', ttl: 30000 },
    ],
  },
})
```

### CacheConfig

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `enabled` | `boolean` | Yes | -- | Whether caching is active. When `false`, all cache operations are no-ops. |
| `defaultTtl` | `number` | Yes | -- | Default time-to-live in milliseconds for cached entries. |
| `maxSize` | `number` | No | `1000` | Maximum number of entries in the cache. When exceeded, the oldest entry is evicted. |
| `rules` | `CacheRule[]` | No | `[]` | Per-tool TTL overrides using glob patterns. |

### CacheRule

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `pattern` | `string` | Yes | Glob pattern matched against the prefixed tool name. Supports `*` and `?`. |
| `ttl` | `number` | Yes | TTL in milliseconds for tools matching this pattern. |

## How caching works

1. When `GatewayService.callTool()` is called, it builds a cache key from the tool name and arguments (sorted deterministically).
2. If a valid (non-expired) cache entry exists, it is returned immediately without contacting the upstream.
3. If the upstream call succeeds (no error), the response is stored in the cache with the appropriate TTL.
4. Error responses are never cached.

### Cache key format

The cache key is built as `toolName:sortedArgsJson`:

```
weather_forecast:{"city":"London","days":"3"}
```

Arguments are sorted by key to ensure consistent cache hits regardless of argument order.

## TTL resolution

Per-tool rules are evaluated in order. The first rule whose `pattern` matches the tool name determines the TTL. If no rule matches, `defaultTtl` is used.

## Eviction

The cache uses two eviction strategies:

- **Expiry-based** -- a periodic cleanup runs at `defaultTtl` intervals and removes all expired entries.
- **Size-based** -- when the cache reaches `maxSize`, the oldest entry (first inserted) is evicted before a new entry is added.

## Invalidation

The `ResponseCacheService` provides methods for manual cache invalidation:

```typescript
import { Injectable } from '@nestjs/common';
import { ResponseCacheService } from '@nest-mcp/gateway';

@Injectable()
export class MyService {
  constructor(private readonly cache: ResponseCacheService) {}

  invalidateWeather() {
    // Invalidate a specific cache key
    this.cache.invalidate('weather_forecast:{"city":"London"}');

    // Invalidate all entries matching a regex pattern
    this.cache.invalidateByPattern('weather_.*');

    // Clear the entire cache
    this.cache.clear();

    // Check current cache size
    console.log(`Cache entries: ${this.cache.size}`);
  }
}
```

### Key methods

| Method | Description |
|--------|-------------|
| `get<T>(key)` | Retrieve a cached value. Returns `undefined` if not found or expired. |
| `set<T>(key, value, toolName?)` | Store a value. If `toolName` is provided, per-tool TTL rules are applied. |
| `buildKey(toolName, args)` | Build a deterministic cache key from a tool name and arguments. |
| `invalidate(key)` | Remove a specific cache entry. |
| `invalidateByPattern(pattern)` | Remove all entries whose keys match the regex pattern. |
| `clear()` | Remove all cache entries. |
| `size` | Current number of entries in the cache. |

## See Also

- [Routing](./routing.md) -- cache patterns match against prefixed tool names
- [Transforms](./transforms.md) -- transforms run before caching
- [Module](./module.md) -- where to configure caching
