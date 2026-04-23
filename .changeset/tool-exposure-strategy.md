---
'@nest-mcp/common': minor
'@nest-mcp/server': minor
---

Add tool exposure / discovery-strategy configuration. Large tool catalogs can now avoid bloating the initial prompt by deferring schemas until they are needed.

Configure via `McpModuleOptions.exposure` with a static strategy or a per-client resolver:

- `{ kind: 'eager' }` — current behaviour, full schemas in `tools/list`.
- `{ kind: 'search', variant: 'bm25' | 'regex', eager?, onAllDeferred? }` — annotates deferred tools with `_meta.defer_loading: true` for Anthropic's Tool Search Tool beta.
- `{ kind: 'lazy', eager?, indexToolName?, schemaToolName?, maxBatchSize?, requireDiscovery? }` — vendor-neutral: ships `list_available_tools` and `get_tool_schema` meta-tools so clients pull definitions on demand.
- `{ kind: 'typed-api' }` — reserved for Code Mode; throws at runtime in this release.

Also ships:

- `clientSupports.search(ctx)` capability helper (checks the `advanced-tool-use-2025-11-20` beta header — no model regex required in user code).
- `preferSearchElseLazy({ eager })` preset resolver for the common per-client tiering case.
- `defineResolver([...kinds], fn)` to declare which strategy kinds a custom resolver can produce. `ExposureService` uses this declaration to skip conservative meta-tool registration when `lazy` is not reachable.
- `buildClientContext({ transport, request, clientInfo, model })` helper that parses `anthropic-beta` headers into `ClientContext`.
- `@Tool({ ..., tags, exposure })` decorator fields. `tags` feeds selectors like `eager: { tags: ['core'] }`; `exposure: 'eager' | 'deferred' | 'auto'` overrides module policy per tool.

All new fields are optional; existing servers continue to behave as before. No protocol extensions — both the `search` annotations and the `lazy` meta-tools work over plain MCP JSON-RPC.
