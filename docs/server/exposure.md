# Exposure Strategies

Exposure controls how `tools/list` presents your catalog to clients. With
dozens or hundreds of tools, listing every full schema eagerly wastes the
model's context window — exposure strategies defer the long tail behind
meta-tools while keeping a curated subset eager. Execution (`tools/call`) is
unaffected.

## Strategies

Configured via `McpModule.forRoot({ exposure })`:

| Kind | Behavior |
|------|----------|
| `{ kind: 'eager' }` | Default. Every tool with its full schema in `tools/list` |
| `{ kind: 'search', variant: 'regex' \| 'bm25' }` | Anthropic Tool Search Tool style: eager subset + a search meta-tool that discovers the rest |
| `{ kind: 'lazy' }` | Eager subset + `list_available_tools` index meta-tool + `get_tool_schema` batch schema fetch |
| `{ kind: 'typed-api' }` | Tool catalog presented as a typed API surface |

The `eager` selector picks which tools stay fully listed, in any of three
forms:

```typescript
exposure: { kind: 'lazy', eager: ['search-docs', 'get-status'] }      // exact names
exposure: { kind: 'lazy', eager: { tags: ['core'] } }                  // by @Tool({ tags })
exposure: { kind: 'lazy', eager: (meta) => meta.name.startsWith('q') } // predicate
```

### Lazy strategy options

```typescript
exposure: {
  kind: 'lazy',
  eager: { tags: ['core'] },
  indexToolName: 'list_available_tools', // default
  schemaToolName: 'get_tool_schema',     // default
  indexFields: ['name', 'description', 'tags'],
  maxBatchSize: 20,
  requireDiscovery: false, // true rejects calls to undiscovered deferred tools
}
```

## Per-tool override

`@Tool({ exposure: 'eager' | 'deferred' | 'auto' })` overrides the module
strategy for that tool (decorator wins).

## Per-client strategies

Pass a resolver instead of a static strategy to tier clients (e.g. give
search-capable clients the search strategy and everyone else lazy):

```typescript
import { defineResolver, preferSearchElseLazy } from '@nest-mcp/common';

exposure: preferSearchElseLazy({ eager: { tags: ['core'] } })
// or a custom resolver over ClientContext (clientInfo, betaHeaders, transport).
// The first argument declares which strategy kinds the resolver may return:
exposure: defineResolver(['search', 'lazy'], (client) =>
  client.betaHeaders?.includes('tool-search-tool-2025-10-19')
    ? { kind: 'search', variant: 'bm25' }
    : { kind: 'lazy' },
)
```

## See Also

- [Module configuration](./module.md)
- [Decorators](./decorators.md)
