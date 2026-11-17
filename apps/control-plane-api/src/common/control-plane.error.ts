export type ControlPlaneErrorCode =
	| "MCP_CAPACITY_EXCEEDED"
	| "MCP_CONNECTION_EXISTS"
	| "MCP_CONNECTION_DELETING"
	| "MCP_CONNECTION_NOT_FOUND"
	| "MCP_CONFORMANCE_ALREADY_ACTIVE"
	| "MCP_CONFORMANCE_CAPACITY_EXCEEDED"
	| "MCP_CONFORMANCE_RUN_NOT_FOUND"
	| "MCP_CONFORMANCE_TARGET_CHANGED"
	| "MCP_DISCOVERY_LIMIT_EXCEEDED"
	| "MCP_ENDPOINT_REJECTED"
	| "MCP_GENERATION_RETIRED"
	| "MCP_HUB_CATALOG_INVALID"
	| "MCP_HUB_CLOSED"
	| "MCP_HUB_MEMBER_CONFLICT"
	| "MCP_HUB_MEMBER_NOT_FOUND"
	| "MCP_HUB_NAMESPACE_CONFLICT"
	| "MCP_HUB_REVISION_CONFLICT"
	| "MCP_NOT_READY"
	| "MCP_OAUTH_AUTHORIZATION_DENIED"
	| "MCP_OAUTH_AUTHORIZATION_REQUIRED"
	| "MCP_OAUTH_CALLBACK_INVALID"
	| "MCP_OAUTH_ENDPOINT_REJECTED"
	| "MCP_OAUTH_UPSTREAM_FAILED"
	| "MCP_QUARANTINED"
	| "MCP_REVISION_CONFLICT"
	| "MCP_RUNTIME_CLOSED"
	| "MCP_TOOL_ARGUMENTS_INVALID"
	| "MCP_TOOL_NOT_FOUND"
	| "MCP_TOOL_SCHEMA_INVALID"
	| "MCP_UPSTREAM_FAILED";

export class ControlPlaneError extends Error {
	readonly code: ControlPlaneErrorCode;
	readonly status: number;

	constructor(
		code: ControlPlaneErrorCode,
		status: number,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ControlPlaneError";
		this.code = code;
		this.status = status;
	}
}

export function safeErrorCode(error: unknown): string {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string" &&
		SAFE_ERROR_CODES.has(error.code)
	) {
		return error.code;
	}
	return "UNKNOWN";
}

const SAFE_ERROR_CODES: ReadonlySet<string> = new Set([
	"MCP_CLIENT_LEASE_CAPACITY_EXCEEDED",
	"MCP_CLIENT_LEASE_INVALIDATED",
	"MCP_CLIENT_LEASE_MANAGER_CLOSED",
	"MCP_GENERATION_RETIRED",
	"MCP_QUARANTINED",
]);
