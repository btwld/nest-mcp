---
'@nest-mcp/server': minor
---

feat(server): add `McpElicitationModule` for browser-based URL elicitation

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
    metadata: { type: 'api-key', message: 'Enter your key' },
  });
await ctx.elicit({ mode: 'url', message: 'Open browser', url, elicitationId });
const result = await waitForCompletion({ signal: ctx.signal, timeoutMs: 60_000 });
```

Pre-existing `ElicitURLRequest` type in `@nest-mcp/common` is unchanged.
