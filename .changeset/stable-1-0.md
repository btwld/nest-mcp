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
