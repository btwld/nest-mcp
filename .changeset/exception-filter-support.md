---
'@nest-mcp/server': minor
---

feat(server): integrate NestJS `@UseFilters()` exception filters into MCP handlers

Tools, resources, and prompts that throw a non-MCP error now consult any
`@UseFilters(...)` declared on the handler method or its enclosing class.
Filter output (string or JSON-serializable value) is rendered as the message
of an `McpError` and surfaced to the client as a JSON-RPC error. Unhandled
errors fall through to the previous `ToolExecutionError` path.
