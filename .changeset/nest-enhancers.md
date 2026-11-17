---
"@nest-mcp/server": minor
"@nest-mcp/common": minor
---

Native NestJS enhancers for MCP capabilities (opt-in).

Set `nestEnhancers: true` on `McpModule.forRoot` / `forRootAsync` to run tool, resource,
resource-template and prompt handlers through NestJS's own enhancer pipeline. `@UseGuards`,
`@UseInterceptors`, `@UsePipes` and `@UseFilters` then work on capabilities at method, class and
application level, with dependency injection, and receive an execution context whose `getType()`
is `'mcp'`.

- **`McpArgumentsHost`** (`@nest-mcp/server`) reads the capability kind, its name or URI, the input
  arguments and the `McpExecutionContext` from a Nest `ExecutionContext` or `ArgumentsHost`.
  `McpContextType` and `MCP_CONTEXT_TYPE` are exported alongside it.
- Enhancers run after the existing module guards, `@Scopes` / `@Roles` / `@Guards`, `@UseMiddleware`
  and the resilience wrappers, all of which keep working unchanged.
- A guard denial (`false`, `ForbiddenException`, `UnauthorizedException`) is reported like the
  built-in authorization failures; a `BadRequestException` from a pipe is reported like an input
  validation failure.

The option is off by default and nothing changes until it is enabled. Once it is, application-level
enhancers (`APP_GUARD`, `APP_INTERCEPTOR`, `APP_PIPE`, `APP_FILTER`, `app.useGlobal*()`) also run
for MCP calls, so make enhancers written for HTTP return early for the `'mcp'` context type first.
See the "NestJS Enhancers" section of the execution pipeline guide.
