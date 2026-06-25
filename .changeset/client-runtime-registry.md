---
"@nest-mcp/client": minor
---

Add runtime connection registry to `McpClientsService`: `addConnection(connection)`,
`getOrCreate(connection)`, `removeConnection(name)`, and `has(name)`. This lets apps register and
tear down MCP client connections at runtime — for multi-tenant gateways where upstreams are
discovered after module init — instead of fixing all connections at `forRoot`/`forRootAsync` time.

`addConnection`/`getOrCreate` are idempotent (a connected client with the same name is reused, a
stale one is replaced, and concurrent first-connects dedupe to a single client); a client whose
`connect()` rejects is not registered. Runtime clients join the same collection as the static ones,
so they are returned by `getClient`/`getClients` and disconnected on application shutdown. Purely
additive — existing `getClient`/`getClients` behavior is unchanged.
