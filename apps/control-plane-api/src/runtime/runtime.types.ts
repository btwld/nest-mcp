import type { McpStreamingFetchLike } from "@nest-mcp/auth/cimd";

export type {
	McpRuntimeCatalogSnapshot as RuntimeCatalogView,
	McpRuntimeManagerPort as RuntimeSupervisorPort,
	McpRuntimeManagerSnapshot as RuntimeManagerView,
	McpRuntimePhase as RuntimePhase,
	McpRuntimeProbeSnapshot as RuntimeProbeView,
	McpRuntimeStateSnapshot as RuntimeStateView,
} from "@nest-mcp/manager";

export const MCP_CONTROL_PLANE_GUARDED_FETCH = Symbol("example-mcp-control-plane:guarded-fetch");
export const MCP_RUNTIME_SUPERVISOR = Symbol("example-mcp-control-plane:runtime-supervisor");

/**
 * The outbound transport seam. Production binds it to Nest MCP's streaming
 * SSRF-guarded fetch; tests bind an in-process server fetch to the same token.
 */
export type McpGuardedTransportFetch = McpStreamingFetchLike;
