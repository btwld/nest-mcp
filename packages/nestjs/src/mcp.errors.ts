export type McpModuleErrorCode =
	| "DUPLICATE_HANDLER"
	| "INVALID_HANDLER"
	| "INVALID_CATALOG_EXPOSURE"
	| "INVALID_OPTIONS"
	| "INVALID_SCOPE"
	| "INVALID_VISIBILITY_POLICY"
	| "RUNTIME_CLOSED"
	| "RUNTIME_NOT_READY"
	| "UNKNOWN_SERVER_TARGET"
	| "UNKNOWN_CLIENT"
	| "UNKNOWN_GATEWAY";

export class McpModuleError extends Error {
	constructor(
		readonly code: McpModuleErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "McpModuleError";
	}
}
