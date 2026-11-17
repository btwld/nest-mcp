---
"@nest-mcp/client": minor
"@nest-mcp/nestjs": minor
---

Return a real Zod v4 schema from `createMcpClientToolSchema`. Its Zod refinement retains exact
Draft 2020-12 validation and identity parsing through the official MCP validator, while the schema
continues to implement Standard Schema and preserve the immutable, detached remote JSON Schema
definition. Explicit older dialects fail closed, and the previous async Standard Schema surface
remains compatible.
