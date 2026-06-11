# @nest-mcp/common

## 0.5.0

### Minor Changes

- f836e53: feat: OAuth/transport hardening for the streamable HTTP transport and `McpAuthModule`

  **Behavioral callout — per-request auth context.** Handler and guard contexts
  on the streamable HTTP transport are now rebuilt per request from the SDK's
  `RequestHandlerExtra`: `ctx.request` is the per-request `RequestInfo`
  (`{ headers }`) instead of the session's _initialize_ `IncomingMessage`.
  Code reading `ctx.request.url` / `ctx.request.method` must migrate to header
  inspection (or a controller guard); previously those values were stale
  captures from the first request of the session anyway. `ctx.authInfo` and
  `ctx.user` are likewise populated from the verified per-request identity.

  Streamable HTTP transport:

  - `transportOptions.streamableHttp.oauth` — opt-in bearer-token gate
    (`enabled`, `required`, `resourceMetadataUrl`, `bindSessionToUser`).
    Unauthorized requests get HTTP 401 with a `WWW-Authenticate: Bearer ...
resource_metadata="..."` challenge (RFC 9728 discovery flow). Tokens are
    verified via the overridable `MCP_BEARER_TOKEN_VERIFIER` provider
    (`BearerTokenVerifier` interface, default `JwtBearerTokenVerifier`).
  - Session binding: when oauth is enabled, stateful sessions are bound to the
    principal that initialized them; requests from another principal get 403.
    Only active with `oauth.enabled` — existing stateful servers are unaffected.
  - DNS-rebinding options forwarded to the SDK transport: `allowedHosts`,
    `allowedOrigins`, `enableDnsRebindingProtection`.
  - `controllerGuards` / `controllerDecorators` applied to the generated
    controller (static even with `forRootAsync`, like `endpoint`).
  - `filterListsByScopes` McpModule option: `tools/resources/templates/prompts`
    list results hide items whose required scopes the caller's token lacks.

  `McpAuthModule` / OAuth server:

  - `McpAuthModule.forRootAsync({ imports?, serverUrl?, useFactory, inject? })`
    with the same `jwtSecret` validation as `forRoot`; the well-known controller
    now constructor-injects `MCP_AUTH_OPTIONS`. `MCP_OAUTH_STORE` is provided
    via a factory in both variants, so a store supplied through options/DI wins
    over the in-memory default.
  - Well-known compliance: `introspection_endpoint` (+
    `introspection_endpoint_auth_methods_supported`,
    `revocation_endpoint_auth_methods_supported`) in the RFC 8414 document, and
    path-insertion wildcard routes for both
    `/.well-known/oauth-authorization-server/*` and
    `/.well-known/oauth-protected-resource/*` (Nest 10 and 11 wildcard syntax
    both supported).
  - RFC 8707 audience binding: access tokens carry
    `aud = resource ?? audience ?? 'mcp-client'`; `validateToken` still does not
    enforce `aud` (non-breaking). Access tokens now also carry a `jti`, making
    them individually revocable.
  - Optional `IOAuthStore.recordIssuedToken(rec)` hook invoked for both tokens
    on the initial grant and on refresh, enabling issued-token tracking and
    refresh-chain revocation; revoked refresh `jti`s are rejected before reuse.
  - New exports: `resolveGuard`, `McpAuthModuleAsyncOptions`,
    `IssuedTokenRecord` (plus the new transport option types via
    `@nest-mcp/common`).

  Requires `@modelcontextprotocol/sdk` peer `^1.26.0` (per-request `authInfo`
  and `requestInfo` on `RequestHandlerExtra`).

  Fix: refresh tokens now carry the `scope` claim, so access tokens re-minted by
  the `refresh_token` grant preserve the originally granted scopes (previously
  they came back scope-less and failed every scope check).

## 0.4.0

### Minor Changes

- 2fde58b: feat(common,server): expose tool/prompt arguments on `McpGuardContext`

  Custom guards now receive an `arguments` field on the `McpGuardContext`
  populated with the raw arguments the caller passed to `tools/call` or
  `prompts/get`. Values are pre-Zod (validation runs after auth), so guards
  inspecting fields should treat them as `unknown`. Resource guards still
  receive only `resourceUri`.

- 2fde58b: feat(common,server): add `serverMutator`, `title`, `websiteUrl`, and `icons` to `McpModuleOptions`

  - `serverMutator?: (server) => server` lets you reach into the underlying SDK
    `McpServer` after our factory builds it (e.g., to register custom JSON-RPC
    methods that the public API does not expose).
  - `title`, `websiteUrl`, and `icons` are forwarded to the SDK
    `Implementation` block alongside `name`, `version`, and the existing
    `description`, so clients can display richer server metadata in the
    `initialize` response.

- 2fde58b: feat(common): support RFC 6570 form-style query expansion in resource URI templates

  `matchUriTemplate` now recognizes the `{?name,email}` query-expansion syntax.
  For a template like `users/{id}{?expand,fields}` matched against a URI like
  `users/42?expand=true&fields=name`, the returned `params` map contains both
  the path params (`id`) and the declared query params (`expand`, `fields`),
  merged. Query params not declared in the template are ignored. Path matching
  is unchanged for templates that don't use `{?...}`.

## 0.3.0

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

## 0.2.0

### Minor Changes

- 5a6ef8e: feat: add advanced transport options and fix logging configuration

  **Transport options** — `StreamableHttpTransportOptions` now supports `sessionIdGenerator`, `enableJsonResponse`, `eventStore`, `onsessioninitialized`, `onsessionclosed`, and `retryInterval`, passed through to the MCP SDK's `StreamableHTTPServerTransport`.

  **Logging** — `McpModuleOptions.logging` type changed from `{ level?: string }` to `false | LogLevel[]`. The old type was declared but never consumed. `bootstrapStdioApp()` now reads `logging` from `McpModule.forRoot()` as a fallback when `StdioBootstrapOptions.logLevels` is not explicitly provided.

  **SDK re-exports** — `EventStore`, `StreamId`, and `EventId` types are now re-exported from `@nest-mcp/server`.

  **BREAKING**: `logging` type change is compile-time only (the old field was never consumed at runtime). Migration: `{ level: 'error' }` → `['error']`.

## 0.1.8

### Patch Changes

- f943fca: Migrate to Zod v4. Zod v4 is now the required peer dependency.

## 0.1.7

### Patch Changes

- 0e1b932: Add npm keywords to all packages for improved discoverability

## 0.1.6

### Patch Changes

- 3fd3c19: Exclude .d.ts.map files from published packages — reduces file count by ~50%

## 0.1.5

### Patch Changes

- ac72e05: Add homepage links and npm/CI badges to each package README

## 0.1.4

### Patch Changes

- aaca8d0: Fix npm provenance via NPM_CONFIG_PROVENANCE environment variable

## 0.1.3

### Patch Changes

- 378b3c3: Enable npm provenance on publish

## 0.1.2

### Patch Changes

- 3dc43bd: Change license from MIT to BSD-3-Clause

## 0.1.1

### Patch Changes

- e6dd416: Add README to each package for npm display
