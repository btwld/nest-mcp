---
"@nest-mcp/manager": minor
"@nest-mcp/nestjs": minor
---

Publish `MCP_RUNTIME_PHASES` and `MCP_RUNTIME_PROTOCOL_ERAS` as frozen tuples that mirror the
`McpRuntimePhase` and `McpRuntimeProtocolEra` unions through a compile-time exhaustiveness fence,
together with `mcpRuntimeStateSnapshotSchema`, `mcpRuntimeProbeSnapshotSchema`, and
`mcpRuntimeCapabilitiesSnapshotSchema`. The validators implement Standard Schema v1 without adding
a runtime dependency: they accept exactly what the manager emits, reject unknown properties and
unpublished phases, eras, or state error codes, and return a frozen normalized snapshot so hosts
can validate persisted projections on the way back in.

Accept an `McpRuntimeToolCallOptions` object as the fourth `callTool` argument. A positional
`AbortSignal` stays source compatible as the cancellation-only form, and pinning `toolDefinition`
threads that exact definition to the managed client runtime so structured output is validated
against it instead of a cached `tools/list` view. `McpManagerService` from `@nest-mcp/nestjs/manager`
inherits the widened call surface.
