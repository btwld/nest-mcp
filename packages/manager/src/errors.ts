import {
	MCP_CLIENT_LEASE_CAPACITY_EXCEEDED,
	MCP_CLIENT_LEASE_INVALIDATED,
	MCP_CLIENT_LEASE_MANAGER_CLOSED,
} from "@nest-mcp/client";

export const MCP_RUNTIME_QUEUE_FULL = "MCP_QUEUE_FULL" as const;
export const MCP_RUNTIME_ADMISSION_TIMEOUT = "MCP_ADMISSION_TIMEOUT" as const;

export const MCP_RUNTIME_CAPACITY_EXCEEDED = "MCP_CAPACITY_EXCEEDED" as const;
export const MCP_RUNTIME_DISCOVERY_LIMIT_EXCEEDED = "MCP_DISCOVERY_LIMIT_EXCEEDED" as const;
export const MCP_RUNTIME_GENERATION_RETIRED = "MCP_GENERATION_RETIRED" as const;
export const MCP_RUNTIME_LEASE_MODE_CONFLICT = "MCP_LEASE_MODE_CONFLICT" as const;
export const MCP_RUNTIME_NOT_READY = "MCP_NOT_READY" as const;
export const MCP_RUNTIME_QUARANTINED = "MCP_QUARANTINED" as const;
export const MCP_RUNTIME_MANAGER_CLOSED = "MCP_RUNTIME_CLOSED" as const;
export const MCP_RUNTIME_UPSTREAM_FAILED = "MCP_UPSTREAM_FAILED" as const;

export const MCP_RUNTIME_CLEANUP_FAILED = "MCP_CLEANUP_FAILED" as const;
export const MCP_RUNTIME_CONNECTION_LOST = "MCP_CONNECTION_LOST" as const;

export type McpRuntimeManagerErrorCode =
	| typeof MCP_RUNTIME_CAPACITY_EXCEEDED
	| typeof MCP_RUNTIME_QUEUE_FULL
	| typeof MCP_RUNTIME_ADMISSION_TIMEOUT
	| typeof MCP_RUNTIME_DISCOVERY_LIMIT_EXCEEDED
	| typeof MCP_RUNTIME_GENERATION_RETIRED
	| typeof MCP_RUNTIME_LEASE_MODE_CONFLICT
	| typeof MCP_RUNTIME_NOT_READY
	| typeof MCP_RUNTIME_QUARANTINED
	| typeof MCP_RUNTIME_MANAGER_CLOSED
	| typeof MCP_RUNTIME_UPSTREAM_FAILED;

export type McpRuntimeStateErrorCode =
	| McpRuntimeManagerErrorCode
	| typeof MCP_RUNTIME_CLEANUP_FAILED
	| typeof MCP_RUNTIME_CONNECTION_LOST
	| "UNKNOWN";

/** Framework-neutral, key-free failure raised by the managed runtime lifecycle. */
export class McpRuntimeManagerError extends Error {
	readonly code: McpRuntimeManagerErrorCode;

	constructor(code: McpRuntimeManagerErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "McpRuntimeManagerError";
		this.code = code;
	}
}

export function mapMcpRuntimeManagerError(error: unknown): unknown {
	if (error instanceof McpRuntimeManagerError) return error;
	if (error instanceof McpRuntimeGenerationResolutionError) return error.cause;
	const code = safeErrorCode(error);
	if (code === MCP_CLIENT_LEASE_CAPACITY_EXCEEDED) {
		return new McpRuntimeManagerError(
			MCP_RUNTIME_CAPACITY_EXCEEDED,
			"The MCP runtime manager is at its connection capacity.",
			{ cause: error },
		);
	}
	if (code === MCP_CLIENT_LEASE_INVALIDATED) {
		return new McpRuntimeGenerationRetiredError(error);
	}
	if (code === MCP_CLIENT_LEASE_MANAGER_CLOSED) return runtimeManagerClosedError(error);
	return new McpRuntimeManagerError(
		MCP_RUNTIME_UPSTREAM_FAILED,
		"The upstream MCP operation failed.",
		{ cause: error },
	);
}

