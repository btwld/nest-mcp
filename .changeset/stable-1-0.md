---
"@nest-mcp/common": major
"@nest-mcp/server": major
"@nest-mcp/client": major
"@nest-mcp/gateway": major
---

First stable release. The 1.x line is built on the v1 MCP TypeScript SDK, speaks MCP protocol
revisions `2024-11-05` through `2025-11-25`, and follows semantic versioning from here on: no
breaking changes to the public API within 1.x.

### Supported ranges

- **NestJS** `^10.0.0 || ^11.0.0 || ^12.0.0`. Stable NestJS 12 replaces the previous exact
  `12.0.0-alpha.5` pin, which rejected every stable 12 release. CI verifies the workspace and the
  packed CommonJS packages against NestJS 12 on Node.js 24 from a TypeScript 6 native ESM consumer.
- **`@modelcontextprotocol/sdk`** `^1.32.0` (was `^1.26.0`). Earlier v1 SDK releases are affected by
  published security advisories — request body and batch limits, session-scoped tasks, bearer-token
  audience checks, cross-origin redirects, and issuer-bound OAuth client credentials. Upgrade the SDK
  together with this release.
- **Node.js** `>=20`, now declared through `engines`.

### Server fixes

- `logging/setLevel` is honored per session. Log messages were sent without the transport session
  id, so a client-set level was never applied.
- Stateful Streamable HTTP sessions key their execution state by the real session id. Dynamic
  registration now reaches live sessions with `listChanged`, and sessions no longer leak a
  placeholder entry.

### Protocol conformance (MCP 2025-11-25)

- A server with no tools (prompts or resources only) no longer fails every connection, and a
  prompt declared without `parameters` no longer fails `prompts/get`.
- Cancellation relies on the SDK's per-request signal. The previous handler was shared across
  sessions, so a cancellation could reach a request with the same id in another session, and the
  response to a cancelled request was still sent.
- Elicitation and sampling requests made from a tool call are tied to that call, so Streamable
  HTTP delivers them on the call's response stream instead of dropping them when the client has
  no standalone stream open.
- Streamable HTTP answers an unknown or terminated `Mcp-Session-Id` with `404` (was `400` plus a
  discarded server instance), a missing session id on `GET`/`DELETE` with `400`, and `GET`/`DELETE`
  in stateless mode with `405`; error bodies are JSON-RPC errors. `DELETE` now goes through the
  SDK transport, so `onsessionclosed` fires.
- `session.timeout`, `session.maxConcurrent` and `session.cleanupInterval` now take effect for
  stateful Streamable HTTP sessions (they were accepted but ignored). Both limits stay off unless
  configured.
- Tool input schemas describe what the caller sends: parameters with a default are no longer
  listed as `required`.
- An invalid pagination cursor, completion for an unknown prompt or resource template, and a
  missing task in the task proxy answer with `-32602` (Invalid params). An error with code
  `-32042` (URL elicitation required) thrown by a tool reaches the client as that protocol error.
- Progress notifications stop once the request has completed and non-increasing values are
  dropped.
- A custom token verifier that reports the resource a token is bound to is now checked against
  the configured resource. The `.well-known` discovery routes are version-neutral.
- STDIO servers started with `bootstrapStdioApp` shut down when the client closes stdin.
- Request-scoped providers registered under a custom injection token resolve correctly, and
  completion handlers on request-scoped providers receive the caller's request.

### Client

- An expired Streamable HTTP session (`404`) now starts a new session through the reconnect path;
  without `reconnect` the client is marked disconnected. `disconnect()` ends the session with an
  HTTP `DELETE` first, stops a reconnection in progress, and a connection closed by the caller is
  never reopened automatically.
- Resource subscriptions are replayed after a reconnect.
- `onNotification` supports several handlers per method and no longer replaces the SDK's own
  progress and cancellation handling.
- Capabilities declared by handlers are merged per key with the `capabilities` option, so nested
  flags survive handler registration and reconnects.
- `connectTimeout` now takes effect (it was accepted but ignored).
- New options: `clientInfo`, `elicitationModes` and `setElicitationHandler(handler, { modes })`
  for URL-mode elicitation, `fetch`, `reconnectionOptions`, `sessionId`, and `stderr` for stdio.
  Sampling, elicitation and roots handlers receive the SDK request `extra` as an optional last
  argument.
- `drainAllPages` accepts `{ maxPages, onTruncated }`, and the `listAll*` methods log a warning
  when the page cap cuts a listing short.

### Gateway

- Tool results keep `structuredContent` and `_meta` from the upstream (also when served from the
  cache). They were dropped while the tool's output schema was still advertised, so clients
  rejected every structured tool.
- Proxied prompts keep their `arguments` in `prompts/list`, and `prompts/get` forwards the
  caller's arguments.
- `readResource`, `readResourceTemplate` and `getPrompt` answer upstream failures with JSON-RPC
  errors instead of returning the error as content, and read results carry gateway URIs.
- `UpstreamConfig.timeout` cancels the upstream request when it expires and is honored above
  60 seconds. Progress and completion context are forwarded to the upstream.
- Tools are routed by the longest matching prefix, so prefixes may contain `_`. Duplicate
  prefixes now fail at startup instead of overwriting each other.
- Upstream `title`, `icons`, `_meta` and tool `execution` reach the gateway's lists.
- `UpstreamConfig.reconnect` now takes effect (it was documented but never read; off unless
  `enabled: true`), and an upstream's lists are re-synced after a reconnect or when the upstream
  sends `list_changed`.
- Dynamic builders accept `title`, `icons` and `_meta` (plus `execution` for tools and raw
  `arguments` for prompts).

### Server features

- **Request-scoped providers**: tools, resources and prompts declared on request- or
  transient-scoped providers resolve a fresh instance per call, with `@Inject(REQUEST)` support.
  They were previously registered as never-constructed instances.
- **`advertiseSecuritySchemes`** (opt-in): `tools/list` entries carry `_meta.securitySchemes`
  derived from `@Public` / `@Scopes`.
- **`McpModule.forRootAsync`** accepts `useClass`, `useExisting` and `extraProviders` in addition to
  `useFactory`.
- **SSE behind path prefixes**: the `endpoint` event derives the messages URL from the incoming
  request path, so `app.setGlobalPrefix()` and `RouterModule` prefixes work.

### Documentation

- New guides for dependency injection, elicitation and tool exposure, a compatibility table in the
  README, and documented Express/Fastify platform support.
- Quick-start snippets corrected to the real `@Tool({ parameters })` and
  `McpModule.forRoot({ transport })` options.
