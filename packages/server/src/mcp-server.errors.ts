export type McpServerErrorCode =
	"DUPLICATE_SERVER" | "INVALID_DEFINITION" | "RUNTIME_CLOSED" | "UNKNOWN_SERVER";

export class McpServerRuntimeError extends Error {
	constructor(
		readonly code: McpServerErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "McpServerRuntimeError";
	}
}
