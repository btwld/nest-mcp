# @nest-mcp/server

## 0.6.0

### Minor Changes

- 2fde58b: feat(server): add built-in `GitHubProvider` and `AzureAdProvider` for `McpAuthModule`

  Two ready-made `OAuthProviderAdapter` implementations covering the most-asked
  identity providers, plus a shared `OAuthCodeExchangeProvider` base class
  that other Authorization-Code flows can extend. All implementations use
  `globalThis.fetch` (Node 20+) — no Passport peer dependencies.

  Public surface:

  - `GitHubProvider({ clientId, clientSecret, scope?, userAgent? })`
  - `AzureAdProvider({ clientId, clientSecret, tenant?, scope? })` — defaults to
    the multi-tenant `common` tenant; supply a tenant GUID or domain to lock
    the issuer to a single Microsoft Entra tenant.
  - `OAuthCodeExchangeProvider` — abstract base; subclasses declare
    `authorizationUrl`, `tokenUrl`, `userInfoUrl`, `scope`, and a
    `mapProfile()` callback.

  Usage:

  ```ts
  import { McpAuthModule, GitHubProvider } from "@nest-mcp/server";

  const provider = new GitHubProvider({
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  });

  McpAuthModule.forProvider(provider, {
    /* ... */
  });
  ```

- 2fde58b: feat(server): integrate NestJS `@UseFilters()` exception filters into MCP handlers

  Tools, resources, and prompts that throw a non-MCP error now consult any
  `@UseFilters(...)` declared on the handler method or its enclosing class.
  Filter output (string or JSON-serializable value) is rendered as the message
  of an `McpError` and surfaced to the client as a JSON-RPC error. Unhandled
  errors fall through to the previous `ToolExecutionError` path.

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

- 2fde58b: feat(server): MCP-spec arg validation + `outputSchema`/`structuredContent`

  **Behavior change** — tool input validation no longer throws
  `ValidationError`. Per the MCP specification, invalid `tools/call` arguments
  now resolve to a tool result `{ isError: true, content: [{ type: 'text',
text: 'Invalid parameters: ...' }] }` so the calling model can self-correct.
  Callers that previously caught a JSON-RPC `InvalidParams` from the protocol
  layer for tool calls should switch to inspecting `result.isError` instead.
  Prompt argument validation still throws `ValidationError`.

  When a tool declares an `outputSchema`, its handler return is now validated
  against the schema and the parsed result is attached to the
  `structuredContent` field of the `CallToolResult`. Schema mismatches throw
  `ToolExecutionError` (server-side bug).

- 2fde58b: feat(server): add `McpElicitationModule` for browser-based URL elicitation

  Adds an opt-in module that hosts the HTTP endpoints + HTML forms required to
  implement the MCP `elicit/create` flow in `mode: 'url'`. Server code (e.g.,
  a tool handler) creates an elicitation via `ElicitationService.createElicitation`,
  emits the URL to the client through the standard MCP elicitation request,
  and registers a completion notifier; when the user submits the form on the
  hosted page, the notifier fires and the awaited request resumes.

  Public surface:

  - `McpElicitationModule.forRoot({ serverUrl, ... })`
  - `ElicitationService` — `createElicitation`, `completeElicitation`,
    `buildElicitationUrl`, `registerCompletionNotifier`,
    `findResultByUserAndType`, plus `startUrlElicitation()` (high-level
    helper that returns `{ elicitationId, url, waitForCompletion }`).
  - `ElicitationCancelledError` — thrown by `waitForCompletion` when the
    user submits the cancel action.
  - `IElicitationStore` — pluggable storage backend (default in-memory; supply
    a Redis/DB-backed store via `storeConfiguration: { type: 'custom', store }`)
  - `MemoryElicitationStore` — default
  - HTML templates for API-key form, confirmation form, success/cancel/error
    pages, with `templateOptions` for branding (logo, app name, primary color,
    custom CSS)
  - Configurable endpoint paths and Nest guards on the controller

  Tool-handler integration pattern:

  ```ts
  const { elicitationId, url, waitForCompletion } =
    await elicitation.startUrlElicitation({
      sessionId: ctx.sessionId,
      userId: ctx.user?.id,
      metadata: { type: "api-key", message: "Enter your key" },
    });
  await ctx.elicit({
    mode: "url",
    message: "Open browser",
    url,
    elicitationId,
  });
  const result = await waitForCompletion({
    signal: ctx.signal,
    timeoutMs: 60_000,
  });
  ```

  Pre-existing `ElicitURLRequest` type in `@nest-mcp/common` is unchanged.

### Patch Changes

- Updated dependencies [2fde58b]
- Updated dependencies [2fde58b]
- Updated dependencies [2fde58b]
  - @nest-mcp/common@0.4.0

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
