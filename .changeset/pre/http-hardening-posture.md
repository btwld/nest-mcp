---
"@nest-mcp/server": minor
"@nest-mcp/nestjs": minor
---

**Breaking default:** MCP HTTP serving now applies a fail-closed security posture. Browser requests
from routable origins are rejected until their hostnames are listed in
`httpSecurity.allowedOriginHostnames` (requests without an `Origin` header are unaffected); opt out
entirely with `allowedOriginHostnames: false`. Request bodies are capped at 1 MiB by default
(`maxBodyBytes`), enforced on the raw Node stream before the SDK buffers it and again at the fetch
layer.

Added MCP-aware CORS: the 2026-07-28 revision's `Mcp-Method`/`Mcp-Name` headers make every browser
MCP POST CORS-preflighted, and the SDK handler answers preflights with 405 — the runtime now
answers them for allowed origins and decorates responses. `@nest-mcp/server/security` gains
`resolveMcpHttpSecurity`, `hardenMcpFetch`, `McpHardenedServer`, `withMcpNodeBodyLimit`, and the
`MCP_CORS_*` header constants; runtime observers see pre-dispatch rejections as `request:rejected`
events. `@nest-mcp/nestjs` adds `mcpCorsOptions()` for `app.enableCors()` and a
`getHttpSecurityOptions()` controller override that replaces the runtime posture for one route.
