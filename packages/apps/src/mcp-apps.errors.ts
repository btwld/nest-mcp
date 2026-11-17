export const McpAppsValidationErrorCode = {
	InvalidUri: "INVALID_URI",
	InvalidMimeType: "INVALID_MIME_TYPE",
	InvalidMetadata: "INVALID_METADATA",
	InvalidCsp: "INVALID_CSP",
	InvalidPermissions: "INVALID_PERMISSIONS",
	InvalidVisibility: "INVALID_VISIBILITY",
	ConflictingResourceUri: "CONFLICTING_RESOURCE_URI",
	MissingResource: "MISSING_RESOURCE",
	InvalidContent: "INVALID_CONTENT",
	InvalidFallback: "INVALID_FALLBACK",
} as const;

export type McpAppsValidationErrorCode =
	(typeof McpAppsValidationErrorCode)[keyof typeof McpAppsValidationErrorCode];

/** Programmer-facing error thrown while constructing MCP Apps wire fragments. */
export class McpAppsValidationError extends TypeError {
	readonly code: McpAppsValidationErrorCode;
	readonly path: string;

	constructor(code: McpAppsValidationErrorCode, path: string, detail: string) {
		super(`Invalid MCP Apps ${path}: ${detail}`);
		this.name = "McpAppsValidationError";
		this.code = code;
		this.path = path;
	}
}
