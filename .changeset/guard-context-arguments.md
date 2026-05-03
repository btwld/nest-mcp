---
'@nest-mcp/common': minor
'@nest-mcp/server': minor
---

feat(common,server): expose tool/prompt arguments on `McpGuardContext`

Custom guards now receive an `arguments` field on the `McpGuardContext`
populated with the raw arguments the caller passed to `tools/call` or
`prompts/get`. Values are pre-Zod (validation runs after auth), so guards
inspecting fields should treat them as `unknown`. Resource guards still
receive only `resourceUri`.
