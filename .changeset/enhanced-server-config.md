---
'@nest-mcp/common': minor
'@nest-mcp/server': minor
---

feat: add advanced transport options and fix logging configuration

**Transport options** — `StreamableHttpTransportOptions` now supports `sessionIdGenerator`, `enableJsonResponse`, `eventStore`, `onsessioninitialized`, `onsessionclosed`, and `retryInterval`, passed through to the MCP SDK's `StreamableHTTPServerTransport`.

**Logging** — `McpModuleOptions.logging` type changed from `{ level?: string }` to `false | LogLevel[]`. The old type was declared but never consumed. `bootstrapStdioApp()` now reads `logging` from `McpModule.forRoot()` as a fallback when `StdioBootstrapOptions.logLevels` is not explicitly provided.

**SDK re-exports** — `EventStore`, `StreamId`, and `EventId` types are now re-exported from `@nest-mcp/server`.

**BREAKING**: `logging` type change is compile-time only (the old field was never consumed at runtime). Migration: `{ level: 'error' }` → `['error']`.