export function runtimeManagerErrorCode(error: unknown): McpRuntimeStateErrorCode {
	if (error instanceof McpRuntimeManagerError) return error.code;
	if (error instanceof McpRuntimeGenerationResolutionError) {
		return runtimeManagerErrorCode(error.cause);
	}
	const code = safeErrorCode(error);
	if (isRuntimeStateErrorCode(code)) return code;
	if (code === MCP_CLIENT_LEASE_CAPACITY_EXCEEDED) return MCP_RUNTIME_CAPACITY_EXCEEDED;
	if (code === MCP_CLIENT_LEASE_INVALIDATED) return MCP_RUNTIME_GENERATION_RETIRED;
	if (code === MCP_CLIENT_LEASE_MANAGER_CLOSED) return MCP_RUNTIME_MANAGER_CLOSED;
	return "UNKNOWN";
}

export function runtimeManagerClosedError(cause?: unknown): McpRuntimeManagerError {
	return new McpRuntimeManagerError(
		MCP_RUNTIME_MANAGER_CLOSED,
		"The MCP runtime manager is closed.",
		cause === undefined ? undefined : { cause },
	);
}

export function runtimeQuarantinedError(cause?: unknown): McpRuntimeManagerError {
	return new McpRuntimeManagerError(
		MCP_RUNTIME_QUARANTINED,
		"The MCP runtime generation is quarantined after uncertain cleanup.",
		cause === undefined ? undefined : { cause },
	);
}

export function runtimeNotReadyError(): McpRuntimeManagerError {
	return new McpRuntimeManagerError(
		MCP_RUNTIME_NOT_READY,
		"The MCP connection does not have an active connected runtime generation.",
	);
}

export function runtimeLeaseModeConflictError(): McpRuntimeManagerError {
	return new McpRuntimeManagerError(
		MCP_RUNTIME_LEASE_MODE_CONFLICT,
		"The MCP runtime generation already has work using a conflicting lease mode.",
	);
}

export class McpRuntimeGenerationResolutionError extends Error {
	override readonly cause: unknown;

	constructor(cause: unknown) {
		super("The MCP runtime generation could not be resolved.", { cause });
		this.name = "McpRuntimeGenerationResolutionError";
		this.cause = cause;
	}
}

class McpRuntimeGenerationRetiredError extends McpRuntimeManagerError {
	constructor(cause: unknown) {
		super(
			MCP_RUNTIME_GENERATION_RETIRED,
			"The MCP runtime generation was retired before the operation completed.",
			{ cause },
		);
	}
}

function safeErrorCode(error: unknown): string {
	if (typeof error !== "object" || error === null) return "UNKNOWN";
	try {
		const code = Reflect.get(error, "code");
		return typeof code === "string" ? code : "UNKNOWN";
	} catch {
		return "UNKNOWN";
	}
}

export function isRuntimeStateErrorCode(code: string): code is McpRuntimeStateErrorCode {
	return RUNTIME_STATE_ERROR_CODES.has(code);
}

const RUNTIME_STATE_ERROR_CODES: ReadonlySet<string> = new Set([
	MCP_RUNTIME_CAPACITY_EXCEEDED,
	MCP_RUNTIME_QUEUE_FULL,
	MCP_RUNTIME_ADMISSION_TIMEOUT,
	MCP_RUNTIME_CLEANUP_FAILED,
	MCP_RUNTIME_CONNECTION_LOST,
	MCP_RUNTIME_DISCOVERY_LIMIT_EXCEEDED,
	MCP_RUNTIME_GENERATION_RETIRED,
	MCP_RUNTIME_LEASE_MODE_CONFLICT,
	MCP_RUNTIME_MANAGER_CLOSED,
	MCP_RUNTIME_NOT_READY,
	MCP_RUNTIME_QUARANTINED,
	MCP_RUNTIME_UPSTREAM_FAILED,
	"UNKNOWN",
]);
