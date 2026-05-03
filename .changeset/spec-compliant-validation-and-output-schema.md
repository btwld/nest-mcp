---
'@nest-mcp/server': minor
---

feat(server): MCP-spec arg validation + `outputSchema`/`structuredContent`

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
