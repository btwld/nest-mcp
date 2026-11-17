---
"@nest-mcp/manager": minor
"@nest-mcp/nestjs": minor
---

Add a published, framework-neutral manager for bounded dynamic MCP client generations, including
deterministic draining, cleanup quarantine, key-free state lifecycle subscriptions, catalog and
operation delegation, a lease-scoped client-runtime integration callback, and optional lifecycle
observation for every managed client runtime.

Expose a thin Nest adapter at `@nest-mcp/nestjs/manager` with synchronous and asynchronous module
configuration, provider-token generation resolvers and observers, an injectable manager service,
and deterministic module shutdown.
