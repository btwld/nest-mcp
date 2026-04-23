# @nest-mcp/server

## 0.5.0

### Minor Changes

- 632d8f0: Add tool exposure / discovery-strategy configuration. Large tool catalogs can now avoid bloating the initial prompt by deferring schemas until they are needed.

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

### Patch Changes

- Updated dependencies [632d8f0]
  - @nest-mcp/common@0.3.0

## 0.4.0

### Minor Changes

- 043aa34: Add `imports` option to `McpModule.forFeature()` allowing feature modules to import other modules that export providers needed by the feature's tools.

## 0.3.0

### Minor Changes

- 5a6ef8e: feat: add advanced transport options and fix logging configuration

  **Transport options** — `StreamableHttpTransportOptions` now supports `sessionIdGenerator`, `enableJsonResponse`, `eventStore`, `onsessioninitialized`, `onsessionclosed`, and `retryInterval`, passed through to the MCP SDK's `StreamableHTTPServerTransport`.

  **Logging** — `McpModuleOptions.logging` type changed from `{ level?: string }` to `false | LogLevel[]`. The old type was declared but never consumed. `bootstrapStdioApp()` now reads `logging` from `McpModule.forRoot()` as a fallback when `StdioBootstrapOptions.logLevels` is not explicitly provided.

  **SDK re-exports** — `EventStore`, `StreamId`, and `EventId` types are now re-exported from `@nest-mcp/server`.

  **BREAKING**: `logging` type change is compile-time only (the old field was never consumed at runtime). Migration: `{ level: 'error' }` → `['error']`.

### Patch Changes

- Updated dependencies [5a6ef8e]
  - @nest-mcp/common@0.2.0

## 0.2.4

### Patch Changes

- f943fca: Migrate to Zod v4. Zod v4 is now the required peer dependency.
- Updated dependencies [f943fca]
  - @nest-mcp/common@0.1.8

## 0.2.3

### Patch Changes

- 0e1b932: Add npm keywords to all packages for improved discoverability
- Updated dependencies [0e1b932]
  - @nest-mcp/common@0.1.7

## 0.2.2

### Patch Changes

- 3fd3c19: Exclude .d.ts.map files from published packages — reduces file count by ~50%
- Updated dependencies [3fd3c19]
  - @nest-mcp/common@0.1.6

## 0.2.1

### Patch Changes

- ac72e05: Add homepage links and npm/CI badges to each package README
- Updated dependencies [ac72e05]
  - @nest-mcp/common@0.1.5

## 0.2.0

### Minor Changes

- 95170f0: Re-export all @nest-mcp/common types from each package — users no longer need to install or import from @nest-mcp/common directly

## 0.1.4

### Patch Changes

- aaca8d0: Fix npm provenance via NPM_CONFIG_PROVENANCE environment variable
- Updated dependencies [aaca8d0]
  - @nest-mcp/common@0.1.4

## 0.1.3

### Patch Changes

- 378b3c3: Enable npm provenance on publish
- Updated dependencies [378b3c3]
  - @nest-mcp/common@0.1.3

## 0.1.2

### Patch Changes

- 3dc43bd: Change license from MIT to BSD-3-Clause
- Updated dependencies [3dc43bd]
  - @nest-mcp/common@0.1.2

## 0.1.1

### Patch Changes

- e6dd416: Add README to each package for npm display
- Updated dependencies [e6dd416]
  - @nest-mcp/common@0.1.1
