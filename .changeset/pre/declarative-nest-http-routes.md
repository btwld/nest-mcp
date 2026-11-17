---
"@nest-mcp/nestjs": minor
---

Add optional static `httpRoutes` to `McpModule.forRoot` and `forRootAsync`. The module generates Nest
controllers for named MCP runtimes and optional OAuth resource discovery documents, preserving
class decorators, guards, interceptors, versioning, and the existing authenticated HTTP pipeline.
Applications can remove boilerplate MCP transport controllers while keeping their own consent,
upload, and other product routes. Existing controller factories and direct handlers remain supported.
