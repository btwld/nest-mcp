export const MCP_CLIENT_RUNTIME_CLOSED = "MCP_CLIENT_RUNTIME_CLOSED" as const;
export const MCP_CLIENT_SERVER_EXISTS = "MCP_CLIENT_SERVER_EXISTS" as const;
export const MCP_CLIENT_SERVER_NOT_FOUND = "MCP_CLIENT_SERVER_NOT_FOUND" as const;
export const MCP_CLIENT_NOT_CONNECTED = "MCP_CLIENT_NOT_CONNECTED" as const;
export const MCP_CLIENT_SHUTDOWN_TIMEOUT = "MCP_CLIENT_SHUTDOWN_TIMEOUT" as const;
export const MCP_CLIENT_LEASE_MANAGER_CLOSED = "MCP_CLIENT_LEASE_MANAGER_CLOSED" as const;
export const MCP_CLIENT_LEASE_CAPACITY_EXCEEDED = "MCP_CLIENT_LEASE_CAPACITY_EXCEEDED" as const;
export const MCP_CLIENT_LEASE_RELEASE_MODE_CONFLICT =
	"MCP_CLIENT_LEASE_RELEASE_MODE_CONFLICT" as const;
export const MCP_CLIENT_LEASE_INVALIDATED = "MCP_CLIENT_LEASE_INVALIDATED" as const;

export type McpClientRuntimeErrorCode =
	| typeof MCP_CLIENT_RUNTIME_CLOSED
	| typeof MCP_CLIENT_SERVER_EXISTS
	| typeof MCP_CLIENT_SERVER_NOT_FOUND
	| typeof MCP_CLIENT_NOT_CONNECTED
	| typeof MCP_CLIENT_SHUTDOWN_TIMEOUT;

export type McpClientLeaseManagerErrorCode =
	| typeof MCP_CLIENT_LEASE_MANAGER_CLOSED
	| typeof MCP_CLIENT_LEASE_CAPACITY_EXCEEDED
	| typeof MCP_CLIENT_LEASE_RELEASE_MODE_CONFLICT
	| typeof MCP_CLIENT_LEASE_INVALIDATED;

/** Base error for deterministic registry and lifecycle failures. */
export class McpClientRuntimeError extends Error {
	readonly code: McpClientRuntimeErrorCode;
	readonly serverName?: string;

	constructor(code: McpClientRuntimeErrorCode, message: string, serverName?: string) {
		super(message);
		this.name = "McpClientRuntimeError";
		this.code = code;
		if (serverName !== undefined) this.serverName = serverName;
	}
}

/** Key-free error for deterministic lease-manager admission and lifecycle failures. */
export class McpClientLeaseManagerError extends Error {
	readonly code: McpClientLeaseManagerErrorCode;

	constructor(code: McpClientLeaseManagerErrorCode, message: string) {
		super(message);
		this.name = "McpClientLeaseManagerError";
		this.code = code;
	}
}

export function runtimeClosedError(): McpClientRuntimeError {
	return new McpClientRuntimeError(
		MCP_CLIENT_RUNTIME_CLOSED,
		"The MCP client runtime is closed and cannot accept new work.",
	);
}

export function serverExistsError(serverName: string): McpClientRuntimeError {
	return new McpClientRuntimeError(
		MCP_CLIENT_SERVER_EXISTS,
		`An MCP server named ${JSON.stringify(serverName)} is already registered.`,
		serverName,
	);
}

export function serverNotFoundError(serverName: string): McpClientRuntimeError {
	return new McpClientRuntimeError(
		MCP_CLIENT_SERVER_NOT_FOUND,
		`No MCP server named ${JSON.stringify(serverName)} is registered.`,
		serverName,
	);
}

export function clientNotConnectedError(serverName: string): McpClientRuntimeError {
	return new McpClientRuntimeError(
		MCP_CLIENT_NOT_CONNECTED,
		`The MCP server ${JSON.stringify(serverName)} is not connected.`,
		serverName,
	);
}

export function shutdownTimeoutError(serverName: string, timeoutMs: number): McpClientRuntimeError {
	return new McpClientRuntimeError(
		MCP_CLIENT_SHUTDOWN_TIMEOUT,
		`The MCP server ${JSON.stringify(serverName)} connection did not stop within ${String(timeoutMs)}ms.`,
		serverName,
	);
}

export function leaseManagerClosedError(): McpClientLeaseManagerError {
	return new McpClientLeaseManagerError(
		MCP_CLIENT_LEASE_MANAGER_CLOSED,
		"The MCP client lease manager is closed and cannot accept new work.",
	);
}

export function leaseCapacityExceededError(): McpClientLeaseManagerError {
	return new McpClientLeaseManagerError(
		MCP_CLIENT_LEASE_CAPACITY_EXCEEDED,
		"The MCP client lease manager is at capacity.",
	);
}

export function leaseReleaseModeConflictError(): McpClientLeaseManagerError {
	return new McpClientLeaseManagerError(
		MCP_CLIENT_LEASE_RELEASE_MODE_CONFLICT,
		"The existing MCP client resource uses a different release mode.",
	);
}

export function leaseInvalidatedError(): McpClientLeaseManagerError {
	return new McpClientLeaseManagerError(
		MCP_CLIENT_LEASE_INVALIDATED,
		"The MCP client lease identity was invalidated before acquisition completed.",
	);
}
