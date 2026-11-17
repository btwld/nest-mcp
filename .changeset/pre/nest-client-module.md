---
"@nest-mcp/nestjs": minor
"@nest-mcp/client": patch
"@nest-mcp/gateway": patch
---

Add a standalone Nest-owned `McpClientModule` and injectable `McpClientService` with synchronous
and asynchronous configuration, module-local collaborators, optional `bootstrap.connectAll`
connection, failed bootstrap rollback, and deterministic shutdown. The framework-neutral
`McpClientRuntime` remains directly constructible from `@nest-mcp/client`.

Compose outbound clients into `McpModule` through Nest module imports instead of embedding raw
client runtime options in the inbound server root. Resolve callback-bearing client, gateway, and
server collaborators from explicit singleton provider tokens, including transport/auth factories,
middleware and lifecycle observers, gateway codecs and caches, request-state verification, JSON
schema validators, and distributed server event buses. Context-aware gateway upstream selection is
now supplied by an injectable `McpGatewayClientProvider`; raw structural upstreams remain available
only from the framework-neutral gateway package. The neutral client's default implementation
identity now derives its version from package metadata so prerelease bumps cannot drift. Provider
binding also preserves client and gateway exact-transform identity and its typed continuation
guarantees.

`McpHttpControllerFor()` now accepts only the server name. Compose HTTP wrappers and Node-adapter
error reporting through the controller's protected overrides so those paths can use injected Nest
providers instead of factory-captured callbacks. Nest client configuration no longer accepts a raw
singleton `runtime.principal`; use the provider-backed `principalResolver` seam.
